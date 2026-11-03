import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError } from '../src/core/config-helpers.js';
import { createHttp } from '../src/core/http.js';
import { createZaloClient, ZaloApiError } from '../src/platforms/zalo/client.js';
import { parseZaloConfig } from '../src/platforms/zalo/config.js';
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

test('getUpdates throws on a bad token', async () => {
  const { zalo } = client(() => ({
    status: 200,
    data: { ok: false, description: 'Unauthorized', error_code: 401 },
    latencyMs: 1,
    headers: new Headers(),
  }));
  await assert.rejects(() => zalo.getUpdates(3), ZaloApiError);
});

test('sendMessage sends parse_mode markdown', async () => {
  const { zalo, http } = client(() => ({
    status: 200,
    data: { ok: true, result: { message_id: 'm1' } },
    latencyMs: 1,
    headers: new Headers(),
  }));
  await zalo.sendMessage('chat-1', '**hello**');
  assert.equal(http.calls[0].url, 'https://bot-api.example/bot123:abc/sendMessage');
  assert.deepEqual(http.calls[0].payload, { chat_id: 'chat-1', text: '**hello**', parse_mode: 'markdown' });
});

test('sendPhoto sends photo + caption', async () => {
  const { zalo, http } = client(() => ({
    status: 200,
    data: { ok: true, result: {} },
    latencyMs: 1,
    headers: new Headers(),
  }));
  await zalo.sendPhoto('chat-1', 'https://x/a.png', 'cat photo');
  assert.deepEqual(http.calls[0].payload, { chat_id: 'chat-1', photo: 'https://x/a.png', caption: 'cat photo' });
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

test('config.webhook.path must be a root-relative path without a trailing slash', () => {
  /** @param {string} webhookPath */
  const parse = (webhookPath) => {
    const root = makeConfig();
    root.webhook = { ...root.webhook, path: webhookPath };
    return parseZaloConfig({ root, env: {} });
  };

  assert.equal(parse('/zalo/hook').webhook.path, '/zalo/hook');
  assert.equal(parse('/').webhook.path, '/');
  for (const bad of ['zalo/webhook', '/zalo/webhook/', '', '/zalo webhook']) {
    assert.throws(() => parse(bad), ConfigError, `expected ConfigError for ${JSON.stringify(bad)}`);
  }
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

test('dry-run does not call the send API', async () => {
  const { zalo, http } = client(
    () => {
      throw new Error('must not be called');
    },
    { dryRun: true },
  );
  const result = await zalo.sendMessage('chat-1', 'hello');
  assert.equal(result.dryRun, true);
  assert.equal(http.calls.length, 0);
});

test('startTyping stops refreshing after stop', async () => {
  let calls = 0;
  const { zalo } = client(
    () => {
      calls += 1;
      return { status: 200, data: { ok: true }, latencyMs: 1, headers: new Headers() };
    },
    { typingIntervalMs: 20 },
  );

  const stop = zalo.startTyping('chat-1');
  assert.equal(calls, 1, 'sends typing immediately');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(calls > 1, 'must keep refreshing before stop');

  await stop();
  const afterStop = calls;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls, afterStop, 'must not send typing after stop');
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

test('getMe prefers display_name', async () => {
  const { zalo } = client(() => ({
    status: 200,
    data: { ok: true, result: { id: '1', account_name: 'bot.xyz', display_name: 'Bot deepseek', can_join_groups: true } },
    latencyMs: 1,
    headers: new Headers(),
  }));
  const me = await zalo.getMe();
  assert.equal(me.display_name, 'Bot deepseek');
  assert.equal(zalo.displayName, 'Bot deepseek');
});
