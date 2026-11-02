import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMetrics } from '../src/metrics.js';
import { createWebhookServer } from '../src/zalo/webhook.js';
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

test('webhook: stop() closes idle keep-alive sockets instead of waiting for them', async () => {
  const config = makeConfig();
  config.webhook = { ...config.webhook, host: '127.0.0.1', port: 0 };
  const server = createWebhookServer({
    config,
    logger: silentLogger,
    metrics: createMetrics(),
    onEvent: () => {},
  });
  const info = await server.start();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

  try {
    const body = await new Promise((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${info.port}/healthz`, { agent }, (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', reject);
      req.end();
    });
    assert.match(body, /"ok":true/);

    // The socket now sits idle in the agent pool: a plain close() would wait for it.
    const started = Date.now();
    await server.stop();
    assert.ok(Date.now() - started < 1500, 'stop() must not wait for the idle keep-alive socket');
  } finally {
    agent.destroy();
  }
});

test('webhook rejects everything when the configured secret is empty', async () => {
  const config = makeConfig();
  config.webhook = { ...config.webhook, host: '127.0.0.1', port: 0, secret: '' };
  const server = createWebhookServer({
    config,
    logger: silentLogger,
    metrics: createMetrics(),
    onEvent: () => {},
  });
  const info = await server.start();
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}${config.webhook.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-api-secret-token': '' },
      body: '{}',
    });
    assert.equal(response.status, 403);
  } finally {
    await server.stop();
  }
});
