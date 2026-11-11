import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageSync } from '../src/platforms/discord/message-sync.js';

function makeSync() {
  const calls = { edits: [], deletes: [], answerDeletes: [] };
  const runtime = {
    store: { exists: async () => true },
    agent: { exclusive: async (_chatId, task) => task() },
    chatServices: {
      editTurn: async (chatId, input) => {
        calls.edits.push({ chatId, ...input });
        return { ok: true };
      },
      deleteTurns: async (chatId, ids) => {
        calls.deletes.push({ chatId, ids });
        return { ok: true, removed: ids.length };
      },
      deleteAnswerMessages: async (chatId, ids) => {
        calls.answerDeletes.push({ chatId, ids });
        return { ok: true, removed: ids.length };
      },
    },
  };
  const sync = createMessageSync({
    config: { discord: {} },
    logger: { debug() {}, warn() {}, info() {}, error() {} },
    metrics: { inc() {} },
    runtime,
    client: { user: { id: 'bot-1' } },
  });
  return { sync, calls };
}

test('user edits and deletes sync into the stored context', async () => {
  const { sync, calls } = makeSync();
  const message = {
    id: 'm1',
    content: 'new text',
    author: { bot: false, username: 'alice' },
    member: { displayName: 'Alice' },
    channelId: 'c1',
    guildId: 'g1',
    channel: { id: 'c1', isDMBased: () => false },
    partial: false,
  };

  await sync.update({ content: 'old text' }, message);
  assert.deepEqual(calls.edits, [
    { chatId: 'c1', messageId: 'm1', text: 'new text', senderName: 'Alice', chatType: 'GROUP' },
  ]);

  await sync.remove({ id: 'm1', channelId: 'c1', author: { bot: false } });
  assert.deepEqual(calls.deletes, [{ chatId: 'c1', ids: ['m1'] }]);
});

test('bot edits are ignored so streaming previews never touch the context', async () => {
  const { sync, calls } = makeSync();
  await sync.update(
    { content: 'old' },
    {
      id: 'm2',
      content: 'preview',
      author: { bot: true, username: 'bot' },
      channelId: 'c1',
      guildId: 'g1',
      channel: { id: 'c1', isDMBased: () => false },
      partial: false,
    },
  );
  assert.deepEqual(calls.edits, []);
});

test('deleting the bot answer drops its stored turn', async () => {
  const { sync, calls } = makeSync();
  await sync.remove({ id: 'b1', channelId: 'c1', author: { bot: true, id: 'bot-1' } });
  assert.deepEqual(calls.answerDeletes, [{ chatId: 'c1', ids: ['b1'] }]);
  assert.deepEqual(calls.deletes, []);

  await sync.remove({ id: 'b2', channelId: 'c1', author: { bot: true, id: 'other-bot' } });
  assert.equal(calls.answerDeletes.length, 1);
  assert.equal(calls.deletes.length, 0);
});

test('an uncached delete with no author tries both user turns and bot answers', async () => {
  const calls = { deletes: [], answerDeletes: [] };
  const sync = createMessageSync({
    config: { discord: {} },
    logger: { debug() {}, warn() {}, info() {}, error() {} },
    metrics: { inc() {} },
    runtime: {
      store: { exists: async () => true },
      agent: { exclusive: async (_chatId, task) => task() },
      chatServices: {
        deleteTurns: async (chatId, ids) => {
          calls.deletes.push({ chatId, ids });
          return { ok: false, removed: 0 };
        },
        deleteAnswerMessages: async (chatId, ids) => {
          calls.answerDeletes.push({ chatId, ids });
          return { ok: true, removed: 1 };
        },
      },
    },
    client: { user: { id: 'bot-1' } },
  });
  await sync.remove({ id: 'x1', channelId: 'c1', partial: true });
  assert.deepEqual(calls.deletes, [{ chatId: 'c1', ids: ['x1'] }]);
  assert.deepEqual(calls.answerDeletes, [{ chatId: 'c1', ids: ['x1'] }]);
});

test('an edit that clears the content drops the stored turn', async () => {
  const { sync, calls } = makeSync();
  await sync.update(
    { content: 'old text' },
    {
      id: 'm1',
      content: '',
      author: { bot: false, username: 'alice' },
      channelId: 'c1',
      guildId: 'g1',
      channel: { id: 'c1', isDMBased: () => false },
      partial: false,
    },
  );
  assert.deepEqual(calls.edits, []);
  assert.deepEqual(calls.deletes, [{ chatId: 'c1', ids: ['m1'] }]);
});
