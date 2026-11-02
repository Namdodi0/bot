/**
 * Pure Discord event normalization (no discord.js import, so it is easy to unit test).
 * Message/interaction objects only need the fields used here.
 */

export const DISCORD_CHAT_PREFIX = 'discord:';

/**
 * Whether a Discord channel is permitted by `config.allowedChannelIds`.
 * An empty/absent list allows every channel. DMs are always allowed because they are
 * addressed directly to the bot. Threads inherit their parent channel's entry by matching
 * `channel.parentId`, so an allowed parent also allows its threads.
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
 * Remove <@id> / <@!id> mentions of the bot, its managed role mention (<@&id>), and
 * collapse the leftover spaces.
 * @param {string} text
 * @param {string} botId
 * @param {string} [roleId] the bot's managed role id, when it was mentioned
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

/** @param {any} member */
function isGuildAdmin(member) {
  try {
    return Boolean(member?.permissions?.has?.('ManageGuild'));
  } catch {
    return false;
  }
}

/**
 * @param {any} message discord.js Message-like
 * @param {any} client discord.js Client-like
 * @returns {any|null} agent event, or null when there is nothing to answer
 */
export function toDiscordEvent(message, client) {
  const channel = message?.channel;
  if (!channel?.id) return null;
  const author = message.author ?? {};
  const attachments = [...(message.attachments?.values?.() ?? [])];
  const image = attachments.find(
    (item) => typeof item?.contentType === 'string' && item.contentType.startsWith('image/'),
  ) ?? attachments.find((item) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(String(item?.url ?? '')));
  const text = stripBotMention(message.content, client?.user?.id, botRoleId(message, client?.user?.id));
  if (!text && !image) return null;
  const kind = text ? 'text' : 'image';
  return {
    kind,
    chatId: `${DISCORD_CHAT_PREFIX}${channel.id}`,
    chatType: channel.isDMBased?.() === true ? 'PRIVATE' : 'GROUP',
    senderId: String(author.id ?? ''),
    senderName: String(
      message.member?.displayName ?? author.displayName ?? author.username ?? 'Member',
    ),
    isBot: Boolean(author.bot),
    text,
    imageUrl: image?.url ? String(image.url) : null,
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
 * Discord's mention picker also offers the bot's managed role (named after the bot).
 * Treat a mention of that role as a mention of the bot itself.
 * @param {any} message
 * @param {string} botId
 */
export function isBotRoleMentioned(message, botId) {
  return Boolean(botRoleId(message, botId));
}

/**
 * Whether an incoming message is addressed to the bot: a direct mention, the bot's managed
 * role, a reply to one of its messages, a DM, or a channel opted into respondToAllChannelIds.
 * @param {{mentioned?: boolean, roleMentioned?: boolean, repliedToBot?: boolean, isDm?: boolean, listensHere?: boolean}} flags
 */
export function isBotAddressed(flags = {}) {
  return Boolean(flags.mentioned || flags.roleMentioned || flags.repliedToBot || flags.isDm || flags.listensHere);
}

/**
 * Turn a slash command interaction into the same synthetic text event the command router
 * already understands (`/name arg1 arg2`). Boolean options named "all" become the word "all".
 * @param {any} interaction discord.js ChatInputCommandInteraction-like
 * @param {any} client discord.js Client-like
 */
export function toDiscordInteractionEvent(interaction, client) {
  const options = [...(interaction?.options?.data ?? [])];
  const args = options
    .map((option) => (option.value === true ? 'all' : String(option.value ?? '').trim()))
    .filter(Boolean)
    .join(' ');
  const command = String(interaction?.commandName ?? '').toLowerCase();
  const user = interaction?.user ?? {};
  const isDm = !interaction?.guildId;
  return {
    kind: 'text',
    chatId: `${DISCORD_CHAT_PREFIX}${interaction.channelId}`,
    chatType: isDm ? 'PRIVATE' : 'GROUP',
    senderId: String(user.id ?? ''),
    senderName: String(
      interaction.member?.displayName ?? user.displayName ?? user.username ?? 'Member',
    ),
    isBot: false,
    text: `/${command}${args ? ` ${args}` : ''}`,
    imageUrl: null,
    sticker: null,
    messageId: null,
    date: Number(interaction.createdTimestamp) || Date.now(),
    eventName: 'message.text.received',
    platform: 'discord',
    botName: String(client?.user?.username ?? ''),
    isAdmin: Boolean(interaction.memberPermissions?.has?.('ManageGuild')),
  };
}
