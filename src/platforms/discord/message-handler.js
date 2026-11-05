import { isBotAddressed, isBotRoleMentioned, isChannelAllowed, isRespondToAllChannel, toDiscordEvent } from './events.js';
import { chunkContent, createPreviewer, photoBatches, photoPayload, v2Message } from './ui.js';

// Cap concurrent streaming turns so a burst of mentions cannot open hundreds of preview
// edits at once. agent.stream() already serializes turns per chat; this is global.
const MAX_STREAMING_CHATS = 4;

/**
 * Ordinary Discord chat: admission, vision bytes, one streaming placeholder reply, then the
 * remaining chunks and photo groups. Commands are handled by interaction-router.js.
 * @param {{config: any, logger?: import('../../core/logger.js').Logger, metrics?: any, transport: any, runtime: any, client: any}} deps
 */
export function createMessageHandler(deps) {
  const { config, logger, metrics, transport, runtime, client } = deps;

  let activeStreams = 0;
  /** @type {Array<() => void>} */
  const streamWaiters = [];

  async function acquireStreamSlot() {
    if (activeStreams < MAX_STREAMING_CHATS) {
      activeStreams += 1;
      return;
    }
    await new Promise((resolve) => streamWaiters.push(/** @type {any} */ (resolve)));
    activeStreams += 1;
  }

  function releaseStreamSlot() {
    activeStreams = Math.max(0, activeStreams - 1);
    streamWaiters.shift()?.();
  }

  /** @param {any} message */
  return async function handleMessage(message) {
    if (message.author?.bot) return;
    const isDm = message.channel?.isDMBased?.() === true;
    const mentioned = Boolean(client.user && message.mentions?.users?.has(client.user.id));
    const roleMentioned = isBotRoleMentioned(message, client.user?.id ?? '');
    if (!isChannelAllowed(config.discord ?? {}, message.channel ?? { id: message.channelId })) return;
    let repliedToBot = false;
    let referenced = null;
    if (message.reference?.messageId) {
      referenced = await message.fetchReference().catch(() => null);
      repliedToBot = Boolean(referenced && referenced.author?.id === client.user?.id);
    }
    const listensHere = isRespondToAllChannel(config.discord ?? {}, message.channel ?? { id: message.channelId });
    if (!isBotAddressed({ mentioned, roleMentioned, repliedToBot, isDm, listensHere })) return;

    const event = toDiscordEvent(message, client, referenced);
    if (!event) return;
    // Slash-only command surface: a typed "/ask ..." is not a command.
    if (String(event.text ?? '').trimStart().startsWith('/')) return;
    if (event.imageUrl && runtime.validator?.download) {
      // Vision bytes are optional: if the download fails the text note still reaches the model.
      try {
        const downloaded = await runtime.validator.download(event.imageUrl);
        if (downloaded?.ok && downloaded.data) {
          event.imageData = { data: downloaded.data, contentType: downloaded.contentType };
        }
      } catch (error) {
        logger?.debug('discord image download failed', { error: String(/** @type {any} */ (error)?.message ?? error) });
      }
    }
    metrics?.inc('discord.messages.in');

    // Ordinary chat streams into one placeholder reply, the same way /ask does.
    await acquireStreamSlot();
    const stopTyping = config.typing ? transport.startTyping(event.chatId) : async () => {};
    /** @type {any} */
    let placeholder = null;
    let streamed = '';
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
        skipCommands: true,
        onDelta: (delta) => {
          streamed += delta;
          previewer.push(streamed);
        },
      });
      await previewer.flush();
      const chunks = result.text ? chunkContent(result.text) : [];
      const first = chunks.shift();
      logger?.debug('discord reply ready', { chatId: event.chatId, photos: result.photos.length, chunks: chunks.length });
      if (placeholder) {
        if (!first && !result.photos.length) {
          await placeholder.delete().catch((error) => {
            logger?.debug('discord placeholder delete failed', {
              chatId: event.chatId,
              error: String(/** @type {any} */ (error)?.message ?? error),
            });
          });
        } else {
          await placeholder
            .edit(v2Message(first || 'Here are the images.'))
            .catch((error) => {
              logger?.debug('discord placeholder edit failed', {
                chatId: event.chatId,
                error: String(/** @type {any} */ (error)?.message ?? error),
              });
            });
        }
      } else if (first) {
        placeholder = await message.reply(v2Message(first));
      }
      for (const chunk of chunks) {
        await message.channel.send(v2Message(chunk)).catch((error) => {
          logger?.warn('discord chunk send failed', {
            chatId: event.chatId,
            error: String(/** @type {any} */ (error)?.message ?? error),
          });
        });
      }
      for (const group of photoBatches(result.photos)) {
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
      releaseStreamSlot();
    }
  };
}
