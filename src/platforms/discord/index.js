import { normalizeWhitespace } from '../../core/text/format.js';
import { createDiscordTransport } from './client.js';
import {
  createDiscordCommandRunner,
  createDiscordNativeCommands,
  DISCORD_COMMAND_SPECS,
  DISCORD_HELP_NOTE,
  DISCORD_HELP_OVERRIDES,
} from './commands.js';
import { registerDiscordPrompt } from './prompt.js';

/**
 * Build the Discord platform: gateway transport plus Discord-specific policy and features.
 * @param {{config: any, boot: {logger: import('../../core/logger.js').Logger, metrics: any}}} input
 * @returns {import('../contract.js').Platform}
 */
export function createDiscordPlatform(input) {
  const config = input.config;
  const { logger, metrics } = input.boot;

  /** @type {(event: any) => void} */
  let dispatch = () => {};
  const nativeCommands = createDiscordNativeCommands();

  const transport = createDiscordTransport({
    token: config.discord.token,
    config: config.discord,
    commandSpecs: DISCORD_COMMAND_SPECS,
    nativeCommands,
    logger,
    metrics,
    onEvent: (event) => dispatch(event),
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
    prompt: {
      register: registerDiscordPrompt,
    },
    commands: {
      specs: DISCORD_COMMAND_SPECS,
      helpOverrides: DISCORD_HELP_OVERRIDES,
      helpNote: DISCORD_HELP_NOTE,
      run: createDiscordCommandRunner(),
      native: nativeCommands,
    },
    tools: {
      run: async (/** @type {string} */ name) =>
        name === 'send_sticker'
          ? { ok: false, text: 'Zalo stickers are not available on Discord.' }
          : null,
    },
    healthServices: ['tavily'],
    explainError: () => null,
    /**
     * @param {import('../contract.js').PlatformStartInput} startInput
     * @returns {Promise<import('../contract.js').PlatformStartResult>}
     */
    async start(startInput) {
      dispatch = startInput.onEvent;
      try {
        await transport.start();
      } catch (error) {
        logger.error('discord failed to start — check DISCORD_BOT_TOKEN', { error });
        throw error;
      }
      if (!config.discord.allowedChannelIds.length) {
        logger.warn(
          'config.discord.allowedChannelIds is empty: the bot answers in every channel where it is mentioned/replied to, and in DMs.',
        );
      }
      if (config.discord.respondToAllChannelIds.length) {
        logger.info('discord respond-to-all channels', {
          channels: config.discord.respondToAllChannelIds,
        });
      }
      const signal = startInput.signal;
      const done = new Promise((resolve) => {
        if (signal?.aborted) resolve(undefined);
        else signal?.addEventListener('abort', () => resolve(undefined), { once: true });
      });
      return { ready: { displayName: transport.displayName }, done };
    },
    async stop() {
      await transport.stop();
    },
  };
}