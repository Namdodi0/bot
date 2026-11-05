import { createCommandRuntime } from './commands.js';
import { createInteractionRouter } from './interaction-router.js';
import { createMessageHandler } from './message-handler.js';
import { createMessageSync } from './message-sync.js';
import { applyPresence } from './presence.js';
import { COMMANDS } from './specs.js';

/**
 * Discord bot runtime: gateway events, command registration, start/stop. Ordinary chat is
 * handled in message-handler.js and native interactions in interaction-router.js, which
 * delegates to commands.js.
 * @param {{config: any, boot: {logger: import('../../core/logger.js').Logger, metrics: any}, platform: import('../contract.js').Platform, runtime: any}} deps
 */
export function createDiscordBot(deps) {
  const { config, boot, platform, runtime } = deps;
  const { logger, metrics } = boot;
  const transport = platform.transport;
  const client = transport.client;

  const commands = createCommandRuntime({ config, logger, platform, runtime });
  const handleMessage = createMessageHandler({ config, logger, metrics, transport, runtime, client });
  const handleInteraction = createInteractionRouter({ config, logger, commands });
  const syncMessage = createMessageSync({ config, logger, metrics, runtime, client });

  async function registerCommands() {
    const application = client.application;
    if (!application) return;
    if (config.discord?.guildId) {
      await application.commands.set(COMMANDS, config.discord.guildId);
      await application.commands.set([]);
    } else {
      await application.commands.set(COMMANDS);
    }
    logger?.info('discord commands registered', {
      scope: config.discord?.guildId ? `guild ${config.discord.guildId}` : 'global',
      count: COMMANDS.length,
      icon: '🛠️',
    });
  }

  async function start() {
    client.on('messageCreate', (message) => {
      handleMessage(message).catch((error) =>
        logger?.error('discord message handling failed', { error: String(/** @type {any} */ (error)?.message ?? error) }),
      );
    });
    client.on('interactionCreate', (interaction) => {
      handleInteraction(interaction).catch((error) =>
        logger?.error('discord interaction failed', { error: String(/** @type {any} */ (error)?.message ?? error) }),
      );
    });
    client.on('messageUpdate', (oldMessage, newMessage) => {
      syncMessage.update(oldMessage, newMessage);
    });
    client.on('messageDelete', (message) => {
      syncMessage.remove(message);
    });
    client.on('messageDeleteBulk', (messages) => {
      syncMessage.removeBulk(messages);
    });
    client.once('clientReady', () => {
      applyPresence({ client, presence: config.discord?.presence, logger });
      logger?.info('discord bot ready', {
        id: client.user?.id,
        name: client.user?.username,
        guilds: client.guilds.cache.size,
        icon: '🤖',
      });
      registerCommands().catch((error) =>
        logger?.error('discord command registration failed', { error: String(/** @type {any} */ (error)?.message ?? error) }),
      );
    });
    client.on('error', (error) =>
      logger?.error('discord client error', { error: String(/** @type {any} */ (error)?.message ?? error) }),
    );
    client.on('shardDisconnect', (event, shardId) =>
      logger?.warn('discord gateway disconnected', { shardId, code: event?.code, reason: event?.reason }),
    );
    client.on('shardReconnecting', (shardId) =>
      logger?.warn('discord gateway reconnecting', { shardId }),
    );
    client.on('shardError', (error, shardId) =>
      logger?.error('discord gateway shard error', {
        shardId,
        error: String(/** @type {any} */ (error)?.message ?? error),
      }),
    );

    await transport.start();
    if (!config.discord?.allowedChannelIds?.length) {
      logger?.warn('config.discord.allowedChannelIds is empty: the bot answers in every channel where it is mentioned/replied to, and in DMs.');
    }
    if (config.discord?.respondToAllChannelIds?.length) {
      logger?.info('discord respond-to-all channels', { channels: config.discord.respondToAllChannelIds });
    }
  }

  async function stop() {
    await transport.stop();
  }

  return { start, stop, client };
}
