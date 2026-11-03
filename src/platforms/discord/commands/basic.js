import { REMINDER_LIMITS } from '../../../core/ai/reminders.js';
import { COMMANDS, HELP_NOTE } from '../specs.js';
import { createPreviewer, errorEmbed, helpEmbed, reminderEmbed, statusEmbed, textEmbed } from '../ui.js';

/**
 * The remaining slash commands that do not stream an agent turn: help/status/ping,
 * context maintenance, tool wrappers and reminders.
 * @param {ReturnType<typeof import('./shared.js').createShared>} shared
 */
export function createBasicHandlers(shared) {
  const {
    config,
    runtime,
    platform,
    chat,
    reminderService,
    ephemeral,
    privateReply,
    isAdmin,
    replyEphemeral,
    deadline,
    sendPhotos,
  } = shared;

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
  };

  return { handlers };
}
