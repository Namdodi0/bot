import path from 'node:path';
import { ConfigError, HELP_TEXT, loadConfig } from './config.js';
import { describeEnvHints, loadEnvFiles, PROJECT_ROOT } from './core/env.js';
import { printBanner } from './core/logger.js';
import { createBoot, createRuntime } from './core/runtime.js';
import { VERSION } from './core/version.js';
import { createDiscordBot } from './platforms/discord/bot.js';
import { createDiscordPlatform } from './platforms/discord/index.js';
import { COMMANDS } from './platforms/discord/specs.js';

const DISCORD_CONFIG_PATH = path.join(PROJECT_ROOT, 'config.discord.json');

const envReport = loadEnvFiles({ extraRoots: [PROJECT_ROOT] });

async function main() {
  const config = loadConfig({ configPath: DISCORD_CONFIG_PATH });
  if (config.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }

  const boot = createBoot({ config, envReport });
  const { logger } = boot;
  const platform = createDiscordPlatform({ config, boot });
  const runtime = await createRuntime({ config, platform, boot });
  const { primary, fallback, contextFiles, shutdown, addDispose, waitForShutdown } = runtime;

  if (config.dryRun) {
    logger.info('dry-run: Discord transport not started');
    await shutdown('dry-run');
    return;
  }

  const bot = createDiscordBot({ config, boot, platform, runtime });
  addDispose(() => bot.stop());

  try {
    await bot.start();
    if (config.logFormat === 'pretty') {
      printBanner(
        process.stdout,
        [
          `🤖 ${platform.transport.displayName || 'Bot Discord'}  ·  v${config.version}  ·  Discord bot`,
          `🧠 ${primary.label} · ${primary.provider}/${primary.model}  (fallback: ${fallback.alias})`,
          `⚙️  gateway · ${COMMANDS.length} commands · reasoning=${config.ai.reasoning} · max_tokens=${config.ai.maxTokens ?? 'unlimited'}`,
          `🔎 search=${config.search.enabled ? `${config.search.depth}/${config.search.maxResults}` : 'off'} · typing=${config.typing ? 'on' : 'off'}`,
          `💾 data ${config.dataDir} · ${contextFiles} file context`,
        ],
        { color: config.logColor },
      );
    }
    await waitForShutdown();
  } catch (error) {
    logger.error('discord failed to start — check DISCORD_BOT_TOKEN', { error });
    await shutdown('discord start failed');
    process.exitCode = 1;
    return;
  }

  await shutdown('discord gateway ended');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`fatal [v${VERSION}]: ${message}\n`);
  if (error instanceof ConfigError) {
    const hints = describeEnvHints();
    if (hints.length) process.stderr.write(`hint:\n${hints.join('\n')}\n`);
  }
  process.exit(1);
});
