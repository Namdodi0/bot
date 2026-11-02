import { createTokenMeter } from '../context/token-meter.js';
import { CircuitOpenError, HttpError } from '../http.js';
import { stripMention } from '../text/format.js';
import { createQueue, createRateLimiter, createSeenTracker } from './agent/queue.js';
import { createSenderFactory } from './agent/sending.js';
import { findBreak, planAttemptBudget, preview, sleep } from './agent/helpers.js';
import { createTurnRunner } from './agent/turn.js';
import { LLM_ERROR, isRetryableLlmError } from './llm/errors.js';
import { createRetryExecutor } from './llm/retry.js';

/**
 * @param {{config: any, logger: import('../logger.js').Logger, metrics: any, transport: any, llm: ReturnType<typeof import('./router.js').createModelRouter>, store: ReturnType<typeof import('../context/store.js').createContextStore>, tools: ReturnType<typeof import('./tools.js').createToolRuntime>, commands: ReturnType<typeof import('../commands/index.js').createCommands>, stickers?: ReturnType<typeof import('./stickers.js').createStickerStore>, http?: ReturnType<typeof import('../http.js').createHttp>, compaction: ReturnType<typeof import('../context/compaction/engine.js').createCompactionEngine>}} deps
 */
export function createAgent(deps) {
  const { config, logger, metrics, transport, llm, store, tools, commands, stickers, compaction } = deps;
  const meter = createTokenMeter();
  const retryExecutor = createRetryExecutor({ shouldRetry: isRetryableLlmError, sleep });
  const seen = createSeenTracker();
  const rateLimited = createRateLimiter(config);
  const { makeSender, sendText } = createSenderFactory({ config, logger, metrics, transport });

  const conversation = createTurnRunner({
    config,
    logger,
    metrics,
    transport,
    llm,
    tools,
    store,
    compaction,
    makeSender,
    sendText,
    meter,
    retryExecutor,
  });

  /**
   * @param {import('../zalo/events.js').BotEvent} event
   */
  async function handle(event) {
    if (!event) return;
    if (event.isBot) return;
    if (event.kind === 'unsupported' || event.kind === 'unknown') return;
    if (config.allowedChatIds.length && !config.allowedChatIds.includes(event.chatId)) {
      logger.debug('chat not allowed, skipping', { chatId: event.chatId, icon: '🚫' });
      return;
    }
    if (seen.alreadySeen(event.messageId)) {
      metrics.inc('messages.duplicate');
      logger.debug('duplicate message skipped', { messageId: event.messageId, icon: '♻️' });
      return;
    }

    metrics.inc('messages.in');
    const incomingPreview =
      event.text && String(event.text).trim() ? preview(event.text, 900) : `[${event.kind}]`;
    logger.info(`💬 ${event.senderName || 'User'}: ${incomingPreview}`, {
      chatId: event.chatId,
      kind: event.kind,
      len: (event.text ?? '').length,
    });
    const stopTyping = config.typing ? transport.startTyping(event.chatId) : async () => {};

    try {
      // Keep the record in memory while the turn runs: eviction would silently lose it.
      store.pin?.(event.chatId);
      const record = await store.get(event.chatId, { chatType: event.chatType });

      // Durable dedupe: `seen` in RAM is lost on restart, the record is not.
      // (Two processes sharing a file can still race — run a single instance.)
      if (event.messageId) {
        const history = Array.isArray(record.seen) ? record.seen : [];
        if (history.includes(event.messageId)) {
          metrics.inc('messages.duplicate');
          logger.debug('duplicate message skipped (context)', { messageId: event.messageId, icon: '♻️' });
          return;
        }
        record.seen = [...history, event.messageId].slice(-200);
        store.touch(event.chatId);
      }

      if (rateLimited(event.chatId, event.senderId)) {
        metrics.inc('messages.rateLimited');
        logger.warn('sender rate limited, ignoring', {
          chatId: event.chatId,
          senderId: event.senderId,
          perMinute: config.userRateLimitPerMinute,
          icon: '🚦',
        });
        return;
      }

      if (event.kind === 'voice') {
        const sender = makeSender(event.chatId, stopTyping, { replyToMessageId: event.messageId });
        await sendText(sender, 'I cannot listen to voice messages yet — please send text instead.');
        return;
      }
      if (event.kind === 'sticker') {
        if (config.sticker.enabled && stickers) {
          // STICKER_ECHO=off means "do not react to incoming stickers" — not "send a random one".
          if (!config.sticker.echo) {
            await stopTyping();
            return;
          }
          const isId = /^[a-f0-9]{20}$/i.test(event.sticker ?? '');
          const stickerId = isId ? event.sticker : stickers.random()?.id;
          await stopTyping();
          if (stickerId) {
            try {
              await transport.sendSticker(event.chatId, stickerId);
              metrics.inc('sticker.reply');
            } catch (error) {
              logger.warn('sticker reply failed', { error: String(/** @type {any} */ (error)?.message ?? error) });
            }
          }
          return;
        }
        const sender = makeSender(event.chatId, stopTyping, { replyToMessageId: event.messageId });
        await sendText(sender, 'I cannot view stickers yet — please send text instead.');
        return;
      }

      const cleanedText = stripMention(
        event.text ?? '',
        [event.botName || transport.displayName].filter(Boolean),
      );
      const command = commands.parseCommand(cleanedText);
      const normalizedEvent = cleanedText === (event.text ?? '') ? event : { ...event, text: cleanedText };
      if (command) {
        const ctx = {
          chatId: event.chatId,
          chatType: event.chatType,
          senderId: event.senderId,
          senderName: event.senderName,
          platform: event.platform,
          isAdmin: event.isAdmin,
          record,
        };
        const result = await commands.run(command, ctx);
        metrics.inc(`commands.${command.name}`);

        if (result.kind === 'search') {
          await conversation(normalizedEvent, record, { forceSearch: result.query }, stopTyping);
          return;
        }
        if (result.kind === 'image') {
          // images do not go through makeSender → stop typing before sending
          await stopTyping();
          const imageResult = await tools.run(
            'send_image',
            { query: result.query },
            {
              chatId: event.chatId,
              senderId: event.senderId,
              platform: event.platform,
              deadline:
                config.responseTimeoutMs > 0
                  ? Date.now() + config.responseTimeoutMs
                  : Number.POSITIVE_INFINITY,
            },
          );
          if (!imageResult.ok) {
            const sender = makeSender(event.chatId, stopTyping, { replyToMessageId: event.messageId });
            await sendText(sender, imageResult.text);
          }
          return;
        }
        if (result.kind === 'sticker') {
          await stopTyping();
          try {
            await transport.sendSticker(event.chatId, result.stickerId);
            metrics.inc('sticker.command');
          } catch (error) {
            logger.warn('sticker command failed', { error: String(/** @type {any} */ (error)?.message ?? error) });
            const sender = makeSender(event.chatId, stopTyping, { replyToMessageId: event.messageId });
            await sendText(sender, 'Could not send the sticker, please try again.');
          }
          return;
        }
        if (result.kind === 'text' && result.text) {
          const sender = makeSender(event.chatId, stopTyping, { replyToMessageId: event.messageId });
          await sendText(sender, result.text);
          return;
        }
        return;
      }

      await conversation(normalizedEvent, record, {}, stopTyping);
    } catch (error) {
      metrics.inc('messages.error');
      const partial = /** @type {any} */ (error);
      logger.error('handle message failed', {
        chatId: event.chatId,
        messageId: event.messageId,
        error,
        status: partial?.status,
        body: typeof partial?.body === 'string' ? partial.body.slice(0, 300) : undefined,
      });

      let text = 'Sorry, something went wrong while handling this message. Please try again.';
      if (error instanceof CircuitOpenError) {
        text = 'I am a bit overloaded right now, please try again in a few seconds.';
      } else if (/** @type {any} */ (error)?.code === LLM_ERROR.AUTH) {
        text = 'The AI provider rejected the API key. Admin, please check the model API key.';
      } else if (error instanceof HttpError && error.status === 401) {
        text = 'Zalo rejected the bot token. Admin, please check ZALO_BOT_TOKEN.';
      }

      try {
        const sender = makeSender(event.chatId, stopTyping, { replyToMessageId: event.messageId });
        await sendText(sender, text);
      } catch (sendError) {
        logger.error('failed to send error message', { error: sendError });
      }
    } finally {
      store.unpin?.(event.chatId);
      try {
        await stopTyping();
      } catch {
        // ignore
      }
    }
  }

  const { enqueue, pending, drain } = createQueue({ config, logger, metrics, transport, handle });

  return { handle, enqueue, pending, drain, seenSize: () => seen.size() };
}

export const __test__ = { findBreak, planAttemptBudget };
