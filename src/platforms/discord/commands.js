import crypto from 'node:crypto';
import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { REMINDER_LIMITS } from '../../core/ai/reminders.js';
import { createChatServices } from '../../core/services/chat.js';
import { createReminderService } from '../../core/services/reminders.js';
import { eventFromInteraction } from './events.js';
import { COMMANDS, HELP_NOTE } from './specs.js';
import {
  answerButtons,
  catchupEmbed,
  chunkContent,
  COLORS,
  createPreviewer,
  errorEmbed,
  helpEmbed,
  modelSelect,
  photoAttachment,
  reminderEmbed,
  settingsEmbed,
  settingsRows,
  statusEmbed,
  textEmbed,
  TONES,
} from './ui.js';

const TOKEN_TTL_MS = 15 * 60_000;
const MAX_VISION_BYTES = 8 * 1024 * 1024;
const CATCHUP_MAX_MESSAGES = 500;
const CATCHUP_PAGE_SIZE = 100;
const CATCHUP_MAX_TRANSCRIPT = 12_000;

/**
 * Native Discord command handlers. Slash commands do not go through the shared text-command
 * router: they use Discord options, ephemeral replies, embeds, buttons and a select menu.
 * @param {{config: any, logger: import('../../core/logger.js').Logger, metrics: any, platform: import('../contract.js').Platform, runtime: any}} deps
 */
export function createCommandRuntime(deps) {
  const { config, logger, metrics, platform, runtime } = deps;
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

  /** @param {any} interaction @param {string} text */
  function askEvent(interaction, text, extra = {}) {
    return eventFromInteraction(interaction, client, text, extra);
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
      return { ok: false, reason: 'That image is too large (max 8 MB).' };
    }
    const downloaded = await runtime.validator?.download?.(String(attachment.url ?? ''));
    if (!downloaded?.ok || !downloaded.data) {
      return { ok: false, reason: `Could not download that image${downloaded?.reason ? ` (${downloaded.reason})` : ''}.` };
    }
    return { ok: true, imageData: { data: downloaded.data, contentType: downloaded.contentType ?? contentType } };
  }

  /** @param {any} record */
  function settingsPayload(record) {
    const current = chat.currentModel(record);
    return {
      embeds: [settingsEmbed(record, config, current)],
      components: settingsRows(chat.listModels(), record, current),
    };
  }

  /** @param {any} interaction @param {string} prompt @param {{chatId?: string, chatType?: string, imageData?: any, onDelta?: (delta: string) => void}} [extra] */
  function streamAsk(interaction, prompt, extra = {}) {
    const event = askEvent(
      interaction,
      prompt,
      extra.chatId ? { chatId: extra.chatId, chatType: extra.chatType ?? 'GROUP' } : undefined,
    );
    if (extra.imageData) event.imageData = extra.imageData;
    return runtime.agent.stream(event, { skipCommands: true, onDelta: extra.onDelta });
  }

  /**
   * @param {any} interaction
   * @param {{text: string, photos: any[]}} result
   * @param {string} token
   * @param {boolean} priv
   */
  async function sendInteractionAnswer(interaction, result, token, priv) {
    const chunks = result.text ? chunkContent(result.text) : [];
    const first = chunks.shift() ?? (result.photos.length ? 'Here are the images.' : 'I do not have an answer for that yet.');
    await interaction.editReply({ content: first, components: answerButtons(token) });
    for (const chunk of chunks) {
      await interaction.followUp({ content: chunk, ...privateReply(priv) });
    }
    await sendPhotos(interaction, result.photos, priv);
  }

  /** @param {any} interaction @param {any[]} photos @param {boolean} priv */
  async function sendPhotos(interaction, photos, priv) {
    for (let index = 0; index < photos.length; index += 10) {
      const group = photos.slice(index, index + 10);
      await interaction.followUp({
        files: group.map(photoAttachment),
        content: group[0].caption?.slice(0, 2000) || undefined,
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
    const chunks = result.text ? chunkContent(result.text) : [];
    const first = chunks.shift() ?? (result.photos.length ? 'Here are the images.' : 'I do not have an answer for that yet.');
    const payload = { content: first, components: answerButtons(token) };
    if (existing?.edit) await existing.edit(payload);
    else await channel.send(payload);
    for (const chunk of chunks) await channel.send({ content: chunk });
    for (let index = 0; index < result.photos.length; index += 10) {
      const group = result.photos.slice(index, index + 10);
      await channel.send({
        files: group.map(photoAttachment),
        content: group[0].caption?.slice(0, 2000) || undefined,
      });
    }
  }

  /**
   * Run the image tool with a capture sink so the command can render the attachments itself.
   * @param {any} args
   * @param {{chatId: string, senderId?: string, platform?: string, deadline?: number}} ctx
   */
  async function runImage(args, ctx) {
    /** @type {Array<{url: string, caption: string, data?: Buffer, contentType?: string}>} */
    const photos = [];
    const result = await runtime.tools.run('send_image', args, {
      ...ctx,
      sendPhoto: async (url, caption, asset) => {
        photos.push({
          url: String(url ?? ''),
          caption: String(caption ?? ''),
          data: asset?.data ? Buffer.from(asset.data) : undefined,
          contentType: asset?.contentType,
        });
        return { ok: true };
      },
    });
    return { result, photos };
  }

  /** @type {Record<string, (interaction: any) => Promise<unknown>>} */
  const handlers = {
    async ask(interaction) {
      const prompt = String(interaction.options.getString('prompt', true)).trim();
      if (!prompt) {
        await replyEphemeral(interaction, { content: 'Ask me something first.' });
        return;
      }
      const chatId = String(interaction.channelId);
      const chatType = interaction.guildId ? 'GROUP' : 'PRIVATE';
      const record = await chat.getRecord(chatId, chatType);
      const privOption = interaction.options.getBoolean('private');
      const threadOption = interaction.options.getBoolean('thread');
      const priv = privOption ?? record?.meta?.privateDefault === true;
      const inThread = threadOption ?? record?.meta?.autoThread === true;
      // Acknowledge BEFORE the image download: downloading up to 8 MB can exceed the
      // 3-second interaction window.
      const useThread = inThread && Boolean(interaction.guild);
      await interaction.deferReply(useThread ? ephemeral : privateReply(priv));

      const image = await askImage(interaction);
      if (!image.ok) {
        await interaction.editReply({ content: String(/** @type {any} */ (image).reason ?? 'That image is not usable.') });
        return;
      }

      let streamed = '';
      const accumulate = (delta) => {
        streamed += delta;
      };

      if (useThread) {
        const channel = /** @type {any} */ (interaction.channel);
        if (!channel?.threads?.create) {
          await interaction.editReply({ content: 'Threads are not available in this channel.' });
          return;
        }
        const name = prompt.replace(/\s+/g, ' ').slice(0, 90) || 'AI answer';
        const thread = await channel.threads.create({ name, autoArchiveDuration: 1440, reason: `AI answer for ${interaction.user.username}` });
        const placeholder = await thread.send({ content: '…' });
        const previewer = createPreviewer((text) => placeholder.edit({ content: text }));
        const result = await streamAsk(interaction, prompt, {
          chatId: thread.id,
          imageData: image.imageData,
          onDelta: (delta) => {
            accumulate(delta);
            previewer.push(streamed);
          },
        });
        await previewer.flush();
        const token = makeToken({ prompt, chatId: thread.id, chatType: 'GROUP', userId: interaction.user.id, ephemeral: false });
        await sendChannelAnswer(thread, result, token, placeholder);
        await interaction.editReply({ content: `Answered in ${thread}.` });
        return;
      }

      const previewer = createPreviewer((text) => interaction.editReply({ content: text }));
      const result = await streamAsk(interaction, prompt, {
        imageData: image.imageData,
        onDelta: (delta) => {
          accumulate(delta);
          previewer.push(streamed);
        },
      });
      await previewer.flush();
      const token = makeToken({
        prompt,
        chatId,
        chatType,
        userId: interaction.user.id,
        ephemeral: priv,
      });
      await sendInteractionAnswer(interaction, result, token, priv);
    },

    async settings(interaction) {
      if (!isAdmin(interaction)) {
        await replyEphemeral(interaction, { embeds: [errorEmbed('Only server admins can change channel settings.')] });
        return;
      }
      const record = await chat.getRecord(String(interaction.channelId), interaction.guildId ? 'GROUP' : 'PRIVATE');
      await replyEphemeral(interaction, settingsPayload(record));
    },

    async catchup(interaction) {
      await interaction.deferReply(ephemeral);
      const hours = interaction.options.getInteger('hours') ?? 24;
      const chatId = String(interaction.channelId);
      const channel = /** @type {any} */ (interaction.channel);
      if (!channel?.messages?.fetch) {
        await interaction.editReply({ content: 'I cannot read messages in this channel.' });
        return;
      }

      const cutoff = Date.now() - hours * 3_600_000;
      /** @type {Array<{name: string, text: string}>} */
      const collected = [];
      /** @type {string|undefined} */
      let before;
      let scanned = 0;
      try {
        while (scanned < CATCHUP_MAX_MESSAGES) {
          const batch = await channel.messages.fetch({ limit: CATCHUP_PAGE_SIZE, ...(before ? { before } : {}) });
          const messages = [...(batch?.values?.() ?? [])];
          if (!messages.length) break;
          let reachedCutoff = false;
          for (const message of messages) {
            if (scanned >= CATCHUP_MAX_MESSAGES) break;
            scanned += 1;
            if (Number(message.createdTimestamp) < cutoff) {
              reachedCutoff = true;
              continue;
            }
            if (message.author?.bot) continue;
            const content = String(message.content ?? '').trim();
            if (content.startsWith('/')) continue;
            const attachmentCount = Number(message.attachments?.size ?? message.attachments?.length ?? 0);
            const text = content ? (attachmentCount > 0 ? `${content} [attachment]` : content) : attachmentCount > 0 ? '[attachment]' : '';
            if (!text) continue;
            collected.push({
              name: String(message.member?.displayName ?? message.author?.username ?? 'Member'),
              text,
            });
          }
          if (reachedCutoff || scanned >= CATCHUP_MAX_MESSAGES) break;
          before = messages[messages.length - 1]?.id;
          if (!before) break;
        }
      } catch (error) {
        logger?.warn('discord catchup fetch failed', { error: String(/** @type {any} */ (error)?.message ?? error) });
        await interaction.editReply({
          content: 'I could not read this channel. I need the Read Message History permission here.',
        });
        return;
      }

      if (!collected.length) {
        await interaction.editReply({
          content: `No messages in the last ${hours} hour${hours === 1 ? '' : 's'} to catch up on.`,
        });
        return;
      }

      const transcript = collected
        .slice()
        .reverse()
        .map((item) => `${item.name}: ${item.text}`)
        .join('\n')
        .slice(0, CATCHUP_MAX_TRANSCRIPT);
      let streamed = '';
      const previewer = createPreviewer((text) => interaction.editReply({ content: text }));
      const summary = await chat.summarizeText(transcript, {
        record: await chat.getRecord(chatId, interaction.guildId ? 'GROUP' : 'PRIVATE'),
        onDelta: (delta) => {
          streamed += delta;
          previewer.push(streamed);
        },
      });
      await previewer.flush();
      if (!summary.ok) {
        await interaction.editReply({ content: 'I could not summarize those messages right now.' });
        return;
      }
      await interaction.editReply({ embeds: [catchupEmbed(hours, collected.length, summary.text)] });
    },

    async help(interaction) {
      await replyEphemeral(interaction, { embeds: [helpEmbed(COMMANDS, HELP_NOTE)] });
    },

    async status(interaction) {
      await interaction.deferReply(ephemeral);
      const chatId = String(interaction.channelId);
      const record = await chat.getRecord(chatId, interaction.guildId ? 'GROUP' : 'PRIVATE');
      await interaction.editReply({
        embeds: [
          statusEmbed({
            model: chat.currentModel(record),
            mode: platform.transportMode,
            uptimeSec: runtime.metrics.snapshot().uptimeSec ?? 0,
            messages: record.messages?.length ?? 0,
            turns: record.turns ?? 0,
            contextFiles: await runtime.store.count(),
            ttlHours: config.context.ttlHours,
            ping: (await platform.transport.ping(chatId)) || 0,
            search: config.search.enabled ? `${config.search.depth}/${config.search.maxResults}` : 'off',
            metrics: runtime.metrics,
          }),
        ],
      });
    },

    async ping(interaction) {
      const gateway = (await platform.transport.ping()) || 0;
      const roundtrip = Date.now() - Number(interaction.createdTimestamp);
      await replyEphemeral(interaction, { content: `Pong — gateway ${gateway}ms, roundtrip ${roundtrip}ms.` });
    },

    async model(interaction) {
      if (!isAdmin(interaction)) {
        await replyEphemeral(interaction, { embeds: [errorEmbed('Only server admins can change the model.')] });
        return;
      }
      const chatId = String(interaction.channelId);
      const record = await chat.getRecord(chatId, interaction.guildId ? 'GROUP' : 'PRIVATE');
      const current = chat.currentModel(record);
      const name = interaction.options.getString('name');
      if (!name) {
        await replyEphemeral(interaction, {
          embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('Model').setDescription(`Current: **${current.label}** (\`${current.alias}\`)`)],
          components: modelSelect(chat.listModels(), current.alias),
        });
        return;
      }
      const picked = chat.findModel(name);
      if (!picked) {
        await replyEphemeral(interaction, { embeds: [errorEmbed(`No model named "${name}".`)] });
        return;
      }
      const saved = await chat.setModel(chatId, name, interaction.guildId ? 'GROUP' : 'PRIVATE');
      if (!saved.ok) {
        await replyEphemeral(interaction, { embeds: [errorEmbed(`No model named "${name}".`)] });
        return;
      }
      await replyEphemeral(interaction, { content: `Model is now **${saved.model.label}** (\`${saved.model.alias}\`).` });
    },

    async reset(interaction) {
      if (!isAdmin(interaction)) {
        await replyEphemeral(interaction, { embeds: [errorEmbed('Only server admins can reset the context.')] });
        return;
      }
      const chatId = String(interaction.channelId);
      const full = interaction.options.getBoolean('all') === true;
      await chat.reset(chatId, { all: full });
      await replyEphemeral(interaction, {
        content: full ? 'Cleared the context and settings for this channel.' : 'Cleared this channel context (settings kept).',
      });
    },

    async compact(interaction) {
      if (!isAdmin(interaction)) {
        await replyEphemeral(interaction, { embeds: [errorEmbed('Only server admins can compact the context.')] });
        return;
      }
      await interaction.deferReply(ephemeral);
      const chatId = String(interaction.channelId);
      const result = await chat.compact(chatId, 'GROUP');
      if (!result?.changed) {
        await interaction.editReply({ content: 'The context does not need compaction yet.' });
        return;
      }
      await interaction.editReply({ content: `Compacted the context${result.summarized ? ' with a summary' : ''}.` });
    },

    async summary(interaction) {
      await interaction.deferReply(ephemeral);
      const count = interaction.options.getInteger('count') ?? 30;
      const chatId = String(interaction.channelId);
      let streamed = '';
      const previewer = createPreviewer((text) => interaction.editReply({ content: text }));
      const result = await chat.summarize(
        chatId,
        interaction.guildId ? 'GROUP' : 'PRIVATE',
        count,
        null,
        {
          onDelta: (delta) => {
            streamed += delta;
            previewer.push(streamed);
          },
        },
      );
      await previewer.flush();
      if (!result.ok) {
        await interaction.editReply({
          content:
            result.reason === 'empty'
              ? 'No summary returned.'
              : 'There are not enough messages to summarize yet.',
        });
        return;
      }
      await interaction.editReply({
        embeds: [textEmbed(`Summary of the last ${result.count} messages`, result.text)],
      });
    },

    async search(interaction) {
      const query = String(interaction.options.getString('query', true)).trim();
      const priv = interaction.options.getBoolean('private') === true;
      await interaction.deferReply(privateReply(priv));
      const result = await runtime.tools.run(
        'web_search',
        { query },
        { chatId: String(interaction.channelId), senderId: interaction.user.id, platform: 'discord', deadline: deadline() },
      );
      if (!result.ok) {
        await interaction.editReply({ embeds: [errorEmbed(result.text)] });
        return;
      }
      await interaction.editReply({ embeds: [textEmbed(`Search: ${query}`, result.text)] });
    },

    async image(interaction) {
      const query = String(interaction.options.getString('query', true)).trim();
      const count = interaction.options.getInteger('count') ?? 1;
      const priv = interaction.options.getBoolean('private') === true;
      await interaction.deferReply(privateReply(priv));
      const { result, photos } = await runImage(
        { query, count, caption: query },
        { chatId: String(interaction.channelId), platform: 'discord', deadline: deadline() },
      );
      if (!photos.length) {
        await interaction.editReply({ embeds: [errorEmbed(result.text || 'No images found.')] });
        return;
      }
      await interaction.editReply({
        content: result.text || `Here ${photos.length === 1 ? 'is' : 'are'} ${photos.length} image${photos.length === 1 ? '' : 's'}.`,
        components: [],
      });
      await sendPhotos(interaction, photos, priv);
    },

    async remind(interaction) {
      if (!reminderService.available()) {
        await replyEphemeral(interaction, { content: 'Reminders are not configured.' });
        return;
      }
      const chatId = String(interaction.channelId);
      const sub = interaction.options.getSubcommand();
      if (sub === 'list') {
        await replyEphemeral(interaction, { embeds: [reminderEmbed(reminderService.list(chatId))] });
        return;
      }
      if (sub === 'cancel') {
        const id = interaction.options.getInteger('id', true);
        const removed = await reminderService.cancel(chatId, id);
        await replyEphemeral(interaction, {
          content: removed ? `Cancelled reminder #${removed.id}.` : `No reminder #${id} in this channel.`,
        });
        return;
      }
      const when = String(interaction.options.getString('when', true)).trim();
      const text = String(interaction.options.getString('text', true)).trim();
      const created = await reminderService.add(chatId, when, text, interaction.user.id);
      if (!created.ok) {
        const messages = {
          'invalid-time': 'Invalid reminder time.',
          'too-long': `The reminder text is too long (max ${REMINDER_LIMITS.MAX_REMINDER_CHARS}).`,
          'chat-limit': `This channel already has ${REMINDER_LIMITS.MAX_PER_CHAT} reminders; cancel one first.`,
          'total-limit': 'The reminder limit has been reached.',
          invalid: 'Invalid reminder.',
          'not-configured': 'Reminders are not configured.',
        };
        await replyEphemeral(interaction, {
          content: messages[/** @type {keyof typeof messages} */ (created.reason)] ?? 'Could not create the reminder.',
        });
        return;
      }
      const seconds = Math.floor(created.item.at / 1000);
      await replyEphemeral(interaction, {
        content: `Reminder #${created.item.id} set for <t:${seconds}:f> (<t:${seconds}:R>): ${text}`,
      });
    },

    async 'Explain message'(interaction) {
      await contextAsk(interaction, 'Explain this Discord message clearly and concisely:');
    },

    async 'Summarize message'(interaction) {
      await contextAsk(interaction, 'Summarize this Discord message in a few bullets:');
    },
  };

  /** @param {any} interaction @param {string} prefix */
  async function contextAsk(interaction, prefix) {
    const content = String(interaction.targetMessage?.content ?? '').trim().slice(0, 3000);
    if (!content) {
      await replyEphemeral(interaction, { content: 'That message has no text to work with.' });
      return;
    }
    await interaction.deferReply(ephemeral);
    const prompt = `${prefix}\n\n${content}`;
    let streamed = '';
    const previewer = createPreviewer((text) => interaction.editReply({ content: text }));
    const result = await runtime.agent.stream(askEvent(interaction, prompt), {
      skipCommands: true,
      onDelta: (delta) => {
        streamed += delta;
        previewer.push(streamed);
      },
    });
    await previewer.flush();
    const token = makeToken({
      prompt,
      chatId: String(interaction.channelId),
      chatType: interaction.guildId ? 'GROUP' : 'PRIVATE',
      userId: interaction.user.id,
      ephemeral: true,
    });
    const chunks = chunkContent(result.text || 'No answer.');
    await interaction.editReply({ content: chunks[0], components: answerButtons(token) });
    for (const chunk of chunks.slice(1)) await interaction.followUp({ content: chunk, ...ephemeral });
    await sendPhotos(interaction, result.photos, true);
  }

  /** @param {any} interaction */
  async function handleCommand(interaction) {
    if (!interaction.isChatInputCommand() && !interaction.isMessageContextMenuCommand()) return;
    const handler = handlers[interaction.commandName];
    if (!handler) return;
    try {
      await handler(interaction);
    } catch (error) {
      await reportError(interaction, error);
    }
  }

  /** @param {any} interaction */
  async function handleAutocomplete(interaction) {
    if (interaction.commandName !== 'model') return interaction.respond([]).catch(() => {});
    const focused = String(interaction.options.getFocused() ?? '').toLowerCase();
    const matches = chat
      .listModels()
      .filter((item) => `${item.alias} ${item.label} ${item.model}`.toLowerCase().includes(focused))
      .slice(0, 25)
      .map((item) => ({ name: `${item.alias} — ${item.label}`.slice(0, 100), value: item.alias }));
    return interaction.respond(matches).catch(() => {});
  }

  /** @param {any} interaction */
  async function handleSelect(interaction) {
    const customId = String(interaction.customId ?? '');
    if (customId === 'model:select') {
      if (!isAdmin(interaction)) {
        await interaction.reply({ content: 'Only server admins can change the model.', flags: MessageFlags.Ephemeral });
        return;
      }
      const alias = interaction.values?.[0];
      const picked = alias ? chat.findModel(alias) : null;
      if (!picked) {
        await interaction.update({ embeds: [errorEmbed('That model is no longer available.')], components: [] });
        return;
      }
      const chatId = String(interaction.channelId);
      await chat.setModel(chatId, picked.alias, interaction.guildId ? 'GROUP' : 'PRIVATE');
      await interaction.update({ embeds: [textEmbed('Model changed', `Now using **${picked.label}** (\`${picked.alias}\`).`)], components: [] });
      return;
    }

    if (!customId.startsWith('settings:')) return;
    if (!isAdmin(interaction)) {
      await interaction.reply({ content: 'Only server admins can change channel settings.', flags: MessageFlags.Ephemeral });
      return;
    }

    const field = customId.slice('settings:'.length);
    const value = String(interaction.values?.[0] ?? '');
    const chatId = String(interaction.channelId);
    const chatType = interaction.guildId ? 'GROUP' : 'PRIVATE';
    const record = await chat.getRecord(chatId, chatType);
    if (!record.meta) record.meta = {};

    if (field === 'model') {
      const picked = chat.findModel(value);
      if (!picked) {
        await interaction.update({ embeds: [errorEmbed('That model is no longer available.')], components: [] });
        return;
      }
      await chat.setModel(chatId, picked.alias, chatType, record);
    } else if (field === 'tone') {
      record.meta.tone = value !== '__default' && TONES.some((item) => item.value === value) ? value : null;
    } else if (field === 'privacy') {
      record.meta.privateDefault = value === 'private';
    } else if (field === 'thread') {
      record.meta.autoThread = value === 'on';
    } else {
      await interaction.deferUpdate();
      return;
    }

    runtime.store.touch?.(chatId);
    await interaction.update(settingsPayload(record));
  }

  /** @param {any} interaction */
  async function handleButton(interaction) {
    const [prefix, action, tokenId] = String(interaction.customId ?? '').split(':');
    if (prefix !== 'ask') return;
    const payload = tokens.get(tokenId);
    if (!payload) {
      await interaction.reply({ content: 'This answer is too old — run `/ask` again.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.user.id !== payload.userId) {
      await interaction.reply({ content: 'This is not your conversation.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === 'delete') {
      await interaction.deferUpdate();
      await interaction.message.delete().catch(() => {});
      return;
    }
    const prompt = action === 'continue' ? 'Continue from where you left off.' : payload.prompt;
    const regenerating = action === 'regen';
    if (regenerating) await interaction.deferUpdate();
    else await interaction.deferReply(privateReply(payload.ephemeral));

    let streamed = '';
    const edit = regenerating
      ? (text) => interaction.message.edit({ content: text })
      : (text) => interaction.editReply({ content: text });
    const previewer = createPreviewer(edit);
    const event = eventFromInteraction(interaction, client, prompt, {
      chatId: payload.chatId,
      chatType: payload.chatType,
      messageId: `interaction:${crypto.randomUUID()}`,
    });
    const result = await runtime.agent.stream(event, {
      skipCommands: true,
      onDelta: (delta) => {
        streamed += delta;
        previewer.push(streamed);
      },
    });
    await previewer.flush();
    const newToken = makeToken({ ...payload });
    const chunks = chunkContent(result.text || 'No answer.');
    const followFlags = privateReply(payload.ephemeral);
    if (regenerating) {
      await interaction.message.edit({ content: chunks[0], components: answerButtons(newToken) });
      for (const chunk of chunks.slice(1)) await interaction.followUp({ content: chunk, ...followFlags });
    } else {
      await interaction.editReply({ content: chunks[0], components: answerButtons(newToken) });
      for (const chunk of chunks.slice(1)) await interaction.followUp({ content: chunk, ...followFlags });
    }
    for (let index = 0; index < result.photos.length; index += 10) {
      const group = result.photos.slice(index, index + 10);
      await interaction.followUp({
        files: group.map(photoAttachment),
        content: group[0].caption?.slice(0, 2000) || undefined,
        ...followFlags,
      });
    }
  }

  return { handleCommand, handleAutocomplete, handleSelect, handleButton };
}
