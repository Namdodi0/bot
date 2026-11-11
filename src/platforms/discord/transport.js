import { AttachmentBuilder, Client, GatewayIntentBits, Partials } from 'discord.js';
import { normalizeWhitespace } from '../../core/text/format.js';

const TYPING_REFRESH_MS = 8_000;
const DISCORD_MAX_CONTENT = 2000;

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
function photoCaption(caption) {
  const text = String(caption ?? '');
  return text ? text.slice(0, DISCORD_MAX_CONTENT) : '';
}

/**
 * Thin Discord transport: sends messages/media/typing for the shared engine. Event routing
 * and slash commands live in bot.js/commands.js.
 * @param {{token: string, client?: any, logger?: import('../../core/logger.js').Logger, createClient?: () => any}} options
 */
export function createDiscordTransport(options) {
  const token = options.token;
  const logger = options.logger;

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
      partials: [Partials.Channel, Partials.Message, Partials.User],
    });

  // One entry per active turn, not per chat: parallel turns in one chat must not
  // overwrite each other's timer.
  /** @type {Set<NodeJS.Timeout>} */
  const typingTimers = new Set();

  /** @param {string} chatId */
  async function channelOf(chatId) {
    const id = String(chatId ?? '');
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

  /** @param {string} chatId */
  function startTyping(chatId) {
    const id = String(chatId ?? '');
    let stopped = false;
    const ping = () => {
      if (stopped) return;
      const channel = /** @type {any} */ (client.channels.cache.get(id));
      channel?.sendTyping?.().catch((error) => {
        logger?.debug('discord typing indicator failed', {
          chatId,
          error: String(/** @type {any} */ (error)?.message ?? error),
        });
      });
    };
    ping();
    const timer = setInterval(ping, TYPING_REFRESH_MS);
    timer.unref?.();
    typingTimers.add(timer);
    return async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      typingTimers.delete(timer);
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
    startTyping,
    stopAllTyping,
    ping,
    formatText: (/** @type {string} */ text) => normalizeWhitespace(String(text ?? '')),
    get displayName() {
      return client.user?.username ?? '';
    },
  };
}
