import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageHandler } from '../src/platforms/discord/message-handler.js';
import { makeConfig, silentLogger } from '../test-utils/helpers.js';

test('image preparation runs inside the per-chat queue, before the turn', async () => {
  /** @type {string[]} */
  const order = [];
  const config = makeConfig({ typing: false });
  const runtime = {
    agent: {
      exclusive: async (_chatId, task) => {
        order.push('queue');
        return task();
      },
      stream: async () => {
        order.push('stream');
        return { text: 'done', photos: [] };
      },
    },
    validator: {
      download: async () => {
        order.push('download');
        return { ok: true, data: Buffer.from('image'), contentType: 'image/png' };
      },
    },
  };
  const transport = {
    startTyping: () => async () => {},
  };
  const client = { user: { id: 'bot-1', username: 'Bot' } };
  const handler = createMessageHandler({
    config,
    logger: silentLogger,
    metrics: { inc() {} },
    transport,
    runtime,
    client,
  });

  const message = {
    id: 'm1',
    content: '<@bot-1> what is this?',
    createdTimestamp: Date.now(),
    author: { id: 'u1', username: 'alice', bot: false },
    member: { displayName: 'Alice' },
    channel: { id: 'c1', isDMBased: () => false, send: async () => ({}) },
    mentions: { users: new Map([['bot-1', {}]]) },
    attachments: [
      {
        contentType: 'image/png',
        url: 'https://cdn.example/cat.png',
        size: 10,
      },
    ],
    async reply() {
      return { edit: async () => {}, delete: async () => {} };
    },
  };

  await handler(message);
  assert.deepEqual(order, ['queue', 'download', 'stream']);
});

test('chat answers post the thinking block when the channel enables it', async () => {
  /** @type {any[]} */
  const sent = [];
  const runtime = {
    agent: {
      exclusive: async (_chatId, task) => task(),
      stream: async (_event, options) => {
        options.onProgress({ type: 'reasoning', text: 'secret plan' });
        return { text: 'done', photos: [] };
      },
    },
    chatServices: { getRecord: async () => ({ meta: { showThinking: true } }) },
  };
  const transport = { startTyping: () => async () => {} };
  const client = { user: { id: 'bot-1', username: 'Bot' } };
  const handler = createMessageHandler({
    config: makeConfig({ typing: false }),
    logger: silentLogger,
    metrics: { inc() {} },
    transport,
    runtime,
    client,
  });

  const message = {
    id: 'm3',
    content: '<@bot-1> hi',
    createdTimestamp: Date.now(),
    author: { id: 'u1', username: 'alice', bot: false },
    member: { displayName: 'Alice' },
    channel: {
      id: 'c1',
      isDMBased: () => false,
      send: async (payload) => {
        sent.push(payload);
      },
    },
    mentions: { users: new Map([['bot-1', {}]]) },
    attachments: [],
    async reply() {
      return { edit: async () => {}, delete: async () => {} };
    },
  };

  await handler(message);
  const rendered = sent
    .map((payload) => JSON.stringify((payload.components ?? []).map((component) => component.toJSON?.())))
    .join('\n');
  assert.match(rendered, /Thinking/);
  assert.match(rendered, /secret plan/);
});
