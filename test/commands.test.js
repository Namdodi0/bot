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

test('/help returns the list of commands', async () => {
  const d = deps();
  const commands = createCommands(d);
  const result = await commands.run({ name: 'help', args: '' }, ctx(d));
  assert.equal(result.kind, 'text');
  assert.match(result.text, /\/status/);
  assert.match(result.text, /@mention/);
});

test('/help on Discord lists the native slash commands', async () => {
  const d = deps({ platformName: 'discord' });
  const commands = createCommands(d);
  const result = await commands.run({ name: 'help', args: '' }, ctx(d));
  assert.match(result.text, /`\/ask`/);
  assert.match(result.text, /Slash commands only/);
  assert.match(result.text, /\/sticker/);
  assert.doesNotMatch(result.text, /tone|split|think/);
});

test('/status on Discord reports the gateway transport', async () => {
  const d = deps({ platformName: 'discord' });
  const commands = createCommands(d);
  const result = await commands.run({ name: 'status', args: '' }, ctx(d));
  assert.match(result.text, /Mode: gateway/);
  assert.doesNotMatch(result.text, /zalo:/);
});

test('/tone shy switches the chat to the shy persona', async () => {
  const d = deps();
  const commands = createCommands(d);
  const context = ctx(d);
  const result = await commands.run({ name: 'tone', args: 'shy' }, context);
  assert.equal(context.record.meta.tone, 'shy');
  assert.match(result.text, /Shy/);
  assert.match(context.record.messages.at(-1).text, /shy/);
});

test('/compact runs compaction and reports the result', async () => {
  const d = deps();
  d.compaction = {
    async compactIfNeeded() {
      return { changed: true, summarized: true, pruned: true };
    },
  };
  const commands = createCommands(d);
  const result = await commands.run({ name: 'compact', args: '' }, ctx(d));
  assert.match(result.text, /Compacted context/);
  assert.match(result.text, /summary/);
});

test('/compact says clearly when nothing needs compaction', async () => {
  const d = deps();
  d.compaction = { async compactIfNeeded() { return null; } };
  const commands = createCommands(d);
  const result = await commands.run({ name: 'compact', args: '' }, ctx(d));
  assert.match(result.text, /does not need compaction/);
});

test('/status includes model and context info', async () => {
  const d = deps();
  const commands = createCommands(d);
  const result = await commands.run({ name: 'status', args: '' }, ctx(d));
  assert.match(result.text, /deepseek-flash/);
  assert.match(result.text, /DeepSeek V4\.1 Flash/);
  assert.match(result.text, /unlimited/);
  assert.match(result.text, /Context: 0 msg/);
});

test('/sticker lists and picks a sticker by mood', async () => {
  const d = deps();
  const commands = createCommands(d);

  const list = await commands.run({ name: 'sticker', args: '' }, ctx(d));
  assert.match(list.text, /Sticker/);
  assert.match(list.text, /\/sticker/);

  const picked = await commands.run({ name: 'sticker', args: 'hello' }, ctx(d));
  assert.equal(picked.kind, 'sticker');
  assert.equal(picked.stickerId, 'd8fa8021bc64553a0c75');

  const missing = await commands.run({ name: 'sticker', args: 'nothing here' }, ctx(d));
  assert.match(missing.text, /No sticker matches/);
});

test('/sticker add test-sends then saves, remove deletes', async () => {
  const d = deps();
  const commands = createCommands(d);
  const context = ctx(d);

  const added = await commands.run({ name: 'sticker', args: 'add 0e078a2fb66a5f34067b Hello there' }, context);
  assert.match(added.text, /Added and test-sent/);
  assert.equal(d.transport.lastSticker.stickerId, '0e078a2fb66a5f34067b');

  const removed = await commands.run({ name: 'sticker', args: 'remove hello' }, context);
  assert.match(removed.text, /Removed the sticker/);
});

test('/model lists and switches the model for the chat', async () => {
  const d = deps();
  const commands = createCommands(d);
  const context = ctx(d);

  const list = await commands.run({ name: 'model', args: '' }, context);
  assert.match(list.text, /Current model/);
  assert.match(list.text, /\/model deepseek/);

  const switched = await commands.run({ name: 'model', args: 'nim' }, context);
  assert.match(switched.text, /Switched to/);
  assert.equal(context.record.meta.model, 'nim');

  const bad = await commands.run({ name: 'model', args: 'gpt-9' }, context);
  assert.match(bad.text, /No model named/);
});

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

test('/search returns the delegate', async () => {
  const d = deps();
  const commands = createCommands(d);
  const result = await commands.run({ name: 'search', args: 'gold price' }, ctx(d));
  assert.deepEqual(result, { kind: 'search', query: 'gold price' });
});

test('/image returns the delegate', async () => {
  const d = deps();
  const commands = createCommands(d);
  const result = await commands.run({ name: 'image', args: 'kitten' }, ctx(d));
  assert.deepEqual(result, { kind: 'image', query: 'kitten' });
});

test('/think changes the reasoning mode', async () => {
  const d = deps();
  const commands = createCommands(d);
  const context = ctx(d);
  await commands.run({ name: 'think', args: 'off' }, context);
  assert.equal(context.record.meta.thinking, 'off');
  const result = await commands.run({ name: 'think', args: '' }, context);
  assert.match(result.text, /off/);
});

test('/split off disables splitting for the chat, /split auto returns to the config', async () => {
  const d = deps();
  const commands = createCommands(d);
  const context = ctx(d);

  const off = await commands.run({ name: 'split', args: 'off' }, context);
  assert.match(off.text, /Split replies disabled/);
  assert.equal(context.record.meta.split, 'off');

  const shown = await commands.run({ name: 'split', args: '' }, context);
  assert.match(shown.text, /off/);

  const back = await commands.run({ name: 'split', args: 'auto' }, context);
  assert.match(back.text, /split mode from the config/);
  assert.equal(context.record.meta.split, null);

  const bad = await commands.run({ name: 'split', args: 'xyz' }, context);
  assert.match(bad.text, /Invalid value/);
});

test('an unknown command returns guidance', async () => {
  const d = deps();
  const commands = createCommands(d);
  const result = await commands.run({ name: 'abc', args: '' }, ctx(d));
  assert.match(result.text, /Unknown command/);
});

test('/remind parses the time and stores a reminder', async () => {
  const d = deps();
  /** @type {any[]} */
  const added = [];
  d.reminders = {
    list: () => [],
    add: async (input) => {
      added.push(input);
      return { ok: true, item: { id: 7, at: input.at, text: input.text } };
    },
    remove: async () => null,
  };
  const commands = createCommands(d);
  const result = await commands.run({ name: 'remind', args: '+10m uống nước' }, ctx(d));
  assert.match(result.text, /Reminder #7 set/);
  assert.equal(added[0].text, 'uống nước');
  assert.ok(added[0].at > Date.now());
});

test('/remind lists and removes reminders', async () => {
  const d = deps();
  const item = { id: 1, at: Date.now() + 60_000, text: 'họp' };
  d.reminders = {
    list: () => [item],
    add: async () => ({ ok: false, reason: 'chat-limit' }),
    remove: async (_chatId, id) => (String(id) === '1' ? item : null),
  };
  const commands = createCommands(d);
  let result = await commands.run({ name: 'remind', args: 'list' }, ctx(d));
  assert.match(result.text, /họp/);
  result = await commands.run({ name: 'remind', args: 'remove 1' }, ctx(d));
  assert.match(result.text, /Removed reminder #1/);
});

test('/summary summarizes the last N turn messages', async () => {
  const d = deps();
  let received = null;
  d.models.chat = async (input) => {
    received = input;
    return { content: 'Summary content' };
  };
  const commands = createCommands(d);
  const record = {
    messages: [
      { role: 'user', kind: 'turn', text: 'a' },
      { role: 'assistant', kind: 'turn', text: 'b' },
      { role: 'user', kind: 'context', text: 'now' },
      { role: 'user', kind: 'turn', text: 'c' },
    ],
    turns: 2,
    meta: { thinking: null },
  };
  const result = await commands.run({ name: 'summary', args: '2' }, ctx(d, { record }));
  assert.match(result.text, /Summary of the last 2 messages/);
  assert.match(result.text, /Summary content/);
  const joined = received.messages.map((message) => message.content).join('\n');
  assert.match(joined, /a/);
  assert.match(joined, /c/);
  assert.equal(joined.includes('now'), false);
  assert.equal(received.reasoning, 'none');
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

test('/summary validates the count and the history', async () => {
  const d = deps();
  d.models.chat = async () => ({ content: 'x' });
  const commands = createCommands(d);
  let result = await commands.run({ name: 'summary', args: 'abc' }, ctx(d));
  assert.match(result.text, /2–200/);
  result = await commands.run({ name: 'summary', args: '' }, ctx(d));
  assert.match(result.text, /Not enough messages/);
});

