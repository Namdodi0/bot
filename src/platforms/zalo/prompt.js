import { SECTION_ORDER } from '../../core/ai/prompt/sections.js';

export const ZALO_TOOL_GUIDANCE = {
  send_sticker:
    'When the user wants a sticker reaction ("send a sticker", "hello sticker", "cat sticker"...), call the `send_sticker` tool with an emotion keyword or pack name.',
  send_image:
    'When the user asks for pictures ("send me a cat photo", "show me 5 pictures of ..."), call the `send_image` tool with `query` and `count` set to the number of images requested (default 1). It sends one Zalo message per image; never cap the number yourself — if the user asks for 10, pass 10. Report how many were actually sent.',
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
      ? '- In groups people only reach you by @mentioning you or replying to your message. The sender name is prefixed to the text as "Name: message" — address that person by name when it matters.'
      : '- This is a private chat: answer directly and warmly.',
  });

  registry.section({
    name: 'platform:formatting',
    order: SECTION_ORDER.formatting,
    text: [
      '- Allowed formatting: **bold**, *italic*, "- " bullets, "1. " lists, "> " quotes, `code`. Zalo does not render markdown headings, so never use "#" or "##" — use a bold line instead. No markdown tables and no [text](url) links — paste bare URLs.',
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