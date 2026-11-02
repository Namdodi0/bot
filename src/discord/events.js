/**
 * Pure Discord event normalization (no discord.js import, so it is easy to unit test).
 * Message/interaction objects only need the fields used here.
 */

export const DISCORD_CHAT_PREFIX = 'discord:';

/**
 * Remove <@id> / <@!id> mentions of the bot and collapse the leftover spaces.
 * @param {string} text
 * @param {string} botId
 */
export function stripBotMention(text, botId) {
  const id = String(botId ?? '').trim();
  let out = String(text ?? '');
  if (id) out = out.replace(new RegExp(`<@!?${id}>`, 'g'), ' ');
  return out.replace(/[ \t]{2,}/g, ' ').trim();
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
  const text = stripBotMention(message.content, client?.user?.id);
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
