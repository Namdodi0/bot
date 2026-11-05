import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMetrics } from '../src/core/metrics.js';
import { createWebhookServer } from '../src/platforms/zalo/webhook.js';
import { makeConfig, silentLogger } from '../test-utils/helpers.js';

function payload() {
  return {
    ok: true,
    result: {
      event_name: 'message.text.received',
      message: {
        from: { id: 'u1', display_name: 'Nam', is_bot: false },
        chat: { id: 'g1', chat_type: 'GROUP' },
        text: 'hello',
        message_id: 'm1',
      },
    },
  };
}

test('webhook: secret, broken JSON, event dispatch, query string', async () => {
  const config = makeConfig();
  config.webhook = { ...config.webhook, host: '127.0.0.1', port: 0 };

  /** @type {any[]} */
  const events = [];
  const server = createWebhookServer({
    config,
    logger: silentLogger,
    metrics: createMetrics(),
    onEvent: (event) => events.push(event),
  });
  const info = await server.start();
  const url = `http://127.0.0.1:${info.port}${config.webhook.path}`;
  const headers = { 'content-type': 'application/json', 'x-bot-api-secret-token': config.webhook.secret };

  try {
    // wrong secret
    let response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 403);

    // broken JSON → 400 so Zalo retries
    response = await fetch(url, { method: 'POST', headers, body: 'not-json' });
    assert.equal(response.status, 400);

    // valid event
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload()) });
    assert.equal(response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(events.length, 1);
    assert.equal(events[0].chatId, 'g1');

    // path with a query string still matches
    response = await fetch(`${url}?x=1`, { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 200);

    // healthz
    response = await fetch(`http://127.0.0.1:${info.port}/healthz`);
    assert.equal(response.status, 200);

    // different path → 404
    response = await fetch(`http://127.0.0.1:${info.port}/other`, { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 404);
  } finally {
    await server.stop();
  }
});

test('webhook logs runtime server errors instead of swallowing them', async () => {
  const config = makeConfig();
  config.webhook = { ...config.webhook, host: '127.0.0.1', port: 0 };
  /** @type {any[]} */
  const errors = [];
  const logger = {
    ...silentLogger,
    error: (/** @type {string} */ message, /** @type {any} */ meta) => errors.push({ message, meta }),
  };
  const fatal = [];
  const server = createWebhookServer({
    config,
    logger,
    metrics: createMetrics(),
    onEvent: () => {},
    onFatal: (error) => fatal.push(error),
  });
  await server.start();
  try {
    const error = new Error('boom');
    assert.doesNotThrow(() => server.server?.emit('error', error));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'webhook server error');
    assert.equal(errors[0].meta.error, error);
    assert.deepEqual(fatal, [error]);

    // a second error is handled as well (no once() listener was left behind)
    server.server?.emit('error', new Error('boom again'));
    assert.equal(errors.length, 2);
  } finally {
    await server.stop();
  }
});

test('webhook start() still rejects when the port is taken', async () => {
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (blocker.address());
  const config = makeConfig();
  config.webhook = { ...config.webhook, host: '127.0.0.1', port: address.port };
  const server = createWebhookServer({ config, logger: silentLogger, metrics: createMetrics(), onEvent: () => {} });
  try {
    await assert.rejects(() => server.start(), /EADDRINUSE/);
  } finally {
    await server.stop();
    await new Promise((resolve) => blocker.close(() => resolve(undefined)));
  }
});
