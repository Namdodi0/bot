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
    react: async () => {},
  };

  await handler(message);
  assert.deepEqual(order, ['queue', 'download', 'stream']);
});

test('chat answers keep thinking and tool calls above the answer', async () => {
  /** @type {any[]} */
  const replies = [];
  /** @type {any[]} */
  const edits = [];
  const runtime = {
    agent: {
      exclusive: async (_chatId, task) => task(),
      stream: async (_event, options) => {
        options.onProgress({ type: 'reasoning', text: 'secret plan' });
        options.onProgress({ type: 'tool', name: 'web_search', query: 'cats' });
        options.onProgress({ type: 'tool-result', name: 'web_search', ok: true });
        return { text: 'the answer', photos: [] };
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
    channel: { id: 'c1', isDMBased: () => false, send: async () => ({}) },
    mentions: { users: new Map([['bot-1', {}]]) },
    attachments: [],
    async reply(payload) {
      replies.push(payload);
      return { edit: async (next) => edits.push(next), delete: async () => {} };
    },
    react: async () => {},
  };

  await handler(message);
  const components = (edits.at(-1)?.components ?? []).map((component) => component.toJSON());
  const progress = components[0]?.content ?? '';
  const answer = components.at(-1)?.content ?? '';
  assert.equal(components[0]?.type, 10);
  assert.equal(components[1]?.type, 14);
  assert.match(progress, /secret plan/);
  assert.match(progress, /Searching the web: cats/);
  assert.match(progress, /Web search done/);
  assert.equal(answer, 'the answer');
});

test('chat answers link their sent message ids to the context', async () => {
  /** @type {any[]} */
  const attached = [];
  const runtime = {
    agent: {
      exclusive: async (_chatId, task) => task(),
      stream: async () => ({ text: 'the answer', photos: [] }),
    },
    chatServices: {
      getRecord: async () => ({ meta: { showThinking: false } }),
      attachAnswerMessages: async (chatId, ids, options) => {
        attached.push({ chatId, ids, options });
      },
    },
  };
  const transport = { startTyping: () => async () => {}, sendPhoto: async () => ({}) };
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
    id: 'm4',
    content: '<@bot-1> hi',
    createdTimestamp: Date.now(),
    author: { id: 'u1', username: 'alice', bot: false },
    member: { displayName: 'Alice' },
    channel: { id: 'c1', isDMBased: () => false, send: async () => ({ id: 'b2' }) },
    mentions: { users: new Map([['bot-1', {}]]) },
    attachments: [],
    async reply() {
      return { id: 'b1', edit: async () => {}, delete: async () => {} };
    },
    react: async () => {},
  };

  await handler(message);
  assert.deepEqual(attached, [{ chatId: 'c1', ids: ['b1'], options: { text: 'the answer' } }]);
});

test('accepted messages get a receipt reaction; a failed reaction never breaks the answer', async () => {
  /** @type {string[]} */
  const reactions = [];
  /** @type {any[]} */
  const replies = [];
  const runtime = {
    agent: {
      exclusive: async (_chatId, task) => task(),
      stream: async () => ({ text: 'the answer', photos: [] }),
    },
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
    id: 'm5',
    content: '<@bot-1> hi',
    createdTimestamp: Date.now(),
    author: { id: 'u1', username: 'alice', bot: false },
    member: { displayName: 'Alice' },
    channel: { id: 'c1', isDMBased: () => false, send: async () => ({}) },
    mentions: { users: new Map([['bot-1', {}]]) },
    attachments: [],
    async reply(payload) {
      replies.push(payload);
      return { edit: async () => {}, delete: async () => {} };
    },
    async react(emoji) {
      reactions.push(emoji);
      throw new Error('Missing Permissions');
    },
  };

  await handler(message);
  assert.deepEqual(reactions, ['👀']);
  assert.equal(replies.length, 1, 'the answer must still arrive when the reaction fails');
});
