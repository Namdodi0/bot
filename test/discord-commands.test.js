import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandRuntime } from '../src/platforms/discord/commands.js';
import { makeConfig, silentLogger } from '../test-utils/helpers.js';

function makePlatform() {
  return {
    name: 'discord',
    label: 'Discord',
    transportMode: 'gateway',
    transport: {
      client: { user: { username: 'Bot' } },
      displayName: 'Bot',
      ping: () => 12,
    },
    capabilities: { uploadMedia: true, stickers: false, nativeInteractions: true },
    limits: { text: 2000, caption: 2000 },
    formatOutgoing: (text) => String(text),
    isAdmin: () => true,
    prompt: {},
    commands: { specs: [] },
    tools: {},
    healthServices: ['tavily'],
    explainError: () => null,
  };
}

function makeRuntime() {
  const record = { messages: [], turns: 0, meta: {} };
  return {
    record,
    store: {
      get: async () => record,
      touch: () => {},
      reset: async () => {},
      count: async () => 0,
    },
    models: {
      resolve: () => ({ alias: 'deepseek', label: 'DeepSeek', provider: 'deepseek', model: 'deepseek-flash' }),
      list: () => [
        { alias: 'deepseek', label: 'DeepSeek', provider: 'deepseek', model: 'deepseek-flash' },
        { alias: 'nim', label: 'NIM', provider: 'nim', model: 'nvidia/model' },
      ],
      find: (value) => (String(value) === 'nim' ? { alias: 'nim', label: 'NIM', provider: 'nim', model: 'nvidia/model' } : null),
      chat: async () => ({ content: 'summary text' }),
    },
    metrics: {
      inc() {},
      snapshot: () => ({ uptimeSec: 10, counters: {}, latency: {} }),
    },
    tools: { run: async () => ({ ok: true, text: 'search result' }) },
    reminders: {
      list: () => [],
      add: async () => ({ ok: true, item: { id: 1, at: Date.now() + 60_000, text: 'x' } }),
      remove: async () => ({ id: 1 }),
    },
    compaction: { compactIfNeeded: async () => ({ changed: false }) },
    tavily: null,
    validator: { validate: async () => ({ ok: true }), download: async () => ({ ok: true }) },
    commands: { parseCommand: () => null },
    agent: { collect: async () => ({ text: 'Answer text', photos: [] }) },
  };
}

function makeCommands() {
  const config = makeConfig();
  const platform = makePlatform();
  const runtime = makeRuntime();
  const commands = createCommandRuntime({ config, logger: silentLogger, metrics: runtime.metrics, platform, runtime });
  return { commands, runtime, platform };
}

/**
 * @param {string} name
 * @param {Record<string, any>} [options]
 * @param {Record<string, any>} [overrides]
 */
function interaction(name, options = {}, overrides = {}) {
  const replies = [];
  const edits = [];
  const follows = [];
  const values = new Map(Object.entries(options));
  return {
    commandName: name,
    guildId: 'g1',
    channelId: 'c1',
    user: { id: 'u1', username: 'user' },
    member: { displayName: 'User' },
    memberPermissions: { has: () => true },
    createdTimestamp: Date.now(),
    isChatInputCommand: () => true,
    isMessageContextMenuCommand: () => false,
    options: {
      getString: (key) => values.get(key) ?? null,
      getBoolean: (key) => values.get(key) ?? null,
      getInteger: (key) => values.get(key) ?? null,
      getSubcommand: () => values.get('__sub') ?? null,
      getFocused: () => '',
    },
    async reply(payload) {
      replies.push(payload);
      this.replied = true;
    },
    async deferReply(payload) {
      this.deferred = true;
      this.deferPayload = payload;
    },
    async editReply(payload) {
      edits.push(payload);
    },
    async followUp(payload) {
      follows.push(payload);
    },
    async update(payload) {
      edits.push(payload);
    },
    replies,
    edits,
    follows,
    ...overrides,
  };
}

test('/help replies with a native ephemeral embed', async () => {
  const { commands } = makeCommands();
  const i = interaction('help');
  await commands.handleCommand(i);
  assert.equal(i.replies.length, 1);
  assert.ok(i.replies[0].flags);
  assert.match(i.replies[0].embeds[0].data.title, /commands/i);
  assert.match(JSON.stringify(i.replies[0].embeds[0].data), /\/ask/);
});

test('/ask runs the engine through the capture runner and adds buttons', async () => {
  const { commands } = makeCommands();
  const i = interaction('ask', { prompt: 'hello', private: true });
  await commands.handleCommand(i);
  assert.equal(i.deferred, true);
  assert.equal(i.edits[0].content, 'Answer text');
  const customId = i.edits[0].components[0].components[0].data.custom_id;
  assert.match(customId, /^ask:regen:/);
});

test('/ping reports the gateway and roundtrip latency', async () => {
  const { commands } = makeCommands();
  const i = interaction('ping');
  await commands.handleCommand(i);
  assert.match(i.replies[0].content, /gateway 12ms/);
});

test('/search returns an embed from the shared tool', async () => {
  const { commands } = makeCommands();
  const i = interaction('search', { query: 'gold price', private: true });
  await commands.handleCommand(i);
  assert.equal(i.deferred, true);
  assert.match(i.edits[0].embeds[0].data.description, /search result/);
});

test('/remind add uses Discord timestamps', async () => {
  const { commands } = makeCommands();
  const i = interaction('remind', { __sub: 'add', when: '+10m', text: 'drink water' });
  await commands.handleCommand(i);
  assert.match(i.replies[0].content, /<t:\d+:f>/);
  assert.match(i.replies[0].content, /drink water/);
});

test('buttons reject another user', async () => {
  const { commands } = makeCommands();
  const i = interaction('ask', { prompt: 'hello' });
  await commands.handleCommand(i);
  const customId = i.edits[0].components[0].components[0].data.custom_id;
  const other = interaction('', {}, { customId, user: { id: 'u2', username: 'other' } });
  await commands.handleButton(other);
  assert.match(other.replies[0].content, /not your conversation/);
});
