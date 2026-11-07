import { QUEUE_BUSY_TEXT } from '../../core/ai/agent/queue.js';
import { isBotAddressed, isBotRoleMentioned, isChannelAllowed, isRespondToAllChannel, toDiscordEvent } from './events.js';
import { createProgressFeed } from './progress.js';
import { chunkContent, createPreviewer, photoBatches, photoPayload, v2Answer, v2Message } from './ui.js';

/**
 * Ordinary Discord chat: admission, vision bytes, one streaming placeholder reply, then the
 * remaining chunks and photo groups. Commands are handled by interaction-router.js.
 * @param {{config: any, logger?: import('../../core/logger.js').Logger, metrics?: any, transport: any, runtime: any, client: any}} deps
 */
export function createMessageHandler(deps) {
  const { config, logger, metrics, transport, runtime, client } = deps;

  /** @param {any} message */
  return async function handleMessage(message) {
    if (message.author?.bot) return;
    const isDm = message.channel?.isDMBased?.() === true;
    const mentioned = Boolean(client.user && message.mentions?.users?.has(client.user.id));
    const roleMentioned = isBotRoleMentioned(message, client.user?.id ?? '');
    if (!isChannelAllowed(config.discord ?? {}, message.channel ?? { id: message.channelId })) return;
    const listensHere = isRespondToAllChannel(config.discord ?? {}, message.channel ?? { id: message.channelId });
    // A reply needs one fetch to know whether it targets the bot; queue that check with the turn.
    if (!isBotAddressed({ mentioned, roleMentioned, isDm, listensHere }) && !message.reference?.messageId) return;

    const chatId = String(message.channel?.id ?? message.channelId ?? '');
    try {
      await runtime.agent.exclusive(chatId, async () => {
        let repliedToBot = false;
        let referenced = null;
        if (message.reference?.messageId) {
          referenced = await message.fetchReference().catch(() => null);
          repliedToBot = Boolean(referenced && referenced.author?.id === client.user?.id);
        }
        if (!isBotAddressed({ mentioned, roleMentioned, repliedToBot, isDm, listensHere })) return;

        const event = toDiscordEvent(message, client, referenced);
        if (!event) return;
        // Slash-only command surface: a typed "/ask ..." is not a command.
        if (String(event.text ?? '').trimStart().startsWith('/')) return;
        const urls = Array.isArray(event.imageUrls) && event.imageUrls.length
          ? event.imageUrls
          : event.imageUrl
            ? [event.imageUrl]
            : [];
        if (urls.length && runtime.validator?.download) {
          // Vision bytes are optional: if a download fails the text note still reaches the model.
          const assets = await Promise.all(
            urls.map(async (url) => {
              try {
                const downloaded = await runtime.validator.download(url);
                if (downloaded?.ok && downloaded.data) {
                  return { data: downloaded.data, contentType: downloaded.contentType };
                }
              } catch (error) {
                logger?.debug('discord image download failed', {
                  url,
                  error: String(/** @type {any} */ (error)?.message ?? error),
                });
              }
              return null;
            }),
          );
          const imageDataList = assets.filter(Boolean);
          if (imageDataList.length) {
            event.imageDataList = imageDataList;
            event.imageData = imageDataList[0];
          }
        }
        metrics?.inc('discord.messages.in');

        // Ordinary chat streams into one placeholder reply, the same way /ask does.
        const stopTyping = config.typing ? transport.startTyping(event.chatId) : async () => {};
        /** @type {any} */
        let placeholder = null;
        let streamed = '';
        const feed = createProgressFeed();
        const renderPreview = () => [feed.text(), streamed].filter(Boolean).join('\n\n');
        const previewer = createPreviewer(async (text) => {
          if (!placeholder) {
            placeholder = await message.reply(v2Message(text));
            await stopTyping();
            return;
          }
          await placeholder.edit(v2Message(text));
        });

        try {
          const result = await runtime.agent.stream(event, {
            scheduled: true,
            skipCommands: true,
            onDelta: (delta) => {
              streamed += delta;
              previewer.push(renderPreview());
            },
            onProgress: (progressEvent) => {
              feed.update(progressEvent);
              previewer.push(renderPreview());
            },
          });
          await previewer.flush();
          const chunks = result.text ? chunkContent(result.text) : [];
          const first = chunks.shift();
          const photos = result.photos ?? [];
          let photosEmbedded = false;
          logger?.debug('discord reply ready', {
            chatId: event.chatId,
            photos: photos.length,
            chunks: chunks.length,
          });
          if (placeholder) {
            if (!first && !photos.length) {
              await placeholder.delete().catch((error) => {
                logger?.debug('discord placeholder delete failed', {
                  chatId: event.chatId,
                  error: String(/** @type {any} */ (error)?.message ?? error),
                });
              });
            } else {
              try {
                await placeholder.edit(v2Answer(first || 'Here are the images.', [], photos));
                photosEmbedded = photos.length > 0;
              } catch (error) {
                logger?.debug('discord combined photo answer failed', {
                  chatId: event.chatId,
                  error: String(/** @type {any} */ (error)?.message ?? error),
                });
                await placeholder.edit(v2Message(first || 'Here are the images.')).catch((editError) => {
                  logger?.debug('discord placeholder edit failed', {
                    chatId: event.chatId,
                    error: String(/** @type {any} */ (editError)?.message ?? editError),
                  });
                });
              }
            }
          } else if (first || photos.length) {
            try {
              placeholder = await message.reply(v2Answer(first || 'Here are the images.', [], photos));
              photosEmbedded = photos.length > 0;
            } catch (error) {
              logger?.warn('discord combined photo reply failed', {
                chatId: event.chatId,
                error: String(/** @type {any} */ (error)?.message ?? error),
              });
              placeholder = await message.reply(v2Message(first || 'Here are the images.'));
            }
          }
          for (const chunk of chunks) {
            await message.channel.send(v2Message(chunk)).catch((error) => {
              logger?.warn('discord chunk send failed', {
                chatId: event.chatId,
                error: String(/** @type {any} */ (error)?.message ?? error),
              });
            });
          }
          for (const group of photosEmbedded ? [] : photoBatches(photos)) {
            try {
              await message.channel.send({ ...photoPayload(group), allowedMentions: { parse: [] } });
            } catch (error) {
              logger?.warn('discord photo send failed', {
                chatId: event.chatId,
                count: group.length,
                status: /** @type {any} */ (error)?.status,
                error: String(/** @type {any} */ (error)?.message ?? error),
              });
              // One bad attachment must not take the whole group down: retry each via the transport.
              for (const photo of group) {
                try {
                  await transport.sendPhoto(
                    event.chatId,
                    photo.url,
                    photo.caption,
                    photo.data ? { data: photo.data, contentType: photo.contentType } : undefined,
                  );
                } catch (fallbackError) {
                  logger?.error('discord photo fallback failed', {
                    chatId: event.chatId,
                    url: photo.url,
                    error: String(/** @type {any} */ (fallbackError)?.message ?? fallbackError),
                  });
                }
              }
            }
          }
        } catch (error) {
          logger?.error('discord streaming reply failed', { error: String(/** @type {any} */ (error)?.message ?? error) });
        } finally {
          await stopTyping();
        }
      });
    } catch (error) {
      if (/** @type {any} */ (error)?.name === 'QueueFullError') {
        await message.reply(v2Message(QUEUE_BUSY_TEXT)).catch((replyError) => {
          logger?.debug('discord busy notice failed', {
            chatId,
            error: String(/** @type {any} */ (replyError)?.message ?? replyError),
          });
        });
        return;
      }
      logger?.error('discord message handling failed', { error: String(/** @type {any} */ (error)?.message ?? error) });
    }
  };
}
