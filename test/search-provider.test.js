import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirecrawlClient } from '../src/core/search/firecrawl.js';
import { createSearchRouter } from '../src/core/search/router.js';

test('firecrawl search asks for images and normalizes both result types', async () => {
  const calls = [];
  const http = {
    requestJson: async (url, options) => {
      calls.push({ url, options });
      return {
        latencyMs: 12,
        data: {
          success: true,
          data: {
            web: [{ title: 'Cat', url: 'https://example.com/cat', description: 'A cat page' }],
            images: [{ title: 'Cat pic', imageUrl: 'https://cdn.example/cat.jpg', url: 'https://example.com' }],
          },
        },
      };
    },
  };
  const client = createFirecrawlClient({ apiKey: 'fc-test', http });

  const result = await client.search('cat', { maxResults: 4, includeImages: true });
  assert.equal(calls[0].url, 'https://api.firecrawl.dev/v2/search');
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.sources, ['web', 'images']);
  assert.equal(body.limit, 4);
  assert.equal(body.safe, false);
  assert.deepEqual(result.results, [{ title: 'Cat', url: 'https://example.com/cat', content: 'A cat page' }]);
  assert.deepEqual(result.images, ['https://cdn.example/cat.jpg']);
});

test('search failover uses only the remaining deadline, never a fresh timeout', async () => {
  let fallbackCalls = 0;
  const router = createSearchRouter({
    primary: {
      search: async (_query, opts) => {
        assert.ok(Number(opts.timeoutMs) <= 60, 'the primary attempt is bounded by the remaining budget');
        await new Promise((resolve) => setTimeout(resolve, 80));
        const error = new Error('primary down');
        /** @type {any} */ (error).status = 503;
        throw error;
      },
    },
    fallback: {
      search: async () => {
        fallbackCalls += 1;
        return { results: [], images: [] };
      },
    },
    logger: { warn() {} },
    metrics: { inc() {} },
  });

  await assert.rejects(
    () => router.search('cat', { deadline: Date.now() + 50, timeoutMs: 9000 }),
    /deadline expired/,
  );
  assert.equal(fallbackCalls, 0, 'no failover request may start after the operation deadline');
});

test('an already-expired deadline is not reported as a primary failure', async () => {
  const warnings = [];
  let fallbackCalls = 0;
  const metrics = { inc: (name) => warnings.push(name) };
  const router = createSearchRouter({
    primary: { search: async () => ({ results: [], images: [] }) },
    fallback: {
      search: async () => {
        fallbackCalls += 1;
        return { results: [], images: [] };
      },
    },
    logger: { warn: (message) => warnings.push(message) },
    metrics,
  });
  await assert.rejects(
    () => router.search('cat', { deadline: Date.now() - 1 }),
    /deadline expired/,
  );
  assert.equal(fallbackCalls, 0);
  assert.deepEqual(warnings, [], 'no failover log or metric for an expired caller budget');
});

test('the router reports options a provider cannot apply instead of ignoring them silently', async () => {
  const logs = [];
  const router = createSearchRouter({
    primary: {
      id: 'firecrawl',
      capabilities: { searchDepth: false, country: false },
      search: async () => ({ results: [], images: [] }),
    },
    fallback: null,
    logger: { debug: (message, fields) => logs.push({ message, fields }), warn() {} },
    metrics: { inc() {} },
  });

  await router.search('cat', { searchDepth: 'advanced', country: 'japan', deadline: Date.now() + 1000 });
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0].fields.options, ['searchDepth', 'country']);
});

test('the search router falls back when the primary provider is over quota', async () => {
  let fallbackCalls = 0;
  const router = createSearchRouter({
    primary: {
      search: async () => {
        const error = new Error('quota exceeded');
        /** @type {any} */ (error).status = 432;
        throw error;
      },
    },
    fallback: {
      search: async () => {
        fallbackCalls += 1;
        return { results: [{ title: 'ok' }], images: [] };
      },
    },
    logger: { warn() {} },
    metrics: { inc() {} },
  });

  const result = await router.search('cat');
  assert.equal(fallbackCalls, 1);
  assert.deepEqual(result.results, [{ title: 'ok' }]);
});
