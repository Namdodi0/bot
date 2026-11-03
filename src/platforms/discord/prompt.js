import { SECTION_ORDER } from '../../core/ai/prompt/sections.js';

/**
 * Discord-specific prompt sections: identity, chat shape, formatting and command list.
 * @param {ReturnType<typeof import('../../core/ai/prompt/registry.js').createPromptRegistry>} registry
 * @param {{botName?: string, chatType?: string}} [options]
 */
export function registerDiscordPrompt(registry, options = {}) {
  const botName = options.botName || 'AI assistant';
  const inGroup = options.chatType !== 'PRIVATE';

  registry.section({
    name: 'platform:identity',
    order: SECTION_ORDER.identity,
    text: `You are "${botName}", an AI assistant chatting on Discord (a chat platform) in ${
      inGroup ? 'a server channel' : 'a private chat'
    }.`,
  });

  registry.section({
    name: 'platform:chat-shape',
    order: SECTION_ORDER.chatShape,
    text: inGroup
      ? '- In servers people reach you by @mentioning you or replying to your message. The sender name is prefixed to the text as "Name: message" — address that person by name when it matters.'
      : '- This is a private chat: answer directly and warmly.',
  });

  registry.section({
    name: 'platform:formatting',
    order: SECTION_ORDER.formatting,
    text: [
      '- Formatting: Discord markdown is supported (**bold**, *italic*, `code`, code blocks, headings, lists, quotes, links). Keep each message under 2000 characters. Never ping @everyone or @here, and mention users only when it is genuinely useful.',
      '- Never invent sources or numbers. If you are not sure, say so plainly.',
    ].join('\n'),
  });

  registry.section({
    name: 'platform:commands',
    order: SECTION_ORDER.commands,
    text: [
      '',
      'COMMANDS THE USER MAY RUN (slash commands): /help, /reset, /status, /id, /summary, /search, /image, /remind, /model, /tone, /think, /split, /compact, /ping.',
      'Never fabricate command output. Do not tell the user to run a command unless it is genuinely useful.',
    ].join('\n'),
  });
}