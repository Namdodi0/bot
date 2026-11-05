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
  const ttlMs = options.cacheTtlMs ?? 10 * 60_000;
  const cacheSize = options.cacheSize ?? 100;
  const now = options.now ?? (() => Date.now());

  /** @type {Map<string, {expires: number, data: any}>} */
  const cache = new Map();

  /** @param {string} key */
  function readCache(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (hit.expires <= now()) {
      cache.delete(key);
      return null;
    }
    return hit.data;
  }

  /** @param {string} key @param {any} data */
  function writeCache(key, data) {
    cache.set(key, { expires: now() + ttlMs, data });
    if (cache.size > cacheSize) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

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
    };
    const key = JSON.stringify(body);
    const cached = readCache(key);
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
    writeCache(key, normalized);
    return normalized;
  }

  return { search, cacheSize: () => cache.size };
}
