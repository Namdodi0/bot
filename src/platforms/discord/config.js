import { ConfigError, asBool, asString, asStringList, section } from '../../core/config-helpers.js';
import { DISCORD_SECTION_KEYS } from '../../config-schema.js';

export { DISCORD_SECTION_KEYS };

const PRESENCE_STATUSES = new Set(['online', 'idle', 'dnd', 'invisible']);
const ACTIVITY_TYPES = new Set(['PLAYING', 'STREAMING', 'LISTENING', 'WATCHING', 'COMPETING']);

/**
 * Parse the Discord-specific settings. Missing-token policy stays in the root composition
 * layer so the platform module only maps config/env to values.
 * @param {{root: Record<string, any>, env: Record<string, unknown>}} input
 */
export function parseDiscordConfig({ root, env }) {
  const discordSection = section(root, 'discord');
  const stickersSection = section(discordSection, 'stickers');
  const presenceSection = section(discordSection, 'presence');
  const presenceStatus = asString(presenceSection.status, 'config.discord.presence.status', 'online').toLowerCase();
  if (!PRESENCE_STATUSES.has(presenceStatus)) {
    throw new ConfigError('config.discord.presence.status must be online|idle|dnd|invisible');
  }
  const presenceType = asString(presenceSection.type, 'config.discord.presence.type', 'WATCHING').toUpperCase();
  if (!ACTIVITY_TYPES.has(presenceType)) {
    throw new ConfigError('config.discord.presence.type must be PLAYING|STREAMING|LISTENING|WATCHING|COMPETING');
  }
  return {
    discord: {
      token: asString(env.DISCORD_BOT_TOKEN, 'DISCORD_BOT_TOKEN'),
      guildId: asString(discordSection.guildId, 'config.discord.guildId'),
      allowedChannelIds: asStringList(discordSection.allowedChannelIds, 'config.discord.allowedChannelIds'),
      respondToAllChannelIds: asStringList(
        discordSection.respondToAllChannelIds,
        'config.discord.respondToAllChannelIds',
      ),
      stickers: {
        enabled: asBool(stickersSection.enabled, 'config.discord.stickers.enabled', true),
        ids: asString(stickersSection.ids, 'config.discord.stickers.ids'),
      },
      presence: {
        status: presenceStatus,
        type: presenceType,
        text: asString(presenceSection.text, 'config.discord.presence.text', '🐋🐳🐋🐳🐋🐳🐋🐳🐋🐳🐋🐳🐋🐳🐋🐳🐋🐳🐋🐳'),
        url: asString(presenceSection.url, 'config.discord.presence.url'),
      },
    },
  };
}
