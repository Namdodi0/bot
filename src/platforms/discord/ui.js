import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { chunkText, formatDuration } from '../../core/text/format.js';
import { photoFilename } from './transport.js';

export const COLORS = { info: 0x5865f2, ok: 0x57f287, warn: 0xfee75c, error: 0xed4245 };

/** @param {string} text @param {number} [limit] */
export function chunkContent(text, limit = 2000) {
  return chunkText(text, { limit }).chunks;
}

/** @param {string} message */
export function errorEmbed(message) {
  return new EmbedBuilder().setColor(COLORS.error).setDescription(String(message ?? 'Something went wrong.'));
}

/**
 * @param {Array<any>} commands
 * @param {string} note
 */
export function helpEmbed(commands, note) {
  const lines = commands
    .filter((command) => command.type === 1)
    .map((command) => `**/${command.name}** — ${command.description}`);
  const menus = commands
    .filter((command) => command.type === 3)
    .map((command) => `**${command.name}** — message menu`);
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('AI bot commands')
    .setDescription([...lines, '', '*Message menus*', ...menus, '', note].join('\n'));
}

/**
 * @param {{model: any, mode: string, uptimeSec: number, messages: number, turns: number, contextFiles: number, ttlHours: number, ping: number, search: string, metrics: any}} data
 */
export function statusEmbed(data) {
  const snapshot = data.metrics?.snapshot?.() ?? {};
  const count = (name) => snapshot.counters?.[name] ?? 0;
  const llm = snapshot.latency?.['llm.latency'];
  const replies = snapshot.latency?.['agent.reply'];
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('Bot status')
    .addFields(
      { name: 'Model', value: `\`${data.model.alias}\` — ${data.model.label}\n\`${data.model.provider}/${data.model.model}\`` },
      { name: 'Transport', value: `${data.mode} · gateway ${data.ping}ms` },
      { name: 'Uptime', value: formatDuration(data.uptimeSec * 1000) },
      { name: 'Context', value: `${data.messages} messages · ${data.turns} turns · ${data.contextFiles} files on disk` },
      { name: 'Search', value: data.search },
      {
        name: 'Latency',
        value: `LLM p50 ${llm ? `${llm.p50}ms` : 'n/a'} · reply p50 ${replies ? `${replies.p50}ms` : 'n/a'}`,
      },
      { name: 'Traffic', value: `${count('messages.in')} received · ${count('messages.replied')} replies · ${count('messages.error')} errors` },
    );
}

/** @param {string} token */
export function answerButtons(token) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ask:regen:${token}`).setLabel('Regenerate').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ask:continue:${token}`).setLabel('Continue').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ask:delete:${token}`).setLabel('Delete').setStyle(ButtonStyle.Danger),
  );
  return [row];
}

/**
 * @param {Array<{alias: string, label: string, provider: string, model: string}>} models
 * @param {string} current
 */
export function modelSelect(models, current) {
  const select = new StringSelectMenuBuilder()
    .setCustomId('model:select')
    .setPlaceholder('Choose a model')
    .addOptions(
      models.slice(0, 25).map((item) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(item.label.slice(0, 100))
          .setValue(item.alias)
          .setDescription(`${item.provider}/${item.model}`.slice(0, 100))
          .setDefault(item.alias === current),
      ),
    );
  return [new ActionRowBuilder().addComponents(select)];
}

/** @param {{url?: string, data?: Buffer, contentType?: string, caption?: string}} photo */
export function photoAttachment(photo) {
  return new AttachmentBuilder(photo.data ? Buffer.from(photo.data) : String(photo.url), {
    name: photoFilename(photo.url ?? '', photo.contentType),
  });
}

/**
 * @param {string} title
 * @param {string} text
 */
export function textEmbed(title, text) {
  const body = String(text ?? '').slice(0, 4000) || 'No results.';
  return new EmbedBuilder().setColor(COLORS.info).setTitle(title).setDescription(body);
}

/** @param {Array<{id: number, at: number, text: string}>} items */
export function reminderEmbed(items) {
  if (!items.length) {
    return new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle('Reminders')
      .setDescription('No reminders in this channel yet. Use `/remind add`.');
  }
  const lines = items
    .slice()
    .sort((a, b) => a.at - b.at)
    .map((item) => `**#${item.id}** — <t:${Math.floor(item.at / 1000)}:f> (<t:${Math.floor(item.at / 1000)}:R>)\n${item.text}`);
  return new EmbedBuilder().setColor(COLORS.info).setTitle(`Reminders (${items.length})`).setDescription(lines.join('\n\n').slice(0, 4000));
}
