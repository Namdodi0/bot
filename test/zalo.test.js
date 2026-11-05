import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttp } from '../src/core/http.js';
import { createZaloClient, ZaloApiError } from '../src/platforms/zalo/client.js';
import { createZaloPlatform } from '../src/platforms/zalo/index.js';
import { createMetrics } from '../src/core/metrics.js';
import { makeConfig, silentLogger } from '../test-utils/helpers.js';

/**
 * @param {(url: string, opts: any) => any} handler
 */
function fakeHttp(handler) {
  const calls = [];
  return {
    calls,
    async requestJson(url, opts) {
      calls.push({ url, payload: JSON.parse(opts.body) });
      return handler(url, opts);
    },
  };
}

function client(handler, extra = {}) {
  const http = fakeHttp(handler);
  const zalo = createZaloClient({
    token: '123:abc',
    baseUrl: 'https://bot-api.example',
    http,
    logger: silentLogger,
    metrics: createMetrics(),
    ...extra,
  });
  return { zalo, http };
}

test('getUpdates treats 408 as "no new messages"', async () => {
  const { zalo } = client(() => ({
    status: 200,
    data: { ok: false, description: 'Request timeout', error_code: 408 },
    latencyMs: 1,
    headers: new Headers(),
  }));
  const data = await zalo.getUpdates(3);
  assert.deepEqual(data, { ok: true, result: [] });
});

test('sendPhoto formats the caption and truncates by code points', async () => {
  const { zalo, http } = client(() => ({
    status: 200,
    data: { ok: true, result: {} },
    latencyMs: 1,
    headers: new Headers(),
  }));
  await zalo.sendPhoto('chat-1', 'https://x/a.png', 'see [here](https://a.com)');
  assert.equal(http.calls[0].payload.caption, 'see here (https://a.com)');

  await zalo.sendPhoto('chat-1', 'https://x/a.png', '😀'.repeat(2000));
  const caption = /** @type {string} */ (http.calls[1].payload.caption);
  assert.equal(Array.from(caption).length, 1900);
  assert.doesNotMatch(caption, /[\uD800-\uDBFF]$/, 'must not end on a lone high surrogate');
});

test('explainError surfaces auth failures reported in a 200 body', async () => {
  const config = makeConfig();
  config.sticker = { ...config.sticker, enabled: false };
  const platform = await createZaloPlatform({
    config,
    boot: { logger: silentLogger, metrics: createMetrics(), http: createHttp({ logger: silentLogger }) },
  });
  const message = platform.explainError(new ZaloApiError('sendMessage', { status: 200, code: 401 }));
  assert.match(String(message), /ZALO_BOT_TOKEN/);
  assert.equal(platform.explainError(new ZaloApiError('sendMessage', { status: 500, code: 0 })), null);
});

test('sendMessage does NOT retry on 5xx (avoids duplicate messages)', async () => {
  let attempts = 0;
  const http = createHttp({
    logger: silentLogger,
    sleep: async () => {},
    fetchImpl: async () => {
      attempts += 1;
      return {
        ok: false,
        status: 500,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => '{"ok":false}',
      };
    },
  });
  const zalo = createZaloClient({ token: 't', http, logger: silentLogger });
  await assert.rejects(() => zalo.sendMessage('chat-1', 'hello'));
  assert.equal(attempts, 1);
});
