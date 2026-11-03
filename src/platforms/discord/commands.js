import { COMMAND_SPECS } from '../../core/commands/registry.js';

export const DISCORD_COMMAND_SPECS = COMMAND_SPECS.map((spec) =>
  spec.name === 'ping' ? { ...spec, description: 'Check the Discord connection' } : spec,
);

export const DISCORD_HELP_OVERRIDES = {
  ping: '`/ping` — check the Discord connection',
};

export const DISCORD_HELP_NOTE = [
  'The bot runs on the Discord gateway; slash commands are registered in the configured server.',
  'In servers, **@mention the bot** (or its role) or **reply** to one of its messages; DMs work without a mention.',
].join('\n');

/**
 * Text commands that Discord handles differently. Slash commands are registered from
 * DISCORD_COMMAND_SPECS; this runner only catches typed text such as `/sticker`.
 * @returns {(name: string, args: string, ctx: any) => Promise<any>|undefined}
 */
export function createDiscordCommandRunner() {
  return async function run(name) {
    if (name === 'sticker') {
      return { kind: 'text', text: 'Zalo stickers are not supported on Discord.' };
    }
    return undefined;
  };
}

/**
 * Native slash-command handlers receive the raw interaction and bypass the text router.
 * Discord-only features (buttons, select menus, modals) plug in here.
 * @param {Record<string, (interaction: any) => Promise<void>|void>} [handlers]
 */
export function createDiscordNativeCommands(handlers = {}) {
  return handlers;
}