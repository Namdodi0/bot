import { createTtlCache } from '../cache.js';

/**
 * Firecrawl v2 search client. Same normalized shape as the Tavily client so the tool
 * runtime can swap providers without branching.
 * @param {{apiKey: string, baseUrl?: string, http: ReturnType<typeof import('../http.js').createHttp>, logger?: import('../logger.js').Logger, metrics?: any, cacheTtlMs?: number, cacheSize?: number, now?: () => number}} options
 */
export function createFirecrawlClient(options) {
  const apiKey = options.apiKey;
  const baseUrl = (options.baseUrl ?? 'https://api.firecrawl.dev').replace(/\/+$/, '');
  const http = options.http;
  const logger = options.logger;
  const metrics = options.metrics;
  const cache = createTtlCache({
    ttlMs: options.cacheTtlMs,
    size: options.cacheSize,
    now: options.now,
  });

  /**
   * @param {string} query
   * @param {{maxResults?: number, includeImages?: boolean, timeoutMs?: number}} [opts]
   */
  async function search(query, opts = {}) {
    const clean = String(query ?? '').trim().slice(0, 300);
    if (!clean) throw new Error('empty query');
    const body = {
      query: clean,
      limit: Math.min(10, Math.max(1, Number(opts.maxResults) || 4)),
      sources: ['web', ...(opts.includeImages ? ['images'] : [])],
      // SafeSearch is opt-in; keep it explicit so a provider default change cannot filter results.
      safe: false,
    };
    const key = JSON.stringify(body);
    const cached = cache.get(key);
    if (cached) {
      metrics?.inc('firecrawl.cacheHit');
      return cached;
    }

    const response = await http.requestJson(`${baseUrl}/v2/search`, {
      service: 'firecrawl',
      label: 'search',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      timeoutMs: opts.timeoutMs ?? 9000,
      // No retry: a search that already ran may be billed twice.
      retries: 0,
    });

    const data = /** @type {any} */ (response.data)?.data ?? {};
    const results = (Array.isArray(data.web) ? data.web : []).map((item) => ({
      title: String(item?.title ?? ''),
      url: String(item?.url ?? ''),
      content: String(item?.description ?? ''),
    }));
    // Image hits use `imageUrl`; `url` is the page that embeds the image.
    const images = (Array.isArray(data.images) ? data.images : [])
      .map((item) => String(item?.imageUrl ?? ''))
      .filter(Boolean);

    const normalized = {
      query: clean,
      answer: '',
      results,
      images,
      responseTime: Number(response.latencyMs) || 0,
      usage: null,
    };
    metrics?.inc('firecrawl.search');
    logger?.debug('firecrawl search', {
      query: clean,
      results: results.length,
      images: images.length,
      ms: response.latencyMs,
      icon: '🔎',
    });
    cache.set(key, normalized);
    return normalized;
  }

  return {
    id: 'firecrawl',
    // Firecrawl has no depth/country knobs; the router surfaces that instead of pretending.
    capabilities: { searchDepth: false, country: false },
    search,
    cacheSize: () => cache.size(),
  };
}
