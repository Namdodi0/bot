import { catchupEmbed, createPreviewer } from '../ui.js';

const CATCHUP_MAX_MESSAGES = 500;
const CATCHUP_PAGE_SIZE = 100;
const CATCHUP_MAX_TRANSCRIPT = 12_000;

/**
 * `/catchup`: page back through the channel history and stream a summary.
 * @param {ReturnType<typeof import('./shared.js').createShared>} shared
 */
export function createCatchupHandlers(shared) {
  const { chat, logger, ephemeral } = shared;

  /** @type {Record<string, (interaction: any) => Promise<unknown>>} */
  const handlers = {
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
  };

  return { handlers };
}
