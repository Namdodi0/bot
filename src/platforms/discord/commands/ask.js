import crypto from 'node:crypto';
import { MessageFlags } from 'discord.js';
import { eventFromInteraction, messageText } from '../events.js';
import { createProgressFeed } from '../progress.js';
import { answerButtons, askModal, chunkContent, createPreviewer, photoBatches, photoPayload, v2Answer, v2Message } from '../ui.js';

const MAX_VISION_BYTES = 8 * 1024 * 1024;

/**
 * `/ask` (slash + modal), the message context menus, and the Regenerate/Continue/Delete
 * buttons that replay a stored prompt.
 * @param {ReturnType<typeof import('./shared.js').createShared>} shared
 */
export function createAskHandlers(shared) {
  const {
    client,
    logger,
    runtime,
    chat,
    tokens,
    makeToken,
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
      skipCommands: true,
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
      flush() {
        return previewer.flush();
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
   * @param {any} interaction
   * @param {{prompt: string, priv: boolean, useThread: boolean, withImage: boolean, imageData?: any}} options
   */
  async function runAskFlow(interaction, options) {
    const { prompt, priv, withImage } = options;
    const wantsThread = options.useThread === true;
    // A private answer must never be posted to a public thread.
    const useThread = wantsThread && !priv;
    await interaction.deferReply(useThread ? ephemeral : privateReply(priv));

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
      await preview.flush();
      if (result.stopped) {
        await preview.stop();
        return;
      }
      const token = makeToken({
        prompt,
        answer: result.text,
        chatId: thread.id,
        chatType: 'GROUP',
        userId: interaction.user.id,
        ephemeral: false,
        origin: 'channel',
      });
      await sendChannelAnswer(thread, result, token, placeholder);
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
    await preview.flush();
    if (result.stopped) {
      await preview.stop();
      return;
    }
    const token = makeToken({
      prompt,
      answer: result.text,
      chatId: String(interaction.channelId),
      chatType: interaction.guildId ? 'GROUP' : 'PRIVATE',
      userId: interaction.user.id,
      ephemeral: priv,
      origin: 'interaction',
    });
    await sendInteractionAnswer(interaction, result, token, priv);
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
    const prompt = `${prefix}\n\n${content}`;
    const preview = createStreamPreview((text) => interaction.editReply(v2Message(text)));
    const result = await runtime.agent.stream(askEvent(interaction, prompt, { private: true }), {
      skipCommands: true,
      onDelta: preview.onDelta,
      onProgress: preview.onProgress,
    });
    await preview.flush();
    if (result.stopped) {
      await preview.stop();
      return;
    }
    const token = makeToken({
      prompt,
      answer: result.text,
      chatId: String(interaction.channelId),
      chatType: interaction.guildId ? 'GROUP' : 'PRIVATE',
      userId: interaction.user.id,
      ephemeral: true,
      origin: 'interaction',
    });
    await sendInteractionAnswer(interaction, result, token, true);
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
      if (form || !prompt) {
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
  async function handleButton(interaction) {
    const [prefix, action, tokenId] = String(interaction.customId ?? '').split(':');
    if (prefix !== 'ask') return;
    const payload = tokens.get(tokenId);
    if (!payload) {
      await interaction.reply({
        content: 'That answer is ancient — run `/ask` again. 👴',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.user.id !== payload.userId) {
      await interaction.reply({
        content: "Hands off — this conversation isn't yours. 🔒",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (action === 'good' || action === 'bad') {
      runtime.metrics?.inc(`feedback.${action}`);
      logger?.info('discord answer feedback', {
        chatId: payload.chatId,
        userId: interaction.user.id,
        rating: action,
      });
      await interaction.reply({
        content:
          action === 'good'
            ? "Appreciated. I'll keep cooking. 👍"
            : "Ouch. Noted — I'll do better. 👎",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Thread answers are channel messages; every other answer is an interaction response.
    const viaChannel = payload.origin === 'channel';
    if (action === 'delete') {
      await interaction.deferUpdate();
      const removed = viaChannel ? interaction.message.delete() : interaction.deleteReply();
      await removed.catch((error) => {
        logger?.debug('discord answer delete failed', {
          error: String(/** @type {any} */ (error)?.message ?? error),
        });
      });
      return;
    }
    // The shared record has public answers already; a private answer was removed after its turn.
    const priorAnswer = payload.ephemeral ? String(payload.answer ?? '').slice(-4000) : '';
    const prompt =
      action === 'continue'
        ? priorAnswer
          ? `Continue from where you left off. Previous answer:\n\n${priorAnswer}`
          : 'Continue from where you left off.'
        : payload.prompt;
    const regenerating = action === 'regen';
    if (regenerating) await interaction.deferUpdate();
    else await interaction.deferReply(privateReply(payload.ephemeral));

    const edit = regenerating
      ? viaChannel
        ? (text) => interaction.message.edit(v2Message(text))
        : (text) => interaction.editReply(v2Message(text))
      : (text) => interaction.editReply(v2Message(text));
    const preview = createStreamPreview(edit);
    const event = askEvent(interaction, prompt, {
      chatId: payload.chatId,
      chatType: payload.chatType,
      messageId: `interaction:${crypto.randomUUID()}`,
      ...(payload.ephemeral ? { private: true } : {}),
    });
    const result = await runtime.agent.stream(event, {
      skipCommands: true,
      onDelta: preview.onDelta,
      onProgress: preview.onProgress,
    });
    await preview.flush();
    if (result.stopped) {
      await preview.stop();
      return;
    }
    const newToken = makeToken({ ...payload });
    const chunks = chunkContent(result.text || 'I got nothing. Ask again, maybe with fewer riddles. 🫥');
    const photos = result.photos ?? [];
    const followFlags = privateReply(payload.ephemeral);
    const editFinal = regenerating
      ? viaChannel
        ? (value) => interaction.message.edit(value)
        : (value) => interaction.editReply(value)
      : (value) => interaction.editReply(value);
    try {
      await editFinal(v2Answer(chunks[0], answerButtons(newToken), photos));
    } catch (error) {
      logger?.warn('combined photo answer failed, sending photos separately', {
        error: String(/** @type {any} */ (error)?.message ?? error),
      });
      await editFinal(v2Message(chunks[0], answerButtons(newToken)));
      for (const group of photoBatches(photos)) {
        await interaction.followUp({ ...photoPayload(group), ...followFlags });
      }
    }
    for (const chunk of chunks.slice(1)) {
      await interaction.followUp(v2Message(chunk, [], { ephemeral: payload.ephemeral }));
    }
  }

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

  return { handlers, handleButton, handleModal };
}
