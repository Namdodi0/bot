/**
 * Run the agent against real NIM/Tavily but send NO messages to Zalo.
 * Use it to check the pipeline, tool calling and context before letting the bot loose in a group.
 *
 *   npm run simulate -- "hi bot, my name is Nam"
 *   npm run simulate -- "what is the gold price today?"
 *   npm run simulate -- "/status"
 */
import path from 'node:path';
import { createAgent } from '../src/core/ai/agent.js';
import { DEEPSEEK_REASONING_MAP, NIM_REASONING_MAP, createOpenAiCompatAdapter } from '../src/core/ai/llm/adapter-openai.js';
import { createLlmService } from '../src/core/ai/llm/service.js';
import { createReminderStore, formatReminderTime } from '../src/core/ai/reminders.js';
import { createModelRouter } from '../src/core/ai/router.js';
import { createStickerStore } from '../src/platforms/zalo/stickers.js';
import { createSummarizer } from '../src/core/ai/summarize.js';
import { createToolRuntime } from '../src/core/ai/tools.js';
import { createCommands } from '../src/core/commands/index.js';
import { createCompactionEngine } from '../src/core/context/compaction/engine.js';
import { loadConfig } from '../src/config.js';
import { createContextStore } from '../src/core/context/store.js';
import { loadEnvFiles } from '../src/core/env.js';
import { createHttp } from '../src/core/http.js';
import { createLogger } from '../src/core/logger.js';
import { createImageValidator } from '../src/core/media/validate.js';
import { createMetrics } from '../src/core/metrics.js';
import { createTavilyClient } from '../src/core/search/tavily.js';
import { prepareOutgoing } from '../src/platforms/zalo/format.js';
import {
  createZaloCommandRunner,
  zaloHelpNote,
  ZALO_COMMAND_SPECS,
  ZALO_HELP_OVERRIDES,
} from '../src/platforms/zalo/commands.js';
import { registerZaloPrompt, ZALO_TOOL_GUIDANCE } from '../src/platforms/zalo/prompt.js';
import { createZaloToolRunner, zaloToolDefinitions } from '../src/platforms/zalo/tools.js';

const text = process.argv.slice(2).join(' ').trim();
if (!text) {
  console.error('Usage: npm run simulate -- "question"');
  process.exit(1);
}

loadEnvFiles();

const config = loadConfig({
  // Do not parse flags from the message content (avoid "--help" inside a question).
  argv: [],
  env: process.env,
});
const logger = createLogger({
  level: config.logLevel,
  format: config.logFormat,
  color: config.logColor,
  version: config.version,
});
const metrics = createMetrics();
const httpClient = createHttp({ logger, metrics });

const store = createContextStore({
  dir: path.join(config.dataDir, 'simulate'),
  logger,
  ttlHours: config.context.ttlHours,
});
await store.init();

/** @type {any} */
const transport = {
  displayName: 'Bot deepseek',
  sendMessage: async (chatId, body) => {
    console.log(`\n[BOT → ${chatId}]\n${body}`);
    return { ok: true };
  },
  sendPhoto: async (chatId, url, caption) => {
    console.log(`\n[BOT → ${chatId}] 🖼️ ${url}\n${caption ?? ''}`);
    return { ok: true };
  },
  sendChatAction: async () => ({ ok: true }),
  sendSticker: async (chatId, stickerId) => {
    console.log(`\n[BOT → ${chatId}] 🧩 sticker ${stickerId}`);
    return { ok: true };
  },
  ping: async () => 0,
  startTyping: () => () => {},
  stopAllTyping: () => {},
};

/** @type {any[]} */
const adapters = [];
if (config.deepseek.apiKey) {
  adapters.push(createOpenAiCompatAdapter({
    provider: 'deepseek',
    apiKey: config.deepseek.apiKey,
    baseUrl: config.deepseek.baseUrl,
    model: config.deepseek.model,
    http: httpClient,
    logger,
    metrics,
    defaultTemperature: config.deepseek.temperature,
    reasoningMap: DEEPSEEK_REASONING_MAP,
  }));
}
if (config.nim.apiKey) {
  adapters.push(createOpenAiCompatAdapter({
    provider: 'nim',
    apiKey: config.nim.apiKey,
    baseUrl: config.nim.baseUrl,
    model: config.nim.model,
    http: httpClient,
    logger,
    metrics,
    defaultTemperature: config.nim.temperature,
    reasoningMap: NIM_REASONING_MAP,
  }));
}
const service = createLlmService({ adapters, logger, metrics });
const models = createModelRouter({ config, service, logger });

const tavily = config.search.enabled
  ? createTavilyClient({
      apiKey: config.search.apiKey,
      baseUrl: config.search.baseUrl,
      http: httpClient,
      logger,
      metrics,
    })
  : null;

const validator = createImageValidator({ logger });
const stickers = createStickerStore({ file: config.sticker.file, extraIds: config.sticker.extraIds, logger });
await stickers.load();
/** @type {import('../src/platforms/contract.js').Platform} */
const platform = {
  name: 'zalo',
  label: 'Zalo',
  transport,
  transportMode: config.mode,
  capabilities: { stickers: true, uploadMedia: false, nativeInteractions: false, messageEdits: false, embeds: false, threads: false },
  limits: { text: 1900, caption: 1900 },
  formatOutgoing: (value) => prepareOutgoing(value, { parseMode: config.zalo.parseMode }),
  isAdmin: () => true,
  prompt: { register: registerZaloPrompt, toolGuidance: ZALO_TOOL_GUIDANCE },
  commands: {
    specs: ZALO_COMMAND_SPECS,
    helpOverrides: ZALO_HELP_OVERRIDES,
    helpNote: zaloHelpNote(config),
    run: createZaloCommandRunner({ config, stickers, transport, logger, metrics }),
  },
  tools: {
    definitions: zaloToolDefinitions,
    run: createZaloToolRunner({ config, stickers, transport, logger, metrics }),
  },
  healthServices: ['zalo', 'tavily'],
  explainError: () => null,
  start: async () => ({ ready: {}, done: Promise.resolve() }),
  stop: async () => {},
};
const summarize = createSummarizer({ llm: models, logger });
const compaction = createCompactionEngine({ config, logger, metrics, summarize });
const reminders = createReminderStore({
  file: null,
  send: async (chatId, text) => console.log(`
[REMINDER → ${chatId}]
${text}`),
  logger,
});
const tools = createToolRuntime({ config, tavily, platform, validator, reminders, logger, metrics });
const commands = createCommands({
  config,
  store,
  metrics,
  platform,
  http: httpClient,
  models,
  reminders,
  logger,
  compaction,
});
const agent = createAgent({
  config,
  logger,
  metrics,
  platform,
  llm: models,
  store,
  tools,
  commands,
  http: httpClient,
  compaction,
});

const started = Date.now();
await agent.handle({
  kind: 'text',
  chatId: 'simulate-chat',
  chatType: 'GROUP',
  senderId: 'user-1',
  senderName: 'Nam',
  isBot: false,
  text,
  imageUrl: null,
  sticker: null,
  messageId: `sim-${Date.now()}`,
  date: Date.now(),
  eventName: 'message.text.received',
});

const record = await store.get('simulate-chat');
console.log(`\n--- ${Date.now() - started}ms · ${record.turns} turns · ${record.messages.length} messages in context ---`);

await reminders.tick();
const pendingReminders = reminders.list();
if (pendingReminders.length) {
  console.log(`\n[reminders] ${pendingReminders.length} pending (the simulator exits now; the long-running bot delivers them)`);
  for (const item of pendingReminders) {
    console.log(`  #${item.id} ${formatReminderTime(item.at)} ${item.text}`);
  }
}
await store.flush();
