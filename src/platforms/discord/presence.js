import { ActivityType } from 'discord.js';

const PRESENCE_TYPES = {
  PLAYING: ActivityType.Playing,
  STREAMING: ActivityType.Streaming,
  LISTENING: ActivityType.Listening,
  WATCHING: ActivityType.Watching,
  COMPETING: ActivityType.Competing,
};

/**
 * Apply `config.discord.presence` once the gateway is ready. Unknown or missing types fall
 * back to Watching, which is the only activity that accepts free text without a URL.
 * @param {{client: any, presence?: any, logger?: import('../../core/logger.js').Logger}} deps
 */
export function applyPresence(deps) {
  const { client, presence, logger } = deps;
  if (!presence?.text) return;
  const type = PRESENCE_TYPES[/** @type {keyof typeof PRESENCE_TYPES} */ (presence.type)] ?? ActivityType.Watching;
  client.user?.setPresence({
    status: presence.status ?? 'online',
    activities: [
      {
        name: presence.text,
        type,
        ...(type === ActivityType.Streaming && presence.url ? { url: presence.url } : {}),
      },
    ],
  });
  logger?.info('discord presence set', {
    status: presence.status,
    type: presence.type,
    text: presence.text,
  });
}
