import crypto from 'node:crypto';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { createChatServices } from '../../../core/services/chat.js';
import { createReminderService } from '../../../core/services/reminders.js';
import { answerButtons, chunkContent, errorEmbed, photoAttachment } from '../ui.js';

const TOKEN_TTL_MS = 15 * 60_000;

/**
 * State and helpers shared by the native Discord command modules: the chat/reminder
 * services, the answer-button token store, ephemeral/admin plumbing and the send helpers.
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

  /** @type {Map<string, {prompt: string, chatId: string, chatType: string, userId: string, ephemeral: boolean, at: number}>} */
  const tokens = new Map();

  function pruneTokens() {
    const now = Date.now();
    for (const [id, value] of tokens) if (now - value.at > TOKEN_TTL_MS) tokens.delete(id);
  }

  /** @param {{prompt: string, chatId: string, chatType: string, userId: string, ephemeral: boolean}} payload */
  function makeToken(payload) {
    pruneTokens();
    const id = crypto.randomUUID().slice(0, 12);
    tokens.set(id, { ...payload, at: Date.now() });
    return id;
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
    return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }

  /** @param {any} interaction */
  async function reportError(interaction, error) {
    const message = String(/** @type {any} */ (error)?.message ?? error);
    logger?.error('discord command failed', { command: interaction.commandName, error: message });
    const payload = { embeds: [errorEmbed('Something went wrong while handling that command.')], components: [] };
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
      else await replyEphemeral(interaction, payload);
    } catch (sendError) {
      logger?.warn('discord command error reply failed', { error: String(/** @type {any} */ (sendError)?.message ?? sendError) });
    }
  }

  function deadline() {
    return config.responseTimeoutMs > 0 ? Date.now() + config.responseTimeoutMs : Number.POSITIVE_INFINITY;
  }

  /**
   * Split an agent result into chunks and a first message, including the empty-answer text.
   * @param {{text: string, photos: any[]}} result
   */
  function splitAnswer(result) {
    const chunks = result.text ? chunkContent(result.text) : [];
    const first = chunks.shift() ?? (result.photos.length ? 'Here are the images.' : 'I do not have an answer for that yet.');
    return { chunks, first };
  }

  /** @param {any[]} photos */
  function photoBatches(photos) {
    /** @type {any[][]} */
    const batches = [];
    for (let index = 0; index < photos.length; index += 10) batches.push(photos.slice(index, index + 10));
    return batches;
  }

  /**
   * @param {any} interaction
   * @param {{text: string, photos: any[]}} result
   * @param {string} token
   * @param {boolean} priv
   */
  async function sendInteractionAnswer(interaction, result, token, priv) {
    const { chunks, first } = splitAnswer(result);
    await interaction.editReply({ content: first, components: answerButtons(token), allowedMentions: noMentions() });
    for (const chunk of chunks) {
      await interaction.followUp({ content: chunk, allowedMentions: noMentions(), ...privateReply(priv) });
    }
    await sendPhotos(interaction, result.photos, priv);
  }

  /** @param {any} interaction @param {any[]} photos @param {boolean} priv */
  async function sendPhotos(interaction, photos, priv) {
    for (const group of photoBatches(photos)) {
      const content = group[0].caption?.slice(0, 2000) || undefined;
      await interaction.followUp({
        files: group.map(photoAttachment),
        content,
        ...(content ? { allowedMentions: noMentions() } : {}),
        ...(priv ? ephemeral : {}),
      });
    }
  }

  /**
   * @param {any} channel
   * @param {{text: string, photos: any[]}} result
   * @param {string} token
   * @param {any} [existing] a preview message to edit instead of sending the first chunk
   */
  async function sendChannelAnswer(channel, result, token, existing = null) {
    const { chunks, first } = splitAnswer(result);
    const payload = { content: first, components: answerButtons(token), allowedMentions: noMentions() };
    if (existing?.edit) await existing.edit(payload);
    else await channel.send(payload);
    for (const chunk of chunks) await channel.send({ content: chunk, allowedMentions: noMentions() });
    for (const group of photoBatches(result.photos)) {
      const content = group[0].caption?.slice(0, 2000) || undefined;
      await channel.send({
        files: group.map(photoAttachment),
        content,
        ...(content ? { allowedMentions: noMentions() } : {}),
      });
    }
  }

  return {
    config,
    logger,
    platform,
    runtime,
    client,
    chat,
    reminderService,
    tokens,
    makeToken,
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
