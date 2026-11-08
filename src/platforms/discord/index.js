import { normalizeWhitespace } from '../../core/text/format.js';
import { createDiscordTransport } from './transport.js';
import { registerDiscordPrompt, DISCORD_TOOL_GUIDANCE } from './prompt.js';
import { createDiscordStickerService, createStickerToolRunner, stickerToolDefinitions } from './stickers.js';

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
    logger,
  });
  const stickers = createDiscordStickerService({ config, client: transport.client, logger, metrics });
  const runStickerTool = createStickerToolRunner({ stickers, logger });

  return {
    name: 'discord',
    label: 'Discord',
    transport,
    transportMode: 'gateway',
    capabilities: {
      stickers: true,
      uploadMedia: true,
      nativeInteractions: true,
      messageEdits: true,
      threads: true,
    },
    limits: { text: 2000, caption: 2000 },
    formatOutgoing: (/** @type {string} */ text) => normalizeWhitespace(String(text ?? '')),
    prompt: { register: registerDiscordPrompt, toolGuidance: DISCORD_TOOL_GUIDANCE },
    tools: {
      definitions: () => stickerToolDefinitions(config),
      run: runStickerTool,
    },
    stickers,
    explainError: () => null,
  };
}
