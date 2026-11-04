import { EmbedBuilder, MessageFlags } from 'discord.js';
import { COLORS, errorEmbed, modelSelect, REASONING_MODES, settingsEmbed, settingsRows, textEmbed, TONES } from '../ui.js';

/**
 * `/settings` and `/model`, plus the select menus and autocomplete that back them.
 * @param {ReturnType<typeof import('./shared.js').createShared>} shared
 */
export function createSettingsHandlers(shared) {
  const { config, runtime, chat, isAdmin, replyEphemeral } = shared;

  /** @param {any} record */
  function settingsPayload(record) {
    const current = chat.currentModel(record);
    return {
      embeds: [settingsEmbed(record, config, current)],
      components: settingsRows(chat.listModels(), record, current),
    };
  }

  /** @type {Record<string, (interaction: any) => Promise<unknown>>} */
  const handlers = {
    async settings(interaction) {
      if (!isAdmin(interaction)) {
        await replyEphemeral(interaction, { embeds: [errorEmbed('Only server admins can change channel settings.')] });
        return;
      }
      const record = await chat.getRecord(String(interaction.channelId), interaction.guildId ? 'GROUP' : 'PRIVATE');
      await replyEphemeral(interaction, settingsPayload(record));
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
  };

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
    } else if (field === 'reasoning') {
      record.meta.thinking =
        value !== '__default' && REASONING_MODES.some((item) => item.value === value) ? value : null;
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

  return { handlers, handleAutocomplete, handleSelect };
}
