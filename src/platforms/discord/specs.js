import { ApplicationCommandType, PermissionFlagsBits } from 'discord.js';

/**
 * Discord-native command surface: slash commands first, plus two message context menus.
 * Zalo-only commands (tone, split, think) are intentionally absent.
 */
export const COMMANDS = [
  {
    type: ApplicationCommandType.ChatInput,
    name: 'ask',
    description: 'Ask the AI in this channel',
    help: '`/ask` — ask the AI (options: private answer, new thread, image)',
    options: [
      { name: 'prompt', description: 'What do you want to ask? (omit to open a form)', type: 3 },
      { name: 'form', description: 'Open a multi-line prompt form', type: 5 },
      { name: 'private', description: 'Only you can see the answer', type: 5 },
      { name: 'thread', description: 'Answer in a new thread', type: 5 },
      { name: 'image', description: 'An image for the bot to look at (max 8 MB)', type: 11 },
    ],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'help',
    description: 'Show the bot commands',
    help: '`/help` — show this list',
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'status',
    description: 'Show model, context and latency',
    help: '`/status` — model, context and latency',
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'ping',
    description: 'Check the gateway latency',
    help: '`/ping` — check the gateway latency',
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'model',
    description: 'Show or switch the model for this channel (admin)',
    help: '`/model` — show or switch the model for this channel (admin)',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    options: [{ name: 'name', description: 'Model alias', type: 3, autocomplete: true }],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'settings',
    description: 'Channel settings: model, style, think effort, privacy, threads (admin)',
    help: '`/settings` — model, style, think effort, privacy and thread defaults (admin)',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'reset',
    description: 'Clear this channel context (admin)',
    help: '`/reset` — clear this channel context (admin)',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    options: [{ name: 'all', description: 'Also clear per-channel settings', type: 5 }],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'compact',
    description: 'Compact this channel context now (admin)',
    help: '`/compact` — compact the context now (admin)',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'summary',
    description: 'Summarize recent messages',
    help: '`/summary` — summarize the last N messages',
    options: [
      { name: 'count', description: 'Messages to summarize (2-200, default 30)', type: 4, min_value: 2, max_value: 200 },
    ],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'catchup',
    description: 'Summarize what you missed in this channel',
    help: '`/catchup` — summarize the last N hours',
    options: [
      { name: 'hours', description: 'How far back to look (1-168, default 24)', type: 4, min_value: 1, max_value: 168 },
    ],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'search',
    description: 'Search the web and answer from the results',
    help: '`/search` — web search',
    options: [
      { name: 'query', description: 'What to search for', type: 3, required: true },
      { name: 'private', description: 'Only you can see the answer', type: 5 },
    ],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'image',
    description: 'Find and send images',
    help: '`/image` — find and send images',
    options: [
      { name: 'query', description: 'Image keywords', type: 3, required: true },
      { name: 'count', description: 'How many images (default 1, max 5)', type: 4, min_value: 1, max_value: 5 },
      { name: 'private', description: 'Only you can see the images', type: 5 },
    ],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'sticker',
    description: 'Send a sticker available in this server',
    help: '`/sticker [name]` — send a server sticker (omit to list)',
    options: [
      { name: 'name', description: 'Sticker name, tag or id (omit to list)', type: 3 },
    ],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'remind',
    description: 'Manage reminders in this channel',
    help: '`/remind add|list|cancel` — reminders with Discord timestamps',
    options: [
      {
        type: 1,
        name: 'add',
        description: 'Set a reminder',
        options: [
          { name: 'when', description: 'HH:MM, HH:MM tomorrow, HH:MM dd/mm, +10m, +2h, +1d', type: 3, required: true },
          { name: 'text', description: 'What to remind you about', type: 3, required: true },
        ],
      },
      { type: 1, name: 'list', description: 'List reminders in this channel' },
      {
        type: 1,
        name: 'cancel',
        description: 'Cancel a reminder by id',
        options: [{ name: 'id', description: 'Reminder id from /remind list', type: 4, required: true, min_value: 1, autocomplete: true }],
      },
    ],
  },
  {
    type: ApplicationCommandType.Message,
    name: 'Explain message',
    help: 'Message menu: Explain message',
  },
  {
    type: ApplicationCommandType.Message,
    name: 'Summarize message',
    help: 'Message menu: Summarize message',
  },
];

/** Help shown by the native /help embed and by the shared engine fallback. */
export const HELP_NOTE = [
  'Slash commands only — the bot also answers when you **@mention** it or **reply** to one of its messages.',
  'Answers are posted in the channel; use the `private` option for an ephemeral reply.',
  'Right-click a message → Apps → **Explain message** / **Summarize message**.',
].join('\n');

export const COMMAND_NAMES = new Set(COMMANDS.map((command) => command.name));
