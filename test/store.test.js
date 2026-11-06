import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createContextStore } from '../src/core/context/store.js';
import { silentLogger } from '../test-utils/helpers.js';

test('store saves, reloads, resets', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-store-'));
  const store = createContextStore({ dir, logger: silentLogger, ttlHours: 72, debounceMs: 2 });
  await store.init();

  const record = await store.get('chat-1', { chatType: 'GROUP' });
  record.messages.push({ role: 'user', text: 'hello', ts: Date.now() });
  record.turns = 1;
  store.touch('chat-1');
  await store.flush();

  const store2 = createContextStore({ dir, logger: silentLogger, ttlHours: 72 });
  await store2.init();
  const loaded = await store2.get('chat-1');
  assert.equal(loaded.messages.length, 1);
  assert.equal(loaded.messages[0].text, 'hello');
  assert.equal(loaded.turns, 1);

  await store2.reset('chat-1');
  const store3 = createContextStore({ dir, logger: silentLogger, ttlHours: 72 });
  await store3.init();
  const fresh = await store3.get('chat-1');
  assert.equal(fresh.messages.length, 0);
});

test('concurrent loads of the same chat share one record instance', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-store-'));
  const store = createContextStore({ dir, logger: silentLogger, ttlHours: 72 });
  await store.init();

  const [first, second] = await Promise.all([store.get('race-chat'), store.get('race-chat')]);
  assert.equal(first, second);
  first.messages.push({ role: 'user', text: 'kept', ts: Date.now() });
  assert.equal(second.messages.length, 1);
});

test('reset keepMeta preserves settings when the chat is not cached', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-store-'));
  const store = createContextStore({ dir, logger: silentLogger, ttlHours: 72, debounceMs: 2 });
  await store.init();

  const record = await store.get('cold-chat', { chatType: 'GROUP' });
  record.meta = { thinking: 'low', model: 'nim' };
  record.messages.push({ role: 'user', text: 'old', ts: Date.now() });
  store.touch('cold-chat');
  await store.flush();

  const cold = createContextStore({ dir, logger: silentLogger, ttlHours: 72, debounceMs: 2 });
  await cold.init();
  const reset = await cold.reset('cold-chat', { keepMeta: true });
  assert.deepEqual(reset.meta, { thinking: 'low', model: 'nim' });

  const loaded = await cold.get('cold-chat');
  assert.equal(loaded.messages.length, 0);
  assert.deepEqual(loaded.meta, { thinking: 'low', model: 'nim' });
});

test('private messages are never written to disk', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-store-'));
  const store = createContextStore({ dir, logger: silentLogger, ttlHours: 72, debounceMs: 2 });
  await store.init();

  const record = await store.get('private-chat', { chatType: 'GROUP' });
  record.messages.push(
    { role: 'user', kind: 'turn', text: 'public question', ts: 1 },
    { role: 'assistant', kind: 'turn', text: 'private answer', private: true, ts: 2 },
  );
  store.touch('private-chat');
  await store.flush();

  const raw = JSON.parse(await fsp.readFile(store.fileFor('private-chat'), 'utf8'));
  assert.deepEqual(raw.messages.map((message) => message.text), ['public question']);
  assert.equal(record.messages.length, 2, 'the in-memory turn still sees its private entries');

  const reloaded = createContextStore({ dir, logger: silentLogger, ttlHours: 72 });
  await reloaded.init();
  const fromDisk = await reloaded.get('private-chat');
  assert.deepEqual(fromDisk.messages.map((message) => message.text), ['public question']);
});

test('store prune deletes files past TTL', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-store-'));
  const store = createContextStore({ dir, logger: silentLogger, ttlHours: 1 });
  await store.init();

  const file = store.fileFor('old-chat');
  await fsp.writeFile(
    file,
    JSON.stringify({ chatId: 'old-chat', chatType: 'GROUP', summary: '', messages: [], turns: 0, updatedAt: 0, meta: { thinking: null } }),
    'utf8',
  );
  const twoDaysAgo = Date.now() / 1000 - 2 * 24 * 3600;
  await fsp.utimes(file, twoDaysAgo, twoDaysAgo);

  const removed = await store.prune();
  assert.ok(removed >= 1);
  await assert.rejects(() => fsp.stat(file));
});

test('store reset by default (no keepMeta) deletes the whole file', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-store-'));
  const store = createContextStore({ dir, logger: silentLogger, ttlHours: 72, debounceMs: 2 });
  await store.init();
  const record = await store.get('chat-3');
  record.meta = { tone: 'roast' };
  await store.flush();

  await store.reset('chat-3');
  await assert.rejects(() => fsp.stat(store.fileFor('chat-3')));
});

test('flush waits for an already-started debounced write', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-store-'));
  const store = createContextStore({ dir, logger: silentLogger, ttlHours: 72, debounceMs: 1 });
  await store.init();
  const record = await store.get('flush-barrier', { chatType: 'GROUP' });
  record.messages.push({ role: 'user', text: 'must survive', ts: Date.now() });
  store.touch('flush-barrier');

  const originalRename = fsp.rename;
  let release;
  let renameEntered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    renameEntered = resolve;
  });
  fsp.rename = async (...args) => {
    renameEntered();
    await gate;
    return originalRename(...args);
  };

  try {
    await entered;
    let flushed = false;
    const flushing = store.flush().then(() => {
      flushed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(flushed, false, 'flush must not resolve before the rename completes');
    release();
    await flushing;
  } finally {
    fsp.rename = originalRename;
  }

  const raw = JSON.parse(await fsp.readFile(store.fileFor('flush-barrier'), 'utf8'));
  assert.equal(raw.messages[0].text, 'must survive');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('prune never evicts a pinned chat or deletes its file', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-store-'));
  const store = createContextStore({ dir, logger: silentLogger, ttlHours: 1, debounceMs: 2 });
  await store.init();
  const record = await store.get('pinned-chat', { chatType: 'GROUP' });
  record.messages.push({ role: 'user', text: 'active turn', ts: Date.now() });
  store.touch('pinned-chat');
  await store.flush();

  const file = store.fileFor('pinned-chat');
  const old = new Date(Date.now() - 2 * 24 * 3_600_000);
  await fsp.utimes(file, old, old);
  store.pin('pinned-chat');
  try {
    await store.prune();
    assert.equal(store.has('pinned-chat'), true);
    await fsp.stat(file);
  } finally {
    store.unpin('pinned-chat');
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('CONTEXT_TTL_HOURS=0: prune deletes no context', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-store-'));
  const store = createContextStore({ dir, logger: silentLogger, ttlHours: 0, debounceMs: 2 });
  await store.init();

  const record = await store.get('keep-forever');
  record.messages.push({ role: 'user', text: 'old message', ts: 1 });
  store.touch('keep-forever');
  await store.flush();

  // Simulate a file that is one year old: with TTL > 0 it gets deleted, with TTL = 0 it must be kept.
  const old = new Date(Date.now() - 365 * 24 * 3_600_000);
  await fsp.utimes(store.fileFor('keep-forever'), old, old);

  assert.equal(await store.prune(), 0);
  assert.equal(await store.count(), 1);

  const fresh = createContextStore({ dir, logger: silentLogger, ttlHours: 0 });
  await fresh.init();
  const loaded = await fresh.get('keep-forever');
  assert.equal(loaded.messages.length, 1);
});
