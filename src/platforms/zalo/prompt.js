import { SECTION_ORDER } from '../../core/ai/prompt/sections.js';

export const ZALO_TOOL_GUIDANCE = {
  send_sticker:
    'When the user wants a sticker reaction, call the `send_sticker` tool with an emotion keyword or pack name.',
  send_image:
    'When the user asks for pictures, call the `send_image` tool with `query` and `count` (default 1). One reply may contain at most 5 images in total: never call the tool again after 5 images were sent in this reply, and if the user asks for more, say the limit is 5 per reply. It sends one Zalo message per image. Report how many were actually sent.',
};

/**
 * Zalo-specific prompt sections: identity, chat shape, formatting and command list.
 * @param {ReturnType<typeof import('../../core/ai/prompt/registry.js').createPromptRegistry>} registry
 * @param {{botName?: string, chatType?: string}} [options]
 */
export function registerZaloPrompt(registry, options = {}) {
  const botName = options.botName || 'AI assistant';
  // Unknown chat types are treated as groups: this bot is built for group chats.
  const inGroup = options.chatType !== 'PRIVATE';

  registry.section({
    name: 'platform:identity',
    order: SECTION_ORDER.identity,
    text: `You are "${botName}", an AI assistant chatting on Zalo (a Vietnamese messaging app) in ${
      inGroup ? 'a group chat' : 'a private chat'
    }.`,
  });

  registry.section({
    name: 'platform:chat-shape',
    order: SECTION_ORDER.chatShape,
    text: inGroup
      ? '- In groups people only reach you by @mentioning you or replying to your message. The sender name is prefixed to the text — address that person by name when it matters.'
      : '- This is a private chat: answer directly and warmly.',
  });

  registry.section({
    name: 'platform:formatting',
    order: SECTION_ORDER.formatting,
    text: [
      '- Use the markdown Zalo renders: bold, italic, bullet and numbered lists, quotes and inline code. Zalo does not render headings, so use a bold line instead. No markdown tables and no markdown links — paste bare URLs.',
      '- Never invent sources or numbers. If you are not sure, say so plainly.',
    ].join('\n'),
  });

  registry.section({
    name: 'platform:commands',
    order: SECTION_ORDER.commands,
    text: [
      '',
      'COMMANDS THE USER MAY SEND: /help, /reset, /status, /id, /summary [N], /search <query>, /image <keyword>, /sticker [mood], /remind <time> <text>, /model [alias], /tone [roast|hard|friendly|default], /think on|off|low|medium|high|auto, /split on|off|auto, /compact, /ping.',
      'Never fabricate command output. Do not tell the user to run a command unless it is genuinely useful.',
    ].join('\n'),
  });
}