import path from 'node:path';
import { ConfigError, HELP_TEXT, loadConfig } from './config.js';
import { createDiscordTransport } from './discord/client.js';
import { describeEnvHints, loadEnvFiles, PROJECT_ROOT } from './env.js';
import { printBanner } from './logger.js';
import { createBoot, createRuntime } from './runtime.js';
import { VERSION } from './version.js';

const DISCORD_CONFIG_PATH = path.join(PROJECT_ROOT, 'config.discord.json');

// Same .env, different config file: the Discord process is independent from the Zalo one.
const envReport = loadEnvFiles({ extraRoots: [PROJECT_ROOT] });

async function main() {
  const config = loadConfig({ configPath: DISCORD_CONFIG_PATH });
  if (config.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }
  if (config.platform !== 'discord') {
    throw new ConfigError('This entry runs the Discord bot; config.platform must be "discord".');
  }

  const boot = createBoot({ config, envReport });
  const { logger, metrics } = boot;

  /** @type {(event: any) => Promise<unknown>|void} */
  let dispatchEvent = () => {};
  const discord = createDiscordTransport({
    token: config.discord.token,
    config: config.discord,
    logger,
    metrics,
    onEvent: (event) => dispatchEvent(event),
  });
  const runtime = await createRuntime({ config, transport: discord, boot });
  const { agent, primary, fallback, contextFiles, addCleanup, shutdown, waitForShutdown } = runtime;
  dispatchEvent = (event) => agent.enqueue(event);
  addCleanup(() => discord.stop());

  if (config.dryRun) {
    logger.info('dry-run: Discord transport not started');
    await shutdown('dry-run');
    return;
  }

  try {
    await discord.start();
    if (config.logFormat === 'pretty') {
      printBanner(
        process.stdout,
        [
          `🤖 ${discord.displayName || 'Bot Discord'}  ·  v${config.version}  ·  Discord bot`,
          `🧠 ${primary.label} · ${primary.provider}/${primary.model}  (fallback: ${fallback.alias})`,
          `⚙️  discord · reasoning=${config.ai.reasoning} · max_tokens=${config.ai.maxTokens ?? 'unlimited'}`,
          `🔎 search=${config.search.enabled ? `${config.search.depth}/${config.search.maxResults}` : 'off'} · typing=${config.typing ? 'on' : 'off'} · progressive=${config.progressive}`,
          `💾 data ${config.dataDir} · ${contextFiles} file context`,
        ],
        { color: config.logColor },
      );
    }
    logger.info('discord bot ready', {
      name: discord.displayName,
      guildId: config.discord.guildId || 'global commands',
      icon: '🎮',
    });
    if (!config.discord.allowedChannelIds.length) {
      logger.warn('config.discord.allowedChannelIds is empty: the bot answers in every channel where it is mentioned/replied to, and in DMs.');
    }
    if (config.discord.respondToAllChannelIds.length) {
      logger.info('discord respond-to-all channels', {
        channels: config.discord.respondToAllChannelIds,
      });
    }
  } catch (error) {
    logger.error('discord failed to start — check DISCORD_BOT_TOKEN', { error });
    await shutdown('discord start failed');
    process.exitCode = 1;
    return;
  }

  await waitForShutdown();
  await shutdown('discord transport ended');
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
