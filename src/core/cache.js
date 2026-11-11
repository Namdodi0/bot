/**
 * Small in-memory TTL cache shared by the search clients and the page reader.
 * Eviction is FIFO by default; `lru: true` refreshes recency on read so a repeatedly
 * used entry survives eviction.
 * @param {{ttlMs?: number, size?: number, now?: () => number, lru?: boolean}} [options]
 */
export function createTtlCache(options = {}) {
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const size = options.size ?? 100;
  const now = options.now ?? (() => Date.now());
  const lru = options.lru === true;
  /** @type {Map<string, {expires: number, data: any}>} */
  const entries = new Map();

  /** @param {string} key */
  function get(key) {
    const hit = entries.get(key);
    if (!hit) return null;
    if (hit.expires <= now()) {
      entries.delete(key);
      return null;
    }
    if (lru) {
      entries.delete(key);
      entries.set(key, hit);
    }
    return hit.data;
  }

  /** @param {string} key @param {any} data */
  function set(key, data) {
    entries.set(key, { expires: now() + ttlMs, data });
    while (entries.size > size) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  return { get, set, size: () => entries.size };
}