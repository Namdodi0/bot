import { SECTION_ORDER } from '../../core/ai/prompt/sections.js';

export const DISCORD_TOOL_GUIDANCE = {
  send_sticker:
    'When the user asks for a sticker or reaction image, call the `send_sticker` tool with a mood, name or id. Only stickers available in this server can be sent; if none match, say so.',
};

/**
 * Discord-specific prompt sections. Slash-command UI and embeds are native, so answers
 * should read like normal Discord messages — no Zalo-style multi-message splitting advice.
 * @param {ReturnType<typeof import('../../core/ai/prompt/registry.js').createPromptRegistry>} registry
 * @param {{botName?: string, chatType?: string}} [options]
 */
export function registerDiscordPrompt(registry, options = {}) {
  const botName = options.botName || 'AI assistant';
  const inGroup = options.chatType !== 'PRIVATE';

  registry.section({
    name: 'platform:identity',
    order: SECTION_ORDER.identity,
    text: `You are "${botName}", an AI assistant living on Discord. You answer in ${
      inGroup ? 'server channels and threads' : 'direct messages'
    }.`,
  });

  registry.section({
    name: 'platform:chat-shape',
    order: SECTION_ORDER.chatShape,
    text: inGroup
      ? [
          '- People reach you by @mentioning you, replying to your message, or using `/ask`. The sender name is prefixed as "Name: message" — address that person by name when it matters.',
          '- Keep the channel clean: one answer per question, no running commentary.',
        ].join('\n')
      : '- This is a direct message: answer directly.',
  });

  registry.section({
    name: 'platform:formatting',
    order: SECTION_ORDER.formatting,
    text: [
      '- Discord markdown works: **bold**, *italic*, `inline code`, ``` code blocks ```, headings, lists, quotes, links, spoilers.',
      '- Discord caps one message at 2000 characters; anything longer is split automatically.',
      '- Never ping @everyone or @here. Mention a user only when it is genuinely useful.',
      '- Never invent sources or numbers. If you are not sure, say so plainly.',
    ].join('\n'),
  });

  registry.section({
    name: 'platform:commands',
    order: SECTION_ORDER.commands,
    text: [
      '',
      'SLASH COMMANDS: /ask, /help, /status, /ping, /model, /reset, /compact, /summary, /search, /image, /remind.',
      'Message menus: Explain message, Summarize message.',
      'Never fabricate command output. Do not tell someone to run a command unless it is genuinely useful.',
    ].join('\n'),
  });
}
