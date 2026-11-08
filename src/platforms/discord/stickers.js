const CACHE_TTL_MS = 5 * 60_000;

/**
 * Parse `config.discord.stickers.ids`: "123456789012345678:wave,987654321098765432:cat".
 * Discord sticker ids are snowflakes (digits).
 * @param {string} raw
 * @returns {Array<{id: string, name: string, tags: string[]}>}
 */
export function parseDiscordStickerIds(raw) {
  /** @type {Array<{id: string, name: string, tags: string[]}>} */
  const out = [];
  for (const part of String(raw ?? '').split(',')) {
    const [idPart, ...nameParts] = part.split(':');
    const id = String(idPart ?? '').trim();
    if (!/^\d{15,25}$/.test(id)) continue;
    out.push({ id, name: nameParts.join(':').trim() || id, tags: [] });
  }
  return out;
}

/**
 * Discord `send_sticker` tool schema, advertised only when server stickers are enabled.
 * @param {any} config
 */
export function stickerToolDefinitions(config) {
  if (config?.discord?.stickers?.enabled === false) return [];
  return [
    {
      type: 'function',
      function: {
        name: 'send_sticker',
        description: 'Send a sticker available in this Discord server that fits the mood.',
        parameters: {
          type: 'object',
          properties: {
            emotion: {
              type: 'string',
              description: 'Sticker name, tag, mood or id, e.g. "wave", "cat", "happy"',
            },
          },
          required: ['emotion'],
        },
      },
    },
  ];
}

/**
 * `send_sticker` tool runner. Returns null for other tool names so the core router keeps
 * looking.
 * @param {{stickers: ReturnType<typeof createDiscordStickerService>, logger?: any}} deps
 */
export function createStickerToolRunner(deps) {
  const stickers = deps.stickers;

  /** @param {string} name @param {any} args @param {{chatId: string, suppressDirectSend?: boolean}} ctx */
  return async function run(name, args, ctx) {
    if (name !== 'send_sticker') return null;
    // Private turns live in an interaction reply; a channel send would leak them publicly.
    if (ctx?.suppressDirectSend === true) {
      return { ok: false, text: 'Stickers cannot be sent in a private answer.' };
    }
    if (!stickers.enabled) return { ok: false, text: 'Stickers are disabled in the config.' };
    try {
      const channel = await stickers.channelOf(ctx.chatId);
      const query = args?.emotion ?? args?.query ?? args?.name;
      const sticker = await stickers.resolve(channel, query);
      if (!sticker) return { ok: false, text: 'No matching sticker in this server.' };
      await stickers.send(channel, sticker);
      return { ok: true, text: `Sent the sticker "${sticker.name}".` };
    } catch (error) {
      return { ok: false, text: `Could not send the sticker: ${String(/** @type {any} */ (error)?.message ?? error)}` };
    }
  };
}

/**
 * Guild sticker lookup with a config fallback. Listing guild stickers needs Manage
 * Expressions; when that is missing the configured ids still work.
 * @param {{config: any, client: any, logger: any, metrics?: any}} deps
 */
export function createDiscordStickerService({ config, client, logger, metrics }) {
  const enabled = config?.discord?.stickers?.enabled !== false;
  const configured = parseDiscordStickerIds(config?.discord?.stickers?.ids ?? '');
  /** @type {Map<string, {items: any[], at: number}>} */
  const cache = new Map();

  /** @param {string} chatId */
  async function channelOf(chatId) {
    const id = String(chatId ?? '').replace(/^discord:/, '');
    const channel = client.channels.cache.get(id) ?? (await client.channels.fetch(id));
    if (!channel || typeof channel.send !== 'function') throw new Error(`Discord channel not found: ${id}`);
    return channel;
  }

  /** @param {any} channel */
  async function guildStickers(channel) {
    const guild = channel?.guild;
    if (!guild) return configured;
    const cached = cache.get(guild.id);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.items;
    try {
      const stickers = await guild.stickers.fetch();
      const items = [...stickers.values()].map((sticker) => ({
        id: String(sticker.id),
        name: String(sticker.name ?? sticker.id),
        tags: String(sticker.tags ?? '')
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      }));
      cache.set(guild.id, { items, at: Date.now() });
      return items;
    } catch (error) {
      logger?.debug('discord guild stickers fetch failed', {
        error: String(/** @type {any} */ (error)?.message ?? error),
      });
      cache.set(guild.id, { items: configured, at: Date.now() });
      return configured;
    }
  }

  /** @param {any} channel */
  async function list(channel) {
    const guildItems = await guildStickers(channel);
    const seen = new Set();
    /** @type {Array<{id: string, name: string, tags: string[]}>} */
    const merged = [];
    for (const item of [...guildItems, ...configured]) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
    }
    return merged;
  }

  /**
   * @param {any} channel
   * @param {string} [query]
   */
  async function resolve(channel, query) {
    const items = await list(channel);
    if (!items.length) return null;
    const needle = String(query ?? '').trim().toLowerCase();
    if (!needle) return items[Math.floor(Math.random() * items.length)];
    return (
      items.find((item) => item.id === needle) ??
      items.find((item) => item.name.toLowerCase() === needle) ??
      items.find((item) => item.name.toLowerCase().includes(needle)) ??
      items.find((item) => item.tags.some((tag) => tag.toLowerCase().includes(needle))) ??
      null
    );
  }

  /** @param {any} channel @param {{id: string, name: string}} sticker */
  async function send(channel, sticker) {
    await channel.send({ stickers: [String(sticker.id)], allowedMentions: { parse: [] } });
    metrics?.inc('discord.sticker.sent');
  }

  return { enabled, configured, list, resolve, send, channelOf };
}
