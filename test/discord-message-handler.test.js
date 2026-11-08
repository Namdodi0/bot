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
