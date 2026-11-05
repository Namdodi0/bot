import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommands, parseCommand } from '../src/core/commands/index.js';
import { createMetrics } from '../src/core/metrics.js';
import { makeConfig, makeDiscordPlatform, makeZaloPlatform, silentLogger } from '../test-utils/helpers.js';

test('parseCommand recognizes commands and arguments', () => {
  assert.deepEqual(parseCommand('/help'), { name: 'help', args: '' });
  assert.deepEqual(parseCommand('/help@Bot'), { name: 'help', args: '' });
  assert.deepEqual(parseCommand('/search@Bot gold price'), { name: 'search', args: 'gold price' });
  assert.deepEqual(parseCommand('/search gold price today'), { name: 'search', args: 'gold price today' });
  assert.equal(parseCommand('hello'), null);
  assert.equal(parseCommand('/'), null);
});

function deps(overrides = {}) {
  const config = makeConfig(overrides.config ?? {});
  const metrics = createMetrics();
  const models = {
    resolve: () => ({ alias: 'deepseek', provider: 'deepseek', model: 'deepseek-flash', label: 'DeepSeek V4.1 Flash' }),
    find: (value) => {
      const needle = String(value).toLowerCase();
      const all = models.list();
      return (
        all.find((item) => item.alias === needle) ??
        all.find((item) => item.provider === needle) ??
        all.find((item) => item.model.toLowerCase().includes(needle)) ??
        null
      );
    },
    list: () => [
      { alias: 'deepseek', provider: 'deepseek', model: 'deepseek-flash', label: 'DeepSeek V4.1 Flash' },
      { alias: 'nim', provider: 'nim', model: 'nvidia/nemotron-3.5-super-vl-120b-a12b', label: 'Nemotron 3.5 Super VL' },
    ],
  };
  const stickers = {
    find: (value) => (String(value).includes('hello') ? { id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi' } : null),
    random: () => ({ id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi' }),
    list: () => [{ id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi', tags: ['hello'] }],
    size: () => 1,
    add: async ({ id, name }) => ({ item: { id, name: name ?? 'New' }, added: true }),
    remove: async (value) => (String(value) === 'hello' ? { id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi' } : null),
  };
  const transport = {
    sendChatAction: async () => ({ ok: true }),
    sendSticker: async (chatId, stickerId) => {
      transport.lastSticker = { chatId, stickerId };
      return { ok: true };
    },
    lastSticker: null,
    ping: async () => 5,
  };
  const platform =
    overrides.platformName === 'discord'
      ? makeDiscordPlatform({ transport })
      : makeZaloPlatform({ config, transport, stickers, logger: silentLogger, metrics });
  return {
    config,
    metrics,
    models,
    stickers,
    platform,
    store: {
      reset: async () => {},
      touch: () => {},
    },
    transport,
    http: {
      stateOf: () => ({ failures: 0, open: false, openedUntil: 0 }),
      listStates: () => [],
    },
    logger: silentLogger,
  };
}

/** @param {any} d */
function ctx(d, overrides = {}) {
  return {
    chatId: 'g1',
    chatType: 'GROUP',
    senderId: 'u1',
    senderName: 'Nam',
    isAdmin: true,
    record: { messages: [], turns: 3, meta: { thinking: null } },
    ...overrides,
  };
}

test('admin-only commands reject group members without the platform admin flag', async () => {
  const cases = [
    ['model', 'deepseek'],
    ['reset', ''],
    ['split', 'off'],
    ['think', 'off'],
    ['tone', 'roast'],
    ['compact', ''],
  ];
  for (const [name, args] of cases) {
    // undefined is what an older/misconfigured platform would pass: deny, never open up.
    for (const isAdmin of [false, undefined]) {
      const d = deps({ config: { adminIds: ['admin-1'] } });
      const commands = createCommands(d);
      const result = await commands.run({ name, args }, ctx(d, { isAdmin }));
      assert.match(result.text, /Only group admins/, `${name} isAdmin=${String(isAdmin)}: ${result.text}`);
    }
  }
});

test('/model settings work in a Discord DM but stay admin-only in a group', async () => {
  const d = deps({ config: { adminIds: ['admin-1'] } });
  const commands = createCommands(d);

  const dm = await commands.run(
    { name: 'model', args: 'nim' },
    ctx(d, { chatId: 'discord:dm1', chatType: 'PRIVATE', isAdmin: false }),
  );
  assert.match(dm.text, /Switched to/);

  const group = await commands.run(
    { name: 'model', args: 'nim' },
    ctx(d, { chatId: 'discord:c1', chatType: 'GROUP', isAdmin: false }),
  );
  assert.match(group.text, /Only group admins/);
});

test('/reset lets admins clear the context', async () => {
  const d = deps({ config: { adminIds: ['u1'] } });
  let resetCalled = false;
  d.store.reset = async () => {
    resetCalled = true;
  };
  const commands = createCommands(d);
  const result = await commands.run({ name: 'reset', args: '' }, ctx(d, { isAdmin: true }));
  assert.equal(resetCalled, true);
  assert.match(result.text, /Cleared this chat's context/);
});

test('/summary ignores private turns', async () => {
  const d = deps();
  let received = null;
  d.models.chat = async (input) => {
    received = input;
    return { content: 'Summary content' };
  };
  const commands = createCommands(d);
  const record = {
    messages: [
      { role: 'user', kind: 'turn', text: 'private question', private: true },
      { role: 'assistant', kind: 'turn', text: 'private answer', private: true },
      { role: 'user', kind: 'turn', text: 'public question' },
      { role: 'assistant', kind: 'turn', text: 'public answer' },
    ],
    turns: 2,
    meta: { thinking: null },
  };
  const result = await commands.run({ name: 'summary', args: '30' }, ctx(d, { record }));
  assert.match(result.text, /Summary of the last 2 messages/);
  const joined = received.messages.map((message) => message.content).join('\n');
  assert.match(joined, /public question/);
  assert.equal(joined.includes('private'), false);
});

test('/summary keeps the newest messages when the transcript is capped', async () => {
  const d = deps();
  let received = null;
  d.models.chat = async (input) => {
    received = input;
    return { content: 'Summary content' };
  };
  const commands = createCommands(d);
  const record = {
    messages: [
      { role: 'user', kind: 'turn', text: `OLDEST ${'x'.repeat(13_000)}` },
      { role: 'assistant', kind: 'turn', text: 'NEWEST answer' },
      { role: 'user', kind: 'turn', text: 'NEWEST question' },
    ],
    turns: 2,
    meta: { thinking: null },
  };
  await commands.run({ name: 'summary', args: '30' }, ctx(d, { record }));
  const joined = received.messages.map((message) => message.content).join('\n');
  assert.match(joined, /NEWEST question/);
  assert.match(joined, /NEWEST answer/);
  assert.equal(joined.includes('OLDEST'), false);
});

