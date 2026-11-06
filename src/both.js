import path from 'node:path';
import { ConfigError, HELP_TEXT, loadConfig } from './config.js';
import { describeEnvHints, loadEnvFiles, PROJECT_ROOT } from './core/env.js';
import { printBanner } from './core/logger.js';
import { createBoot, createRuntime } from './core/runtime.js';
import { VERSION } from './core/version.js';
import { createDiscordBot } from './platforms/discord/bot.js';
import { createDiscordPlatform } from './platforms/discord/index.js';
import { createZaloPlatform } from './platforms/zalo/index.js';

// Combined entry: Zalo and Discord share one process, but keep separate config/data dirs and
// runtimes. Process signals are handled here instead of by each runtime.
const envReport = loadEnvFiles({ extraRoots: [PROJECT_ROOT] });

/** @param {string} name */
function configPath(name) {
  return path.join(PROJECT_ROOT, name);
}

async function main() {
  const zaloConfig = loadConfig({ configPath: configPath('config.json') });
  const discordConfig = loadConfig({ configPath: configPath('config.discord.json') });
  if (zaloConfig.help || discordConfig.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }
  if (zaloConfig.platform !== 'zalo') {
    throw new ConfigError('config.json must use platform "zalo" for combined mode');
  }
  if (discordConfig.platform !== 'discord') {
    throw new ConfigError('config.discord.json must use platform "discord" for combined mode');
  }

  const zaloBoot = createBoot({ config: zaloConfig, envReport });
  const discordBoot = createBoot({ config: discordConfig, envReport });
  const zaloPlatform = await createZaloPlatform({ config: zaloConfig, boot: zaloBoot });
  const discordPlatform = createDiscordPlatform({ config: discordConfig, boot: discordBoot });
  const zaloRuntime = await createRuntime({
    config: zaloConfig,
    platform: zaloPlatform,
    boot: zaloBoot,
    manageSignals: false,
  });
  const discordRuntime = await createRuntime({
    config: discordConfig,
    platform: discordPlatform,
    boot: discordBoot,
    manageSignals: false,
  });

  zaloRuntime.addDispose(() => zaloPlatform.stop());
  const discordBot = createDiscordBot({
    config: discordConfig,
    boot: discordBoot,
    platform: discordPlatform,
    runtime: discordRuntime,
  });
  discordRuntime.addDispose(() => discordBot.stop());

  /** @type {Promise<void>|null} */
  let shutdownPromise = null;
  /** @param {string} reason */
  function shutdownAll(reason) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const results = await Promise.allSettled([
        zaloRuntime.shutdown(reason),
        discordRuntime.shutdown(reason),
      ]);
      for (const result of results) {
        if (result.status === 'rejected') {
          zaloBoot.logger.error('combined shutdown failed', { error: result.reason });
        }
      }
    })();
    return shutdownPromise;
  }

  /** @param {string} reason */
  const onSignal = (reason) => {
    shutdownAll(reason).finally(() => process.exit(0));
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    zaloBoot.logger.error('unhandled rejection', { error: reason });
    discordBoot.logger.error('unhandled rejection', { error: reason });
  });
  process.on('uncaughtException', (error) => {
    zaloBoot.logger.error('uncaught exception', { error });
    discordBoot.logger.error('uncaught exception', { error });
    void shutdownAll('uncaughtException').finally(() => process.exit(1));
  });

  try {
    const zaloStart = await zaloPlatform.start({
      onEvent: (event) => zaloRuntime.agent.enqueue(event),
      signal: zaloRuntime.controller.signal,
      once: zaloConfig.once,
    });
    await discordBot.start();

    if (zaloConfig.logFormat === 'pretty') {
      printBanner(
        process.stdout,
        [
          `🤖 Both bots · v${VERSION}`,
          `Zalo: ${zaloRuntime.primary.label} · ${zaloConfig.mode} · data ${zaloConfig.dataDir}`,
          `Discord: ${discordRuntime.primary.label} · gateway · data ${discordConfig.dataDir}`,
        ],
        { color: zaloConfig.logColor },
      );
    }

    // The Zalo loop owns the combined lifetime: when it ends, stop Discord too.
    await Promise.race([
      zaloStart.done,
      discordRuntime.waitForShutdown().then(() => 'discord stopped'),
    ]);
  } catch (error) {
    zaloBoot.logger.error('combined bot failed to start', { error });
    discordBoot.logger.error('combined bot failed to start', { error });
    process.exitCode = 1;
  } finally {
    await shutdownAll('both stopped');
  }
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
