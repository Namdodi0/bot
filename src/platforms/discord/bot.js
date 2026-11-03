import { MessageFlags } from 'discord.js';
import { createCommandRuntime } from './commands.js';
import { isBotAddressed, isBotRoleMentioned, isChannelAllowed, isRespondToAllChannel, toDiscordEvent } from './events.js';
import { COMMANDS } from './specs.js';

/**
 * Discord bot runtime: gateway events, admission, command registration and interaction
 * routing. Native interactions are handled in commands.js; ordinary chat goes through the
 * shared agent.
 * @param {{config: any, boot: {logger: import('../../core/logger.js').Logger, metrics: any}, platform: import('../contract.js').Platform, runtime: any}} deps
 */
export function createDiscordBot(deps) {
  const { config, boot, platform, runtime } = deps;
  const { logger, metrics } = boot;
  const transport = platform.transport;
  const client = transport.client;

  const commands = createCommandRuntime({ config, logger, metrics, platform, runtime });

  /** @param {any} interaction */
  function channelOfInteraction(interaction) {
    return interaction.channel ?? (interaction.channelId ? { id: interaction.channelId } : null);
  }

  /** @param {any} interaction */
  async function allowedInteraction(interaction) {
    if (!interaction.guildId) return true;
    const channel = channelOfInteraction(interaction);
    if (channel) return isChannelAllowed(config, channel);
    // A guild command with no resolvable channel must not bypass an allow-list.
    return !(config.discord?.allowedChannelIds?.length ?? 0);
  }

  /** @param {any} message */
  async function handleMessage(message) {
    if (message.author?.bot) return;
    const isDm = message.channel?.isDMBased?.() === true;
    const mentioned = Boolean(client.user && message.mentions?.users?.has(client.user.id));
    const roleMentioned = isBotRoleMentioned(message, client.user?.id ?? '');
    if (!isChannelAllowed(config.discord ?? {}, message.channel ?? { id: message.channelId })) return;
    let repliedToBot = false;
    if (!mentioned && !roleMentioned && !isDm && message.reference?.messageId) {
      const referenced = await message.fetchReference().catch(() => null);
      repliedToBot = Boolean(referenced && referenced.author?.id === client.user?.id);
    }
    const listensHere = isRespondToAllChannel(config.discord ?? {}, message.channel ?? { id: message.channelId });
    if (!isBotAddressed({ mentioned, roleMentioned, repliedToBot, isDm, listensHere })) return;

    const event = toDiscordEvent(message, client);
    if (!event) return;
    // Slash-only command surface: a typed "/ask ..." is not a command.
    if (String(event.text ?? '').trimStart().startsWith('/')) return;
    if (event.imageUrl && runtime.validator?.download) {
      // Vision bytes are optional: if the download fails the text note still reaches the model.
      try {
        const downloaded = await runtime.validator.download(event.imageUrl);
        if (downloaded?.ok && downloaded.data) {
          event.imageData = { data: downloaded.data, contentType: downloaded.contentType };
        }
      } catch (error) {
        logger?.debug('discord image download failed', { error: String(/** @type {any} */ (error)?.message ?? error) });
      }
    }
    metrics?.inc('discord.messages.in');
    await runtime.agent.enqueue(event);
  }

  /** @param {any} interaction */
  async function handleInteraction(interaction) {
    if (!(await allowedInteraction(interaction))) {
      if (interaction.isAutocomplete()) {
        await interaction.respond([]).catch(() => {});
        return;
      }
      const payload = { content: 'This channel is not allowed.', flags: MessageFlags.Ephemeral };
      if (interaction.isRepliable()) await interaction.reply(payload).catch(() => {});
      return;
    }
    try {
      if (interaction.isAutocomplete()) {
        await commands.handleAutocomplete(interaction);
        return;
      }
      if (interaction.isButton()) {
        await commands.handleButton(interaction);
        return;
      }
      if (interaction.isStringSelectMenu()) {
        await commands.handleSelect(interaction);
        return;
      }
      if (interaction.isChatInputCommand() || interaction.isMessageContextMenuCommand()) {
        await commands.handleCommand(interaction);
      }
    } catch (error) {
      logger?.error('discord interaction failed', {
        command: interaction.commandName || interaction.customId,
        error: String(/** @type {any} */ (error)?.message ?? error),
      });
    }
  }

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
    client.once('clientReady', () => {
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
