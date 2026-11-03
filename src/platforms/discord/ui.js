import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { chunkText, formatDuration } from '../../core/text/format.js';
import { photoFilename } from './transport.js';

export const COLORS = { info: 0x5865f2, ok: 0x57f287, warn: 0xfee75c, error: 0xed4245 };
export const PREVIEW_INTERVAL_MS = 1000;

/**
 * Serialized, throttled message preview. Identical (often clamped) previews are skipped so a
 * long answer does not re-edit the message with the same text. A failed edit disables
 * previews for the rest of the turn; the final answer still replaces the message.
 * @param {(text: string) => Promise<unknown>} edit
 * @param {number} [intervalMs]
 */
export function createPreviewer(edit, intervalMs = PREVIEW_INTERVAL_MS) {
  let chain = Promise.resolve();
  let disabled = false;
  let lastAt = 0;
  let lastText = '';
  return {
    /** @param {string} text */
    push(text) {
      if (disabled) return;
      const now = Date.now();
      if (lastAt && now - lastAt < intervalMs) return;
      const previewText = streamPreview(text);
      if (!previewText || previewText === lastText) return;
      lastAt = now;
      lastText = previewText;
      chain = chain
        .then(async () => {
          if (disabled) return;
          await edit(previewText);
        })
        .catch(() => {
          disabled = true;
        });
    },
    async flush() {
      await chain;
    },
  };
}

/** @param {string} text @param {number} [limit] */
export function chunkContent(text, limit = 2000) {
  return chunkText(text, { limit }).chunks;
}

/**
 * Clamp a streaming delta to the Discord limit and balance an unterminated code fence so a
 * half-written answer still renders. Never throws: a broken preview must not kill the turn.
 * @param {string} text
 * @param {number} [limit]
 */
export function streamPreview(text, limit = 1900) {
  try {
    let value = String(text ?? '');
    if (!value.trim()) return '';
    if (value.length > limit) value = value.slice(0, limit);
    if ((value.match(/```/g) ?? []).length % 2 === 1) {
      value = `${value.slice(0, Math.max(0, limit - 4))}\n\`\`\``;
    }
    return value;
  } catch {
    return '';
  }
}

/** @param {string} message */
export function errorEmbed(message) {
  return new EmbedBuilder().setColor(COLORS.error).setDescription(String(message ?? 'Something went wrong.'));
}

/**
 * Multi-line prompt form for `/ask`. Privacy/thread choices travel in the customId.
 * @param {boolean} priv
 * @param {boolean} inThread
 */
export function askModal(priv, inThread) {
  const input = new TextInputBuilder()
    .setCustomId('prompt')
    .setLabel('Your question')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(4000)
    .setRequired(true);
  return new ModalBuilder()
    .setCustomId(`ask-form:${priv ? 1 : 0}:${inThread ? 1 : 0}`)
    .setTitle('Ask the AI')
    .addComponents(/** @type {any} */ (new ActionRowBuilder().addComponents(input)));
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

/** @type {Array<{value: string, label: string}>} */
export const TONES = [
  { value: '__default', label: 'Default' },
  { value: 'friendly', label: 'Friendly' },
  { value: 'shy', label: 'Shy' },
  { value: 'roast', label: 'Roast' },
  { value: 'roast-hard', label: 'Roast hard' },
  { value: 'roast-extreme', label: 'Roast extreme' },
];

/**
 * Channel settings summary. Reads the same `record.meta` fields the handlers write.
 * @param {any} record
 * @param {any} config
 * @param {{alias: string, label: string}} currentModel
 */
export function settingsEmbed(record, config, currentModel) {
  const meta = record?.meta ?? {};
  const tone = typeof meta.tone === 'string' && meta.tone ? meta.tone : `default (${config?.tone ?? 'friendly'})`;
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('Channel settings')
    .addFields(
      { name: 'Model', value: `\`${currentModel.alias}\` — ${currentModel.label}`, inline: true },
      { name: 'Tone', value: tone, inline: true },
      { name: 'Default privacy', value: meta.privateDefault ? 'private' : 'public', inline: true },
      { name: 'Auto-thread', value: meta.autoThread ? 'on' : 'off', inline: true },
    )
    .setFooter({ text: 'Changes apply to this channel only.' });
}

/**
 * @param {{customId: string, placeholder: string, options: Array<{label: string, value: string, description?: string, default?: boolean}>}} input
 */
function selectRow(input) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(input.customId)
    .setPlaceholder(input.placeholder)
    .addOptions(
      input.options.slice(0, 25).map((option) => {
        const builder = new StringSelectMenuOptionBuilder()
          .setLabel(option.label.slice(0, 100))
          .setValue(option.value)
          .setDefault(option.default === true);
        return option.description ? builder.setDescription(option.description.slice(0, 100)) : builder;
      }),
    );
  return new ActionRowBuilder().addComponents(select);
}

/**
 * At most four action rows (Discord's limit): model, tone, default privacy, auto-thread.
 * @param {Array<{alias: string, label: string, provider: string, model: string}>} models
 * @param {any} record
 * @param {{alias: string}} currentModel
 */
export function settingsRows(models, record, currentModel) {
  const meta = record?.meta ?? {};
  const model = typeof meta.model === 'string' && meta.model ? meta.model : currentModel.alias;
  const tone = typeof meta.tone === 'string' && meta.tone ? meta.tone : '__default';
  return [
    selectRow({
      customId: 'settings:model',
      placeholder: 'Choose a model',
      options: models.slice(0, 25).map((item) => ({
        label: item.label,
        value: item.alias,
        description: `${item.provider}/${item.model}`,
        default: item.alias === model,
      })),
    }),
    selectRow({
      customId: 'settings:tone',
      placeholder: 'Choose a tone',
      options: TONES.map((item) => ({ ...item, default: item.value === tone })),
    }),
    selectRow({
      customId: 'settings:privacy',
      placeholder: 'Default privacy for /ask',
      options: [
        { value: 'public', label: 'Public', default: !meta.privateDefault },
        { value: 'private', label: 'Private', default: meta.privateDefault === true },
      ],
    }),
    selectRow({
      customId: 'settings:thread',
      placeholder: 'Answer /ask in a new thread',
      options: [
        { value: 'off', label: 'Off', default: meta.autoThread !== true },
        { value: 'on', label: 'On', default: meta.autoThread === true },
      ],
    }),
  ];
}

/**
 * @param {number} hours
 * @param {number} count
 * @param {string} text
 */
export function catchupEmbed(hours, count, text) {
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`Catch-up — last ${hours} hour${hours === 1 ? '' : 's'}`)
    .setDescription(String(text ?? '').slice(0, 4000) || 'Nothing to summarize.')
    .setFooter({ text: `${count} message${count === 1 ? '' : 's'} summarized` });
}
