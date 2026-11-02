/**
 * Route transport calls to the right platform.
 * Zalo chat ids stay raw; Discord chat ids are prefixed with "discord:".
 * @param {{zalo: any, discord?: any}} options
 */
export function createTransportRouter(options) {
  const zalo = options.zalo;
  const discord = options.discord ?? null;

  /** @param {unknown} chatId */
  function isDiscord(chatId) {
    return String(chatId ?? '').startsWith('discord:');
  }

  /** @param {unknown} chatId */
  function pick(chatId) {
    if (!isDiscord(chatId)) return zalo;
    if (!discord) throw new Error('Discord is disabled, cannot send to a discord: chat');
    return discord;
  }

  return {
    get displayName() {
      return zalo?.displayName || '';
    },
    /** @param {string} chatId @param {string} text @param {{replyToMessageId?: string}} [opts] */
    sendMessage: async (chatId, text, opts) => pick(chatId).sendMessage(chatId, text, opts),
    /** @param {string} chatId @param {string} url @param {string} [caption] */
    sendPhoto: async (chatId, url, caption) => pick(chatId).sendPhoto(chatId, url, caption),
    /** @param {string} chatId @param {string} stickerId */
    sendSticker: async (chatId, stickerId) => pick(chatId).sendSticker(chatId, stickerId),
    /** @param {string} chatId */
    startTyping: (chatId) => pick(chatId).startTyping(chatId),
    stopAllTyping: () => {
      zalo?.stopAllTyping?.();
      discord?.stopAllTyping?.();
    },
    /** @param {string} chatId */
    ping: async (chatId) => pick(chatId).ping(chatId),
    isDiscord,
  };
}
