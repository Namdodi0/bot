import { MAX_VISION_IMAGES } from '../../core/ai/agent/helpers.js';

/**
 * Pure Discord normalization and admission helpers (no discord.js import, easy to test).
 * Channel ids are used as-is.
 */

/**
 * Remove <@id> / <@!id> mentions of the bot, its managed role mention (<@&id>), and
 * collapse the leftover spaces.
 * @param {string} text
 * @param {string} botId
 * @param {string} [roleId]
 */
export function stripBotMention(text, botId, roleId = '') {
  const id = String(botId ?? '').trim();
  const role = String(roleId ?? '').trim();
  let out = String(text ?? '');
  if (id) out = out.replace(new RegExp(`<@!?${id}>`, 'g'), ' ');
  if (role) out = out.replace(new RegExp(`<@&${role}>`, 'g'), ' ');
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * The id of the bot's managed role when that role was mentioned, else an empty string.
 * @param {any} message
 * @param {string} botId
 */
export function botRoleId(message, botId) {
  const id = String(botId ?? '');
  if (!id) return '';
  const roles = [...(message?.mentions?.roles?.values?.() ?? [])];
  const role = roles.find((item) => String(item?.tags?.botId ?? '') === id);
  return String(role?.id ?? '');
}

/** @param {any} message @param {string} botId */
export function isBotRoleMentioned(message, botId) {
  return Boolean(botRoleId(message, botId));
}

/** @param {any} member */
function isGuildAdmin(member) {
  try {
    return Boolean(member?.permissions?.has?.('ManageGuild'));
  } catch {
    return false;
  }
}

/**
 * Whether a Discord channel is permitted by `config.allowedChannelIds`.
 * Empty/absent list allows everything; DMs are always allowed; threads inherit their
 * parent channel's entry.
 * @param {{allowedChannelIds?: string[]}|null|undefined} config
 * @param {{id?: string, parentId?: string|null, isDMBased?: () => boolean}|null|undefined} channel
 */
export function isChannelAllowed(config, channel) {
  const ids = config?.allowedChannelIds ?? [];
  if (!ids.length) return true;
  if (channel?.isDMBased?.() === true) return true;
  const id = String(channel?.id ?? '').trim();
  if (id && ids.includes(id)) return true;
  const parentId = String(channel?.parentId ?? '').trim();
  return Boolean(parentId) && ids.includes(parentId);
}

/**
 * Channels opted into answering every message (no mention). Threads inherit the parent.
 * @param {{respondToAllChannelIds?: string[]}|null|undefined} config
 * @param {{id?: string, parentId?: string|null}|null|undefined} channel
 */
export function isRespondToAllChannel(config, channel) {
  const ids = config?.respondToAllChannelIds ?? [];
  if (!ids.length) return false;
  const id = String(channel?.id ?? '').trim();
  if (id && ids.includes(id)) return true;
  const parentId = String(channel?.parentId ?? '').trim();
  return Boolean(parentId) && ids.includes(parentId);
}

/**
 * Whether a message is addressed to the bot.
 * @param {{mentioned?: boolean, roleMentioned?: boolean, repliedToBot?: boolean, isDm?: boolean, listensHere?: boolean}} flags
 */
export function isBotAddressed(flags = {}) {
  return Boolean(flags.mentioned || flags.roleMentioned || flags.repliedToBot || flags.isDm || flags.listensHere);
}

/**
 * Visible text of a message, including Components V2 TextDisplay blocks. The bot's own
 * V2 answers have an empty `content`, so reply quotes would otherwise be blank.
 * @param {any} message
 * @returns {string}
 */
export function messageText(message) {
  if (!message) return '';
  const content = String(message.content ?? '').trim();
  if (content) return content;
  /** @param {any[]} components */
  const collect = (components) => {
    const parts = [];
    for (const component of components ?? []) {
      const json = typeof component?.toJSON === 'function' ? component.toJSON() : component;
      if (!json) continue;
      if (json.type === 10 && json.content) parts.push(String(json.content));
      else if (Array.isArray(json.components)) parts.push(collect(json.components));
    }
    return parts.filter(Boolean).join('\n');
  };
  return collect(message.components).trim();
}

/**
 * Compact quote of the message a user replied to, safe to prepend to the new message text.
 * Mentions of the bot are stripped, whitespace is flattened and long content is clipped.
 * @param {any} referenced discord.js Message-like
 * @param {string} [botId]
 * @param {number} [maxChars]
 * @returns {string}
 */
export function replyQuote(referenced, botId = '', maxChars = 500) {
  if (!referenced) return '';
  const author = String(
    referenced.member?.displayName ??
      referenced.author?.displayName ??
      referenced.author?.username ??
      'someone',
  );
  const flat = stripBotMention(messageText(referenced), botId).replace(/\s+/g, ' ').trim();
  const attachmentCount = Number(referenced.attachments?.size ?? referenced.attachments?.length ?? 0);
  const body = flat
    ? attachmentCount > 0
      ? `${flat} [attachment]`
      : flat
    : attachmentCount > 0
      ? '[attachment]'
      : '';
  if (!body) return '';
  const clipped = body.length > maxChars ? `${body.slice(0, maxChars)}…` : body;
  return `[Replying to ${author}: ${clipped}]`;
}

/** @param {any} item */
function isImageAttachment(item) {
  if (typeof item?.contentType === 'string' && item.contentType.toLowerCase().startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(String(item?.url ?? ''));
}

/**
 * Order image attachments by usefulness (largest pixel area, then byte size) and keep at
 * most `MAX_VISION_IMAGES`. Discord lists attachments in arbitrary order, so the first
 * image can be an emoji rather than the actual photo.
 * @param {any[]} attachments
 */
function sortedImages(attachments) {
  /** @type {{item: any, index: number, score: number}[]} */
  const ranked = [];
  for (let index = 0; index < attachments.length; index += 1) {
    const item = attachments[index];
    if (!isImageAttachment(item)) continue;
    const area = (Number(item?.width) || 0) * (Number(item?.height) || 0);
    ranked.push({ item, index, score: area || Number(item?.size) || 0 });
  }
  return ranked
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_VISION_IMAGES)
    .map((entry) => entry.item);
}

/**
 * Normalize a Discord message for the shared engine.
 * @param {any} message discord.js Message-like
 * @param {any} client discord.js Client-like
 * @param {any} [referenced] the message this one replies to, when fetched
 * @returns {any|null}
 */
export function toDiscordEvent(message, client, referenced = null) {
  const channel = message?.channel;
  if (!channel?.id) return null;
  const author = message.author ?? {};
  const attachments = [...(message.attachments?.values?.() ?? [])];
  const images = sortedImages(attachments);
  let text = stripBotMention(message.content, client?.user?.id, botRoleId(message, client?.user?.id));
  const quote = replyQuote(referenced, client?.user?.id);
  if (quote) text = text ? `${quote}\n${text}` : quote;
  if (!text && !images.length) return null;
  const kind = text ? 'text' : 'image';
  return {
    kind,
    chatId: String(channel.id),
    chatType: channel.isDMBased?.() === true ? 'PRIVATE' : 'GROUP',
    senderId: String(author.id ?? ''),
    senderName: String(message.member?.displayName ?? author.displayName ?? author.username ?? 'Member'),
    isBot: Boolean(author.bot),
    text,
    imageUrl: images[0]?.url ? String(images[0].url) : null,
    imageUrls: images.map((item) => String(item.url ?? '')).filter(Boolean),
    sticker: null,
    messageId: String(message.id ?? ''),
    date: Number(message.createdTimestamp) || Date.now(),
    eventName: kind === 'image' ? 'message.image.received' : 'message.text.received',
    platform: 'discord',
    botName: String(client?.user?.username ?? ''),
    isAdmin: isGuildAdmin(message.member),
  };
}

/**
 * Build the same normalized event from a slash command or context-menu interaction, so
 * native Discord commands can reuse the shared engine for one turn.
 * @param {any} interaction
 * @param {any} client
 * @param {string} text
 * @param {{messageId?: string, chatId?: string, chatType?: string}} [extra]
 */
export function eventFromInteraction(interaction, client, text, extra = {}) {
  const user = interaction?.user ?? {};
  return {
    kind: 'text',
    chatId: String(extra.chatId ?? interaction.channelId ?? ''),
    chatType: extra.chatType ?? (interaction.guildId ? 'GROUP' : 'PRIVATE'),
    senderId: String(user.id ?? ''),
    senderName: String(interaction.member?.displayName ?? user.displayName ?? user.username ?? 'Member'),
    isBot: false,
    text: String(text ?? ''),
    imageUrl: null,
    imageUrls: [],
    sticker: null,
    messageId: String(extra.messageId ?? `interaction:${interaction.id ?? Date.now()}`),
    date: Number(interaction.createdTimestamp) || Date.now(),
    eventName: 'message.text.received',
    platform: 'discord',
    botName: String(client?.user?.username ?? ''),
    isAdmin: Boolean(interaction.guildId) && Boolean(interaction.memberPermissions?.has?.('ManageGuild')),
  };
}
