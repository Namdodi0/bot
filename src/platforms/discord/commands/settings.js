import { MessageFlags } from 'discord.js';
import { errorPanel, modelSelect, REASONING_MODES, settingsPanel, settingsRows, textPanel, TONES } from '../ui.js';

/**
 * `/settings` and `/model`, plus the select menus and autocomplete that back them.
 * @param {ReturnType<typeof import('./shared.js').createShared>} shared
 */
export function createSettingsHandlers(shared) {
  const { config, logger, runtime, chat, isAdmin, replyEphemeral, runExclusive } = shared;

  /** @param {any} record */
  function settingsPayload(record) {
    const current = chat.currentModel(record);
    return settingsPanel(
      record,
      config,
      current,
      chat.currentVisionModel(record),
      settingsRows(chat.listModels(), record, current),
    );
  }

  /** @type {Record<string, (interaction: any) => Promise<unknown>>} */
  const handlers = {
    async settings(interaction) {
      if (!isAdmin(interaction)) {
        await replyEphemeral(
          interaction,
          errorPanel('Only server admins get to touch these dials. 🔒'),
        );
        return;
      }
      const chatId = String(interaction.channelId);
      const chatType = interaction.guildId ? 'GROUP' : 'PRIVATE';
      const requested = interaction.options?.getString?.('vision');
      if (requested !== null && requested !== undefined && String(requested).trim()) {
        const saved = await chat.setVisionModel(chatId, requested, chatType);
        if (!saved.ok) {
          await replyEphemeral(
            interaction,
            errorPanel(`"${requested}" is not a vision-capable model. It can't see. 👀`),
          );
          return;
        }
        const clearing = ['default', '__default'].includes(String(requested).trim().toLowerCase());
        await replyEphemeral(interaction, {
          content: clearing
            ? `Vision model reset to the default${saved.model ? ` (\`${saved.model.alias}\` — ${saved.model.label})` : ''}. Back to factory eyes. 👀`
            : `Vision model is now **${saved.model.label}** (\`${saved.model.alias}\`). Eyes unlocked. 👀`,
        });
        return;
      }
      const record = await chat.getRecord(chatId, chatType);
      await replyEphemeral(interaction, settingsPayload(record));
    },

    async model(interaction) {
      if (!isAdmin(interaction)) {
        await replyEphemeral(
          interaction,
          errorPanel('Only server admins get to swap the brain. 🔒'),
        );
        return;
      }
      const chatId = String(interaction.channelId);
      const record = await chat.getRecord(chatId, interaction.guildId ? 'GROUP' : 'PRIVATE');
      const current = chat.currentModel(record);
      const name = interaction.options.getString('name');
      if (!name) {
        await replyEphemeral(
          interaction,
          textPanel('Model', `Currently running **${current.label}** (\`${current.alias}\`).`, {
            icon: '🧠',
            subtitle: 'Pick a different brain below.',
            rows: modelSelect(chat.listModels(), current.alias),
          }),
        );
        return;
      }
      const picked = chat.findModel(name);
      if (!picked) {
        await replyEphemeral(
          interaction,
          errorPanel(`No model named "${name}". Nice try, though.`, 'No dice'),
        );
        return;
      }
      const saved = await chat.setModel(chatId, name, interaction.guildId ? 'GROUP' : 'PRIVATE');
      if (!saved.ok) {
        await replyEphemeral(
          interaction,
          errorPanel(`No model named "${name}". Nice try, though.`, 'No dice'),
        );
        return;
      }
      await replyEphemeral(interaction, {
        content: `Model is now **${saved.model.label}** (\`${saved.model.alias}\`). Fresh brain, same attitude. 🧠`,
      });
    },
  };

  /** @param {any} interaction */
  async function handleAutocomplete(interaction) {
    if (interaction.commandName !== 'model' && interaction.commandName !== 'settings') {
      return interaction.respond([]).catch((error) => {
        logger?.debug('discord autocomplete reply failed', {
          error: String(/** @type {any} */ (error)?.message ?? error),
        });
      });
    }
    const raw = interaction.options.getFocused(true);
    const structured = raw && typeof raw === 'object';
    const optionName = structured
      ? String(raw.name ?? '')
      : interaction.commandName === 'settings'
        ? 'vision'
        : 'name';
    const focused = String(structured ? raw.value ?? '' : raw ?? '').toLowerCase();
    const vision = optionName === 'vision';
    const options = (vision ? chat.listVisionModels() : chat.listModels())
      .filter((item) => `${item.alias} ${item.label} ${item.model}`.toLowerCase().includes(focused))
      .slice(0, vision ? 24 : 25)
      .map((item) => ({ name: `${item.alias} — ${item.label}`.slice(0, 100), value: item.alias }));
    if (vision && 'default'.includes(focused)) {
      options.unshift({ name: 'default — back to the configured vision model', value: 'default' });
    }
    return interaction.respond(options).catch((error) => {
      logger?.debug('discord autocomplete reply failed', {
        error: String(/** @type {any} */ (error)?.message ?? error),
      });
    });
  }

  /** @param {any} interaction */
  async function handleSelect(interaction) {
    const customId = String(interaction.customId ?? '');
    if (customId === 'model:select') {
      if (!isAdmin(interaction)) {
        await interaction.reply({
          content: 'Only server admins get to swap the brain. 🔒',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const alias = interaction.values?.[0];
      const picked = alias ? chat.findModel(alias) : null;
      if (!picked) {
        await interaction.update(errorPanel('That model walked off the stage. Pick another. 🚪', 'No dice'));
        return;
      }
      const chatId = String(interaction.channelId);
      const outcome = await runExclusive(interaction, () =>
        chat.setModel(chatId, picked.alias, interaction.guildId ? 'GROUP' : 'PRIVATE'),
      );
      if (!outcome.ok) return;
      await interaction.update(
        textPanel('Brain swapped', `Now running **${picked.label}** (\`${picked.alias}\`). Fresh neurons. 🧠`, {
          icon: '✅',
          ephemeral: true,
        }),
      );
      return;
    }

    if (!customId.startsWith('settings:')) return;
    if (!isAdmin(interaction)) {
      await interaction.reply({
        content: 'Only server admins get to touch these dials. 🔒',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const field = customId.slice('settings:'.length);
    const value = String(interaction.values?.[0] ?? '');
    const chatId = String(interaction.channelId);
    const chatType = interaction.guildId ? 'GROUP' : 'PRIVATE';
    if (!['model', 'tone', 'reasoning', 'privacy', 'thread'].includes(field)) {
      await interaction.deferUpdate();
      return;
    }
    if (field === 'model' && !chat.findModel(value)) {
      await interaction.update(errorPanel('That model walked off the stage. Pick another. 🚪', 'No dice'));
      return;
    }

    const outcome = await runExclusive(interaction, async () => {
      const record = await chat.getRecord(chatId, chatType);
      if (!record.meta) record.meta = {};
      if (field === 'model') {
        await chat.setModel(chatId, value, chatType, record);
      } else if (field === 'tone') {
        record.meta.tone = value !== '__default' && TONES.some((item) => item.value === value) ? value : null;
      } else if (field === 'reasoning') {
        record.meta.thinking =
          value !== '__default' && REASONING_MODES.some((item) => item.value === value) ? value : null;
      } else if (field === 'privacy') {
        record.meta.privateDefault = value === 'private';
      } else if (field === 'thread') {
        record.meta.autoThread = value === 'on';
      }
      runtime.store.touch?.(chatId);
      return settingsPayload(record);
    });
    if (!outcome.ok) return;
    await interaction.update(outcome.value);
  }

  /** @param {any} interaction */
  async function handleButton(interaction) {
    if (interaction.customId !== 'settings:thinking') return false;
    if (!isAdmin(interaction)) {
      await replyEphemeral(
        interaction,
        errorPanel('Only server admins get to touch these dials. 🔒'),
      );
      return true;
    }
    const chatId = String(interaction.channelId);
    const chatType = interaction.guildId ? 'GROUP' : 'PRIVATE';
    const outcome = await runExclusive(interaction, async () => {
      const record = await chat.getRecord(chatId, chatType);
      if (!record.meta) record.meta = {};
      record.meta.showThinking = record.meta.showThinking !== true;
      runtime.store.touch?.(chatId);
      return settingsPayload(record);
    });
    if (!outcome.ok) return true;
    await interaction.update(outcome.value);
    return true;
  }

  return { handlers, handleAutocomplete, handleSelect, handleButton };
}
