import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { freshRecord, normalizeRecord } from './record.js';

/**
 * @typedef {object} StoredMessage
 * @property {'user'|'assistant'|'tool'} role
 * @property {string} [kind] turn | context | summary | tool-call | tool-result
 * @property {string} text
 * @property {string} [name]
 * @property {string} [source]
 * @property {number} ts
 * @property {string} [messageId]
 * @property {string} [toolCallId]
 * @property {boolean} [private]
 * @property {Array<{id: string, name: string, arguments: any, rawArguments?: string}>} [toolCalls]
 */

/**
 * @typedef {object} ChatRecord
 * @property {number} schemaVersion
 * @property {string} chatId
 * @property {string} chatType
 * @property {StoredMessage[]} messages
 * @property {number} turns
 * @property {number} updatedAt
 * @property {{thinking?: string|null, tone?: string|null, model?: string|null, split?: string|null}} meta
 * @property {string[]} [seen] recent message_ids — prevents duplicate processing after restart
 */

/**
 * Persist context per chat as JSON, written atomically + debounced.
 * @param {{dir: string, logger?: import('../logger.js').Logger, ttlHours?: number, maxChats?: number, debounceMs?: number, now?: () => number}} options
 */
export function createContextStore(options) {
  const dir = options.dir;
  const logger = options.logger;
  const ttlMs = (options.ttlHours ?? 72) * 3_600_000;
  const maxChats = options.maxChats ?? 50;
  const debounceMs = options.debounceMs ?? 500;
  const now = options.now ?? (() => Date.now());

  /** @type {Map<string, ChatRecord>} */
  const memory = new Map();
  /** @type {Map<string, NodeJS.Timeout>} */
  const timers = new Map();
  /** @type {Set<string>} */
  const dirty = new Set();
  /** @type {Map<string, number>} */
  const pinned = new Map();

  /** @param {string} chatId */
  function fileFor(chatId) {
    const hash = crypto.createHash('sha1').update(chatId).digest('hex').slice(0, 24);
    return path.join(dir, `${hash}.json`);
  }

  async function init() {
    await fsp.mkdir(dir, { recursive: true });
    await prune();
  }

  /** @param {unknown} value @returns {value is ChatRecord} */
  function isRecord(value) {
    return Boolean(
      value &&
        typeof value === 'object' &&
        typeof (/** @type {any} */ (value).chatId) === 'string' &&
        Array.isArray(/** @type {any} */ (value).messages),
    );
  }

  /** @type {Map<string, number>} */
  const epochs = new Map();
  /** @type {Map<string, Promise<ChatRecord>>} */
  const loads = new Map();
  /** @type {Map<string, Promise<void>>} */
  const writeChains = new Map();
  /** Writes that have started but not settled yet; flush must await them. */
  const pendingWrites = new Set();
  /** @type {Map<string, number>} */
  const versions = new Map();

  let writeSeq = 0;

  /** @param {string} chatId */
  async function readRecord(chatId) {
    try {
      const raw = await fsp.readFile(fileFor(chatId), 'utf8');
      const parsed = JSON.parse(raw);
      if (isRecord(parsed)) {
        const record = normalizeRecord(parsed);
        // Old builds may have persisted private entries; never reload them into shared context.
        record.messages = record.messages.filter((message) => !message.private);
        return record;
      }
    } catch (error) {
      const code = /** @type {any} */ (error)?.code;
      if (code !== 'ENOENT') logger?.warn('read context failed, starting fresh', { chatId, error });
    }
    return null;
  }

  /** @param {ChatRecord} record */
  function persist(record) {
    const chatId = record.chatId;
    // Private turns are needed only while the current turn runs; never let a debounced
    // save or shutdown flush write them to shared disk context.
    const payload = JSON.stringify({
      ...record,
      messages: (record.messages ?? []).filter((message) => !message.private),
    });
    // A reset between "write temp" and "rename" must not resurrect the old file.
    const epoch = epochs.get(chatId) ?? 0;
    const previous = writeChains.get(chatId) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(() => writePayload(chatId, payload, epoch));
    const guarded = task.catch(() => {});
    writeChains.set(chatId, guarded);
    pendingWrites.add(task);
    const settle = () => {
      pendingWrites.delete(task);
      if (writeChains.get(chatId) === guarded) writeChains.delete(chatId);
    };
    task.then(settle, settle);
    return task;
  }

  /**
   * @param {string} chatId
   * @param {string} payload
   * @param {number} epoch
   */
  async function writePayload(chatId, payload, epoch) {
    const file = fileFor(chatId);
    // Unique tmp name: debounce and flush() can queue the same chat concurrently.
    writeSeq += 1;
    const tmp = `${file}.${process.pid}.${writeSeq}.tmp`;
    await fsp.writeFile(tmp, payload, 'utf8');
    if ((epochs.get(chatId) ?? 0) !== epoch) {
      try {
        await fsp.unlink(tmp);
      } catch {
        // ignore
      }
      return;
    }
    await fsp.rename(tmp, file);
  }

  /** @param {string} chatId */
  function scheduleSave(chatId) {
    dirty.add(chatId);
    const existing = timers.get(chatId);
    if (existing) return;
    const timer = setTimeout(() => {
      timers.delete(chatId);
      const record = memory.get(chatId);
      if (!record || !dirty.has(chatId)) return;
      dirty.delete(chatId);
      persist(record).catch((error) => logger?.warn('save context failed', { chatId, error }));
    }, debounceMs);
    timer.unref?.();
    timers.set(chatId, timer);
  }

  /**
   * @param {string} chatId
   * @param {{chatType?: string}} [meta]
   * @returns {Promise<ChatRecord>}
   */
  async function get(chatId, meta = {}) {
    const cached = memory.get(chatId);
    if (cached) {
      memory.delete(chatId);
      memory.set(chatId, cached);
      if (meta.chatType) cached.chatType = meta.chatType;
      return cached;
    }

    // Concurrent callers must share one record instance; otherwise the later memory.set
    // orphans the first caller's writes (a whole turn can vanish).
    const inflight = loads.get(chatId);
    if (inflight) {
      const shared = await inflight;
      if (meta.chatType) shared.chatType = meta.chatType;
      return shared;
    }

    const task = (async () => {
      const loaded = await readRecord(chatId);
      const record = normalizeRecord(loaded ?? freshRecord(chatId, meta.chatType ?? 'UNKNOWN', now()));
      if (meta.chatType) record.chatType = meta.chatType;
      memory.set(chatId, record);
      evictIfNeeded();
      return record;
    })();
    loads.set(chatId, task);
    try {
      return await task;
    } finally {
      if (loads.get(chatId) === task) loads.delete(chatId);
    }
  }

  function evictIfNeeded() {
    while (memory.size > maxChats) {
      // A chat with a turn in flight (pinned) or the record just loaded/refreshed must
      // never be dropped from memory: the turn would keep writing to an orphaned record.
      const keys = [...memory.keys()];
      const active = keys.at(-1);
      const victim = keys.find((key) => key !== active && !pinned.has(key));
      // Everything left is pinned: keep memory above maxChats rather than lose a turn.
      if (victim === undefined) return;
      const record = memory.get(victim);
      memory.delete(victim);
      versions.delete(victim);
      if (record && dirty.has(victim)) {
        dirty.delete(victim);
        persist(record).catch((error) => logger?.warn('evict save context failed', { error }));
      }
    }
  }

  /** @param {string} chatId */
  function pin(chatId) {
    pinned.set(chatId, (pinned.get(chatId) ?? 0) + 1);
  }

  /** @param {string} chatId */
  function unpin(chatId) {
    const count = (pinned.get(chatId) ?? 0) - 1;
    if (count > 0) pinned.set(chatId, count);
    else pinned.delete(chatId);
  }

  /** @param {string} chatId */
  function touch(chatId) {
    const record = memory.get(chatId);
    if (!record) return;
    record.updatedAt = now();
    versions.set(chatId, (versions.get(chatId) ?? 0) + 1);
    scheduleSave(chatId);
  }

  /**
   * Delete the context of a chat.
   * @param {string} chatId
   * @param {{keepMeta?: boolean}} [options] `keepMeta: true` → only clear messages/summary/turns,
   *   keep `meta` (tone/model/thinking). By default the whole file is removed as before.
   */
  async function reset(chatId, options = {}) {
    const inflight = loads.get(chatId);
    if (inflight) {
      try {
        await inflight;
      } catch {
        // start the reset regardless of a failed load
      }
    }
    // keepMeta on a cold chat must still preserve the settings stored on disk.
    const loaded = options.keepMeta && !memory.has(chatId) ? await readRecord(chatId) : null;
    epochs.set(chatId, (epochs.get(chatId) ?? 0) + 1);
    const timer = timers.get(chatId);
    if (timer) {
      clearTimeout(timer);
      timers.delete(chatId);
    }
    dirty.delete(chatId);
    versions.delete(chatId);
    const removed = memory.get(chatId) ?? loaded;

    if (options.keepMeta && removed) {
      removed.messages = [];
      removed.turns = 0;
      removed.schemaVersion = 2;
      removed.updatedAt = now();
      memory.set(chatId, removed);
      await persist(removed);
      return removed;
    }

    memory.delete(chatId);
    try {
      await fsp.unlink(fileFor(chatId));
    } catch (error) {
      const code = /** @type {any} */ (error)?.code;
      if (code !== 'ENOENT') logger?.warn('delete context file failed', { chatId, error });
    }
    return removed;
  }

  async function flush() {
    /** @type {Set<string>} */
    const failed = new Set();
    // Two passes are enough to catch a touch that landed while the first save was running.
    for (let pass = 0; pass < 2; pass += 1) {
      const pending = [...dirty].filter((chatId) => !failed.has(chatId));
      if (!pending.length) break;
      for (const chatId of pending) {
        const timer = timers.get(chatId);
        if (timer) {
          clearTimeout(timer);
          timers.delete(chatId);
        }
        const record = memory.get(chatId);
        if (!record) {
          dirty.delete(chatId);
          continue;
        }
        const version = versions.get(chatId) ?? 0;
        try {
          await persist(record);
          // A touch during the write keeps the record dirty so the newer state is saved too.
          if ((versions.get(chatId) ?? 0) === version) dirty.delete(chatId);
        } catch (error) {
          // keep it dirty and retry later so no data is lost
          failed.add(chatId);
          logger?.warn('flush context failed', { chatId, error });
          scheduleSave(chatId);
        }
      }
    }
    // Writes started by debounced timers/eviction may still be running even when no chat is
    // dirty anymore. A flush barrier must wait for those files to be renamed into place.
    while (pendingWrites.size) {
      await Promise.allSettled([...pendingWrites]);
    }
  }

  async function prune() {
    // ttlHours = 0 → never delete context automatically
    if (ttlMs <= 0) return 0;
    let entries;
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return 0;
    }
    const files = [];
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const full = path.join(dir, name);
      try {
        const stat = await fsp.stat(full);
        files.push({ full, mtimeMs: stat.mtimeMs });
      } catch {
        // ignore
      }
    }
    let removed = 0;
    const cutoff = now() - ttlMs;
    // A turn in flight is pinned: neither its file nor its in-memory record may be evicted.
    const pinnedFiles = new Set([...pinned.keys()].map((chatId) => fileFor(chatId)));
    for (const file of files) {
      if (file.mtimeMs < cutoff && !pinnedFiles.has(file.full)) {
        try {
          await fsp.unlink(file.full);
          removed += 1;
        } catch {
          // ignore
        }
      }
    }
    // If the file was deleted but the in-memory copy is still there, TTL is
    // ineffective for open chats: drop the old record too (the chat reloads from disk fresh next time).
    for (const [chatId, record] of [...memory]) {
      // Keep records with a weird/missing updatedAt (corrupt old file); do not assume they expired.
      if (dirty.has(chatId) || pinned.has(chatId) || !Number.isFinite(record.updatedAt) || record.updatedAt >= cutoff) continue;
      const timer = timers.get(chatId);
      if (timer) {
        clearTimeout(timer);
        timers.delete(chatId);
      }
      memory.delete(chatId);
      versions.delete(chatId);
    }
    return removed;
  }

  /** @param {string} chatId */
  function has(chatId) {
    return memory.has(chatId);
  }

  /**
   * Whether a chat already has stored context, without loading it into memory.
   * Used by edit/delete sync so unrelated channels never get an empty record.
   * @param {string} chatId
   */
  async function exists(chatId) {
    if (memory.has(chatId)) return true;
    try {
      await fsp.access(fileFor(chatId));
      return true;
    } catch {
      return false;
    }
  }

  function loadedChats() {
    return memory.size;
  }

  /** Number of context files currently on disk (only .json files). */
  async function count() {
    let entries;
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return 0;
    }
    return entries.filter((name) => name.endsWith('.json')).length;
  }

  return { init, get, reset, touch, flush, prune, has, exists, loadedChats, count, scheduleSave, fileFor, pin, unpin };
}
