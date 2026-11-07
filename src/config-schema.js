/**
 * Single source of truth for the config keys `loadConfig` understands. Parsing and defaults
 * stay in config.js / the platform config modules; this file only lists what exists so the
 * typo report, examples and platform parsers cannot drift apart.
 */

export const TOP_LEVEL_KEYS = [
  'platform',
  'mode',
  'dataDir',
  'allowedChatIds',
  'adminIds',
  'tone',
  'typing',
  'typingIntervalMs',
  'progressive',
  'progressiveAfterMs',
  'maxMessagesPerReply',
  'maxQueueDepth',
  'maxConcurrentChats',
  'userRateLimitPerMinute',
  'userRateLimits',
  'responseTimeoutMs',
  'logLevel',
  'logThinking',
  'logFormat',
  'logColor',
  'opsPort',
];

export const SECTION_KEYS = {
  zalo: ['botId', 'baseUrl', 'parseMode'],
  discord: ['guildId', 'allowedChannelIds', 'respondToAllChannelIds', 'stickers', 'presence'],
  webhook: ['port', 'host', 'path', 'secret', 'publicUrl'],
  nim: [
    'baseUrl',
    'model',
    'ultraModel',
    'fallbackModel',
    'mistralModel',
    'glmModel',
    'temperature',
    'visionTemperature',
    'visionTimeoutMs',
    'timeoutMs',
    'topP',
    'topK',
    'minP',
    'repetitionPenalty',
    'frequencyPenalty',
    'presencePenalty',
    'seed',
  ],
  deepseek: [
    'baseUrl',
    'model',
    'proModel',
    'temperature',
    'timeoutMs',
    'topP',
    'frequencyPenalty',
    'presencePenalty',
    'seed',
  ],
  refuseless: [
    'baseUrl',
    'model',
    'temperature',
    'timeoutMs',
    'topP',
    'frequencyPenalty',
    'presencePenalty',
    'seed',
  ],
  model: ['defaultAlias', 'fallbackAlias', 'visionAlias', 'visionReasoning'],
  ai: ['reasoning', 'maxTokens', 'maxToolRounds'],
  context: [
    'maxTokens',
    'maxMessages',
    'maxCharsPerMessage',
    'ttlHours',
    'summary',
    'modelWindow',
    'compactThreshold',
    'keepRecent',
    'summaryMaxChars',
    'toolResultKeepChars',
  ],
  search: ['enabled', 'auto', 'baseUrl', 'depth', 'maxResults', 'country', 'cacheTtlMs'],
  image: ['enabled'],
  sticker: ['enabled', 'echo', 'ids'],
};

export const NESTED_SECTION_KEYS = {
  'discord.stickers': ['enabled', 'ids'],
  'discord.presence': ['status', 'type', 'text', 'url'],
};

export const KNOWN_TOP_LEVEL_KEYS = new Set(TOP_LEVEL_KEYS);

/** @type {Record<string, Set<string>>} */
export const KNOWN_SECTION_KEYS = Object.fromEntries(
  Object.entries(SECTION_KEYS).map(([name, keys]) => [name, new Set(keys)]),
);

/** @type {Record<string, Set<string>>} */
export const KNOWN_NESTED_SECTION_KEYS = Object.fromEntries(
  Object.entries(NESTED_SECTION_KEYS).map(([name, keys]) => [name, new Set(keys)]),
);

export const ZALO_SECTION_KEYS = KNOWN_SECTION_KEYS.zalo;
export const DISCORD_SECTION_KEYS = KNOWN_SECTION_KEYS.discord;
export const WEBHOOK_SECTION_KEYS = KNOWN_SECTION_KEYS.webhook;
export const STICKER_SECTION_KEYS = KNOWN_SECTION_KEYS.sticker;
