/**
 * @param {any} config
 * @returns {(event: any) => boolean}
 */
export function createZaloAdmission(config) {
  return function admits(event) {
    if (!config.allowedChatIds.length) return true;
    return config.allowedChatIds.includes(String(event?.chatId ?? ''));
  };
}

/**
 * Zalo-only incoming stickers: echo the sticker back (or explain that stickers are not
 * viewable). The shared agent delegates here and does nothing else for sticker events.
 * @param {{config: any, stickers: any, transport: any, logger?: any, metrics?: any}} deps
 */
export function createZaloIncomingHandler(deps) {
  const { config, stickers, transport, logger, metrics } = deps;

  /** @param {any} event @param {{stopTyping: () => Promise<void>|void}} helpers */
  return async function handleIncoming(event, helpers) {
    if (event.kind !== 'sticker') return false;
    if (!config.sticker.enabled || !stickers) {
      await helpers.stopTyping();
      await transport.sendMessage(event.chatId, 'I cannot view stickers yet — please send text instead.', {
        replyToMessageId: event.messageId,
      });
      return true;
    }
    // STICKER_ECHO=off means "do not react to incoming stickers" — not "send a random one".
    if (!config.sticker.echo) {
      await helpers.stopTyping();
      return true;
    }
    const isId = /^[a-f0-9]{20}$/i.test(event.sticker ?? '');
    const stickerId = isId ? event.sticker : stickers.random()?.id;
    await helpers.stopTyping();
    if (stickerId) {
      try {
        await transport.sendSticker(event.chatId, stickerId);
        metrics?.inc('sticker.reply');
      } catch (error) {
        logger?.warn('sticker reply failed', { error: String(/** @type {any} */ (error)?.message ?? error) });
      }
    }
    return true;
  };
}