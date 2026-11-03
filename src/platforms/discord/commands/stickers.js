/**
 * `/sticker`: list or send server stickers through the platform sticker service.
 * @param {ReturnType<typeof import('./shared.js').createShared>} shared
 */
export function createStickerHandlers(shared) {
  const { platform, ephemeral, replyEphemeral } = shared;

  /** @type {Record<string, (interaction: any) => Promise<unknown>>} */
  const handlers = {
    async sticker(interaction) {
      const stickers = platform.stickers;
      if (!stickers?.enabled) {
        await replyEphemeral(interaction, { content: 'Stickers are disabled in the config.' });
        return;
      }
      await interaction.deferReply(ephemeral);
      const channel = interaction.channel;
      const query = interaction.options.getString('name');
      try {
        if (!query) {
          const items = await stickers.list(channel);
          if (!items.length) {
            await interaction.editReply({
              content: 'No server stickers found. Add ids in `config.discord.stickers.ids` or give the bot Manage Expressions.',
            });
            return;
          }
          const lines = items
            .slice(0, 25)
            .map((item) => `• **${item.name}** — \`${item.id}\``)
            .join('\n');
          await interaction.editReply({ content: `**Server stickers** (${items.length})\n${lines}` });
          return;
        }
        const sticker = await stickers.resolve(channel, query);
        if (!sticker) {
          await interaction.editReply({ content: `No sticker matches "${query}" in this server.` });
          return;
        }
        await stickers.send(channel, sticker);
        await interaction.editReply({ content: `Sent the sticker **${sticker.name}**.` });
      } catch (error) {
        await interaction.editReply({ content: `Could not send the sticker: ${String(/** @type {any} */ (error)?.message ?? error)}` });
      }
    },
  };

  return { handlers };
}
