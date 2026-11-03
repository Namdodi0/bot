import { AttachmentBuilder, Client, GatewayIntentBits, Partials } from 'discord.js';
import { slashCommandPayloads } from '../../core/commands/registry.js';
import {
  DISCORD_CHAT_PREFIX,
  isBotAddressed,
  isBotRoleMentioned,
  isChannelAllowed,
  toDiscordEvent,
  toDiscordInteractionEvent,
} from './events.js';

const TYPING_REFRESH_MS = 8_000;
/** Discord's content limit for messages, and the practical limit for a photo caption. */
export const DISCORD_MAX_CONTENT = 2000;

/**
 * Clamp a photo caption to Discord's content limit (an empty caption is dropped).
 * @param {string} caption
 */
export function photoCaption(caption) {
  const text = String(caption ?? '');
  return text ? text.slice(0, DISCORD_MAX_CONTENT) : '';
}

/**
 * Discord transport backed by discord.js.
 * @param {{token: string, config?: {guildId?: string, allowedChannelIds?: string[], respondToAllChannelIds?: string[]}, commandSpecs?: import('../../core/commands/registry.js').CommandSpec[], nativeCommands?: Record<string, (interaction: any) => Promise<void>|void>, logger?: import('../../core/logger.js').Logger, metrics?: any, onEvent: (event: any) => Promise<unknown>|void, createClient?: () => any}} options
 */
export function createDiscordTransport(options) {
  const token = options.token;
  const config = options.config ?? {};
  const logger = options.logger;
  const metrics = options.metrics;
  const onEvent = options.onEvent ?? (async () => {});
  const nativeCommands = options.nativeCommands ?? {};
  const slashCommands = slashCommandPayloads(options.commandSpecs ?? []);

  const client =
    options.createClient?.() ??
    new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });

  /** @type {Map<string, NodeJS.Timeout>} */
  const typingTimers = new Map();

  /** @param {string} chatId */
  const channelIdOf = (chatId) =>
    String(chatId).startsWith(DISCORD_CHAT_PREFIX)
      ? String(chatId).slice(DISCORD_CHAT_PREFIX.length)
      : String(chatId);

  /** @param {string} chatId */
  async function channelOf(chatId) {
    const id = channelIdOf(chatId);
    const cached = client.channels.cache.get(id);
    const channel = cached ?? (await client.channels.fetch(id));
    if (!channel || typeof (/** @type {any} */ (channel).send) !== 'function') {
      throw new Error(`Discord channel not found: ${id}`);
    }
    return /** @type {any} */ (channel);
  }

  /**
   * @param {string} chatId
   * @param {string} text
   * @param {{replyToMessageId?: string}} [opts]
   */
  async function sendMessage(chatId, text, opts = {}) {
    const channel = await channelOf(chatId);
    /** @type {any} */
    const payload = { content: String(text ?? ''), allowedMentions: { parse: [] } };
    if (opts?.replyToMessageId) {
      payload.reply = { messageReference: String(opts.replyToMessageId), failIfNotExists: false };
    }
    return channel.send(payload);
  }

  /**
   * @param {string} chatId
   * @param {string} url
   * @param {string} [caption]
   * @param {{data?: Buffer, contentType?: string}} [options] pre-validated bytes; avoids a second fetch
   */
  async function sendPhoto(chatId, url, caption = '', options = {}) {
    const channel = await channelOf(chatId);
    const file = new AttachmentBuilder(options?.data ? Buffer.from(options.data) : String(url), { name: 'image' });
    const content = photoCaption(caption);
    return channel.send({
      content: content || undefined,
      files: [file],
      allowedMentions: { parse: [] },
    });
  }

  async function sendSticker() {
    throw new Error('Zalo stickers are not supported on Discord');
  }

  /** @param {string} chatId @param {string} messageId @param {string} text */
  async function editMessage(chatId, messageId, text) {
    const channel = await channelOf(chatId);
    const message = await channel.messages.fetch(String(messageId));
    return message.edit({ content: String(text ?? '') });
  }

  /** @param {string} chatId @param {string} messageId @param {string} emoji */
  async function react(chatId, messageId, emoji) {
    const channel = await channelOf(chatId);
    const message = await channel.messages.fetch(String(messageId));
    return message.react(String(emoji));
  }

  /** @param {string} chatId @param {any} embed */
  async function sendEmbed(chatId, embed) {
    const channel = await channelOf(chatId);
    return channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  }

  /** @param {string} chatId @param {string} name */
  async function createThread(chatId, name) {
    const channel = await channelOf(chatId);
    return channel.threads.create({ name: String(name ?? 'thread') });
  }

  /** @param {string} chatId */
  function startTyping(chatId) {
    const id = channelIdOf(chatId);
    let stopped = false;
    const ping = () => {
      if (stopped) return;
      const channel = /** @type {any} */ (client.channels.cache.get(id));
      channel?.sendTyping?.().catch(() => {});
    };
    ping();
    const timer = setInterval(ping, TYPING_REFRESH_MS);
    timer.unref?.();
    typingTimers.set(id, timer);
    return async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      typingTimers.delete(id);
    };
  }

  function stopAllTyping() {
    for (const timer of typingTimers.values()) clearInterval(timer);
    typingTimers.clear();
  }

  /** @param {string} [chatId] */
  function ping(chatId) {
    void chatId;
    const value = Number(client.ws.ping);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  }

  async function registerCommands() {
    const application = client.application;
    if (!application) return;
    if (config.guildId) {
      await application.commands.set(slashCommands, config.guildId);
      // Guild commands are instant; clear the previous global registration so clients
      // do not show duplicate command names.
      await application.commands.set([]);
    } else {
      await application.commands.set(slashCommands);
    }
    logger?.info('discord slash commands registered', {
      scope: config.guildId ? `guild ${config.guildId}` : 'global',
      count: slashCommands.length,
      icon: '🛠️',
    });
  }

  /** @param {any} message */
  async function handleMessage(message) {
    if (message.author?.bot) return;
    const isDm = message.channel?.isDMBased?.() === true;
    const mentioned = Boolean(client.user && message.mentions?.users?.has(client.user.id));
    // The mention picker also offers the bot's managed role; accept it as a mention.
    const roleMentioned = isBotRoleMentioned(message, client.user?.id ?? '');
    logger?.debug('discord message received', {
      channelId: message.channelId,
      author: message.author?.username,
      isDm,
      mentioned,
      roleMentioned,
      reference: Boolean(message.reference?.messageId),
    });
    if (!isChannelAllowed(config, message.channel ?? { id: message.channelId })) return;
    let repliedToBot = false;
    if (!mentioned && !roleMentioned && !isDm && message.reference?.messageId) {
      const referenced = await message.fetchReference().catch(() => null);
      repliedToBot = Boolean(referenced && referenced.author?.id === client.user?.id);
    }
    // Channels listed in respondToAllChannelIds get a reply to every message, no mention needed.
    const listensHere = config.respondToAllChannelIds?.includes(message.channelId) === true;
    if (!isBotAddressed({ mentioned, roleMentioned, repliedToBot, isDm, listensHere })) return;
    const event = toDiscordEvent(message, client);
    if (!event) return;
    metrics?.inc('discord.messages.in');
    await onEvent(event);
  }

  /** @param {any} interaction */
  async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand()) return;
    // Threads resolve through interaction.channel; a missing channel falls back to channelId.
    const channel = interaction.channel ?? (interaction.channelId ? { id: interaction.channelId } : null);
    // DMs (no guild) are direct to the bot, so they are always allowed.
    const allowed = !interaction.guildId || !channel || isChannelAllowed(config, channel);
    if (!allowed) {
      await interaction.reply({ content: 'This channel is not allowed.', ephemeral: true });
      return;
    }
    // Native handlers own the interaction lifecycle (buttons, select menus, modals).
    const native = nativeCommands[String(interaction.commandName ?? '').toLowerCase()];
    if (native) {
      try {
        await native(interaction);
      } catch (error) {
        logger?.error('discord native command failed', {
          command: interaction.commandName,
          error: String(/** @type {any} */ (error)?.message ?? error),
        });
      }
      return;
    }
    const event = toDiscordInteractionEvent(interaction, client);
    try {
      await interaction.deferReply();
    } catch (error) {
      logger?.warn('discord interaction defer failed', {
        error: String(/** @type {any} */ (error)?.message ?? error),
      });
    }
    try {
      await onEvent(event);
    } catch (error) {
      logger?.error('discord slash command failed', {
        command: interaction.commandName,
        error: String(/** @type {any} */ (error)?.message ?? error),
      });
    } finally {
      try {
        await interaction.deleteReply();
      } catch {
        // The deferred reply may already be gone (or expired): ignore.
      }
    }
  }

  async function start() {
    client.on('messageCreate', (message) => {
      handleMessage(message).catch((error) =>
        logger?.error('discord message handling failed', {
          error: String(/** @type {any} */ (error)?.message ?? error),
        }),
      );
    });
    client.on('interactionCreate', (interaction) => {
      handleInteraction(interaction).catch((error) =>
        logger?.error('discord interaction failed', {
          error: String(/** @type {any} */ (error)?.message ?? error),
        }),
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
        logger?.error('discord command registration failed', {
          error: String(/** @type {any} */ (error)?.message ?? error),
        }),
      );
    });
    client.on('error', (error) =>
      logger?.error('discord client error', { error: String(/** @type {any} */ (error)?.message ?? error) }),
    );
    await client.login(token);
  }

  async function stop() {
    stopAllTyping();
    await client.destroy();
  }

  return {
    start,
    stop,
    sendMessage,
    sendPhoto,
    sendSticker,
    editMessage,
    react,
    sendEmbed,
    createThread,
    startTyping,
    stopAllTyping,
    ping,
    get displayName() {
      return client.user?.username ?? '';
    },
  };
}
