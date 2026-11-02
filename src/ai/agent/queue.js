const MAX_CONCURRENT_CHATS = 4;
const RATE_WINDOW_MS = 60_000;

/**
 * In-memory message dedupe, capped at 2000 ids.
 */
export function createSeenTracker() {
  /** @type {Map<string, number>} */
  const seen = new Map();

  /** @param {string} messageId */
  function alreadySeen(messageId) {
    if (!messageId) return false;
    if (seen.has(messageId)) {
      // Refresh insertion order so the map behaves as an LRU, not a FIFO.
      const ts = seen.get(messageId);
      seen.delete(messageId);
      seen.set(messageId, ts);
      return true;
    }
    seen.set(messageId, Date.now());
    if (seen.size > 2000) {
      const oldest = seen.keys().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return false;
  }

  return { alreadySeen, size: () => seen.size };
}

/**
 * Per-chat + per-sender rate limit for incoming messages.
 * @param {any} config
 */
export function createRateLimiter(config) {
  /** @type {Map<string, number[]>} */
  const userHits = new Map();

  /**
   * Limit how many messages one person sends per minute — blocks spam that burns API credit.
   * Scoped per chat so one busy group cannot lock a member out of another chat.
   * Ignore silently (no reply) so we do not encourage spam.
   * @param {string} chatId
   * @param {string} senderId
   */
  function rateLimited(chatId, senderId) {
    const limit = config.userRateLimitPerMinute ?? 0;
    if (!limit || !senderId) return false;
    const key = `${chatId}:${senderId}`;
    const now = Date.now();
    const hits = (userHits.get(key) ?? []).filter((ts) => now - ts < RATE_WINDOW_MS);
    if (hits.length >= limit) {
      userHits.delete(key);
      userHits.set(key, hits);
      return true;
    }
    hits.push(now);
    userHits.delete(key);
    userHits.set(key, hits);
    if (userHits.size > 500) {
      const oldest = userHits.keys().next().value;
      if (oldest !== undefined) userHits.delete(oldest);
    }
    return false;
  }

  return rateLimited;
}

/**
 * Queue per chat (preserving order) + a global concurrency limit.
 * @param {{config: any, logger: import('../../logger.js').Logger, metrics: any, transport: any, handle: (event: any) => Promise<void>}} deps
 */
export function createQueue({ config, logger, metrics, transport, handle }) {
  /** @type {Map<string, Promise<void>>} */
  const chatQueues = new Map();
  /** @type {Array<{resolve: () => void, timer: NodeJS.Timeout}>} */
  const drainWaiters = [];

  let active = 0;
  let queueDepth = 0;
  /** @type {Array<() => void>} */
  const waiters = [];

  async function acquire() {
    if (active < MAX_CONCURRENT_CHATS) {
      active += 1;
      return;
    }
    await new Promise((resolve) => waiters.push(/** @type {any} */ (resolve)));
    active += 1;
  }

  function release() {
    active = Math.max(0, active - 1);
    const next = waiters.shift();
    if (next) next();
  }

  /**
   * @param {import('../../zalo/events.js').BotEvent} event
   */
  function enqueue(event) {
    const chatId = event?.chatId ?? 'unknown';

    if (queueDepth >= config.maxQueueDepth) {
      metrics.inc('queue.dropped');
      logger.warn('queue is full, skipping message', {
        chatId,
        queueDepth,
        max: config.maxQueueDepth,
        icon: '🧯',
      });
      // notify the user briefly without putting it in the queue
      const chatAllowed = !config.allowedChatIds.length || config.allowedChatIds.includes(chatId);
      if (chatAllowed) {
        transport
          .sendMessage(chatId, 'I am handling too many messages right now, please try again in a few seconds.')
          .catch((error) => logger.debug('busy notice failed', { error: String(error?.message ?? error) }));
      }
      return Promise.resolve();
    }

    queueDepth += 1;
    let acquired = false;
    const previous = chatQueues.get(chatId) ?? Promise.resolve();
    const task = previous
      .then(() => acquire())
      .then(() => {
        acquired = true;
        return handle(event);
      })
      .catch((error) => logger.error('queued handler crashed', { error }))
      .finally(() => {
        queueDepth = Math.max(0, queueDepth - 1);
        if (acquired) release();
        notifyDrainWaiters();
      });

    chatQueues.set(chatId, task);
    task.finally(() => {
      if (chatQueues.get(chatId) === task) chatQueues.delete(chatId);
    });
    return task;
  }

  function pending() {
    return queueDepth;
  }

  function notifyDrainWaiters() {
    if (queueDepth > 0) return;
    for (const waiter of drainWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  /**
   * Wait for in-flight messages to finish (used on shutdown).
   * @param {number} [timeoutMs]
   * @returns {Promise<number>} messages left when time runs out (0 = clean)
   */
  async function drain(timeoutMs = 10_000) {
    if (queueDepth === 0) return 0;
    /** @type {Promise<void>} */
    const drained = new Promise((resolve) => {
      /** @type {() => void} */
      const done = () => resolve();
      /** @type {{resolve: () => void, timer: NodeJS.Timeout}} */
      const waiter = {
        resolve: done,
        timer: setTimeout(() => {
          const index = drainWaiters.indexOf(waiter);
          if (index >= 0) drainWaiters.splice(index, 1);
          done();
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      drainWaiters.push(waiter);
    });
    await drained;
    return queueDepth;
  }

  return { enqueue, pending, drain };
}
