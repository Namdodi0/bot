import crypto from 'node:crypto';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { createChatServices } from '../../../core/services/chat.js';
import { createReminderService } from '../../../core/services/reminders.js';
import { chunkContent, errorPanel, paginationRow, photoBatches, photoPayload, textPanel, v2Answer, v2Message } from '../ui.js';

const PAGER_TTL_MS = 15 * 60_000;

/**
 * State and helpers shared by the native Discord command modules: the chat/reminder
 * services, the pagination store, ephemeral/admin plumbing and the send helpers.
 * @param {{config: any, logger: any, platform: import('../../contract.js').Platform, runtime: any}} deps
 */
export function createShared(deps) {
  const { config, logger, platform, runtime } = deps;
  const client = platform.transport.client;
  const chat = runtime.chatServices ?? createChatServices({
    config,
    store: runtime.store,
    models: runtime.models,
    compaction: runtime.compaction,
  });
  const reminderService = runtime.reminderService ?? createReminderService({ reminders: runtime.reminders });

  /** @type {Map<string, {pages: string[], title: string, icon: string, userId: string, at: number}>} */
  const pagers = new Map();

  function prunePagers() {
    const now = Date.now();
    for (const [id, value] of pagers) if (now - value.at > PAGER_TTL_MS) pagers.delete(id);
  }

  /**
   * Store page text under a short id and return it for the pagination buttons.
   * @param {string} userId
   * @param {string[]} pages
   * @param {string} title
   * @param {string} [icon]
   */
  function makePager(userId, pages, title, icon = '') {
    prunePagers();
    const id = crypto.randomUUID().slice(0, 12);
    pagers.set(id, { pages, title, icon, userId, at: Date.now() });
    return id;
  }

  /** @param {any} interaction */
  async function handlePager(interaction) {
    const [prefix, pagerId, rawPage] = String(interaction.customId ?? '').split(':');
    if (prefix !== 'page') return false;
    const pager = pagers.get(pagerId);
    if (!pager) {
      await interaction.reply({
        content: 'That list expired — run the command again. ⏳',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    if (interaction.user.id !== pager.userId) {
      await interaction.reply({
        content: "That list isn't yours. Get your own. 🔒",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    const page = Math.max(0, Math.min(pager.pages.length - 1, Number(rawPage) || 0));
    await interaction.update(
      textPanel(pager.title, pager.pages[page], {
        icon: pager.icon,
        ephemeral: true,
        rows: paginationRow(pagerId, page, pager.pages.length),
      }),
    );
    return true;
  }

  const ephemeral = { flags: MessageFlags.Ephemeral };
  const privateReply = (value) => (value ? ephemeral : {});

  /** Model text must never ping: fresh object per payload so discord.js cannot share it. */
  const noMentions = () => ({ parse: [] });

  /** @param {any} interaction */
  function isAdmin(interaction) {
    if (!interaction.guildId) return true;
    return interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild) === true;
  }

  /** @param {any} interaction */
  async function replyEphemeral(interaction, payload) {
    return interaction.reply({
      ...payload,
      flags: Number(payload?.flags ?? 0) | MessageFlags.Ephemeral,
    });
  }

  /** @param {any} interaction */
  async function reportError(interaction, error) {
    const message = String(/** @type {any} */ (error)?.message ?? error);
    logger?.error('discord command failed', { command: interaction.commandName, error: message });
    const payload = errorPanel('Something broke on my side — not your fault. Try again?', 'That broke');
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
      else await replyEphemeral(interaction, payload);
    } catch (sendError) {
      logger?.warn('discord command error reply failed', { error: String(/** @type {any} */ (sendError)?.message ?? sendError) });
    }
  }

  async function busyReply(interaction) {
    const payload = {
      content: "I'm juggling too many messages right now. Give me a few seconds and try again. 🤹",
    };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await replyEphemeral(interaction, payload);
  }

  /**
   * Run record-mutating or provider work inside the chat's shared queue. Native commands
   * must not read/write context or call providers outside the same serialization as turns.
   * @param {any} interaction
   * @param {() => Promise<any>} task
   * @returns {Promise<{ok: true, value: any}|{ok: false, busy: true}>}
   */
  async function runExclusive(interaction, task) {
    const chatId = String(interaction.channelId ?? '');
    try {
      return { ok: true, value: await runtime.agent.exclusive(chatId, task) };
    } catch (error) {
      if (/** @type {any} */ (error)?.name === 'QueueFullError') {
        await busyReply(interaction);
        return { ok: false, busy: true };
      }
      throw error;
    }
  }

  /**
   * Split an agent result into chunks and a first message, including the empty-answer text.
   * @param {{text: string, photos: any[]}} result
   */
  function splitAnswer(result) {
    const chunks = result.text ? chunkContent(result.text) : [];
    const first =
      chunks.shift() ??
      (result.photos.length ? 'Fresh pixels, as requested. 🖼️' : 'I got nothing. Ask again? 🫥');
    return { chunks, first };
  }

  /**
   * @param {any} interaction
   * @param {{text: string, photos: any[]}} result
   * @param {boolean} priv
   */
  async function sendInteractionAnswer(interaction, result, priv) {
    const { chunks, first } = splitAnswer(result);
    const photos = result.photos ?? [];
    try {
      await interaction.editReply(v2Answer(first, [], photos));
    } catch (error) {
      logger?.warn('combined photo answer failed, sending photos separately', {
        error: String(/** @type {any} */ (error)?.message ?? error),
      });
      await interaction.editReply(v2Message(first));
      await sendPhotos(interaction, photos, priv);
    }
    for (const chunk of chunks) {
      await interaction.followUp(v2Message(chunk, [], { ephemeral: priv }));
    }
  }

  /** @param {any} interaction @param {any[]} photos @param {boolean} priv */
  async function sendPhotos(interaction, photos, priv) {
    for (const group of photoBatches(photos)) {
      await interaction.followUp({ ...photoPayload(group), ...(priv ? ephemeral : {}) });
    }
  }

  /**
   * @param {any} channel
   * @param {{text: string, photos: any[]}} result
   * @param {any} [existing] a preview message to edit instead of sending the first chunk
   */
  async function sendChannelAnswer(channel, result, existing = null) {
    const { chunks, first } = splitAnswer(result);
    const photos = result.photos ?? [];
    let attached = false;
    try {
      const payload = v2Answer(first, [], photos);
      if (existing?.edit) await existing.edit(payload);
      else await channel.send(payload);
      attached = photos.length > 0;
    } catch (error) {
      logger?.warn('combined photo answer failed, sending photos separately', {
        error: String(/** @type {any} */ (error)?.message ?? error),
      });
      const payload = v2Message(first);
      if (existing?.edit) await existing.edit(payload);
      else await channel.send(payload);
    }
    for (const chunk of chunks) await channel.send(v2Message(chunk));
    if (!attached) {
      for (const group of photoBatches(photos)) {
        await channel.send({ ...photoPayload(group), allowedMentions: noMentions() });
      }
    }
  }

  /**
   * Split long text into readable pages without cutting a line when possible.
   * @param {string} text
   * @param {number} [maxChars]
   */
  function splitPages(text, maxChars = 1800) {
    const clean = String(text ?? '').trim();
    if (clean.length <= maxChars) return [clean];
    const pages = [];
    let rest = clean;
    while (rest.length > maxChars) {
      let cut = rest.lastIndexOf('\n', maxChars);
      if (cut < Math.floor(maxChars * 0.5)) cut = maxChars;
      pages.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) pages.push(rest);
    return pages;
  }

  return {
    config,
    logger,
    platform,
    runtime,
    client,
    chat,
    reminderService,
    makePager,
    runExclusive,
    busyReply,
    handlePager,
    splitPages,
    ephemeral,
    privateReply,
    isAdmin,
    replyEphemeral,
    reportError,
    sendInteractionAnswer,
    sendPhotos,
    sendChannelAnswer,
  };
}
