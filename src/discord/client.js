import { AttachmentBuilder, Client, GatewayIntentBits, Partials } from 'discord.js';
import { DISCORD_CHAT_PREFIX, toDiscordEvent, toDiscordInteractionEvent } from './events.js';

const TYPING_REFRESH_MS = 8_000;

/** Slash commands mirror the text command router; Zalo stickers are intentionally absent. */
const SLASH_COMMANDS = [
  { name: 'help', description: 'List bot commands' },
  { name: 'status', description: 'Bot status, model and context info' },
  { name: 'id', description: 'Show this channel id and your user id' },
  {
    name: 'reset',
    description: 'Clear this chat context (keeps settings)',
    options: [{ name: 'all', description: 'Also clear per-chat settings', type: 5 }],
  },
  { name: 'compact', description: 'Compact the context now (admin)' },
  {
    name: 'summary',
    description: 'Summarize recent messages',
    options: [{ name: 'count', description: 'Messages to summarize (2-200, default 30)', type: 4, min_value: 2, max_value: 200 }],
  },
  {
    name: 'search',
    description: 'Force a web search for a question',
    options: [{ name: 'query', description: 'Question to search', type: 3, required: true }],
  },
  {
    name: 'image',
    description: 'Find and send images',
    options: [{ name: 'query', description: 'Image keywords', type: 3, required: true }],
  },
  {
    name: 'model',
    description: 'Show or switch the model for this chat',
    options: [{ name: 'alias', description: 'deepseek | pro | nim | ultra | nim-light', type: 3 }],
  },
  {
    name: 'tone',
    description: 'Show or switch the tone for this chat',
    options: [{ name: 'name', description: 'roast | hard | friendly | default', type: 3 }],
  },
  {
    name: 'think',
    description: 'Change the reasoning mode for this chat',
    options: [{ name: 'mode', description: 'on | off | low | medium | high | auto', type: 3 }],
  },
  {
    name: 'split',
    description: 'Change how replies are split into messages',
    options: [{ name: 'mode', description: 'on | off | auto', type: 3 }],
  },
  {
    name: 'remind',
    description: 'Set a reminder in this channel',
    options: [
      { name: 'when', description: 'HH:MM, HH:MM tomorrow, HH:MM dd/mm, +10m, +2h, +1d', type: 3, required: true },
      { name: 'text', description: 'What to remind about', type: 3, required: true },
    ],
  },
  { name: 'ping', description: 'Check the Discord connection' },
];

/**
 * Discord transport backed by discord.js.
 * @param {{token: string, config?: {guildId?: string, allowedChannelIds?: string[]}, logger?: import('../logger.js').Logger, metrics?: any, onEvent: (event: any) => Promise<unknown>|void}} options
 */
export function createDiscordTransport(options) {
  const token = options.token;
  const config = options.config ?? {};
  const logger = options.logger;
  const metrics = options.metrics;
  const onEvent = options.onEvent ?? (async () => {});

  const client = new Client({
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
   */
  async function sendPhoto(chatId, url, caption = '') {
    const channel = await channelOf(chatId);
    const file = new AttachmentBuilder(String(url), { name: 'image' });
    return channel.send({
      content: caption ? String(caption) : undefined,
      files: [file],
      allowedMentions: { parse: [] },
    });
  }

  async function sendSticker() {
    throw new Error('Zalo stickers are not supported on Discord');
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
    if (config.guildId) await application.commands.set(SLASH_COMMANDS, config.guildId);
    else await application.commands.set(SLASH_COMMANDS);
    logger?.info('discord slash commands registered', {
      scope: config.guildId ? `guild ${config.guildId}` : 'global',
      count: SLASH_COMMANDS.length,
      icon: '🛠️',
    });
  }

  /** @param {any} message */
  async function handleMessage(message) {
    if (message.author?.bot) return;
    if (config.allowedChannelIds?.length && !config.allowedChannelIds.includes(message.channelId)) return;
    const isDm = message.channel?.isDMBased?.() === true;
    const mentioned = Boolean(client.user && message.mentions?.users?.has(client.user.id));
    let repliedToBot = false;
    if (!mentioned && !isDm && message.reference?.messageId) {
      const referenced = await message.fetchReference().catch(() => null);
      repliedToBot = Boolean(referenced && referenced.author?.id === client.user?.id);
    }
    if (!mentioned && !repliedToBot && !isDm) return;
    const event = toDiscordEvent(message, client);
    if (!event) return;
    metrics?.inc('discord.messages.in');
    await onEvent(event);
  }

  /** @param {any} interaction */
  async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand()) return;
    const allowed = config.allowedChannelIds ?? [];
    if (allowed.length && interaction.channelId && !allowed.includes(interaction.channelId)) {
      await interaction.reply({ content: 'This channel is not allowed.', ephemeral: true });
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
    client.once('ready', () => {
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
    startTyping,
    stopAllTyping,
    ping,
    get displayName() {
      return client.user?.username ?? '';
    },
  };
}
