/**
 * Search provider failover: Firecrawl is primary, Tavily covers quota/outage failures.
 * Both clients expose `search(query, opts)` with the same normalized result shape.
 * @param {{primary: any, fallback: any, logger?: import('../logger.js').Logger, metrics?: any}} options
 */
export function createSearchRouter({ primary, fallback, logger, metrics }) {
  /** @param {Record<string, any>} opts */
  function withRemainingBudget(opts) {
    const deadline = Number(opts.deadline);
    if (!Number.isFinite(deadline)) return opts;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const error = new Error('search deadline expired');
      /** @type {any} */ (error).status = 408;
      throw error;
    }
    return { ...opts, timeoutMs: Math.max(1, Math.min(Number(opts.timeoutMs) || remaining, remaining)) };
  }

  /** @param {any} provider @param {string} query @param {Record<string, any>} opts */
  function askProvider(provider, query, opts) {
    const capabilities = provider.capabilities ?? {};
    const unsupported = ['searchDepth', 'country'].filter(
      (key) => opts[key] !== undefined && capabilities[key] === false,
    );
    if (unsupported.length) {
      logger?.debug('search provider ignores unsupported options', {
        provider: provider.id ?? 'unknown',
        options: unsupported,
      });
    }
    return provider.search(query, opts);
  }

  /** @param {string} query @param {Record<string, any>} [opts] */
  async function search(query, opts = {}) {
    if (primary) {
      try {
        return await askProvider(primary, query, withRemainingBudget(opts));
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
    // Failover gets only what remains of the caller's deadline, never a fresh full timeout.
    return askProvider(fallback, query, withRemainingBudget(opts));
  }

  return { search };
}
