import { REMINDER_LIMITS } from '../../../core/ai/reminders.js';
import { COMMANDS, HELP_NOTE } from '../specs.js';
import {
  createPreviewer,
  errorPanel,
  paginationRow,
  remindersPanel,
  remindButtons,
  remindModal,
  statusPanel,
  textPanel,
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
      '**Message menus**',
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
      'invalid-time': 'That time makes no sense. Try `HH:MM`, `tomorrow`, or `+10m`. ⏰',
      'too-long': `That reminder is too long (max ${REMINDER_LIMITS.MAX_REMINDER_CHARS} chars). Trim it.`,
      'chat-limit': `This channel already has ${REMINDER_LIMITS.MAX_PER_CHAT} reminders. Cancel one first.`,
      'total-limit': 'The reminder limit is full. Even I have limits.',
      invalid: 'That reminder is invalid. Try again.',
      'not-configured': "Reminders aren't configured here. Somebody forgot to flip the switch. 🔌",
    };
    return messages[/** @type {keyof typeof messages} */ (reason)] ?? 'Could not create the reminder. Rude.';
  }

  function deadline() {
    return config.responseTimeoutMs > 0 ? Date.now() + config.responseTimeoutMs : Number.POSITIVE_INFINITY;
  }

  function avatarUrl() {
    try {
      return platform.transport.client?.user?.displayAvatarURL?.({ extension: 'png', size: 128 }) ?? null;
    } catch {
      return null;
    }
  }

  /** @param {any} interaction */
  async function commandRateLimited(interaction) {
    const chatId = String(interaction.channelId);
    if (!runtime.agent.rateLimited?.(chatId, interaction.user.id)) return false;
    await replyEphemeral(interaction, {
      content: "Whoa, easy. You're hitting commands too fast — give it a minute. 🏎️",
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
        await replyEphemeral(
          interaction,
          textPanel('Command deck', pages[0], { icon: '📚', thumbnail: avatarUrl() }),
        );
        return;
      }
      const pager = makePager(interaction.user.id, pages, 'Command deck', '📚');
      await replyEphemeral(
        interaction,
        textPanel('Command deck', pages[0], {
          icon: '📚',
          thumbnail: avatarUrl(),
          rows: paginationRow(pager, 0, pages.length),
        }),
      );
    },

    async status(interaction) {
      await interaction.deferReply(ephemeral);
      const chatId = String(interaction.channelId);
      const record = await chat.getRecord(chatId, interaction.guildId ? 'GROUP' : 'PRIVATE');
      await interaction.editReply(
        statusPanel({
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
          avatar: avatarUrl(),
        }),
      );
    },

    async reasoning(interaction) {
      await interaction.deferReply(ephemeral);
      const record = await chat.getRecord(
        String(interaction.channelId),
        interaction.guildId ? 'GROUP' : 'PRIVATE',
      );
      const messages = record?.messages ?? [];
      let latest = null;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role === 'assistant' && (message.kind ?? 'turn') === 'turn') {
          latest = message;
          break;
        }
      }
      const text = String(latest?.reasoning ?? '').trim();
      if (!text) {
        await interaction.editReply(
          v2Message('My latest answer came without any reasoning attached. Nothing to show. 🫥'),
        );
        return;
      }
      const body = text.length > 3600 ? `${text.slice(0, 3600)}\n\n[truncated]` : text;
      await interaction.editReply(v2Message(`🧠 **Reasoning behind my latest answer**\n\n${body}`));
    },

    async restart(interaction) {
      if (!isAdmin(interaction)) {
        await replyEphemeral(interaction, errorPanel('Only server admins can restart me. 🔒'));
        return;
      }
      await interaction.deferReply(ephemeral);
      await interaction.editReply(v2Message('♻️ Restarting — back in a few seconds. 🐋'));
      logger?.warn('restart requested from Discord', {
        user: interaction.user?.id,
        channelId: interaction.channelId,
        icon: '♻️',
      });
      void runtime.restart?.('slash /restart');
    },

    async ping(interaction) {
      const gateway = (await platform.transport.ping()) || 0;
      const roundtrip = Date.now() - Number(interaction.createdTimestamp);
      await replyEphemeral(interaction, {
        content: `🏓 Pong — gateway **${gateway}ms**, round trip **${roundtrip}ms**. My reflexes are ridiculous.`,
      });
    },

    async stop(interaction) {
      const stopped = runtime.agent?.stop?.(String(interaction.channelId)) === true;
      await replyEphemeral(interaction, {
        content: stopped
          ? '🛑 Stopped. That answer is cancelled — the mic is yours.'
          : 'Nothing to stop — this channel is already quiet. 😴',
      });
    },

    async reset(interaction) {
      if (!isAdmin(interaction)) {
        await replyEphemeral(interaction, errorPanel('Only server admins get to wipe the memory. 🔒'));
        return;
      }
      await interaction.deferReply(ephemeral);
      const chatId = String(interaction.channelId);
      const full = interaction.options.getBoolean('all') === true;
      const outcome = await runExclusive(interaction, () => chat.reset(chatId, { all: full }));
      if (!outcome.ok) return;
      await interaction.editReply({
        content: full
          ? '🧹 Memory wiped — context and channel settings are gone. Clean slate.'
          : '🧹 Memory wiped. Your settings survived.',
      });
    },

    async compact(interaction) {
      if (!isAdmin(interaction)) {
        await replyEphemeral(interaction, errorPanel('Only server admins get to squeeze the context. 🔒'));
        return;
      }
      if (await commandRateLimited(interaction)) return;
      await interaction.deferReply(ephemeral);
      const chatId = String(interaction.channelId);
      const outcome = await runExclusive(interaction, () => chat.compact(chatId, 'GROUP'));
      if (!outcome.ok) return;
      const result = outcome.value;
      if (!result?.changed) {
        await interaction.editReply({ content: '📦 Nothing to squeeze — the context is already lean.' });
        return;
      }
      await interaction.editReply({
        content: `📦 Context compacted${result.summarized ? ' with a fresh summary' : ''}. Leaner, meaner.`,
      });
    },

    async summary(interaction) {
      if (await commandRateLimited(interaction)) return;
      await interaction.deferReply(ephemeral);
      const count = interaction.options.getInteger('count') ?? 30;
      const chatId = String(interaction.channelId);
      let streamed = '';
      const previewer = createPreviewer((text) => interaction.editReply(v2Message(text)));
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
              ? 'No summary came back. The model ghosted me. 👻'
              : 'Not enough messages to recap yet. Give me more chaos. 🍿',
        });
        return;
      }
      const title = `Recap — last ${result.count} messages`;
      const pages = splitPages(result.text);
      if (pages.length > 1) {
        const pager = makePager(interaction.user.id, pages, title, '📝');
        await interaction.editReply(
          textPanel(title, pages[0], { icon: '📝', rows: paginationRow(pager, 0, pages.length) }),
        );
        return;
      }
      await interaction.editReply(textPanel(title, result.text, { icon: '📝' }));
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
        await interaction.editReply(errorPanel(result.text, 'Search tripped'));
        return;
      }
      await interaction.editReply(
        textPanel('Web search', result.text, { icon: '🔎', subtitle: query }),
      );
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
        await interaction.editReply(errorPanel(result.text || 'No images found.', 'No pixels'));
        return;
      }
      const text =
        result.text ||
        `Fresh pixels, as requested — ${photos.length} image${photos.length === 1 ? '' : 's'}. 🖼️`;
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
        await replyEphemeral(interaction, {
          content: "Reminders aren't wired up here. Tell an admin to flip the switch. 🔌",
        });
        return;
      }
      const chatId = String(interaction.channelId);
      const sub = interaction.options.getSubcommand();
      if (sub === 'list') {
        await replyEphemeral(
          interaction,
          remindersPanel(reminderService.list(chatId), remindButtons()),
        );
        return;
      }
      if (sub === 'cancel') {
        const id = interaction.options.getInteger('id', true);
        const removed = await reminderService.cancel(chatId, id);
        await replyEphemeral(interaction, {
          content: removed
            ? `🗑️ Reminder #${removed.id} cancelled.`
            : `No reminder #${id} here. Check the list.`,
        });
        return;
      }
      const when = String(interaction.options.getString('when', true)).trim();
      const text = String(interaction.options.getString('text', true)).trim();
      const created = await reminderService.add(chatId, when, text, interaction.user.id);
      if (!created.ok) {
        await replyEphemeral(interaction, { content: reminderError(created.reason) });
        return;
      }
      const seconds = Math.floor(created.item.at / 1000);
      await replyEphemeral(interaction, {
        content: `⏰ Locked in. Reminder #${created.item.id} fires <t:${seconds}:f> — that's <t:${seconds}:R>.
> ${text}`,
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
      content: `⏰ Locked in. Reminder #${created.item.id} fires <t:${seconds}:f> — that's <t:${seconds}:R>.
> ${created.item.text}`,
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
