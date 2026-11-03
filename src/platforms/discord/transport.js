import { AttachmentBuilder, Client, GatewayIntentBits, Partials } from 'discord.js';
import { normalizeWhitespace } from '../../core/text/format.js';

const TYPING_REFRESH_MS = 8_000;
export const DISCORD_MAX_CONTENT = 2000;

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'gif', 'webp', 'bmp']);

/**
 * Discord renders attachments inline by extension; a buffer uploaded as "image" (no
 * extension) shows up as a generic file. Use the validated content type first, then the URL.
 * @param {string} url
 * @param {string} [contentType]
 */
export function photoFilename(url, contentType) {
  const subtype = String(contentType ?? '')
    .split('/')[1]
    ?.split(';')[0]
    ?.trim()
    .toLowerCase();
  const fromType = subtype === 'jpeg' ? 'jpg' : subtype;
  if (IMAGE_EXTENSIONS.has(fromType)) return `image.${fromType}`;
  const fromUrl = /\.(png|jpe?g|gif|webp|bmp)(?:[?#]|$)/i.exec(String(url ?? ''));
  return `image.${fromUrl ? fromUrl[1].toLowerCase().replace('jpeg', 'jpg') : 'png'}`;
}

/** @param {string} caption */
export function photoCaption(caption) {
  const text = String(caption ?? '');
  return text ? text.slice(0, DISCORD_MAX_CONTENT) : '';
}

/**
 * Thin Discord transport: sends messages/media/typing for the shared engine. Event routing
 * and slash commands live in bot.js/commands.js.
 * @param {{token: string, config?: {allowedChannelIds?: string[], respondToAllChannelIds?: string[]}, client?: any, logger?: import('../../core/logger.js').Logger, metrics?: any, createClient?: () => any}} options
 */
export function createDiscordTransport(options) {
  const token = options.token;
  const config = options.config ?? {};
  const logger = options.logger;
  const metrics = options.metrics;

  const client =
    options.client ??
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

  /** Accept both raw channel ids and the legacy `discord:` prefix used by old reminders. */
  const channelIdOf = (chatId) =>
    String(chatId ?? '').startsWith('discord:') ? String(chatId).slice('discord:'.length) : String(chatId ?? '');

  /** @param {string} chatId */
  async function channelOf(chatId) {
    const id = channelIdOf(chatId);
    const cached = client.channels.cache.get(id);
    const channel = cached ?? (await client.channels.fetch(id));
    if (!channel || typeof channel.send !== 'function') throw new Error(`Discord channel not found: ${id}`);
    return channel;
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
   * @param {{data?: Buffer, contentType?: string}} [asset] pre-validated bytes
   */
  async function sendPhoto(chatId, url, caption = '', asset = {}) {
    const channel = await channelOf(chatId);
    const file = new AttachmentBuilder(asset?.data ? Buffer.from(asset.data) : String(url), {
      name: photoFilename(url, asset?.contentType),
    });
    const content = photoCaption(caption);
    return channel.send({
      content: content || undefined,
      files: [file],
      allowedMentions: { parse: [] },
    });
  }

  async function sendSticker() {
    throw new Error('Stickers are not supported on Discord');
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

  async function start() {
    await client.login(token);
  }

  async function stop() {
    stopAllTyping();
    await client.destroy();
  }

  return {
    client,
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
    formatText: (/** @type {string} */ text) => normalizeWhitespace(String(text ?? '')),
    get displayName() {
      return client.user?.username ?? '';
    },
  };
}
