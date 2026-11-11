import crypto from 'node:crypto';
import { createTokenMeter } from '../context/token-meter.js';
import { CircuitOpenError, HttpError } from '../http.js';
import { QUEUE_BUSY_TEXT, QueueFullError, createQueue, createRateLimiter, createSeenTracker } from './agent/queue.js';
import { createCollectorSink, createSenderFactory } from './agent/sending.js';
import { FALLBACK_MIN_MS, preview, sleep } from './agent/helpers.js';
import { createTurnRunner } from './agent/turn.js';
import { LLM_ERROR, isRetryableLlmError } from './llm/errors.js';
import { createRetryExecutor } from './llm/retry.js';

/**
 * @param {{config: any, logger: import('../logger.js').Logger, metrics: any, platform: import('../../platforms/contract.js').Platform, llm: ReturnType<typeof import('./router.js').createModelRouter>, store: ReturnType<typeof import('../context/store.js').createContextStore>, tools: ReturnType<typeof import('./tools.js').createToolRuntime>, http?: ReturnType<typeof import('../http.js').createHttp>, compaction: ReturnType<typeof import('../context/compaction/engine.js').createCompactionEngine>, rateLimitFile?: string}} deps
 */
export function createAgent(deps) {
  const { config, logger, metrics, platform, llm, store, tools, compaction } = deps;
  const transport = platform.transport;
  const meter = createTokenMeter();
  const retryExecutor = createRetryExecutor({
    shouldRetry: isRetryableLlmError,
    sleep,
    reserveMs: FALLBACK_MIN_MS,
  });
  const seen = createSeenTracker();
  const rateLimited = createRateLimiter(config, { file: deps.rateLimitFile });
  /** @type {Map<string, Set<AbortController>>} */
  const activeTurns = new Map();

  /**
   * Merge the entries a forked turn created back into the live record. Entries are tagged
   * with `turnId`, so parallel turns cannot interleave tool blocks or private entries.
   * @param {any} live
   * @param {any} fork
   * @param {string} turnId
   * @param {string} chatId
   */
  function mergeTurn(live, fork, turnId, chatId) {
    if (!live || !fork) return;
    const tagged = (fork.messages ?? []).filter((message) => message.turnId === turnId);
    if (!tagged.length) return;
    for (const entry of tagged) {
      if (entry.private) continue;
      const { turnId: _turnId, ...rest } = entry;
      live.messages.push(rest);
    }
    live.turns = (live.turns ?? 0) + 1;
    store.touch(chatId);
  }
  const { makeSender, sendText } = createSenderFactory({ config, logger, metrics, platform });

  const conversation = createTurnRunner({
    config,
    logger,
    metrics,
    platform,
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
   * @param {import('../../platforms/contract.js').BotEvent} event
   * @param {{collector?: ReturnType<typeof import('./agent/sending.js').createCollectorSink>}} [options]
   */
  async function handle(event, options = {}) {
    if (!event) return;
    if (event.isBot) return;
    if (event.kind === 'unsupported' || event.kind === 'unknown') return;
    if (seen.alreadySeen(event.messageId)) {
      metrics.inc('messages.duplicate');
      logger.debug('duplicate message skipped', { messageId: event.messageId, icon: '♻️' });
      return;
    }

    metrics.inc('messages.in');
    const incomingPreview =
      event.text && String(event.text).trim() ? preview(event.text, 300) : `[${event.kind}]`;
    logger.info(`💬 ${event.senderName || 'User'}: ${incomingPreview}`, {
      chatId: event.chatId,
      kind: event.kind,
      len: (event.text ?? '').length,
    });
    const collector = options.collector ?? null;
    const stopTyping = collector || !config.typing ? async () => {} : transport.startTyping(event.chatId);
    /** @type {any} */
    let activeRecord = null;

    /** @param {string} text */
    async function reply(text) {
      if (collector) {
        await collector.enqueue(text);
        return;
      }
      const sender = makeSender(event.chatId, stopTyping, { replyToMessageId: event.messageId });
      await sendText(sender, text);
    }

    const controller = new AbortController();
    const controllers = activeTurns.get(event.chatId) ?? new Set();
    controllers.add(controller);
    activeTurns.set(event.chatId, controllers);
    if (collector) /** @type {any} */ (collector).signal = controller.signal;

    try {
      // Keep the record in memory while the turn runs: eviction would silently lose it.
      store.pin?.(event.chatId);
      const record = await store.get(event.chatId, { chatType: event.chatType });
      activeRecord = record;

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

      if (rateLimited(event.chatId, event.senderId, event.senderName)) {
        metrics.inc('messages.rateLimited');
        logger.warn('sender rate limited, ignoring', {
          chatId: event.chatId,
          senderId: event.senderId,
          perMinute: config.userRateLimitPerMinute,
          icon: '🚦',
        });
        if (collector) {
          await collector.enqueue(
            'You are sending messages too quickly — please wait a minute and try again.',
          );
        }
        return;
      }

      if (event.kind === 'voice') {
        await reply('I cannot listen to voice messages yet — please send text instead.');
        return;
      }
      if (event.kind === 'sticker') {
        await reply('I cannot view stickers yet — please send text instead.');
        return;
      }

      /** @param {Record<string, any>} turnOptions */
      async function runAsTurn(turnOptions) {
        const turnId = crypto.randomUUID();
        // A lone turn keeps the live record (so compaction persists); only when another
        // turn is already active in this chat does it work on an isolated snapshot.
        const forked = controllers.size > 1;
        const fork = forked ? structuredClone(record) : record;
        try {
          await conversation(
            event,
            fork,
            { ...turnOptions, signal: controller.signal, turnId, forked },
            stopTyping,
            collector,
          );
        } finally {
          if (fork !== record) mergeTurn(record, fork, turnId, event.chatId);
        }
      }
      await runAsTurn({});
    } catch (error) {
      if (controller.signal.aborted) {
        logger.info('turn stopped by user', { chatId: event.chatId, icon: '⏹️' });
        return;
      }
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
      const platformHint = platform.explainError?.(error) ?? null;
      if (error instanceof CircuitOpenError) {
        text = 'I am a bit overloaded right now, please try again in a few seconds.';
      } else if (/** @type {any} */ (error)?.code === LLM_ERROR.AUTH) {
        text = 'The AI provider rejected the API key. Admin, please check the model API key.';
      } else if (platformHint) {
        text = platformHint;
      } else if (error instanceof HttpError && error.status === 401) {
        text = 'The bot token was rejected. Admin, please check the platform token.';
      }

      try {
        await reply(text);
      } catch (sendError) {
        logger.error('failed to send error message', { error: sendError });
      }
    } finally {
      const activeForChat = activeTurns.get(event.chatId);
      activeForChat?.delete(controller);
      if (!activeForChat?.size) activeTurns.delete(event.chatId);
      if (event.private && activeRecord?.messages) {
        const before = activeRecord.messages.length;
        activeRecord.messages = activeRecord.messages.filter((message) => !message.private);
        if (activeRecord.messages.length !== before) store.touch(event.chatId);
      }
      store.unpin?.(event.chatId);
      try {
        await stopTyping();
      } catch {
        // ignore
      }
    }
  }

  const {
    enqueue: enqueueQueued,
    exclusive: exclusiveQueued,
    parallel: parallelQueued,
    isFull,
    pending,
    drain,
  } = createQueue({
    config,
    logger,
    metrics,
    transport,
    handle,
  });

  /** Shutdown stops admission first, then drains what is already queued. */
  let accepting = true;
  function stopAccepting() {
    accepting = false;
  }
  function enqueue(event) {
    if (!accepting) return Promise.resolve();
    return enqueueQueued(event);
  }
  function exclusive(chatId, task) {
    if (!accepting) return Promise.reject(new QueueFullError());
    return exclusiveQueued(chatId, task);
  }
  function parallel(chatId, task) {
    if (!accepting) return Promise.reject(new QueueFullError());
    return parallelQueued(chatId, task);
  }

  /**
   * @param {import('../../platforms/contract.js').BotEvent} event
   * @param {{scheduled?: boolean}} options
   * @param {ReturnType<typeof import('./agent/sending.js').createCollectorSink>} collector
   */
  function runCollected(event, options, collector) {
    const chatId = String(event?.chatId ?? '');
    const run = async () => {
      await handle(event, { collector });
      return collector.result();
    };
    // Native callers that already hold the chat slot must not schedule it again.
    if (options.scheduled === true) return run();
    if (!accepting || isFull()) {
      metrics.inc('queue.dropped');
      logger.warn('queue is full, skipping slash turn', { chatId, icon: '🧯' });
      return Promise.resolve({ text: QUEUE_BUSY_TEXT, photos: [] });
    }
    return parallel(chatId, run);
  }

  /**
   * Run one turn and collect its output instead of sending it (native slash commands).
   * Turns are serialized per chat so they cannot interleave writes to the same record.
   * @param {import('../../platforms/contract.js').BotEvent} event
   * @param {{scheduled?: boolean}} [options] `scheduled` = caller already holds the chat slot
   * @returns {Promise<{text: string, photos: any[]}>}
   */
  function collect(event, options = {}) {
    return runCollected(event, options, createCollectorSink());
  }

  /**
   * Same as `collect`, but streams content deltas to `onDelta` for live message edits.
   * @param {import('../../platforms/contract.js').BotEvent} event
   * @param {{onDelta?: (delta: string) => void, onProgress?: (event: any) => void, scheduled?: boolean}} [options]
   * @returns {Promise<{text: string, photos: any[]}>}
   */
  function stream(event, options = {}) {
    return runCollected(
      event,
      options,
      createCollectorSink({ live: true, onDelta: options.onDelta, onProgress: options.onProgress }),
    );
  }

  /** @param {string} chatId */
  function stop(chatId) {
    const controllers = activeTurns.get(String(chatId));
    if (!controllers?.size) return false;
    for (const controller of controllers) controller.abort();
    return true;
  }

  return {
    handle,
    stop,
    collect,
    stream,
    enqueue,
    exclusive,
    parallel,
    isFull,
    rateLimited,
    flushRateLimits: () => rateLimited.flush?.(),
    pending,
    drain,
    stopAccepting,
    seenSize: () => seen.size(),
  };
}

