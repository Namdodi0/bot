/**
 * Single source of truth for the config keys `loadConfig` understands. Parsing and defaults
 * stay in config.js / the platform config modules; this file only lists what exists so the
 * typo report, examples and platform parsers cannot drift apart.
 */

const TOP_LEVEL_KEYS = [
  'dataDir',
  'tone',
  'typing',
  'typingIntervalMs',
  'progressive',
  'progressiveAfterMs',
  'maxMessagesPerReply',
  'maxQueueDepth',
  'maxConcurrentChats',
  'maxConcurrentPerChat',
  'userRateLimitPerMinute',
  'userRateLimits',
  'responseTimeoutMs',
  'logLevel',
  'logThinking',
  'logFormat',
  'logColor',
  'opsPort',
];

const SECTION_KEYS = {
  discord: ['guildId', 'allowedChannelIds', 'respondToAllChannelIds', 'stickers', 'presence'],
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
    'samplingDefaultsModels',
    'reasoningBudget',
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
  abliteration: [
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
};

const NESTED_SECTION_KEYS = {
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

export const DISCORD_SECTION_KEYS = KNOWN_SECTION_KEYS.discord;
