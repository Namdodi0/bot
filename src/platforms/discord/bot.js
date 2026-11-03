import { MessageFlags } from 'discord.js';
import { createCommandRuntime } from './commands.js';
import { isBotAddressed, isBotRoleMentioned, isChannelAllowed, isRespondToAllChannel, toDiscordEvent } from './events.js';
import { COMMANDS } from './specs.js';
import { chunkContent, createPreviewer, photoAttachment } from './ui.js';

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

  const MAX_STREAMING_CHATS = 4;
  let activeStreams = 0;
  /** @type {Array<() => void>} */
  const streamWaiters = [];

  async function acquireStreamSlot() {
    if (activeStreams < MAX_STREAMING_CHATS) {
      activeStreams += 1;
      return;
    }
    await new Promise((resolve) => streamWaiters.push(/** @type {any} */ (resolve)));
    activeStreams += 1;
  }

  function releaseStreamSlot() {
    activeStreams = Math.max(0, activeStreams - 1);
    streamWaiters.shift()?.();
  }

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

    // Ordinary chat streams into one placeholder reply, the same way /ask does.
    await acquireStreamSlot();
    const stopTyping = config.typing ? transport.startTyping(event.chatId) : async () => {};
    /** @type {any} */
    let placeholder = null;
    let streamed = '';
    const previewer = createPreviewer(async (text) => {
      if (!placeholder) {
        placeholder = await message.reply({ content: text, allowedMentions: { parse: [] } });
        await stopTyping();
        return;
      }
      await placeholder.edit({ content: text, allowedMentions: { parse: [] } });
    });

    try {
      const result = await runtime.agent.stream(event, {
        skipCommands: true,
        onDelta: (delta) => {
          streamed += delta;
          previewer.push(streamed);
        },
      });
      await previewer.flush();
      const chunks = result.text ? chunkContent(result.text) : [];
      const first = chunks.shift();
      if (placeholder) {
        if (!first && !result.photos.length) await placeholder.delete().catch(() => {});
        else await placeholder.edit({ content: first || 'Here are the images.', allowedMentions: { parse: [] } }).catch(() => {});
      } else if (first) {
        placeholder = await message.reply({ content: first, allowedMentions: { parse: [] } });
      }
      for (const chunk of chunks) {
        await message.channel.send({ content: chunk, allowedMentions: { parse: [] } }).catch(() => {});
      }
      for (let index = 0; index < result.photos.length; index += 10) {
        const group = result.photos.slice(index, index + 10);
        await message.channel
          .send({
            files: group.map(photoAttachment),
            content: group[0].caption?.slice(0, 2000) || undefined,
            allowedMentions: { parse: [] },
          })
          .catch(() => {});
      }
    } catch (error) {
      logger?.error('discord streaming reply failed', { error: String(/** @type {any} */ (error)?.message ?? error) });
    } finally {
      await stopTyping();
      releaseStreamSlot();
    }
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
