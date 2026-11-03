/**
 * Zalo-only model tool: send_sticker.
 * @param {{config: any}} input
 */
export function zaloToolDefinitions(input) {
  if (!input.config.sticker.enabled) return [];
  return [
    {
      type: 'function',
      function: {
        name: 'send_sticker',
        description:
          'Send a Zalo sticker that fits the mood/context (greeting, happy, sad, thanks, birthday, cat...). Use when the user wants to react with a sticker.',
        parameters: {
          type: 'object',
          properties: {
            emotion: {
              type: 'string',
              description: 'Mood or sticker pack name, e.g. "greeting", "happy", "cat", "birthday"',
            },
          },
          required: ['emotion'],
        },
      },
    },
  ];
}

/**
 * @param {{config: any, stickers: any, transport: any, logger?: any, metrics?: any}} deps
 */
export function createZaloToolRunner(deps) {
  const { config, stickers, transport, logger, metrics } = deps;

  /** @param {string} name @param {any} args @param {{chatId: string, deadline?: number}} ctx */
  return async function run(name, args, ctx) {
    if (name !== 'send_sticker') return null;
    if (!config.sticker.enabled) return { ok: false, text: 'Stickers are disabled.' };
    if (!stickers) return { ok: false, text: 'No sticker catalog yet.' };
    if (ctx.deadline && Date.now() > ctx.deadline) {
      return { ok: false, text: 'Ran out of time before the sticker could be sent.' };
    }
    const query = String(args?.emotion ?? args?.query ?? '').trim();
    const item = (query && stickers.find(query)) || stickers.random();
    if (!item) return { ok: false, text: 'Could not find a matching sticker.' };

    try {
      await transport.sendSticker(ctx.chatId, item.id);
      metrics?.inc('tool.sendSticker.ok');
      logger?.info('sticker sent', { name: item.name, id: item.id, icon: '🧩' });
      return { ok: true, text: `Sent the sticker "${item.name}".` };
    } catch (error) {
      metrics?.inc('tool.sendSticker.fail');
      logger?.warn('send_sticker failed', { error: String(/** @type {any} */ (error)?.message ?? error) });
      return { ok: false, text: `Failed to send sticker: ${String(/** @type {any} */ (error)?.message ?? error)}` };
    }
  };
}