import nodeHttp from 'node:http';
import path from 'node:path';
import { createAgent } from './ai/agent.js';
import {
  DEEPSEEK_REASONING_MAP,
  NIM_REASONING_MAP,
  REFUSELESS_REASONING_MAP,
  createOpenAiCompatAdapter,
} from './ai/llm/adapter-openai.js';
import { createLlmService } from './ai/llm/service.js';
import { createReminderStore } from './ai/reminders.js';
import { createModelRouter } from './ai/router.js';
import { createSummarizer } from './ai/summarize.js';
import { createToolRuntime } from './ai/tools.js';
import { createCommands } from './commands/index.js';
import { collectSecrets, describeConfig, isEphemeralDataDir } from '../config.js';
import { createCompactionEngine } from './context/compaction/engine.js';
import { createContextStore } from './context/store.js';
import { closeHttpServer, createHttp } from './http.js';
import { createLogger } from './logger.js';
import { createImageValidator } from './media/validate.js';
import { createMetrics } from './metrics.js';
import { createTavilyClient } from './search/tavily.js';
import { createChatServices } from './services/chat.js';
import { createReminderService } from './services/reminders.js';

/**
 * Logger, metrics and the HTTP client shared by the entries and the runtime.
 * @param {{config: any, envReport?: any}} input
 */
export function createBoot(input) {
  const config = input.config;
  const logger = createLogger({
    level: config.logLevel,
    format: config.logFormat,
    color: config.logColor,
    secrets: collectSecrets(config),
    version: config.version,
    files: [
      { path: path.join(config.dataDir, 'logs', 'bot.log'), level: config.logLevel },
      { path: path.join(config.dataDir, 'logs', 'debug.log'), level: 'debug' },
    ],
  });
  const metrics = createMetrics();
  const http = createHttp({ logger, metrics });

  if (config.configFile && !config.configFileFound) {
    logger.warn('config file not found — using built-in defaults', { path: config.configFile });
  }
  if (config.ignoredEnvKeys?.length) {
    logger.warn('non-secret .env settings are ignored; move them to config.json', {
      keys: config.ignoredEnvKeys,
    });
  }
  if (config.unknownConfigKeys?.length) {
    logger.warn('unknown config keys are ignored', { keys: config.unknownConfigKeys });
  }
  logger.debug('config', describeConfig(config));
  if (input.envReport) {
    logger.debug('env files', {
      cwd: input.envReport.cwd,
      files: input.envReport.files.map((/** @type {any} */ file) => ({
        name: file.name,
        found: file.found,
        applied: file.applied.length,
        ...(file.error ? { error: file.error } : {}),
      })),
    });
  }
  logger.info('starting bot', {
    platform: config.platform,
    mode: config.mode,
    ...(config.dryRun ? { dryRun: true } : {}),
    icon: '🚀',
  });
  if (config.logThinking !== false && config.ai.reasoning === 'none') {
    logger.info('AI_REASONING=none means the model returns no thinking — set low|medium|high|auto to see the 🧠 line');
  }
  return { logger, metrics, http };
}

/**
 * Shared bot engine: context store, models, tools, commands, agent and lifecycle.
 * The entry point provides one platform (Zalo or Discord) and starts its transport.
 * @param {{config: any, platform: import('../platforms/contract.js').Platform, boot: ReturnType<typeof createBoot>, manageSignals?: boolean}} input
 */
export async function createRuntime(input) {
  const config = input.config;
  const platform = input.platform;
  const transport = platform.transport;
  const { logger, metrics, http: httpClient } = input.boot;

  const store = createContextStore({
    dir: config.context.dir,
    logger,
    ttlHours: config.context.ttlHours,
  });
  await store.init();
  const contextFiles = await store.count();
  logger.info('context store', {
    dir: config.context.dir,
    files: contextFiles,
    ttl: config.context.ttlHours > 0 ? `${config.context.ttlHours}h` : 'never',
    icon: '📚',
  });
  if (isEphemeralDataDir(config.dataDir)) {
    logger.warn('DATA_DIR is inside a temp directory — context will be lost on restart/redeploy', {
      dir: config.dataDir,
    });
  }

  /** @type {any[]} */
  const adapters = [];
  if (config.deepseek.apiKey) {
    adapters.push(
      createOpenAiCompatAdapter({
        provider: 'deepseek',
        apiKey: config.deepseek.apiKey,
        baseUrl: config.deepseek.baseUrl,
        model: config.deepseek.model,
        http: httpClient,
        logger,
        metrics,
        defaultTemperature: config.deepseek.temperature,
        reasoningMap: DEEPSEEK_REASONING_MAP,
      }),
    );
  }
  if (config.nim.apiKey) {
    adapters.push(
      createOpenAiCompatAdapter({
        provider: 'nim',
        apiKey: config.nim.apiKey,
        baseUrl: config.nim.baseUrl,
        model: config.nim.model,
        http: httpClient,
        logger,
        metrics,
        defaultTemperature: config.nim.temperature,
        reasoningMap: NIM_REASONING_MAP,
      }),
    );
  }
  if (config.refuseless?.apiKey) {
    adapters.push(
      createOpenAiCompatAdapter({
        provider: 'refuseless',
        apiKey: config.refuseless.apiKey,
        baseUrl: config.refuseless.baseUrl,
        model: config.refuseless.model,
        http: httpClient,
        logger,
        metrics,
        defaultTemperature: config.refuseless.temperature,
        reasoningMap: REFUSELESS_REASONING_MAP,
      }),
    );
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
        cacheTtlMs: config.search.cacheTtlMs,
      })
    : null;

  const validator = createImageValidator({ logger, timeoutMs: 4000 });

  const reminders = createReminderStore({
    file: path.join(config.dataDir, 'reminders.json'),
    send: (chatId, text) => transport.sendMessage(chatId, text),
    logger,
  });
  const summarize = createSummarizer({ llm: models, logger });
  const compaction = createCompactionEngine({ config, logger, metrics, summarize });
  const chatServices = createChatServices({ config, store, models, compaction });
  const reminderService = createReminderService({ reminders });
  const tools = createToolRuntime({
    config,
    tavily,
    platform,
    validator,
    reminders,
    logger,
    metrics,
  });
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
    rateLimitFile: path.join(config.dataDir, 'rate-limits.json'),
  });

  const primary = models.resolve(null);
  const fallback = models.resolve({ meta: { model: models.fallbackAlias } });

  if (!config.dryRun) {
    // Warm up sequentially, exactly once per provider+model pair.
    const warmTargets = [];
    for (const alias of new Set([models.defaultAlias, models.fallbackAlias])) {
      const target = models.find(alias);
      if (!target) continue;
      const key = `${target.provider}:${target.model}`;
      if (warmTargets.some((item) => item.key === key)) continue;
      warmTargets.push({ key, alias, target });
    }
    // No await: warmup runs in the background, the bot starts serving right away.
    (async () => {
      for (const item of warmTargets) {
        const result = await models.warmup(item.alias);
        const fields = {
          alias: item.alias,
          provider: item.target.provider,
          model: item.target.model,
          ms: result.ms,
          icon: '⚡',
        };
        if (result.ok) logger.info('llm warmup done', fields);
        else logger.debug('llm warmup skipped (no impact)', { ...fields, error: result.error });
      }
    })();
  }

  const controller = new AbortController();
  /** @type {Array<() => Promise<void>|void>} */
  const cleanups = [];
  await reminders.load();
  reminders.start();
  cleanups.push(() => reminders.stop());

  /** @param {() => Promise<void>|void} cleanup */
  function addCleanup(cleanup) {
    cleanups.push(cleanup);
  }

  /** @type {Promise<void>|null} */
  let shutdownPromise = null;
  /** @param {string} reason */
  function shutdown(reason) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      logger.info('shutting down', { reason, icon: '👋' });
      controller.abort();
      // Close the message sources first so the queue stops growing while waiting.
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup();
        } catch (error) {
          logger.warn('cleanup failed', { error });
        }
      }
      try {
        const left = await agent.drain(10_000);
        if (left > 0) logger.warn('shutdown: messages still unfinished', { pending: left, icon: '⏳' });
      } catch (error) {
        logger.warn('drain on shutdown failed', { error });
      }
      try {
        transport.stopAllTyping();
        await agent.flushRateLimits?.();
        await store.flush();
      } catch (error) {
        logger.warn('flush on shutdown failed', { error });
      }
      logger.info('session summary', {
        messages: metrics.get('messages.in'),
        replies: metrics.get('messages.replied'),
        errors: metrics.get('messages.error'),
        aiCalls: metrics.get('llm.calls'),
        searches: metrics.get('tool.webSearch'),
        images: metrics.get('tool.sendImage.ok'),
        icon: '📊',
      });
      try {
        await logger.close();
      } catch {
        // log files are best effort
      }
    })();
    return shutdownPromise;
  }

  function waitForShutdown() {
    if (controller.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(undefined), { once: true });
    });
  }

  // A combined entry (src/both.js) owns process signals and shuts both runtimes down once.
  if (input.manageSignals !== false) {
    process.on('SIGINT', () => {
      shutdown('SIGINT').then(() => process.exit(0));
    });
    process.on('SIGTERM', () => {
      shutdown('SIGTERM').then(() => process.exit(0));
    });
    process.on('unhandledRejection', (reason) => {
      logger.error('unhandled rejection', { error: reason });
    });
    process.on('uncaughtException', (error) => {
      logger.error('uncaught exception', { error });
      // The process is in an unknown state: stop taking work and exit instead of limping on.
      void shutdown('uncaughtException').finally(() => process.exit(1));
    });
  }

  const pruneTimer = setInterval(() => {
    store.prune().catch((error) => logger.warn('prune failed', { error }));
  }, 3_600_000);
  pruneTimer.unref?.();
  addCleanup(() => clearInterval(pruneTimer));

  if (config.opsPort) {
    const opsServer = nodeHttp.createServer((req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, platform: config.platform, uptimeSec: Math.round(process.uptime()) }));
        return;
      }
      if (req.url === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            {
              ...metrics.snapshot(),
              agent: { queueDepth: agent.pending(), seen: agent.seenSize() },
              contexts: { loaded: store.loadedChats() },
              config: describeConfig(config),
            },
            null,
            2,
          ),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    opsServer.on('error', (error) => {
      logger.error('ops server error (check opsPort)', { error });
    });
    opsServer.listen(config.opsPort, '127.0.0.1');
    addCleanup(() => closeHttpServer(opsServer));
    logger.info('ops server listening', {
      port: config.opsPort,
      url: `http://127.0.0.1:${config.opsPort}/metrics`,
    });
  }

  return {
    config,
    logger,
    metrics,
    http: httpClient,
    store,
    models,
    service,
    tavily,
    validator,
    reminders,
    reminderService,
    chatServices,
    summarize,
    compaction,
    tools,
    commands,
    agent,
    primary,
    fallback,
    contextFiles,
    controller,
    addCleanup,
    shutdown,
    waitForShutdown,
  };
}
