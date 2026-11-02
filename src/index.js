import { ConfigError, HELP_TEXT, loadConfig } from './config.js';
import { describeEnvHints, loadEnvFiles, PROJECT_ROOT } from './env.js';
import { printBanner } from './logger.js';
import { createBoot, createRuntime } from './runtime.js';
import { VERSION } from './version.js';
import { createZaloClient } from './zalo/client.js';
import { startPolling } from './zalo/polling.js';
import { createWebhookServer } from './zalo/webhook.js';

// Load .env inside the code, BEFORE reading the config: host panels / pm2 / systemd often
// run `node index.js` and drop the --env-file-if-exists flag. Variables already in the
// environment still take precedence (see src/env.js). Also try the repo root so a panel that
// starts the bot from another working directory still finds the file.
const envReport = loadEnvFiles({ extraRoots: [PROJECT_ROOT] });

async function main() {
  const config = loadConfig();
  if (config.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }
  if (config.platform !== 'zalo') {
    throw new ConfigError('This entry runs the Zalo bot; use `node src/discord.js` for platform "discord".');
  }

  const boot = createBoot({ config, envReport });
  const { logger, metrics, http } = boot;
  const zalo = createZaloClient({
    token: config.zalo.token,
    baseUrl: config.zalo.baseUrl,
    parseMode: config.zalo.parseMode,
    http,
    logger,
    metrics,
    dryRun: config.dryRun,
    typingIntervalMs: config.typingIntervalMs,
  });
  const runtime = await createRuntime({ config, transport: zalo, boot });
  const { agent, primary, fallback, contextFiles, controller, shutdown, waitForShutdown, addCleanup } = runtime;

  // Verify the bot token + fetch the display name so mentions can be stripped.
  try {
    const me = await zalo.getMe();
    zalo.displayName = String(me.display_name ?? me.account_name ?? '');
    if (config.logFormat === 'pretty') {
      printBanner(
        process.stdout,
        [
          `🤖 ${zalo.displayName || 'Bot Zalo'}  ·  v${config.version}  ·  Zalo group chatbot`,
          `🧠 ${primary.label} · ${primary.provider}/${primary.model}  (fallback: ${fallback.alias})`,
          `⚙️  ${config.mode} · reasoning=${config.ai.reasoning} · max_tokens=${config.ai.maxTokens ?? 'unlimited'}`,
          `🔎 search=${config.search.enabled ? `${config.search.depth}/${config.search.maxResults}${config.search.auto ? '' : ' (auto off)'}` : 'off'} · typing=${config.typing ? 'on' : 'off'} · progressive=${config.progressive} · sticker=${config.sticker.enabled ? 'on' : 'off'}`,
          `📚 context ${config.context.maxTokens > 0 || config.context.maxMessages > 0 ? `${config.context.maxTokens > 0 ? config.context.maxTokens : '∞'} tokens / ${config.context.maxMessages > 0 ? config.context.maxMessages : '∞'} msgs` : 'unlimited'} · replies ${config.maxMessagesPerReply > 0 ? `≤ ${config.maxMessagesPerReply} msgs` : 'unlimited msgs'}`,
          `💾 data ${config.dataDir} · ${contextFiles} file context · TTL ${config.context.ttlHours > 0 ? `${config.context.ttlHours}h` : 'never'}`,
        ],
        { color: config.logColor },
      );
    }
    logger.info('zalo bot ready', {
      id: me.id,
      name: zalo.displayName,
      groups: me.can_join_groups,
      icon: '🤖',
    });
    if (config.zalo.botId && me.id && String(me.id) !== config.zalo.botId) {
      logger.warn('config.zalo.botId does not match the token', {
        expected: config.zalo.botId,
        actual: me.id,
      });
    }
    if (me.can_join_groups !== true) {
      logger.warn('this bot is not allowed to join groups (can_join_groups=false)');
    }
    if (!config.allowedChatIds.length) {
      logger.warn('config.allowedChatIds is empty: the bot will reply to every chat. Set the group chat.id.');
    }
  } catch (error) {
    logger.error('could not call getMe — check ZALO_BOT_TOKEN', { error });
    await shutdown('getMe failed');
    process.exitCode = 1;
    return;
  }

  if (config.mode === 'webhook') {
    const server = createWebhookServer({
      config,
      logger,
      metrics,
      onEvent: (event) => {
        agent.enqueue(event);
      },
    });
    const { port, url } = await server.start();
    addCleanup(() => server.stop());
    logger.info('webhook server listening', { port, path: config.webhook.path, icon: '🌐' });

    if (config.webhook.publicUrl) {
      try {
        const result = await zalo.setWebhook(config.webhook.publicUrl, config.webhook.secret);
        logger.info('setWebhook ok', { result, icon: '🔗' });
      } catch (error) {
        logger.error('setWebhook failed', { error });
      }
    } else {
      logger.info('webhook not registered yet — set config.webhook.publicUrl or call setWebhook manually', {
        localUrl: url,
        icon: '🔗',
      });
    }

    await waitForShutdown();
    await shutdown('webhook loop ended');
    return;
  }

  // Polling (default)
  if (config.once) {
    logger.info('running --once: handle at most 1 update then exit');
  }
  await startPolling({
    zalo,
    onEvent: (event) => {
      agent.enqueue(event);
    },
    logger,
    metrics,
    signal: controller.signal,
    once: config.once,
  });

  if (config.once) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await shutdown('once finished');
    process.exit(0);
  }

  await waitForShutdown();
  await shutdown('polling loop ended');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  // Include the version on the error path too: panel logs only show the last few lines, so you must know which build is running.
  process.stderr.write(`fatal [v${VERSION}]: ${message}\n`);
  if (error instanceof ConfigError) {
    // Show where .env was looked for and which files are missing → no more guessing on the panel.
    const hints = describeEnvHints();
    if (hints.length) process.stderr.write(`hint:\n${hints.join('\n')}\n`);
  }
  process.exit(1);
});
