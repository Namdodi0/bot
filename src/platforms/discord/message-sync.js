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
      if (!fresh) return;
      if (oldMessage?.content === fresh.content) return;
      if (!isChannelAllowed(config.discord ?? {}, fresh.channel ?? { id: fresh.channelId })) return;
      const chatId = String(fresh.channelId ?? fresh.channel?.id ?? '');
      if (!fresh.content) {
        // An edit that clears the content must not leave the old text in context.
        const result = await withChat(chatId, () =>
          runtime.chatServices.deleteTurns(chatId, [String(fresh.id ?? '')]),
        );
        if (result?.removed) metrics?.inc('discord.messages.deleted');
        return;
      }
      const text = stripBotMention(
        fresh.content,
        client?.user?.id,
        botRoleId(fresh, client?.user?.id),
      ).trim();
      if (!text || text.startsWith('/')) return;
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
      if (!message) return;
      const chatId = String(message.channelId ?? message.channel?.id ?? '');
      const messageId = String(message.id ?? '');
      if (!chatId || !messageId) return;
      const ownBot = message.author?.bot === true && message.author?.id === client?.user?.id;
      if (message.author?.bot && !ownBot) return;
      const result = await withChat(chatId, async () => {
        if (ownBot) return runtime.chatServices.deleteAnswerMessages(chatId, [messageId]);
        if (message.author) return runtime.chatServices.deleteTurns(chatId, [messageId]);
        // Uncached delete (e.g. after a restart): no author, so it may be a user turn or
        // one of the bot's own answers. Try both; each only matches its own kind.
        const user = await runtime.chatServices.deleteTurns(chatId, [messageId]);
        if (user?.removed) return user;
        return runtime.chatServices.deleteAnswerMessages(chatId, [messageId]);
      });
      if (result?.removed) {
        metrics?.inc('discord.messages.deleted');
        logger?.debug('discord message delete synced', {
          chatId,
          messageId,
          answer: ownBot,
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
      /** @type {Map<string, {user: string[], answers: string[]}>} */
      const byChat = new Map();
      for (const message of messages?.values?.() ?? []) {
        if (!message) continue;
        const chatId = String(message.channelId ?? message.channel?.id ?? '');
        const messageId = String(message.id ?? '');
        if (!chatId || !messageId) continue;
        const ownBot = message.author?.bot === true && message.author?.id === client?.user?.id;
        if (message.author?.bot && !ownBot) continue;
        const bucket = byChat.get(chatId) ?? { user: [], answers: [] };
        if (ownBot) bucket.answers.push(messageId);
        else if (message.author) bucket.user.push(messageId);
        else {
          // Author unknown on an uncached delete: it may be either kind.
          bucket.user.push(messageId);
          bucket.answers.push(messageId);
        }
        byChat.set(chatId, bucket);
      }
      for (const [chatId, ids] of byChat) {
        let removed = 0;
        if (ids.user.length) {
          const result = await withChat(chatId, () => runtime.chatServices.deleteTurns(chatId, ids.user));
          removed += Number(result?.removed) || 0;
        }
        if (ids.answers.length) {
          const result = await withChat(chatId, () => runtime.chatServices.deleteAnswerMessages(chatId, ids.answers));
          removed += Number(result?.removed) || 0;
        }
        if (removed) {
          metrics?.inc('discord.messages.deleted', removed);
          logger?.debug('discord bulk delete synced', { chatId, removed, icon: '🗑️' });
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
