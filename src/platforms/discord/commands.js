import crypto from 'node:crypto';
import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { REMINDER_LIMITS } from '../../core/ai/reminders.js';
import { createChatServices } from '../../core/services/chat.js';
import { createReminderService } from '../../core/services/reminders.js';
import { eventFromInteraction } from './events.js';
import { COMMANDS, HELP_NOTE } from './specs.js';
import {
  answerButtons,
  chunkContent,
  COLORS,
  errorEmbed,
  helpEmbed,
  modelSelect,
  photoAttachment,
  reminderEmbed,
  statusEmbed,
  textEmbed,
} from './ui.js';

const TOKEN_TTL_MS = 15 * 60_000;

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
   */
  async function sendChannelAnswer(channel, result, token) {
    const chunks = result.text ? chunkContent(result.text) : [];
    const first = chunks.shift() ?? (result.photos.length ? 'Here are the images.' : 'I do not have an answer for that yet.');
    await channel.send({ content: first, components: answerButtons(token) });
    for (const chunk of chunks) await channel.send({ content: chunk });
    for (let index = 0; index < result.photos.length; index += 10) {
      const group = result.photos.slice(index, index + 10);
      await channel.send({
        files: group.map(photoAttachment),
        content: group[0].caption?.slice(0, 2000) || undefined,
      });
    }
  }

  /** @param {any} interaction @param {string} prompt @param {string} [chatId] */
  async function runAsk(interaction, prompt, chatId) {
    return runtime.agent.collect(
      askEvent(interaction, prompt, chatId ? { chatId, chatType: 'GROUP' } : undefined),
      { skipCommands: true },
    );
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
      const priv = interaction.options.getBoolean('private') === true;
      const inThread = interaction.options.getBoolean('thread') === true;
      if (!prompt) {
        await replyEphemeral(interaction, { content: 'Ask me something first.' });
        return;
      }

      if (inThread && interaction.guild) {
        await interaction.deferReply(ephemeral);
        const channel = /** @type {any} */ (interaction.channel);
        if (!channel?.threads?.create) {
          await interaction.editReply({ content: 'Threads are not available in this channel.' });
          return;
        }
        const name = prompt.replace(/\s+/g, ' ').slice(0, 90) || 'AI answer';
        const thread = await channel.threads.create({ name, autoArchiveDuration: 1440, reason: `AI answer for ${interaction.user.username}` });
        const result = await runAsk(interaction, prompt, thread.id);
        const token = makeToken({ prompt, chatId: thread.id, chatType: 'GROUP', userId: interaction.user.id, ephemeral: false });
        await sendChannelAnswer(thread, result, token);
        await interaction.editReply({ content: `Answered in ${thread}.` });
        return;
      }

      await interaction.deferReply(privateReply(priv));
      const result = await runAsk(interaction, prompt);
      const token = makeToken({
        prompt,
        chatId: String(interaction.channelId),
        chatType: interaction.guildId ? 'GROUP' : 'PRIVATE',
        userId: interaction.user.id,
        ephemeral: priv,
      });
      await sendInteractionAnswer(interaction, result, token, priv);
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
      const result = await chat.summarize(chatId, interaction.guildId ? 'GROUP' : 'PRIVATE', count);
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
    const result = await runtime.agent.collect(askEvent(interaction, `${prefix}\n\n${content}`), {
      skipCommands: true,
    });
    const token = makeToken({
      prompt: `${prefix}\n\n${content}`,
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
    if (interaction.customId !== 'model:select') return;
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
    await interaction.deferUpdate();
    const event = eventFromInteraction(interaction, client, prompt, {
      chatId: payload.chatId,
      chatType: payload.chatType,
      messageId: `interaction:${crypto.randomUUID()}`,
    });
    const result = await runtime.agent.collect(event, { skipCommands: true });
    const newToken = makeToken({ ...payload });
    const chunks = chunkContent(result.text || 'No answer.');
    if (action === 'regen') {
      await interaction.message.edit({ content: chunks[0], components: answerButtons(newToken) });
      for (const chunk of chunks.slice(1)) await interaction.followUp({ content: chunk, ...privateReply(payload.ephemeral) });
    } else {
      await interaction.followUp({ content: chunks[0], components: answerButtons(newToken), ...privateReply(payload.ephemeral) });
      for (const chunk of chunks.slice(1)) await interaction.followUp({ content: chunk, ...privateReply(payload.ephemeral) });
    }
    for (let index = 0; index < result.photos.length; index += 10) {
      const group = result.photos.slice(index, index + 10);
      await interaction.followUp({
        files: group.map(photoAttachment),
        content: group[0].caption?.slice(0, 2000) || undefined,
        ...privateReply(payload.ephemeral),
      });
    }
  }

  return { handleCommand, handleAutocomplete, handleSelect, handleButton };
}
