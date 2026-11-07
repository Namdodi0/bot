import { createCommandRuntime } from '../src/platforms/discord/commands.js';
import { makeConfig, silentLogger } from './helpers.js';

export function makeDiscordCommandPlatform() {
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
    stickers: {
      enabled: true,
      list: async () => [{ id: '123456789012345678', name: 'wave', tags: [] }],
      resolve: async () => ({ id: '123456789012345678', name: 'wave' }),
      send: async () => {},
    },
    healthServices: ['tavily'],
    explainError: () => null,
  };
}

export function makeDiscordCommandRuntime() {
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
        { alias: 'nim', label: 'NIM', provider: 'nim', model: 'nvidia/model', vision: true },
        { alias: 'mistral-large', label: 'Mistral Large', provider: 'nim', model: 'mistralai/model', vision: true },
      ],
      find: (value) =>
        ({
          nim: { alias: 'nim', label: 'NIM', provider: 'nim', model: 'nvidia/model', vision: true },
          'mistral-large': {
            alias: 'mistral-large',
            label: 'Mistral Large',
            provider: 'nim',
            model: 'mistralai/model',
            vision: true,
          },
        })[String(value)] ?? null,
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
    validator: {
      validate: async () => ({ ok: true }),
      download: async () => ({ ok: true, data: Buffer.from('image'), contentType: 'image/png' }),
    },
    commands: { parseCommand: () => null },
    agent: {
      collect: async () => ({ text: 'Answer text', photos: [] }),
      stream: async (_event, options = {}) => {
        options.onDelta?.('Answer ');
        options.onDelta?.('text');
        return { text: 'Answer text', photos: [] };
      },
      exclusive: async (_chatId, task) => task(),
      rateLimited: () => false,
      stop: () => true,
    },
  };
}

export function makeDiscordCommands() {
  const config = makeConfig();
  const platform = makeDiscordCommandPlatform();
  const runtime = makeDiscordCommandRuntime();
  const commands = createCommandRuntime({ config, logger: silentLogger, metrics: runtime.metrics, platform, runtime });
  return { commands, runtime, platform, config };
}

/**
 * Fake Discord interaction: records replies/edits/followUps and resolves option values
 * from `options`, with per-test overrides for customIds, values, channels, messages and
 * lifecycle predicates.
 * @param {string} name
 * @param {Record<string, any>} [options]
 * @param {Record<string, any>} [overrides]
 */
export function makeInteraction(name, options = {}, overrides = {}) {
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
    isModalSubmit: () => false,
    async showModal(modal) {
      this.modal = modal;
      this.replied = true;
    },
    options: {
      getString: (key) => values.get(key) ?? null,
      getBoolean: (key) => values.get(key) ?? null,
      getInteger: (key) => values.get(key) ?? null,
      getAttachment: (key) => values.get(key) ?? null,
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
