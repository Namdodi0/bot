import { ApplicationCommandType, PermissionFlagsBits } from 'discord.js';

/**
 * Discord-native command surface: slash commands first, plus two message context menus.
 * Native Discord command surface only; no typed text commands.
 */
export const COMMANDS = [
  {
    type: ApplicationCommandType.ChatInput,
    name: 'ask',
    description: 'Ask me anything — text, images, chaos',
    help: '`/ask` — ask me anything (private, thread, image)',
    options: [
      { name: 'prompt', description: 'What do you want to know? (leave empty for the form)', type: 3 },
      { name: 'form', description: 'Open a multi-line form instead', type: 5 },
      { name: 'private', description: 'Only you get to see the answer', type: 5 },
      { name: 'thread', description: 'Answer in a fresh thread', type: 5 },
      { name: 'image', description: 'An image for me to inspect (max 8 MB)', type: 11 },
    ],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'help',
    description: 'Show the command deck',
    help: '`/help` — show the command deck',
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'status',
    description: 'My vitals: model, context, latency',
    help: '`/status` — my vitals',
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'ping',
    description: 'Check my reflexes',
    help: '`/ping` — check my reflexes',
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'stop',
    description: 'Pull the plug on the current answer',
    help: '`/stop` — pull the plug on the current answer',
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'model',
    description: 'Swap my brain for this channel (admin)',
    help: '`/model` — swap my brain for this channel (admin)',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    options: [{ name: 'name', description: 'Model alias', type: 3, autocomplete: true }],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'settings',
    description: 'Tune this channel: brain, vision, personality, thinking, privacy, threads, after-answer thinking (admin)',
    help: '`/settings` — channel controls (admin)',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    options: [
      {
        name: 'vision',
        description: 'Vision brain for images (leave empty for the panel; "default" resets)',
        type: 3,
        autocomplete: true,
      },
    ],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'reset',
    description: "Wipe this channel's memory (admin)",
    help: "`/reset` — wipe this channel's memory (admin)",
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    options: [{ name: 'all', description: "Also wipe this channel's settings", type: 5 }],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'compact',
    description: 'Squeeze the context until it behaves (admin)',
    help: '`/compact` — squeeze the context (admin)',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'summary',
    description: 'Recap the recent chaos',
    help: '`/summary` — recap the last N messages',
    options: [
      { name: 'count', description: 'How many messages to recap (2–200, default 30)', type: 4, min_value: 2, max_value: 200 },
    ],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'catchup',
    description: 'Recap what you missed',
    help: '`/catchup` — recap the last N hours',
    options: [
      { name: 'hours', description: 'How far back to dig (1–168 hours, default 24)', type: 4, min_value: 1, max_value: 168 },
    ],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'search',
    description: 'Search the web, then give you the good stuff',
    help: '`/search` — web search with answers',
    options: [
      { name: 'query', description: 'What are we hunting for?', type: 3, required: true },
      { name: 'private', description: 'Only you get to see the answer', type: 5 },
    ],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'image',
    description: 'Hunt down images and ship them',
    help: '`/image` — hunt down images',
    options: [
      { name: 'query', description: 'Image keywords', type: 3, required: true },
      { name: 'count', description: 'How many images (default 1, max 2)', type: 4, min_value: 1, max_value: 2 },
      { name: 'private', description: 'Only you get to see the images', type: 5 },
    ],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'sticker',
    description: 'Send a sticker from this server',
    help: '`/sticker [name]` — send a server sticker (leave empty to browse)',
    options: [
      { name: 'name', description: 'Sticker name, tag or id (leave empty to browse)', type: 3 },
    ],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'remind',
    description: 'Set, list or cancel reminders',
    help: '`/remind add|list|cancel` — reminders with Discord timestamps',
    options: [
      {
        type: 1,
        name: 'add',
        description: 'Set a reminder',
        options: [
          { name: 'when', description: 'HH:MM, HH:MM tomorrow, HH:MM dd/mm, +10m, +2h, +1d', type: 3, required: true },
          { name: 'text', description: 'What should I remind you about?', type: 3, required: true },
        ],
      },
      { type: 1, name: 'list', description: "List this channel's reminders" },
      {
        type: 1,
        name: 'cancel',
        description: 'Cancel a reminder by id',
        options: [{ name: 'id', description: 'Reminder id from the list', type: 4, required: true, min_value: 1, autocomplete: true }],
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

/** Help shown by `/help` and by the shared engine fallback. */
export const HELP_NOTE = [
  'Slash commands are my native language. **@mention** me or **reply** to one of my messages and I jump in.',
  'Want it just for you? Flip the `private` option.',
  'Right-click a message → Apps → **Explain message** / **Summarize message**.',
].join('\n');

