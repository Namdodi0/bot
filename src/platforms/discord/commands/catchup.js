import { PermissionFlagsBits } from 'discord.js';
import { catchupEmbed, createPreviewer, paginationRow, textEmbed } from '../ui.js';

const CATCHUP_MAX_MESSAGES = 500;
const CATCHUP_PAGE_SIZE = 100;
const CATCHUP_MAX_TRANSCRIPT = 12_000;

/**
 * Keep the newest whole lines within the character cap.
 * @param {string[]} lines
 * @param {number} maxChars
 */
function tailTranscript(lines, maxChars) {
  const kept = [];
  let total = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const cost = lines[index].length + 1;
    if (total + cost > maxChars) break;
    kept.unshift(lines[index]);
    total += cost;
  }
  return { text: kept.join('\n'), count: kept.length };
}

/**
 * `/catchup`: page back through the channel history and stream a summary.
 * @param {ReturnType<typeof import('./shared.js').createShared>} shared
 */
export function createCatchupHandlers(shared) {
  const { chat, logger, ephemeral, runtime, replyEphemeral, makePager, splitPages, runExclusive } = shared;

  /** @type {Record<string, (interaction: any) => Promise<unknown>>} */
  const handlers = {
    async catchup(interaction) {
      const chatId = String(interaction.channelId);
      if (runtime.agent.rateLimited?.(chatId, interaction.user.id)) {
        await replyEphemeral(interaction, {
          content: 'You are using commands too quickly — please wait a minute and try again.',
        });
        return;
      }
      // History access is the requester's permission, not the bot's. Summarizing through the
      // bot must not reveal messages the member cannot read themselves.
      if (interaction.guildId && interaction.memberPermissions?.has?.(PermissionFlagsBits.ReadMessageHistory) !== true) {
        await replyEphemeral(interaction, {
          content: 'You need the Read Message History permission in this channel to use /catchup.',
        });
        return;
      }
      await interaction.deferReply(ephemeral);
      const hours = interaction.options.getInteger('hours') ?? 24;
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

      const transcript = tailTranscript(
        collected
          .slice()
          .reverse()
          .map((item) => `${item.name}: ${item.text}`),
        CATCHUP_MAX_TRANSCRIPT,
      );
      let streamed = '';
      const previewer = createPreviewer((text) =>
        interaction.editReply({ content: text, allowedMentions: { parse: [] } }),
      );
      const outcome = await runExclusive(interaction, async () =>
        chat.summarizeText(transcript.text, {
          record: await chat.getRecord(chatId, interaction.guildId ? 'GROUP' : 'PRIVATE'),
          onDelta: (delta) => {
            streamed += delta;
            previewer.push(streamed);
          },
        }),
      );
      if (!outcome.ok) return;
      const summary = outcome.value;
      await previewer.flush();
      if (!summary.ok) {
        await interaction.editReply({ content: 'I could not summarize those messages right now.' });
        return;
      }
      const pages = splitPages(summary.text);
      if (pages.length > 1) {
        const title = `Catch-up — last ${hours} hour${hours === 1 ? '' : 's'}`;
        const pager = makePager(interaction.user.id, pages, title);
        await interaction.editReply({
          embeds: [textEmbed(title, pages[0])],
          components: paginationRow(pager, 0, pages.length),
        });
        return;
      }
      await interaction.editReply({ embeds: [catchupEmbed(hours, transcript.count, summary.text)] });
    },
  };

  return { handlers };
}
