/**
 * Search provider failover: Firecrawl is primary, Tavily covers quota/outage failures.
 * Both clients expose `search(query, opts)` with the same normalized result shape.
 * @param {{primary: any, fallback: any, logger?: import('../logger.js').Logger, metrics?: any}} options
 */
export function createSearchRouter({ primary, fallback, logger, metrics }) {
  /** @param {string} query @param {Record<string, any>} [opts] */
  async function search(query, opts = {}) {
    if (primary) {
      try {
        return await primary.search(query, opts);
      } catch (error) {
        const status = Number(/** @type {any} */ (error)?.status);
        logger?.warn('primary search failed, falling back', {
          provider: 'firecrawl',
          status,
          error: String(/** @type {any} */ (error)?.message ?? error),
          icon: '🛟',
        });
        metrics?.inc('search.fallback');
        if (!fallback) throw error;
      }
    }
    if (!fallback) throw new Error('no search provider configured');
    return fallback.search(query, opts);
  }

  return { search };
}
