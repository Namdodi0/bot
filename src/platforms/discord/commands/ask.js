import { MessageFlags } from 'discord.js';
import { eventFromInteraction, messageText } from '../events.js';
import { createProgressFeed } from '../progress.js';
import { askModal, createPreviewer, v2Message } from '../ui.js';

const MAX_VISION_BYTES = 8 * 1024 * 1024;

/**
 * `/ask` (slash + modal) and the message context menus.
 * @param {ReturnType<typeof import('./shared.js').createShared>} shared
 */
export function createAskHandlers(shared) {
  const {
    client,
    logger,
    runtime,
    chat,
    ephemeral,
    privateReply,
    reportError,
    replyEphemeral,
    sendChannelAnswer,
    sendInteractionAnswer,
  } = shared;

  /**
   * @param {any} interaction
   * @param {string} text
   * @param {Record<string, any>} [extra] `private: true` marks the turn non-durable for the core
   */
  function askEvent(interaction, text, extra = {}) {
    /** @type {any} */
    const event = eventFromInteraction(interaction, client, text, extra);
    if (extra.private === true) event.private = true;
    return event;
  }

  /**
   * Validate and download the optional `/ask` image. Discord's CDN is not SSRF-safe to trust
   * directly: the shared validator pins DNS and enforces the size cap.
   * @param {any} interaction
   * @returns {Promise<{ok: true, imageData: any}|{ok: false, reason: string}>}
   */
  async function askImage(interaction) {
    const attachment = interaction.options.getAttachment?.('image');
    if (!attachment) return { ok: true, imageData: null };
    const contentType = String(attachment.contentType ?? '').toLowerCase();
    if (!contentType.startsWith('image/')) {
      return { ok: false, reason: 'The attachment must be an image.' };
    }
    if (Number(attachment.size) > MAX_VISION_BYTES) {
      return { ok: false, reason: 'That image is too big (max 8 MB). I have limits.' };
    }
    const downloaded = await runtime.validator?.download?.(String(attachment.url ?? ''));
    if (!downloaded?.ok || !downloaded.data) {
      return {
        ok: false,
        reason: `Couldn't download that image${downloaded?.reason ? ` (${downloaded.reason})` : ''}. The link fought back.`,
      };
    }
    return { ok: true, imageData: { data: downloaded.data, contentType: downloaded.contentType ?? contentType } };
  }

  /** @param {any} interaction @param {string} prompt @param {{chatId?: string, chatType?: string, imageData?: any, private?: boolean, onDelta?: (delta: string) => void, onProgress?: (event: any) => void}} [extra] */
  function streamAsk(interaction, prompt, extra = {}) {
    const event = askEvent(interaction, prompt, {
      ...(extra.chatId ? { chatId: extra.chatId, chatType: extra.chatType ?? 'GROUP' } : {}),
      ...(extra.private === true ? { private: true } : {}),
    });
    if (extra.imageData) event.imageData = extra.imageData;
    return runtime.agent.stream(event, {
      onDelta: extra.onDelta,
      onProgress: extra.onProgress,
    });
  }

  /**
   * One throttled preview renderer for status + streamed answer.
   * @param {(text: string) => Promise<any>} edit
   */
  function createStreamPreview(edit) {
    const feed = createProgressFeed();
    let streamed = '';
    const render = () => [feed.text(), streamed].filter(Boolean).join('\n\n');
    const previewer = createPreviewer((text) => edit(text));
    return {
      onDelta(delta) {
        streamed += delta;
        previewer.push(render());
      },
      onProgress(event) {
        feed.update(event);
        previewer.push(render());
      },
      cancel() {
        return previewer.cancel();
      },
      summary() {
        return feed.summary();
      },
      async stop() {
        try {
          await edit('⏹️ Stopped. The answer hit the brakes.');
        } catch {
          // The preview may already be gone.
        }
      },
    };
  }

  /**
   * Link the sent answer messages to its assistant turn so deleting one drops the context.
   * @param {string} chatId
   * @param {string[]} ids
   * @param {string} text
   */
  async function attachAnswer(chatId, ids, text) {
    if (!ids?.length) return;
    try {
      await runtime.chatServices?.attachAnswerMessages?.(chatId, ids, { text });
    } catch (error) {
      logger?.debug('answer message attach failed', {
        chatId,
        error: String(/** @type {any} */ (error)?.message ?? error),
      });
    }
  }

  /** @param {any} interaction */
  async function thinkingEnabled(interaction) {
    try {
      const record = await chat.getRecord(
        String(interaction.channelId),
        interaction.guildId ? 'GROUP' : 'PRIVATE',
      );
      return record?.meta?.showThinking !== false;
    } catch (error) {
      logger?.debug('discord chat settings read failed', {
        chatId: String(interaction.channelId),
        error: String(/** @type {any} */ (error)?.message ?? error),
      });
      return false;
    }
  }

  /**
   * @param {any} interaction
   * @param {{prompt: string, priv: boolean, useThread: boolean, withImage: boolean, imageData?: any}} options
   */
  async function runAskFlow(interaction, options) {
    const { prompt, priv, withImage } = options;
    const wantsThread = options.useThread === true;
    // A private answer must never be posted to a public thread.
    const useThread = wantsThread && !priv;
    await interaction.deferReply(useThread ? ephemeral : privateReply(priv));
    const showThinking = await thinkingEnabled(interaction);

    let imageData = options.imageData ?? null;
    if (withImage) {
      const image = await askImage(interaction);
      if (!image.ok) {
        await interaction.editReply(
          v2Message(String(/** @type {any} */ (image).reason ?? 'That image is unusable. Try another one. 🖼️')),
        );
        return;
      }
      imageData = image.imageData;
    }

    if (useThread) {
      const channel = /** @type {any} */ (interaction.channel);
      if (!channel?.threads?.create) {
        await interaction.editReply(
          v2Message("Threads aren't available here. Discord said no. 🚫"),
        );
        return;
      }
      const name = prompt.replace(/\s+/g, ' ').slice(0, 90) || 'AI answer';
      const thread = await channel.threads.create({ name, autoArchiveDuration: 1440, reason: `AI answer for ${interaction.user.username}` });
      const placeholder = await thread.send(v2Message('…'));
      const preview = createStreamPreview((text) => placeholder.edit(v2Message(text)));
      const result = await streamAsk(interaction, prompt, {
        chatId: thread.id,
        imageData,
        onDelta: preview.onDelta,
        onProgress: preview.onProgress,
      });
      await preview.cancel();
      if (result.stopped) {
        await preview.stop();
        return;
      }
      const answerIds = await sendChannelAnswer(thread, result, placeholder, showThinking ? preview.summary() : '');
      await attachAnswer(String(thread.id), answerIds, result.text);
      await interaction.editReply({ content: `All yours in ${thread}. 🧵`, allowedMentions: { parse: [] } });
      return;
    }

    const preview = createStreamPreview((text) => interaction.editReply(v2Message(text)));
    const result = await streamAsk(interaction, prompt, {
      imageData,
      private: priv,
      onDelta: preview.onDelta,
      onProgress: preview.onProgress,
    });
    await preview.cancel();
    if (result.stopped) {
      await preview.stop();
      return;
    }
    const answerIds = await sendInteractionAnswer(interaction, result, priv, showThinking ? preview.summary() : '');
    if (!priv) await attachAnswer(String(interaction.channelId), answerIds, result.text);
    if (wantsThread) {
      await interaction.followUp({
        content: 'Private answers skip threads — your secret stays right here. 🤫',
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    }
  }

  /** @param {any} interaction @param {string} prefix */
  async function contextAsk(interaction, prefix) {
    const content = messageText(interaction.targetMessage).trim().slice(0, 3000);
    if (!content) {
      await replyEphemeral(interaction, {
        content: 'That message has no text for me to chew on. 🍽️',
      });
      return;
    }
    await interaction.deferReply(ephemeral);
    const showThinking = await thinkingEnabled(interaction);
    const prompt = `${prefix}\n\n${content}`;
    const preview = createStreamPreview((text) => interaction.editReply(v2Message(text)));
    const result = await runtime.agent.stream(askEvent(interaction, prompt, { private: true }), {
      onDelta: preview.onDelta,
      onProgress: preview.onProgress,
    });
    await preview.cancel();
    if (result.stopped) {
      await preview.stop();
      return;
    }
    await sendInteractionAnswer(interaction, result, true, showThinking ? preview.summary() : '');
  }

  /** @type {Record<string, (interaction: any) => Promise<unknown>>} */
  const handlers = {
    async ask(interaction) {
      const prompt = String(interaction.options.getString('prompt') ?? '').trim();
      const chatId = String(interaction.channelId);
      const chatType = interaction.guildId ? 'GROUP' : 'PRIVATE';
      const record = await chat.getRecord(chatId, chatType);
      const priv = interaction.options.getBoolean('private') ?? record?.meta?.privateDefault === true;
      const inThread = interaction.options.getBoolean('thread') ?? record?.meta?.autoThread === true;
      const useThread = inThread && Boolean(interaction.guild);
      const form = interaction.options.getBoolean('form') === true;
      // An image-only /ask still runs the flow (the core phrases the image turn); only a
      // truly empty invocation opens the modal, which cannot carry attachments.
      const hasImage = Boolean(interaction.options.getAttachment?.('image'));
      if (form || (!prompt && !hasImage)) {
        await interaction.showModal(askModal(priv, useThread));
        return;
      }
      await runAskFlow(interaction, { prompt, priv, useThread, withImage: true });
    },

    async 'Explain message'(interaction) {
      await contextAsk(interaction, 'Explain this Discord message clearly:');
    },

    async 'Summarize message'(interaction) {
      await contextAsk(interaction, 'Summarize this Discord message in a few bullets:');
    },
  };

  /** @param {any} interaction */
  async function handleModal(interaction) {
    if (!interaction.isModalSubmit?.()) return;
    const customId = String(interaction.customId ?? '');
    if (!customId.startsWith('ask-form:')) return;
    const [, privFlag, threadFlag] = customId.split(':');
    const prompt = String(interaction.fields.getTextInputValue('prompt') ?? '').trim();
    if (!prompt) {
      await replyEphemeral(interaction, { content: 'You called me over and said nothing? Try again. 🎤' });
      return;
    }
    try {
      await runAskFlow(interaction, {
        prompt,
        priv: privFlag === '1',
        useThread: threadFlag === '1' && Boolean(interaction.guild),
        withImage: false,
      });
    } catch (error) {
      await reportError(interaction, error);
    }
  }

  return { handlers, handleModal };
}
