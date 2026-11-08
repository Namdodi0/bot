import { createSilentLogger } from '../src/core/logger.js';
import { normalizeWhitespace } from '../src/core/text/format.js';
import { registerDiscordPrompt } from '../src/platforms/discord/prompt.js';
import { COMMANDS as DISCORD_COMMANDS, HELP_NOTE as DISCORD_HELP_NOTE } from '../src/platforms/discord/specs.js';

export const silentLogger = createSilentLogger();

/**
 * Minimal config used by the agent/commands tests.
 * @param {Record<string, any>} [overrides]
 */
export function makeConfig(overrides = {}) {
  const base = {
    help: false,
    platform: 'discord',
    nim: {
      apiKey: 'test-nim-key',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      model: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
      ultraModel: 'nvidia/nemotron-3-ultra-550b-a55b',
      fallbackModel: 'nvidia/nemotron-3.5-lightning-30b-a3b',
      temperature: 0.6,
      timeoutMs: 5000,
    },
    deepseek: {
      apiKey: 'test-deepseek-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      proModel: 'deepseek-v4-pro',
      temperature: 0.6,
      timeoutMs: 5000,
    },
    model: { defaultAlias: 'deepseek', fallbackAlias: 'nim-light' },
    ai: { reasoning: 'none', maxTokens: null, maxToolRounds: 3, timeoutMs: 5000 },
    responseTimeoutMs: 8000,
    context: {
      dir: './data/test',
      maxTokens: 6000,
      maxMessages: 40,
      maxCharsPerMessage: 12000,
      ttlHours: 72,
      summary: true,
      modelWindow: 0,
      compactThreshold: 0.8,
      keepRecent: 8,
      summaryMaxChars: 1200,
      toolResultKeepChars: 600,
    },
    search: {
      enabled: true,
      auto: true,
      apiKey: 'test-tavily',
      baseUrl: 'https://api.tavily.com',
      depth: 'fast',
      maxResults: 4,
      country: 'vietnam',
      cacheTtlMs: 600000,
    },
    image: { enabled: true },
    sticker: { enabled: true, echo: true, file: './data/test/stickers.json' },
    tone: 'friendly',
    typing: false,
    typingIntervalMs: 4000,
    progressive: 'off',
    progressiveAfterMs: 3000,
    maxMessagesPerReply: 3,
    maxQueueDepth: 50,
    userRateLimitPerMinute: 0,
    logLevel: 'silent',
    dataDir: './data/test',
    opsPort: null,
    dryRun: false,
    once: false,
  };
  return {
    ...base,
    ...overrides,
    nim: { ...base.nim, ...(overrides.nim ?? {}) },
    deepseek: { ...base.deepseek, ...(overrides.deepseek ?? {}) },
    model: { ...base.model, ...(overrides.model ?? {}) },
    ai: { ...base.ai, ...(overrides.ai ?? {}) },
    context: { ...base.context, ...(overrides.context ?? {}) },
    search: { ...base.search, ...(overrides.search ?? {}) },
  };
}

/**
 * @param {Record<string, any>} [overrides]
 */
export function makeTransport(overrides = {}) {
  const transport = {
    displayName: 'Bot deepseek',
    sendMessage: async () => ({ ok: true }),
    sendPhoto: async () => ({ ok: true }),
    sendSticker: async (chatId, stickerId) => {
      transport.lastSticker = { chatId, stickerId };
      return { ok: true };
    },
    lastSticker: null,
    startTyping: () => () => {},
    stopAllTyping: () => {},
    ping: async () => 5,
    ...overrides,
  };
  return transport;
}

/**
 * Discord platform double for engine tests.
 * @param {{transport?: any, overrides?: Record<string, any>}} [input]
 */
export function makeDiscordPlatform(input = {}) {
  const transport = input.transport ?? makeTransport();
  return {
    name: 'discord',
    label: 'Discord',
    transport,
    transportMode: 'gateway',
    capabilities: {
      stickers: false,
      uploadMedia: true,
      nativeInteractions: true,
      messageEdits: true,
      embeds: true,
      threads: true,
    },
    limits: { text: 2000, caption: 2000 },
    formatOutgoing: (text) => normalizeWhitespace(String(text ?? '')),
    isAdmin: (event) => event?.isAdmin === true,
    prompt: { register: registerDiscordPrompt },
    commands: {
      specs: DISCORD_COMMANDS,
      helpNote: DISCORD_HELP_NOTE,
      run: async () => undefined,
    },
    stickers: {
      enabled: true,
      list: async () => [{ id: '1', name: 'wave', tags: [] }],
      resolve: async () => ({ id: '1', name: 'wave' }),
      send: async () => {},
    },
    tools: {
      definitions: () => [
        {
          type: 'function',
          function: {
            name: 'send_sticker',
            description: 'Send a server sticker',
            parameters: { type: 'object', properties: { emotion: { type: 'string' } }, required: ['emotion'] },
          },
        },
      ],
      run: async (name) => (name === 'send_sticker' ? { ok: true, text: 'Sent the sticker "wave".' } : null),
    },
    healthServices: ['tavily'],
    explainError: () => null,
    start: async () => ({ ready: {}, done: Promise.resolve() }),
    stop: async () => {},
    ...(input.overrides ?? {}),
  };
}

/** @param {string} text */
export function textEvent(text, overrides = {}) {
  return {
    kind: 'text',
    chatId: 'chat-1',
    chatType: 'GROUP',
    senderId: 'user-1',
    senderName: 'Nam',
    isBot: false,
    text,
    imageUrl: null,
    sticker: null,
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    date: Date.now(),
    eventName: 'message.text.received',
    ...overrides,
  };
}
