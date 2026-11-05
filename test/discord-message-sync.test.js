import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageSync } from '../src/platforms/discord/message-sync.js';

function makeSync() {
  const calls = { edits: [], deletes: [] };
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
