import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransportRouter } from '../src/transport/router.js';

function stub(name) {
  const calls = [];
  return {
    calls,
    displayName: name,
    sendMessage: async (chatId, text) => calls.push(['message', chatId, text]),
    sendPhoto: async (chatId, url) => calls.push(['photo', chatId, url]),
    sendSticker: async (chatId, id) => calls.push(['sticker', chatId, id]),
    startTyping: () => async () => {},
    stopAllTyping: () => calls.push(['stop']),
    ping: async () => 1,
  };
}

test('router dispatches by discord: prefix and fans out stopAllTyping', async () => {
  const zalo = stub('zalo');
  const discord = stub('discord');
  const router = createTransportRouter({ zalo, discord });
  assert.equal(router.displayName, 'zalo');

  await router.sendMessage('g1', 'hi');
  await router.sendMessage('discord:c1', 'hi');
  assert.deepEqual(zalo.calls[0], ['message', 'g1', 'hi']);
  assert.deepEqual(discord.calls[0], ['message', 'discord:c1', 'hi']);

  await router.sendPhoto('discord:c1', 'https://x/a.png', 'cap');
  assert.deepEqual(discord.calls[1], ['photo', 'discord:c1', 'https://x/a.png']);

  router.stopAllTyping();
  assert.deepEqual(zalo.calls.at(-1), ['stop']);
  assert.deepEqual(discord.calls.at(-1), ['stop']);
});

test('router rejects discord chats when Discord is disabled', async () => {
  const router = createTransportRouter({ zalo: stub('zalo'), discord: null });
  await assert.rejects(() => router.sendMessage('discord:c1', 'hi'), /Discord is disabled/);
});
