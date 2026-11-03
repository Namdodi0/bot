import { normalizeWhitespace } from '../../core/text/format.js';
import { createDiscordTransport } from './transport.js';
import { registerDiscordPrompt, DISCORD_TOOL_GUIDANCE } from './prompt.js';
import { createDiscordStickerService } from './stickers.js';

/**
 * Discord platform descriptor. The native bot (bot.js) owns slash commands and interactions;
 * this object only exposes what the shared engine needs (transport, limits, prompt, policy).
 * @param {{config: any, boot: {logger: import('../../core/logger.js').Logger, metrics: any}}} input
 * @returns {import('../contract.js').Platform}
 */
export function createDiscordPlatform(input) {
  const config = input.config;
  const { logger, metrics } = input.boot;

  const transport = createDiscordTransport({
    token: config.discord.token,
    config: config.discord,
    logger,
    metrics,
  });
  const stickers = createDiscordStickerService({ config, client: transport.client, logger, metrics });

  return {
    name: 'discord',
    label: 'Discord',
    transport,
    transportMode: 'gateway',
    capabilities: {
      stickers: false,
      uploadMedia: true,
      nativeInteractions: true,
      messageEdits: true,
      embeds: true,
      threads: true,
    },
    limits: { text: 2000, caption: 2000 },
    formatOutgoing: (/** @type {string} */ text) => normalizeWhitespace(String(text ?? '')),
    isAdmin: (/** @type {any} */ event) => event?.isAdmin === true,
    prompt: { register: registerDiscordPrompt, toolGuidance: DISCORD_TOOL_GUIDANCE },
    commands: {
      // Slash commands are native (specs.js/commands.js); the shared text router is unused.
      specs: [],
      run: async () => undefined,
    },
    tools: {
      definitions: () =>
        stickers.enabled
          ? [
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
            ]
          : [],
      run: async (/** @type {string} */ name, /** @type {any} */ args, /** @type {any} */ ctx) => {
        if (name !== 'send_sticker') return null;
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
      },
    },
    stickers,
    healthServices: ['tavily'],
    explainError: () => null,
    start: async () => {
      await transport.start();
      return { ready: {}, done: Promise.resolve() };
    },
    stop: () => transport.stop(),
  };
}
