import { REMINDER_LIMITS } from '../../../core/ai/reminders.js';
import { COMMANDS, HELP_NOTE } from '../specs.js';
import {
  createPreviewer,
  errorEmbed,
  helpEmbed,
  paginationRow,
  reminderEmbed,
  remindButtons,
  remindModal,
  statusEmbed,
  textEmbed,
  v2Answer,
  v2Message,
} from '../ui.js';

/**
 * The remaining slash commands that do not stream an agent turn: help/status/ping,
 * context maintenance, tool wrappers and reminders.
 * @param {ReturnType<typeof import('./shared.js').createShared>} shared
 */
export function createBasicHandlers(shared) {
  const {
    config,
    logger,
    runtime,
    platform,
    chat,
    reminderService,
    ephemeral,
    privateReply,
    isAdmin,
    replyEphemeral,
    sendPhotos,
    makePager,
    splitPages,
    runExclusive,
  } = shared;

  /** Split the command list into pages that fit a mobile embed. */
  function helpPages() {
    const lines = [
      ...COMMANDS.filter((command) => command.type === 1).map((command) => `**/${command.name}** — ${command.description}`),
      '',
      '*Message menus*',
      ...COMMANDS.filter((command) => command.type === 3).map((command) => `**${command.name}** — message menu`),
    ];
    const pages = [];
    for (let index = 0; index < lines.length; index += 8) pages.push(lines.slice(index, index + 8).join('\n'));
    pages[pages.length - 1] = `${pages[pages.length - 1]}\n\n${HELP_NOTE}`;
    return pages;
  }

  /** @param {string} reason */
  function reminderError(reason) {
    const messages = {
      'invalid-time': 'Invalid reminder time.',
      'too-long': `The reminder text is too long (max ${REMINDER_LIMITS.MAX_REMINDER_CHARS}).`,
      'chat-limit': `This channel already has ${REMINDER_LIMITS.MAX_PER_CHAT} reminders; cancel one first.`,
      'total-limit': 'The reminder limit has been reached.',
      invalid: 'Invalid reminder.',
      'not-configured': 'Reminders are not configured.',
    };
    return messages[/** @type {keyof typeof messages} */ (reason)] ?? 'Could not create the reminder.';
  }

  function deadline() {
    return config.responseTimeoutMs > 0 ? Date.now() + config.responseTimeoutMs : Number.POSITIVE_INFINITY;
  }

  /** @param {any} interaction */
  async function commandRateLimited(interaction) {
    const chatId = String(interaction.channelId);
    if (!runtime.agent.rateLimited?.(chatId, interaction.user.id)) return false;
    await replyEphemeral(interaction, {
      content: 'You are using commands too quickly — please wait a minute and try again.',
    });
    return true;
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
    async help(interaction) {
      const pages = helpPages();
      if (pages.length <= 1) {
        await replyEphemeral(interaction, { embeds: [helpEmbed(COMMANDS, HELP_NOTE)] });
        return;
      }
      const pager = makePager(interaction.user.id, pages, 'AI bot commands');
      await replyEphemeral(interaction, {
        embeds: [textEmbed('AI bot commands', pages[0])],
        components: paginationRow(pager, 0, pages.length),
      });
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
      await interaction.deferReply(ephemeral);
      const chatId = String(interaction.channelId);
      const full = interaction.options.getBoolean('all') === true;
      const outcome = await runExclusive(interaction, () => chat.reset(chatId, { all: full }));
      if (!outcome.ok) return;
      await interaction.editReply({
        content: full ? 'Cleared the context and settings for this channel.' : 'Cleared this channel context (settings kept).',
      });
    },

    async compact(interaction) {
      if (!isAdmin(interaction)) {
        await replyEphemeral(interaction, { embeds: [errorEmbed('Only server admins can compact the context.')] });
        return;
      }
      if (await commandRateLimited(interaction)) return;
      await interaction.deferReply(ephemeral);
      const chatId = String(interaction.channelId);
      const outcome = await runExclusive(interaction, () => chat.compact(chatId, 'GROUP'));
      if (!outcome.ok) return;
      const result = outcome.value;
      if (!result?.changed) {
        await interaction.editReply({ content: 'The context does not need compaction yet.' });
        return;
      }
      await interaction.editReply({ content: `Compacted the context${result.summarized ? ' with a summary' : ''}.` });
    },

    async summary(interaction) {
      if (await commandRateLimited(interaction)) return;
      await interaction.deferReply(ephemeral);
      const count = interaction.options.getInteger('count') ?? 30;
      const chatId = String(interaction.channelId);
      let streamed = '';
      const previewer = createPreviewer((text) =>
        interaction.editReply({ content: text, allowedMentions: { parse: [] } }),
      );
      const outcome = await runExclusive(interaction, () =>
        chat.summarize(chatId, interaction.guildId ? 'GROUP' : 'PRIVATE', count, null, {
          onDelta: (delta) => {
            streamed += delta;
            previewer.push(streamed);
          },
        }),
      );
      if (!outcome.ok) return;
      const result = outcome.value;
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
      const title = `Summary of the last ${result.count} messages`;
      const pages = splitPages(result.text);
      if (pages.length > 1) {
        const pager = makePager(interaction.user.id, pages, title);
        await interaction.editReply({
          embeds: [textEmbed(title, pages[0])],
          components: paginationRow(pager, 0, pages.length),
        });
        return;
      }
      await interaction.editReply({ embeds: [textEmbed(title, result.text)] });
    },

    async search(interaction) {
      if (await commandRateLimited(interaction)) return;
      const query = String(interaction.options.getString('query', true)).trim();
      const priv = interaction.options.getBoolean('private') === true;
      await interaction.deferReply(privateReply(priv));
      const outcome = await runExclusive(interaction, () =>
        runtime.tools.run(
          'web_search',
          { query },
          { chatId: String(interaction.channelId), senderId: interaction.user.id, platform: 'discord', deadline: deadline() },
        ),
      );
      if (!outcome.ok) return;
      const result = outcome.value;
      if (!result.ok) {
        await interaction.editReply({ embeds: [errorEmbed(result.text)] });
        return;
      }
      await interaction.editReply({ embeds: [textEmbed(`Search: ${query}`, result.text)] });
    },

    async image(interaction) {
      if (await commandRateLimited(interaction)) return;
      const query = String(interaction.options.getString('query', true)).trim();
      const count = interaction.options.getInteger('count') ?? 1;
      const priv = interaction.options.getBoolean('private') === true;
      await interaction.deferReply(privateReply(priv));
      const outcome = await runExclusive(interaction, () =>
        runImage(
          { query, count, caption: query },
          { chatId: String(interaction.channelId), platform: 'discord', deadline: deadline() },
        ),
      );
      if (!outcome.ok) return;
      const { result, photos } = outcome.value;
      if (!photos.length) {
        await interaction.editReply({ embeds: [errorEmbed(result.text || 'No images found.')] });
        return;
      }
      const text =
        result.text ||
        `Here ${photos.length === 1 ? 'is' : 'are'} ${photos.length} image${photos.length === 1 ? '' : 's'}.`;
      try {
        await interaction.editReply(v2Answer(text, [], photos));
      } catch (error) {
        logger?.warn('combined image reply failed, sending separately', {
          error: String(/** @type {any} */ (error)?.message ?? error),
        });
        await interaction.editReply(v2Message(text));
        await sendPhotos(interaction, photos, priv);
      }
    },

    async remind(interaction) {
      if (!reminderService.available()) {
        await replyEphemeral(interaction, { content: 'Reminders are not configured.' });
        return;
      }
      const chatId = String(interaction.channelId);
      const sub = interaction.options.getSubcommand();
      if (sub === 'list') {
        await replyEphemeral(interaction, {
          embeds: [reminderEmbed(reminderService.list(chatId))],
          components: remindButtons(),
        });
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

  /** @param {any} interaction */
  async function handleButton(interaction) {
    if (interaction.customId !== 'remind:new') return false;
    await interaction.showModal(remindModal());
    return true;
  }

  /** @param {any} interaction */
  async function handleModal(interaction) {
    if (interaction.customId !== 'remind-form') return false;
    const chatId = String(interaction.channelId);
    const when = String(interaction.fields?.getTextInputValue('remind-when') ?? '').trim();
    const text = String(interaction.fields?.getTextInputValue('remind-text') ?? '').trim();
    const created = await reminderService.add(chatId, when, text, interaction.user.id);
    if (!created.ok) {
      await replyEphemeral(interaction, { content: reminderError(created.reason) });
      return true;
    }
    const seconds = Math.floor(created.item.at / 1000);
    await replyEphemeral(interaction, {
      content: `Reminder #${created.item.id} set for <t:${seconds}:f> (<t:${seconds}:R>): ${created.item.text}`,
    });
    return true;
  }

  /** @param {any} interaction */
  async function handleAutocomplete(interaction) {
    if (interaction.commandName !== 'remind') return false;
    let sub = '';
    try {
      sub = interaction.options.getSubcommand(false) ?? '';
    } catch {
      sub = '';
    }
    if (sub !== 'cancel') {
      await interaction.respond([]);
      return true;
    }
    const chatId = String(interaction.channelId);
    const focused = String(interaction.options.getFocused() ?? '').toLowerCase();
    const choices = reminderService
      .list(chatId)
      .slice()
      .sort((a, b) => a.at - b.at)
      .map((item) => ({ name: `#${item.id} — ${item.text}`.slice(0, 100), value: String(item.id) }))
      .filter((item) => item.name.toLowerCase().includes(focused) || item.value.includes(focused))
      .slice(0, 25);
    await interaction.respond(choices);
    return true;
  }

  return { handlers, handleButton, handleModal, handleAutocomplete };
}
