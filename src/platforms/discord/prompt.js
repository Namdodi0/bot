import { SECTION_ORDER } from '../../core/ai/prompt/sections.js';

export const DISCORD_TOOL_GUIDANCE = {
  send_sticker:
    'When the user asks for a sticker or reaction image, call the `send_sticker` tool with a mood, name or id. Only stickers available in this server can be sent; if none match, say so.',
};

/**
 * Platform-specific prompt sections. Slash commands, panels and buttons are native, so
 * answers should read like normal chat messages.
 * @param {ReturnType<typeof import('../../core/ai/prompt/registry.js').createPromptRegistry>} registry
 * @param {{botName?: string, chatType?: string}} [options]
 */
export function registerDiscordPrompt(registry, options = {}) {
  const botName = options.botName || 'AI assistant';
  const inGroup = options.chatType !== 'PRIVATE';

  registry.section({
    name: 'platform:identity',
    order: SECTION_ORDER.identity,
    text: `You are "${botName}", an AI assistant living in this chat. You answer in ${
      inGroup ? 'server channels and threads' : 'direct messages'
    }.`,
  });

  registry.section({
    name: 'platform:chat-shape',
    order: SECTION_ORDER.chatShape,
    text: inGroup
      ? [
          '- People reach you by @mentioning you, replying to your message, or using `/ask`. The sender name is prefixed to the text — address that person by name when it matters.',
          '- Keep the channel clean: one answer per question, no running commentary.',
        ].join('\n')
      : '- This is a direct message: answer directly.',
  });

  registry.section({
    name: 'platform:formatting',
    order: SECTION_ORDER.formatting,
    text: [
      '- Markdown works: bold, italic, inline code, code blocks, headings, lists, quotes, links and spoilers.',
      '- Prose stays plain Markdown: Discord already renders headings, bold, italic, lists and quotes, so never wrap a story, explanation, paragraph or the whole answer in a fenced block or inline code. Fenced blocks are for runnable code; fenced text blocks are for multi-line math derivations.',
      '- LaTeX is not rendered in normal messages. Never use LaTeX delimiters or commands in a normal answer. Write math in plain text with Unicode operators and symbols; use slash or parenthesised fractions, numbered steps for long solutions, and put multi-line derivations in a fenced text code block with short lines. Use bold for the final result.',
      '- If the user explicitly asks for LaTeX, keep it inside a fenced code block instead of inline text.',
      '- One message is capped at 4000 characters; anything longer is split automatically.',
      '- Never ping @everyone or @here. Mention a user only when it is genuinely useful.',
    ].join('\n'),
  });

  registry.section({
    name: 'platform:commands',
    order: SECTION_ORDER.commands,
    text: [
      '',
      'SLASH COMMANDS: /ask, /help, /status, /reasoning, /ping, /stop, /restart, /model, /settings, /reset, /compact, /summary, /catchup, /search, /image, /sticker, /remind.',
      'Message menus: Explain message, Summarize message.',
      'Never fabricate command output. Do not tell someone to run a command unless it is genuinely useful.',
    ].join('\n'),
  });
}
