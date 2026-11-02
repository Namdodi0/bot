/**
 * Single source of truth for command metadata: Discord slash definitions and /help bullets.
 *
 * @typedef {{name: string, description: string, help: string, helpDiscord?: string, platforms?: string[], options?: any[]}} CommandSpec
 */

/** @type {CommandSpec[]} */
export const COMMAND_SPECS = [
  {
    name: 'help',
    description: 'List bot commands',
    help: '`/help` — list of commands',
  },
  {
    name: 'status',
    description: 'Bot status, model and context info',
    help: '`/status` — bot status, context, latency',
  },
  {
    name: 'id',
    description: 'Show this channel id and your user id',
    help: '`/id` — id of the current chat',
  },
  {
    name: 'reset',
    description: 'Clear this chat context (keeps settings)',
    help: '`/reset` — clear this chat\'s context (keeps model/tone); `/reset all` also clears the settings',
    options: [{ name: 'all', description: 'Also clear per-chat settings', type: 5 }],
  },
  {
    name: 'compact',
    description: 'Compact the context now (admin)',
    help: '`/compact` — compact the context now (admin)',
  },
  {
    name: 'summary',
    description: 'Summarize recent messages',
    help: '`/summary [N]` — summarize the last N messages (default 30)',
    options: [{ name: 'count', description: 'Messages to summarize (2-200, default 30)', type: 4, min_value: 2, max_value: 200 }],
  },
  {
    name: 'search',
    description: 'Force a web search for a question',
    help: '`/search <question>` — force a web search for the question',
    options: [{ name: 'query', description: 'Question to search', type: 3, required: true }],
  },
  {
    name: 'image',
    description: 'Find and send images',
    help: '`/image <keywords>` — find and send an image',
    options: [{ name: 'query', description: 'Image keywords', type: 3, required: true }],
  },
  {
    name: 'sticker',
    description: 'Send a sticker',
    help: '`/sticker [mood]` — send a sticker; `/sticker add <id> [name]` to add an ID',
    platforms: ['zalo'],
  },
  {
    name: 'remind',
    description: 'Set a reminder in this channel',
    help: '`/remind <time> <text>` — set a reminder (e.g. `/remind 20:00 tomorrow team meeting`)',
    options: [
      { name: 'when', description: 'HH:MM, HH:MM tomorrow, HH:MM dd/mm, +10m, +2h, +1d', type: 3, required: true },
      { name: 'text', description: 'What to remind about', type: 3, required: true },
    ],
  },
  {
    name: 'model',
    description: 'Show or switch the model for this chat',
    help: '`/model` — view/change the model for this chat',
    options: [{ name: 'alias', description: 'deepseek | pro | nim | ultra | nim-light', type: 3 }],
  },
  {
    name: 'tone',
    description: 'Show or switch the tone for this chat',
    help: '`/tone` — view/change the tone (roast = snarky)',
    options: [{ name: 'name', description: 'roast | hard | friendly | default', type: 3 }],
  },
  {
    name: 'think',
    description: 'Change the reasoning mode for this chat',
    help: '`/think on|off|low|medium|high|auto` — turn reasoning on/off for this chat',
    options: [{ name: 'mode', description: 'on | off | low | medium | high | auto', type: 3 }],
  },
  {
    name: 'split',
    description: 'Change how replies are split into messages',
    help: '`/split on|off|auto` — disable/enable splitting replies into multiple messages',
    options: [{ name: 'mode', description: 'on | off | auto', type: 3 }],
  },
  {
    name: 'ping',
    description: 'Check the Discord connection',
    help: '`/ping` — check the connection to Zalo',
    helpDiscord: '`/ping` — check the Discord connection',
  },
];

/**
 * @param {string} platform
 * @returns {CommandSpec[]}
 */
export function commandSpecsFor(platform) {
  return COMMAND_SPECS.filter((spec) => !spec.platforms || spec.platforms.includes(platform));
}

/** @returns {{name: string, description: string, options?: any[]}[]} */
export function slashCommandPayloads() {
  return commandSpecsFor('discord').map(({ name, description, options }) => ({
    name,
    description,
    ...(options ? { options } : {}),
  }));
}

/**
 * @param {string} platform
 * @returns {string[]}
 */
export function helpBullets(platform) {
  const useDiscordWording = platform === 'discord';
  return commandSpecsFor(platform).map(
    (spec) => `• ${(useDiscordWording && spec.helpDiscord) || spec.help}`,
  );
}
