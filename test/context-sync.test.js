import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { turnEntry } from '../src/core/context/record.js';
import { createContextStore } from '../src/core/context/store.js';
import { createChatServices } from '../src/core/services/chat.js';

async function makeHarness() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-sync-'));
  // Keep the debounce timer pending so flush() owns the write and cleanup cannot race it.
  const store = createContextStore({ dir, debounceMs: 60_000 });
  await store.init();
  const chat = createChatServices({ config: {}, store, models: {}, compaction: {} });
  const record = await store.get('c1', { chatType: 'GROUP' });
  record.messages.push(
    turnEntry({ text: 'Alice: [Replying to Bob: hi]\nhello', name: 'Alice', ts: 1, messageId: 'm1' }),
    turnEntry({ text: 'Bob: yo', name: 'Bob', ts: 2, messageId: 'm2' }),
    turnEntry({ role: 'assistant', text: 'answer', ts: 3 }),
  );
  return { dir, store, chat, record };
}

test('editing a turn keeps the sender prefix and stored reply quote', async () => {
  const { dir, store, chat, record } = await makeHarness();
  const result = await chat.editTurn('c1', {
    messageId: 'm1',
    text: 'edited',
    senderName: 'Alice',
    chatType: 'GROUP',
  });
  assert.equal(result.ok, true);
  assert.equal(record.messages[0].text, 'Alice: [Replying to Bob: hi]\nedited');

  const missing = await chat.editTurn('c1', { messageId: 'nope', text: 'x' });
  assert.deepEqual(missing, { ok: false, reason: 'missing' });
  assert.equal(await store.exists('never-seen'), false);
  await store.flush();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('deleting messages removes only matching user turns', async () => {
  const { dir, store, chat, record } = await makeHarness();
  const result = await chat.deleteTurns('c1', ['m1', 'unknown']);
  assert.deepEqual(result, { ok: true, removed: 1 });
  assert.deepEqual(
    record.messages.map((message) => message.text),
    ['Bob: yo', 'answer'],
  );
  await store.flush();
  await fsp.rm(dir, { recursive: true, force: true });
});
