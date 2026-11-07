import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_ALIAS, FALLBACK_ALIAS, MODEL_ALIASES, isKnownAlias } from './core/ai/models.js';
import {
  ConfigError,
  asBool,
  asInt,
  asNumber,
  asOptionalInt,
  asOptionalNumber,
  asString,
  section,
} from './core/config-helpers.js';
import { KNOWN_NESTED_SECTION_KEYS, KNOWN_SECTION_KEYS, KNOWN_TOP_LEVEL_KEYS } from './config-schema.js';
import { parseDiscordConfig } from './platforms/discord/config.js';
import { parseZaloConfig } from './platforms/zalo/config.js';
import { VERSION } from './core/version.js';

/** @typedef {'polling'|'webhook'} TransportMode */
/** @typedef {'none'|'low'|'medium'|'high'|'auto'} ReasoningMode */
/** @typedef {'auto'|'on'|'off'} ProgressiveMode */

export { ConfigError };

// Root directory of the repo, derived from this file (src/..) — NOT dependent on cwd.
// Panel/pm2/systemd may start the bot with a different cwd, which makes a relative dataDir
// point at a brand-new directory and the context "disappear" after every restart.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');

/** Settings that used to live in .env. They are ignored now; warn so old deployments migrate. */
const LEGACY_ENV_KEYS = new Set([
  'MODE',
  'AI_REASONING',
  'NIM_REASONING',
  'PROGRESSIVE',
  'LOG_FORMAT',
  'LOG_COLOR',
  'LOG_LEVEL',
  'LOG_THINKING',
  'NIM_MAX_TOKENS',
  'MODEL_DEFAULT',
  'MODEL_FALLBACK',
  'SEARCH_ENABLED',
  'SEARCH_AUTO',
  'SEARCH_DEPTH',
  'SEARCH_MAX_RESULTS',
  'SEARCH_COUNTRY',
  'SEARCH_CACHE_TTL_MS',
  'DATA_DIR',
  'ZALO_BOT_ID',
  'ZALO_BASE_URL',
  'ZALO_PARSE_MODE',
  'ALLOWED_CHAT_IDS',
  'ADMIN_IDS',
  'WEBHOOK_PORT',
  'WEBHOOK_HOST',
  'WEBHOOK_PATH',
  'WEBHOOK_PUBLIC_URL',
  'WEBHOOK_SECRET',
  'NIM_BASE_URL',
  'NIM_MODEL',
  'NIM_ULTRA_MODEL',
  'NIM_FALLBACK_MODEL',
  'NIM_TEMPERATURE',
  'NIM_TIMEOUT_MS',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_MODEL',
  'DEEPSEEK_PRO_MODEL',
  'DEEPSEEK_TEMPERATURE',
  'DEEPSEEK_TIMEOUT_MS',
  'TAVILY_BASE_URL',
  'RESPONSE_TIMEOUT_MS',
  'CONTEXT_MAX_TOKENS',
  'CONTEXT_MAX_MESSAGES',
  'CONTEXT_MAX_CHARS_PER_MESSAGE',
  'CONTEXT_TTL_HOURS',
  'CONTEXT_SUMMARY',
  'CONTEXT_MODEL_WINDOW',
  'CONTEXT_COMPACT_THRESHOLD',
  'CONTEXT_KEEP_RECENT',
  'CONTEXT_SUMMARY_MAX_CHARS',
  'CONTEXT_TOOL_RESULT_KEEP_CHARS',
  'IMAGE_ENABLED',
  'STICKER_ENABLED',
  'STICKER_ECHO',
  'STICKER_IDS',
  'BOT_TONE',
  'TYPING',
  'TYPING_INTERVAL_MS',
  'PROGRESSIVE_AFTER_MS',
  'MAX_MESSAGES_PER_REPLY',
  'MAX_QUEUE_DEPTH',
  'USER_RATE_LIMIT_PER_MINUTE',
  'OPS_PORT',
]);

/**
 * A dataDir inside a temp directory is guaranteed to be lost on restart/redeploy.
 * @param {string} dir
 */
export function isEphemeralDataDir(dir) {
  const normalized = String(dir).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return (
    normalized === '/tmp' ||
    normalized.startsWith('/tmp/') ||
    normalized === '/var/tmp' ||
    normalized.startsWith('/var/tmp/') ||
    normalized.endsWith('/temp') ||
    normalized.includes('/temp/') ||
    normalized.includes('/appdata/local/temp')
  );
}

/** @param {string} file */
function readConfigFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') return null;
    throw new ConfigError(`Could not read config file ${file}: ${/** @type {any} */ (error)?.message ?? error}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`Could not parse ${file}: ${/** @type {any} */ (error)?.message ?? error}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`${file} must contain a JSON object`);
  }
  return /** @type {Record<string, any>} */ (parsed);
}

/** Shorten a secret so it is safe to print in logs. */
export function maskSecret(value) {
  if (!value) return '(empty)';
  const text = String(value);
  if (text.length <= 10) return '***';
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

/** List the secrets that must be redacted in logs. */
export function collectSecrets(config) {
  return [
    config.zalo.token,
    config.nim.apiKey,
    config.deepseek.apiKey,
    config.refuseless?.apiKey,
    config.search.apiKey,
    config.search.firecrawlApiKey,
    config.discord?.token,
    config.webhook.secret,
  ].filter(Boolean);
}

/**
 * Dotted names of settings that config.js never reads. Reported at startup (never fatal):
 * a typo like `allowChatIds` would otherwise silently leave `allowedChatIds` empty.
 * The key sets live in config-schema.js so parsers, examples and this check stay in sync.
 * @param {Record<string, any>} root
 */
export function collectUnknownConfigKeys(root) {
  /** @type {string[]} */
  const unknown = [];
  for (const key of Object.keys(root ?? {})) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key) && !Object.hasOwn(KNOWN_SECTION_KEYS, key)) unknown.push(key);
  }
  for (const [name, known] of Object.entries(KNOWN_SECTION_KEYS)) {
    const value = root?.[name];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const key of Object.keys(value)) {
      if (!known.has(key)) unknown.push(`${name}.${key}`);
    }
  }
  for (const [prefix, known] of Object.entries(KNOWN_NESTED_SECTION_KEYS)) {
    const [name, nested] = prefix.split('.');
    const parent = root?.[name];
    if (!parent || typeof parent !== 'object' || Array.isArray(parent)) continue;
    const value = parent[nested];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const key of Object.keys(value)) {
      if (!known.has(key)) unknown.push(`${prefix}.${key}`);
    }
  }
  return unknown.sort();
}

/** @type {import('node:util').ParseArgsOptionsConfig} */
const CLI_OPTIONS = {
  config: { type: 'string' },
  model: { type: 'string' },
  mode: { type: 'string' },
  think: { type: 'string' },
  'max-tokens': { type: 'string' },
  'no-search': { type: 'boolean' },
  'no-typing': { type: 'boolean' },
  'no-progressive': { type: 'boolean' },
  progressive: { type: 'string' },
  verbose: { type: 'boolean' },
  json: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  once: { type: 'boolean' },
  help: { type: 'boolean' },
};

export const HELP_TEXT = `zalo-group-bot — Zalo bot for group chats (DeepSeek / NVIDIA NIM + Tavily)

Usage: node index.js [flags]
  Secrets are read from .env; non-secret settings from config.json.

Flags:
  --config <path>    Config file (default: config.json in the repo root)
  --model <alias>    Default model: deepseek | pro | nim | ultra | nim-light | ds-abl-free
  --mode <m>         polling | webhook
  --think <mode>     none | low | medium | high | auto
  --max-tokens <n>   Cap on generated tokens (empty = unlimited)
  --progressive <m>  auto | on | off  (send chunked replies on slow answers)
  --no-progressive   Disable chunked replies
  --no-search        Disable web search
  --no-typing        Do not send the "typing" status
  --dry-run          Do not send real messages (log only)
  --once             Handle a single update then exit (for testing)
  --verbose          Debug-level logging
  --json             JSON logs (default is pretty, with colors + icons)
  --help             Print this help

Secrets: ZALO_BOT_TOKEN, NIM_API_KEY, DEEPSEEK_API_KEY, TAVILY_API_KEY (see .env.example).
Settings: see config.example.json.`;

/**
 * @param {{argv?: string[], env?: Record<string, unknown>, cwd?: string, config?: Record<string, any>, configPath?: string}} [input]
 */
export function loadConfig(input = {}) {
  const argv = input.argv ?? process.argv.slice(2);
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();

  const { values } = parseArgs({
    args: argv,
    options: CLI_OPTIONS,
    allowPositionals: true,
    strict: false,
  });
  const cli = /** @type {Record<string, any>} */ (values);

  if (cli.help) {
    return /** @type {any} */ ({ help: true });
  }

  // An explicit --config always wins: entries that pass their own default path
  // (config.discord.json) must still honour the flag.
  const explicitConfigPath = cli.config ? path.resolve(cwd, String(cli.config)) : (input.configPath ?? null);
  const configPath = explicitConfigPath ?? DEFAULT_CONFIG_PATH;
  let root;
  let configFileFound;
  if (input.config !== undefined) {
    root = input.config;
    configFileFound = true;
  } else {
    const loaded = readConfigFile(configPath);
    if (!loaded && explicitConfigPath) {
      throw new ConfigError(`Config file not found: ${configPath}`);
    }
    root = loaded ?? {};
    configFileFound = loaded !== null;
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new ConfigError('config must be a JSON object');
  }

  const legacyEnvKeys = [...LEGACY_ENV_KEYS]
    .filter((key) => env[key] !== undefined && env[key] !== '')
    .sort();
  if (legacyEnvKeys.length && !configFileFound) {
    throw new ConfigError(
      `Non-secret settings found in the environment/.env but config.json is missing. ` +
        `Move them to config.json (copy config.example.json): ${legacyEnvKeys.join(', ')}`,
    );
  }

  const nimSection = section(root, 'nim');
  const deepseekSection = section(root, 'deepseek');
  const refuselessSection = section(root, 'refuseless');
  const modelSection = section(root, 'model');
  const aiSection = section(root, 'ai');
  const contextSection = section(root, 'context');
  const searchSection = section(root, 'search');
  const imageSection = section(root, 'image');
  const stickerSection = section(root, 'sticker');

  const platform = asString(root.platform, 'config.platform', 'zalo').toLowerCase();
  if (!['zalo', 'discord'].includes(platform)) {
    throw new ConfigError(`config.platform must be "zalo" or "discord" (got: "${platform}")`);
  }

  const dataDirRaw = asString(root.dataDir, 'config.dataDir', './data') || './data';
  const dataDir = path.isAbsolute(dataDirRaw)
    ? path.normalize(dataDirRaw)
    : path.resolve(PROJECT_ROOT, dataDirRaw);

  // Both sections are parsed regardless of `platform` so the config object keeps the same
  // shape for every entry point; only the missing-token policy depends on the platform.
  const zaloConfig = parseZaloConfig({ root, env, cli, dataDir });
  const { discord } = parseDiscordConfig({ root, env });

  if (platform === 'zalo' && !zaloConfig.token) {
    throw new ConfigError('Missing ZALO_BOT_TOKEN (see .env.example)');
  }
  const nimKey = asString(env.NIM_API_KEY, 'NIM_API_KEY');
  const deepseekKey = asString(env.DEEPSEEK_API_KEY, 'DEEPSEEK_API_KEY');
  const refuselessKey = asString(env.REFUSELESS_API_KEY, 'REFUSELESS_API_KEY');
  const tavilyKey = asString(env.TAVILY_API_KEY, 'TAVILY_API_KEY');
  const firecrawlKey = asString(env.FIRECRAWL_API_KEY, 'FIRECRAWL_API_KEY');
  if (platform === 'discord' && !discord.token) {
    throw new ConfigError('Missing DISCORD_BOT_TOKEN (required when config.platform is "discord")');
  }

  const mode = zaloConfig.mode;

  const reasoning = String(
    cli.think ?? asString(aiSection.reasoning, 'config.ai.reasoning', 'none'),
  ).toLowerCase();
  if (!['none', 'low', 'medium', 'high', 'auto'].includes(reasoning)) {
    throw new ConfigError(`config.ai.reasoning must be none|low|medium|high|auto (got: "${reasoning}")`);
  }

  let progressive = String(
    cli['no-progressive'] ? 'off' : cli.progressive ?? asString(root.progressive, 'config.progressive', 'auto'),
  ).toLowerCase();
  if (!['auto', 'on', 'off'].includes(progressive)) {
    throw new ConfigError(`config.progressive must be auto|on|off (got: "${progressive}")`);
  }

  const logFormat = String(cli.json ? 'json' : asString(root.logFormat, 'config.logFormat', 'pretty')).toLowerCase();
  if (!['pretty', 'json'].includes(logFormat)) {
    throw new ConfigError(`config.logFormat must be pretty or json (got: "${logFormat}")`);
  }

  const logColor = asString(root.logColor, 'config.logColor', 'auto').toLowerCase();
  if (!['auto', 'always', 'never'].includes(logColor)) {
    throw new ConfigError(`config.logColor must be auto|always|never (got: "${logColor}")`);
  }

  const maxTokensRaw = cli['max-tokens'] !== undefined ? cli['max-tokens'] : aiSection.maxTokens;
  let maxTokens = null;
  if (maxTokensRaw !== undefined && maxTokensRaw !== null && maxTokensRaw !== '') {
    const parsed = asInt(maxTokensRaw, 'config.ai.maxTokens', 0, { min: 0 });
    // 0 = unlimited (same as leaving it empty)
    maxTokens = parsed === 0 ? null : parsed;
  }

  const defaultAlias = String(cli.model ?? asString(modelSection.defaultAlias, 'config.model.defaultAlias', DEFAULT_ALIAS)).toLowerCase();
  if (!isKnownAlias(defaultAlias)) {
    throw new ConfigError(
      `config.model.defaultAlias is invalid (got: "${defaultAlias}"). Choose: ${Object.keys(MODEL_ALIASES).join(', ')}`,
    );
  }
  let fallbackAlias = String(
    asString(modelSection.fallbackAlias, 'config.model.fallbackAlias', FALLBACK_ALIAS),
  ).toLowerCase();
  if (!isKnownAlias(fallbackAlias)) {
    throw new ConfigError(
      `config.model.fallbackAlias is invalid (got: "${fallbackAlias}"). Choose: ${Object.keys(MODEL_ALIASES).join(', ')}`,
    );
  }
  const visionAlias = asString(modelSection.visionAlias, 'config.model.visionAlias', 'nim').toLowerCase();
  if (!isKnownAlias(visionAlias)) {
    throw new ConfigError(
      `config.model.visionAlias is invalid (got: "${visionAlias}"). Choose: ${Object.keys(MODEL_ALIASES).join(', ')}`,
    );
  }
  if (MODEL_ALIASES[visionAlias].vision !== true) {
    throw new ConfigError(
      `config.model.visionAlias must point to a vision-capable alias (got: "${visionAlias}"). Choose: ${Object.keys(MODEL_ALIASES).filter((alias) => MODEL_ALIASES[alias].vision === true).join(', ')}`,
    );
  }
  // Image turns use their own reasoning level; the highest is "high" (providers cap here).
  const visionReasoning = String(
    asString(modelSection.visionReasoning, 'config.model.visionReasoning', 'high'),
  ).toLowerCase();
  if (!['none', 'low', 'medium', 'high', 'auto'].includes(visionReasoning)) {
    throw new ConfigError(
      `config.model.visionReasoning must be none|low|medium|high|auto (got: "${visionReasoning}")`,
    );
  }
  if (fallbackAlias === defaultAlias) {
    fallbackAlias = defaultAlias === 'nim-light' ? 'deepseek' : 'nim-light';
  }

  // Only the provider actually used as the primary needs a key. The fallback is optional:
  // when its provider has no key the model catalog simply drops that alias and picks another
  // available model (or no distinct fallback), instead of refusing to start.
  const primaryProvider = MODEL_ALIASES[defaultAlias].provider;
  if (primaryProvider === 'nim' && !nimKey) {
    throw new ConfigError('Missing NIM_API_KEY (used as the primary model)');
  }
  if (primaryProvider === 'deepseek' && !deepseekKey) {
    throw new ConfigError('Missing DEEPSEEK_API_KEY (see .env.example)');
  }
  if (primaryProvider === 'refuseless' && !refuselessKey) {
    throw new ConfigError('Missing REFUSELESS_API_KEY (used as the primary model)');
  }

  const searchEnabled = cli['no-search'] ? false : asBool(searchSection.enabled, 'config.search.enabled', true);
  if (searchEnabled && !tavilyKey && !firecrawlKey) {
    throw new ConfigError(
      'config.search.enabled is true but TAVILY_API_KEY and FIRECRAWL_API_KEY are missing (or use --no-search)',
    );
  }

  const depthRaw = asString(searchSection.depth, 'config.search.depth', 'fast');
  if (!['fast', 'basic', 'advanced', 'ultra-fast'].includes(depthRaw)) {
    throw new ConfigError(`config.search.depth must be fast|basic|advanced|ultra-fast (got: "${depthRaw}")`);
  }

  const compactThreshold = asNumber(contextSection.compactThreshold, 'config.context.compactThreshold', 0.8);
  if (!(compactThreshold > 0 && compactThreshold <= 1)) {
    throw new ConfigError(`config.context.compactThreshold must be within (0, 1] (got: "${compactThreshold}")`);
  }

  const toneRaw = asString(root.tone, 'config.tone', 'roast-hard').toLowerCase();
  const toneAlias = {
    max: 'roast-extreme',
    extreme: 'roast-extreme',
    cuc: 'roast-extreme',
    'c\u1EF1c': 'roast-extreme',
    'sieu-nang': 'roast-extreme',
    hard: 'roast-hard',
    nang: 'roast-hard',
    'n\u1EB7ng': 'roast-hard',
    cay: 'roast',
    cakhia: 'roast',
    cute: 'shy',
    timid: 'shy',
    ngai: 'shy',
    'ng\u1EA1i': 'shy',
  };
  const tone = toneAlias[toneRaw] ?? toneRaw;
  if (!['friendly', 'shy', 'grok', 'unhinged', 'roast', 'roast-hard', 'roast-extreme'].includes(tone)) {
    throw new ConfigError(`config.tone must be friendly, shy, grok, unhinged, roast, roast-hard or roast-extreme (got: "${toneRaw}")`);
  }

  const nimTopP = asOptionalNumber(nimSection.topP, 'config.nim.topP', { min: 0, max: 1 }) ?? 0.9;
  if (nimTopP !== null && nimTopP <= 0) {
    throw new ConfigError('config.nim.topP must be within (0, 1]');
  }
  // NVIDIA recommends 0.6 for image/video input and 1.0 for text.
  const nimVisionTemperature =
    asOptionalNumber(nimSection.visionTemperature, 'config.nim.visionTemperature', { min: 0, max: 2 }) ?? 0.6;
  // Vision turns get their own wall-clock cap: a stalled 120B VL request must not hold
  // the chat for minutes. 0 disables the cap and falls back to the turn deadline.
  const nimVisionTimeoutMs = /** @type {number} */ (
    asInt(nimSection.visionTimeoutMs, 'config.nim.visionTimeoutMs', 60_000, { min: 0 })
  );
  // Cut the long tail of low-probability tokens (a common source of language drift).
  const nimTopK = asOptionalInt(nimSection.topK, 'config.nim.topK', { min: -1 }) ?? 40;
  const nimMinP = asOptionalNumber(nimSection.minP, 'config.nim.minP', { min: 0, max: 1 });
  const nimRepetitionPenalty = asOptionalNumber(nimSection.repetitionPenalty, 'config.nim.repetitionPenalty', {
    min: 0,
    max: 2,
  });
  if (nimRepetitionPenalty !== null && nimRepetitionPenalty <= 0) {
    throw new ConfigError('config.nim.repetitionPenalty must be within (0, 2]');
  }
  const nimFrequencyPenalty =
    asOptionalNumber(nimSection.frequencyPenalty, 'config.nim.frequencyPenalty', { min: -2, max: 2 }) ?? 0;
  const nimPresencePenalty =
    asOptionalNumber(nimSection.presencePenalty, 'config.nim.presencePenalty', { min: -2, max: 2 }) ?? 0;
  const nimSeed = asOptionalInt(nimSection.seed, 'config.nim.seed', { min: 0 });

  const deepseekTopP =
    asOptionalNumber(deepseekSection.topP, 'config.deepseek.topP', { min: 0, max: 1 }) ?? 0.9;
  if (deepseekTopP !== null && deepseekTopP <= 0) {
    throw new ConfigError('config.deepseek.topP must be within (0, 1]');
  }
  const deepseekFrequencyPenalty =
    asOptionalNumber(deepseekSection.frequencyPenalty, 'config.deepseek.frequencyPenalty', { min: -2, max: 2 }) ?? 0;
  const deepseekPresencePenalty =
    asOptionalNumber(deepseekSection.presencePenalty, 'config.deepseek.presencePenalty', { min: -2, max: 2 }) ?? 0;
  const deepseekSeed = asOptionalInt(deepseekSection.seed, 'config.deepseek.seed', { min: 0 });

  const refuselessTopP =
    asOptionalNumber(refuselessSection.topP, 'config.refuseless.topP', { min: 0, max: 1 }) ?? 0.9;
  if (refuselessTopP !== null && refuselessTopP <= 0) {
    throw new ConfigError('config.refuseless.topP must be within (0, 1]');
  }
  const refuselessFrequencyPenalty =
    asOptionalNumber(refuselessSection.frequencyPenalty, 'config.refuseless.frequencyPenalty', { min: -2, max: 2 }) ??
    0;
  const refuselessPresencePenalty =
    asOptionalNumber(refuselessSection.presencePenalty, 'config.refuseless.presencePenalty', { min: -2, max: 2 }) ?? 0;
  const refuselessSeed = asOptionalInt(refuselessSection.seed, 'config.refuseless.seed', { min: 0 });

  const unknownConfigKeys = collectUnknownConfigKeys(root);

  /** @type {Record<string, number>} */
  const userRateLimits = {};
  if (root.userRateLimits !== undefined && root.userRateLimits !== null) {
    if (typeof root.userRateLimits !== 'object' || Array.isArray(root.userRateLimits)) {
      throw new ConfigError('config.userRateLimits must be an object mapping user ids to messages per minute');
    }
    for (const [rawId, rawLimit] of Object.entries(root.userRateLimits)) {
      const id = String(rawId).trim();
      if (!id) throw new ConfigError('config.userRateLimits cannot use an empty user id');
      userRateLimits[id] = /** @type {number} */ (asInt(rawLimit, `config.userRateLimits.${id}`, 0, { min: 0 }));
    }
  }

  const config = {
    help: false,
    version: VERSION,
    platform,
    configFile: input.config !== undefined ? null : configPath,
    configFileFound,
    ignoredEnvKeys: legacyEnvKeys,
    unknownConfigKeys,
    zalo: {
      token: zaloConfig.token,
      ...zaloConfig.zalo,
    },
    allowedChatIds: zaloConfig.allowedChatIds,
    adminIds: zaloConfig.adminIds,
    discord,
    mode: /** @type {TransportMode} */ (mode),
    webhook: zaloConfig.webhook,
    nim: {
      apiKey: nimKey,
      baseUrl: asString(nimSection.baseUrl, 'config.nim.baseUrl', 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, ''),
      model: asString(nimSection.model, 'config.nim.model', 'nvidia/nemotron-3.5-super-vl-120b-a12b'),
      ultraModel: asString(nimSection.ultraModel, 'config.nim.ultraModel', 'nvidia/nemotron-3-ultra-550b-a55b'),
      fallbackModel: asString(nimSection.fallbackModel, 'config.nim.fallbackModel', 'nvidia/nemotron-3.5-lightning-30b-a3b'),
      mistralModel: asString(
        nimSection.mistralModel,
        'config.nim.mistralModel',
        'mistralai/mistral-large-4-1t-a52b',
      ),
      temperature: asNumber(nimSection.temperature, 'config.nim.temperature', 0.7, { min: 0, max: 2 }),
      visionTemperature: nimVisionTemperature,
      visionTimeoutMs: nimVisionTimeoutMs,
      // 0 = no request timeout (wait for the provider as long as it needs).
      timeoutMs: /** @type {number} */ (asInt(nimSection.timeoutMs, 'config.nim.timeoutMs', 0, { min: 0 })),
      topP: nimTopP,
      topK: nimTopK,
      minP: nimMinP,
      repetitionPenalty: nimRepetitionPenalty,
      frequencyPenalty: nimFrequencyPenalty,
      presencePenalty: nimPresencePenalty,
      seed: nimSeed,
    },
    deepseek: {
      apiKey: deepseekKey,
      baseUrl: asString(deepseekSection.baseUrl, 'config.deepseek.baseUrl', 'https://api.deepseek.com').replace(/\/+$/, ''),
      model: asString(deepseekSection.model, 'config.deepseek.model', 'deepseek-flash'),
      proModel: asString(deepseekSection.proModel, 'config.deepseek.proModel', 'deepseek-v4-pro'),
      temperature: asNumber(deepseekSection.temperature, 'config.deepseek.temperature', 0.7, { min: 0, max: 2 }),
      timeoutMs: /** @type {number} */ (asInt(deepseekSection.timeoutMs, 'config.deepseek.timeoutMs', 0, { min: 0 })),
      topP: deepseekTopP,
      frequencyPenalty: deepseekFrequencyPenalty,
      presencePenalty: deepseekPresencePenalty,
      seed: deepseekSeed,
    },
    refuseless: {
      apiKey: refuselessKey,
      baseUrl: asString(refuselessSection.baseUrl, 'config.refuseless.baseUrl', 'https://api.refuseless.com/v1').replace(
        /\/+$/,
        '',
      ),
      model: asString(
        refuselessSection.model,
        'config.refuseless.model',
        'deepseek-v4.1-flash-abliterated-free',
      ),
      temperature: asNumber(refuselessSection.temperature, 'config.refuseless.temperature', 0.7, { min: 0, max: 2 }),
      timeoutMs: /** @type {number} */ (asInt(refuselessSection.timeoutMs, 'config.refuseless.timeoutMs', 0, { min: 0 })),
      topP: refuselessTopP,
      frequencyPenalty: refuselessFrequencyPenalty,
      presencePenalty: refuselessPresencePenalty,
      seed: refuselessSeed,
    },
    model: {
      defaultAlias,
      fallbackAlias,
      visionAlias,
      visionReasoning: /** @type {ReasoningMode} */ (visionReasoning),
    },
    ai: {
      reasoning: /** @type {ReasoningMode} */ (reasoning),
      maxTokens,
      // 0 = unlimited tool rounds (the model may keep calling tools until it answers).
      maxToolRounds: /** @type {number} */ (asInt(aiSection.maxToolRounds, 'config.ai.maxToolRounds', 3, { min: 0 })),
    },
    // 0 = no deadline (the bot waits until the provider answers).
    responseTimeoutMs: /** @type {number} */ (asInt(root.responseTimeoutMs, 'config.responseTimeoutMs', 0, { min: 0 })),
    context: {
      dir: path.join(dataDir, 'contexts'),
      // 0 = unlimited
      maxTokens: /** @type {number} */ (asInt(contextSection.maxTokens, 'config.context.maxTokens', 0, { min: 0 })),
      maxMessages: /** @type {number} */ (asInt(contextSection.maxMessages, 'config.context.maxMessages', 0, { min: 0 })),
      maxCharsPerMessage: /** @type {number} */ (
        asInt(contextSection.maxCharsPerMessage, 'config.context.maxCharsPerMessage', 12_000, { min: 0 })
      ),
      ttlHours: /** @type {number} */ (asInt(contextSection.ttlHours, 'config.context.ttlHours', 72, { min: 0 })),
      // ttlHours = 0 → never auto-delete the context
      summary: asBool(contextSection.summary, 'config.context.summary', true),
      // 0 = unknown context window → only compact when the provider reports overflow
      modelWindow: /** @type {number} */ (asInt(contextSection.modelWindow, 'config.context.modelWindow', 0, { min: 0 })),
      compactThreshold,
      keepRecent: /** @type {number} */ (asInt(contextSection.keepRecent, 'config.context.keepRecent', 8, { min: 1 })),
      summaryMaxChars: /** @type {number} */ (
        asInt(contextSection.summaryMaxChars, 'config.context.summaryMaxChars', 1200, { min: 100 })
      ),
      toolResultKeepChars: /** @type {number} */ (
        asInt(contextSection.toolResultKeepChars, 'config.context.toolResultKeepChars', 600, { min: 0 })
      ),
    },
    search: {
      enabled: searchEnabled,
      auto: asBool(searchSection.auto, 'config.search.auto', true),
      apiKey: tavilyKey,
      firecrawlApiKey: firecrawlKey,
      baseUrl: asString(searchSection.baseUrl, 'config.search.baseUrl', 'https://api.tavily.com').replace(/\/+$/, ''),
      depth: /** @type {'fast'|'basic'|'advanced'|'ultra-fast'} */ (depthRaw),
      maxResults: /** @type {number} */ (asInt(searchSection.maxResults, 'config.search.maxResults', 4, { min: 1, max: 10 })),
      country: asString(searchSection.country, 'config.search.country', 'vietnam'),
      cacheTtlMs: /** @type {number} */ (asInt(searchSection.cacheTtlMs, 'config.search.cacheTtlMs', 600_000, { min: 0 })),
    },
    image: {
      enabled: asBool(imageSection.enabled, 'config.image.enabled', true),
    },
    sticker: {
      enabled: asBool(stickerSection.enabled, 'config.sticker.enabled', true),
      // echo the same sticker back when someone sends a sticker to the bot
      echo: asBool(stickerSection.echo, 'config.sticker.echo', true),
      file: zaloConfig.sticker.file,
      extraIds: zaloConfig.sticker.extraIds,
    },
    tone,
    typing: cli['no-typing'] ? false : asBool(root.typing, 'config.typing', true),
    typingIntervalMs: /** @type {number} */ (asInt(root.typingIntervalMs, 'config.typingIntervalMs', 4000, { min: 1000 })),
    progressive: /** @type {ProgressiveMode} */ (progressive),
    progressiveAfterMs: /** @type {number} */ (asInt(root.progressiveAfterMs, 'config.progressiveAfterMs', 3000, { min: 500 })),
    // 0 = unlimited messages per reply
    maxMessagesPerReply: /** @type {number} */ (asInt(root.maxMessagesPerReply, 'config.maxMessagesPerReply', 0, { min: 0 })),
    maxQueueDepth: /** @type {number} */ (asInt(root.maxQueueDepth, 'config.maxQueueDepth', 50, { min: 1, max: 1000 })),
    // 0 = off; enabled by default to block spam that burns API credits
    userRateLimitPerMinute: /** @type {number} */ (
      asInt(root.userRateLimitPerMinute, 'config.userRateLimitPerMinute', 12, { min: 0 })
    ),
    userRateLimits,
    logLevel: cli.verbose ? 'debug' : asString(root.logLevel, 'config.logLevel', 'info').toLowerCase(),
    logThinking: asBool(root.logThinking, 'config.logThinking', true),
    logFormat: /** @type {'pretty'|'json'} */ (logFormat),
    logColor: /** @type {'auto'|'always'|'never'} */ (logColor),
    dataDir,
    opsPort: asInt(root.opsPort, 'config.opsPort', null, { min: 1, max: 65535 }),
    dryRun: Boolean(cli['dry-run']),
    once: Boolean(cli.once),
  };

  return config;
}

/** Safe config summary for the startup log. */
export function describeConfig(config) {
  const primary = MODEL_ALIASES[config.model.defaultAlias];
  const primaryModel = primary ? config[primary.provider]?.[primary.modelKey] : '';
  const fallback = MODEL_ALIASES[config.model.fallbackAlias];
  const fallbackModel = fallback ? config[fallback.provider]?.[fallback.modelKey] : '';
  const fallbackReady = Boolean(fallback && config[fallback.provider]?.apiKey);
  return {
    version: config.version,
    mode: config.mode,
    configFile: config.configFile ? path.basename(config.configFile) : 'inline/defaults',
    platform: config.platform,
    model: `${config.model.defaultAlias} (${primaryModel})`,
    fallbackModel: fallback
      ? `${config.model.fallbackAlias} (${fallbackReady ? fallbackModel || 'off' : 'no key — skipped'})`
      : 'off',
    reasoning: config.ai.reasoning,
    tone: config.tone,
    maxTokens: config.ai.maxTokens ?? 'unlimited',
    search: config.search.enabled ? `${config.search.depth}/${config.search.maxResults}` : 'off',
    typing: config.typing,
    progressive: config.progressive,
    dataDir: config.dataDir,
    contextDir: config.context.dir,
    contextTtl: config.context.ttlHours > 0 ? `${config.context.ttlHours}h` : 'never',
    context:
      config.context.maxTokens > 0 || config.context.maxMessages > 0
        ? `${config.context.maxTokens > 0 ? `${config.context.maxTokens} tok` : '∞ tok'} / ${config.context.maxMessages > 0 ? `${config.context.maxMessages} msg` : '∞ msg'}`
        : 'unlimited',
    replyChunks: config.maxMessagesPerReply > 0 ? `≤${config.maxMessagesPerReply}` : 'unlimited',
    userRateLimit:
      config.userRateLimitPerMinute > 0 ? `${config.userRateLimitPerMinute}/min/user` : 'off',
    allowedChats: config.allowedChatIds.length || 'all',
    admins: config.adminIds.length || 'everyone',
    token: maskSecret(config.zalo.token),
    nimKey: maskSecret(config.nim.apiKey),
    deepseekKey: maskSecret(config.deepseek.apiKey),
    refuselessKey: maskSecret(config.refuseless.apiKey),
    tavilyKey: maskSecret(config.search.apiKey),
    firecrawlKey: maskSecret(config.search.firecrawlApiKey),
    dryRun: config.dryRun,
  };
}