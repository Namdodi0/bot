import { asString, asStringList, section } from '../../core/config-helpers.js';

/** Known keys of the `discord` section, reported by the root typo check. */
export const DISCORD_SECTION_KEYS = new Set(['guildId', 'allowedChannelIds', 'respondToAllChannelIds']);

/**
 * Parse the Discord-specific settings. Missing-token policy stays in the root composition
 * layer so the platform module only maps config/env to values.
 * @param {{root: Record<string, any>, env: Record<string, unknown>}} input
 */
export function parseDiscordConfig({ root, env }) {
  const discordSection = section(root, 'discord');
  return {
    discord: {
      token: asString(env.DISCORD_BOT_TOKEN, 'DISCORD_BOT_TOKEN'),
      guildId: asString(discordSection.guildId, 'config.discord.guildId'),
      allowedChannelIds: asStringList(discordSection.allowedChannelIds, 'config.discord.allowedChannelIds'),
      respondToAllChannelIds: asStringList(
        discordSection.respondToAllChannelIds,
        'config.discord.respondToAllChannelIds',
      ),
    },
  };
}
