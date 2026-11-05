import { botRoleId, isChannelAllowed, stripBotMention } from './events.js';

/**
 * Keep the stored chat context in sync with Discord edits and deletions. Every mutation
 * goes through agent.exclusive so it cannot race a running turn, and channels without a
 * stored record are skipped before loading one.
 * @param {{config: any, logger?: import('../../core/logger.js').Logger, metrics?: any, runtime: any, client: any}} deps
 */
export function createMessageSync(deps) {
  const { config, logger, metrics, runtime, client } = deps;

  /** @param {any} message */
  function senderName(message) {
    return String(
      message?.member?.displayName ??
        message?.author?.displayName ??
        message?.author?.username ??
        'Member',
    );
  }

  /** @param {any} channel @param {any} message */
  function chatType(channel, message) {
    if (channel?.isDMBased?.() === true) return 'PRIVATE';
    return message?.guildId ? 'GROUP' : 'PRIVATE';
  }

  /**
   * @param {string} chatId
   * @param {() => Promise<any>} task
   */
  async function withChat(chatId, task) {
    if (!chatId) return null;
    if (typeof runtime.store?.exists === 'function' && !(await runtime.store.exists(chatId))) return null;
    return runtime.agent.exclusive(chatId, task);
  }

  /** @param {any} oldMessage @param {any} newMessage */
  async function update(oldMessage, newMessage) {
    try {
      if (!newMessage || newMessage.author?.bot) return;
      const needsFetch = newMessage.partial || newMessage.author?.partial;
      const fresh = needsFetch ? await newMessage.fetch().catch(() => null) : newMessage;
      if (!fresh?.content) return;
      if (oldMessage?.content === fresh.content) return;
      if (!isChannelAllowed(config.discord ?? {}, fresh.channel ?? { id: fresh.channelId })) return;
      const text = stripBotMention(
        fresh.content,
        client?.user?.id,
        botRoleId(fresh, client?.user?.id),
      ).trim();
      if (!text || text.startsWith('/')) return;
      const chatId = String(fresh.channelId ?? fresh.channel?.id ?? '');
      const result = await withChat(chatId, () =>
        runtime.chatServices.editTurn(chatId, {
          messageId: String(fresh.id ?? ''),
          text,
          senderName: senderName(fresh),
          chatType: chatType(fresh.channel, fresh),
        }),
      );
      if (result?.ok) {
        metrics?.inc('discord.messages.edited');
        logger?.debug('discord message edit synced', {
          chatId,
          messageId: String(fresh.id ?? ''),
          icon: '✏️',
        });
      }
    } catch (error) {
      logger?.debug('discord message edit sync failed', {
        error: String(/** @type {any} */ (error)?.message ?? error),
      });
    }
  }

  /** @param {any} message */
  async function remove(message) {
    try {
      if (!message || message.author?.bot) return;
      const chatId = String(message.channelId ?? message.channel?.id ?? '');
      const result = await withChat(chatId, () =>
        runtime.chatServices.deleteTurns(chatId, [String(message.id ?? '')]),
      );
      if (result?.removed) {
        metrics?.inc('discord.messages.deleted');
        logger?.debug('discord message delete synced', {
          chatId,
          messageId: String(message.id ?? ''),
          icon: '🗑️',
        });
      }
    } catch (error) {
      logger?.debug('discord message delete sync failed', {
        error: String(/** @type {any} */ (error)?.message ?? error),
      });
    }
  }

  /** @param {any} messages */
  async function removeBulk(messages) {
    try {
      /** @type {Map<string, string[]>} */
      const byChat = new Map();
      for (const message of messages?.values?.() ?? []) {
        if (!message || message.author?.bot) continue;
        const chatId = String(message.channelId ?? message.channel?.id ?? '');
        if (!chatId) continue;
        const ids = byChat.get(chatId) ?? [];
        ids.push(String(message.id ?? ''));
        byChat.set(chatId, ids);
      }
      for (const [chatId, ids] of byChat) {
        const result = await withChat(chatId, () => runtime.chatServices.deleteTurns(chatId, ids));
        if (result?.removed) {
          metrics?.inc('discord.messages.deleted', result.removed);
          logger?.debug('discord bulk delete synced', { chatId, removed: result.removed, icon: '🗑️' });
        }
      }
    } catch (error) {
      logger?.debug('discord bulk delete sync failed', {
        error: String(/** @type {any} */ (error)?.message ?? error),
      });
    }
  }

  return { update, remove, removeBulk };
}
