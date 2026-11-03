import { normalizeWhitespace } from '../../core/text/format.js';
import { createDiscordTransport } from './transport.js';
import { registerDiscordPrompt } from './prompt.js';

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
    prompt: { register: registerDiscordPrompt },
    commands: {
      // Slash commands are native (specs.js/commands.js); the shared text router is unused.
      specs: [],
      run: async () => undefined,
    },
    tools: {
      run: async (/** @type {string} */ name) =>
        name === 'send_sticker' ? { ok: false, text: 'Stickers are not supported on Discord.' } : null,
    },
    healthServices: ['tavily'],
    explainError: () => null,
    start: async () => {
      await transport.start();
      return { ready: {}, done: Promise.resolve() };
    },
    stop: () => transport.stop(),
  };
}
