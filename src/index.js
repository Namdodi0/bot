import { ConfigError, HELP_TEXT, loadConfig } from './config.js';
import { describeEnvHints, loadEnvFiles, PROJECT_ROOT } from './core/env.js';
import { printBanner } from './core/logger.js';
import { createBoot, createRuntime } from './core/runtime.js';
import { VERSION } from './core/version.js';
import { createZaloPlatform } from './platforms/zalo/index.js';

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
  const { logger } = boot;
  const platform = await createZaloPlatform({ config, boot });
  const runtime = await createRuntime({ config, platform, boot });
  const { agent, primary, fallback, contextFiles, controller, shutdown, addDispose } = runtime;
  addDispose(() => platform.stop());

  try {
    const { ready, done } = await platform.start({
      onEvent: (event) => agent.enqueue(event),
      signal: controller.signal,
      once: config.once,
    });

    if (config.logFormat === 'pretty') {
      printBanner(
        process.stdout,
        [
          `🤖 ${platform.transport.displayName || 'Bot Zalo'}  ·  v${config.version}  ·  Zalo group chatbot`,
          `🧠 ${primary.label} · ${primary.provider}/${primary.model}  (fallback: ${fallback.alias})`,
          `⚙️  ${config.mode} · reasoning=${config.ai.reasoning} · max_tokens=${config.ai.maxTokens ?? 'unlimited'}`,
          `🔎 search=${config.search.enabled ? `${config.search.depth}/${config.search.maxResults}${config.search.auto ? '' : ' (auto off)'}` : 'off'} · typing=${config.typing ? 'on' : 'off'} · progressive=${config.progressive} · sticker=${config.sticker.enabled ? 'on' : 'off'}`,
          `📚 context ${config.context.maxTokens > 0 || config.context.maxMessages > 0 ? `${config.context.maxTokens > 0 ? config.context.maxTokens : '∞'} tokens / ${config.context.maxMessages > 0 ? config.context.maxMessages : '∞'} msgs` : 'unlimited'} · replies ${config.maxMessagesPerReply > 0 ? `≤ ${config.maxMessagesPerReply} msgs` : 'unlimited msgs'}`,
          `💾 data ${config.dataDir} · ${contextFiles} file context · TTL ${config.context.ttlHours > 0 ? `${config.context.ttlHours}h` : 'never'}`,
        ],
        { color: config.logColor },
      );
      logger.debug('zalo transport ready', { id: ready?.me?.id, mode: ready?.mode });
    }

    await done;
  } catch (error) {
    logger.error('zalo bot failed to start', { error });
    await shutdown('zalo start failed');
    process.exitCode = 1;
    return;
  }

  if (config.once) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await shutdown('once finished');
    process.exit(0);
  }

  await shutdown(config.mode === 'webhook' ? 'webhook loop ended' : 'polling loop ended');
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