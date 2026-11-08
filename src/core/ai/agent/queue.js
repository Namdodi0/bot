import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_CONCURRENT_CHATS = 8;
const DEFAULT_MAX_CONCURRENT_PER_CHAT = 3;
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
 * Per-chat + per-sender rate limit for incoming messages. When `options.file` is set the
 * current window is persisted so a quick restart does not reset an active limit.
 * @param {any} config
 * @param {{file?: string}} [options]
 */
export function createRateLimiter(config, options = {}) {
  /** @type {Map<string, number[]>} */
  const userHits = new Map();
  const filePath = options.file ? path.resolve(String(options.file)) : '';
  /** @type {NodeJS.Timeout|null} */
  let saveTimer = null;
  /** @type {Promise<void>} */
  let writeChain = Promise.resolve();
  /** @type {Promise<void>|null} */
  let dirReady = null;

  /** @param {number[]} hits @param {number} [now] */
  function fresh(hits, now = Date.now()) {
    return hits.filter((ts) => Number.isFinite(ts) && now - ts < RATE_WINDOW_MS);
  }

  if (filePath) {
    try {
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const now = Date.now();
      for (const [key, hits] of Object.entries(saved?.hits ?? {})) {
        if (!Array.isArray(hits)) continue;
        const kept = fresh(/** @type {number[]} */ (hits), now);
        if (kept.length) userHits.set(key, kept);
      }
    } catch {
      // No saved window yet, or the file is unreadable: start clean.
    }
  }

  function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!filePath) return Promise.resolve();
    const now = Date.now();
    /** @type {Record<string, number[]>} */
    const hits = {};
    for (const [key, values] of userHits) {
      const kept = fresh(values, now);
      if (kept.length) hits[key] = kept;
    }
    const payload = JSON.stringify({ savedAt: now, hits });
    // Serialize writes without blocking the event loop on a busy chat.
    writeChain = writeChain.then(async () => {
      try {
        dirReady ??= fsp.mkdir(path.dirname(filePath), { recursive: true }).then(
          () => undefined,
          () => undefined,
        );
        await dirReady;
        await fsp.writeFile(filePath, payload);
      } catch {
        // Rate-limit persistence is best effort; never affect message handling.
      }
    });
    return writeChain;
  }

  function scheduleFlush() {
    if (!filePath || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flush();
    }, 2_000);
    saveTimer.unref?.();
  }

  /**
   * Limit how many messages one person sends per minute — blocks spam that burns API credit.
   * Scoped per chat so one busy group cannot lock a member out of another chat.
   * Ignore silently (no reply) so we do not encourage spam.
   * @param {string} chatId
   * @param {string} senderId
   * @param {string} [senderName]
   */
  function rateLimited(chatId, senderId, senderName) {
    const override =
      (senderId ? config.userRateLimits?.[senderId] : undefined) ??
      (senderName ? config.userRateLimits?.[senderName] : undefined);
    const limit = Number.isFinite(override) ? override : (config.userRateLimitPerMinute ?? 0);
    if (!limit || !senderId) return false;
    const key = `${chatId}:${senderId}`;
    const now = Date.now();
    const hits = fresh(userHits.get(key) ?? [], now);
    if (hits.length >= limit) {
      userHits.delete(key);
      userHits.set(key, hits);
      scheduleFlush();
      return true;
    }
    hits.push(now);
    userHits.delete(key);
    userHits.set(key, hits);
    if (userHits.size > 500) {
      const oldest = userHits.keys().next().value;
      if (oldest !== undefined) userHits.delete(oldest);
    }
    scheduleFlush();
    return false;
  }

  rateLimited.flush = flush;
  return rateLimited;
}

export const QUEUE_BUSY_TEXT =
  "Whoa — I'm juggling too many messages right now. Give me a few seconds and try again. 🤹";

export class QueueFullError extends Error {
  constructor() {
    super('queue is full');
    this.name = 'QueueFullError';
  }
}

/**
 * Message turns run in parallel per chat up to maxConcurrentPerChat; exclusive record
 * maintenance stays on the per-chat FIFO chain. All work is capped by the global limit.
 * @param {{config: any, logger: import('../../logger.js').Logger, metrics: any, transport: any, handle: (event: any) => Promise<void>}} deps
 */
export function createQueue({ config, logger, metrics, transport, handle }) {
  const maxConcurrentChats = Math.max(1, Number(config.maxConcurrentChats) || DEFAULT_MAX_CONCURRENT_CHATS);
  const maxConcurrentPerChat = Math.max(
    1,
    Number(config.maxConcurrentPerChat) || DEFAULT_MAX_CONCURRENT_PER_CHAT,
  );
  /** @type {Map<string, Promise<void>>} */
  const chatQueues = new Map();
  /** @type {Map<string, number>} */
  const chatActive = new Map();
  /** @type {Map<string, Array<() => void>>} */
  const chatWaiters = new Map();
  /** @type {Array<{resolve: () => void, timer: NodeJS.Timeout}>} */
  const drainWaiters = [];

  let active = 0;
  let queueDepth = 0;
  /** @type {Array<() => void>} */
  const waiters = [];

  async function acquire() {
    if (active < maxConcurrentChats) {
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

  /** @param {string} chatId */
  function waitForChatSlot(chatId) {
    return new Promise((resolve) => {
      const list = chatWaiters.get(chatId) ?? [];
      list.push(/** @type {any} */ (resolve));
      chatWaiters.set(chatId, list);
    });
  }

  /** @param {string} chatId */
  async function acquireChatSlot(chatId) {
    while ((chatActive.get(chatId) ?? 0) >= maxConcurrentPerChat) {
      await waitForChatSlot(chatId);
    }
    chatActive.set(chatId, (chatActive.get(chatId) ?? 0) + 1);
  }

  /** @param {string} chatId */
  function releaseChatSlot(chatId) {
    const left = Math.max(0, (chatActive.get(chatId) ?? 1) - 1);
    if (left) chatActive.set(chatId, left);
    else chatActive.delete(chatId);
    const waitersForChat = chatWaiters.get(chatId);
    const wake = waitersForChat?.shift();
    if (wake) {
      if (!waitersForChat?.length) chatWaiters.delete(chatId);
      wake();
    }
  }

  /**
   * Run a turn without the per-chat FIFO chain, but under a per-chat concurrency slot.
   * Record isolation is handled by the turn snapshot/merge in the agent.
   * @param {string} chatId
   * @param {() => Promise<any>} task
   */
  function parallel(chatId, task) {
    if (isFull()) return Promise.reject(new QueueFullError());
    queueDepth += 1;
    return (async () => {
      await acquireChatSlot(chatId);
      try {
        await acquire();
        try {
          return await task();
        } finally {
          release();
        }
      } finally {
        releaseChatSlot(chatId);
        queueDepth = Math.max(0, queueDepth - 1);
        notifyDrainWaiters();
      }
    })();
  }

  /** @param {string} chatId @param {() => Promise<any>} task */
  function chain(chatId, task) {
    const previous = chatQueues.get(chatId) ?? Promise.resolve();
    const run = previous.then(task);
    const guarded = run.catch(() => {});
    chatQueues.set(chatId, guarded);
    guarded.then(() => {
      if (chatQueues.get(chatId) === guarded) chatQueues.delete(chatId);
    });
    return run;
  }

  /**
   * Run a task in the chat's FIFO chain and under the global concurrency limit.
   * @param {string} chatId
   * @param {() => Promise<any>} task
   */
  function schedule(chatId, task) {
    // Admission is part of the queue's contract: callers cannot bypass maxQueueDepth.
    if (isFull()) return Promise.reject(new QueueFullError());
    queueDepth += 1;
    let acquired = false;
    return chain(chatId, async () => {
      await acquire();
      acquired = true;
      try {
        return await task();
      } finally {
        queueDepth = Math.max(0, queueDepth - 1);
        if (acquired) release();
        notifyDrainWaiters();
      }
    });
  }

  function isFull() {
    return queueDepth >= config.maxQueueDepth;
  }

  /**
   * @param {import('../../../platforms/contract.js').BotEvent} event
   */
  function enqueue(event) {
    const chatId = event?.chatId ?? 'unknown';

    if (isFull()) {
      metrics.inc('queue.dropped');
      logger.warn('queue is full, skipping message', {
        chatId,
        queueDepth,
        max: config.maxQueueDepth,
        icon: '🧯',
      });
      // notify the user briefly without putting it in the queue; platforms filter unwanted chats
      transport
        .sendMessage(chatId, QUEUE_BUSY_TEXT)
        .catch((error) => logger.debug('busy notice failed', { error: String(error?.message ?? error) }));
      return Promise.resolve();
    }

    return parallel(chatId, () => handle(event)).catch((error) =>
      logger.error('queued handler crashed', { error }),
    );
  }

  /**
   * Serialize arbitrary record-mutating work (slash turns, reset/compact) with turns.
   * @param {string} chatId
   * @param {() => Promise<any>} task
   */
  function exclusive(chatId, task) {
    return schedule(chatId, task);
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

  return { enqueue, exclusive, parallel, isFull, pending, drain };
}
