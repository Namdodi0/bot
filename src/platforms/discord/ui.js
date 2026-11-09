import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MessageFlags,
  ModalBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  ThumbnailBuilder,
} from 'discord.js';
import { chunkText, formatDuration } from '../../core/text/format.js';
import { photoFilename } from './transport.js';

const COLORS = { info: 0x5865f2, ok: 0x57f287, warn: 0xfee75c, error: 0xed4245 };
const PREVIEW_INTERVAL_MS = 1000;
/** Components V2 TextDisplay cap; answers chunk just under it instead of the 2000-char content cap. */
const V2_TEXT_LIMIT = 4000;

/**
 * Components V2 answer payload: a top-level TextDisplay (plain-message look) plus optional
 * button rows. Deliberately no Container — the card chrome made answers look foreign.
 * V2 messages cannot carry `content` or `embeds`, hence every answer payload uses this.
 * @param {string} content
 * @param {any[]} [rows]
 * @param {{ephemeral?: boolean}} [options]
 */
export function v2Message(content, rows = [], options = {}) {
  const raw = String(content ?? '');
  const text = raw.trim() ? raw.slice(0, V2_TEXT_LIMIT) : '…';
  return {
    components: [new TextDisplayBuilder().setContent(text), ...rows],
    flags: MessageFlags.IsComponentsV2 | (options.ephemeral ? MessageFlags.Ephemeral : 0),
    allowedMentions: { parse: [] },
  };
}

/**
 * V2 answer that also carries images in a MediaGallery, so text and pictures share one
 * message. Attachment names are unique because `photoFilename` returns the same name for
 * every photo of a format.
 * @param {string} content
 * @param {any[]} [rows]
 * @param {any[]} [photos]
 * @param {{ephemeral?: boolean}} [options]
 */
export function v2Answer(content, rows = [], photos = [], options = {}) {
  const payload = v2Message(content, rows, options);
  const list = (photos ?? []).slice(0, 10);
  if (!list.length) return payload;
  const gallery = new MediaGalleryBuilder();
  const files = [];
  list.forEach((photo, index) => {
    const extension = photoFilename(photo?.url ?? '', photo?.contentType).split('.').pop() || 'png';
    const name = `image-${index + 1}.${extension}`;
    files.push(
      new AttachmentBuilder(photo?.data ? Buffer.from(photo.data) : String(photo?.url ?? ''), { name }),
    );
    gallery.addItems({ media: { url: `attachment://${name}` } });
  });
  payload.components.splice(1, 0, gallery);
  payload.files = files;
  return payload;
}

/**
 * Split an answer so its first chunk fits beside the progress block (thinking + tools).
 * @param {string} text
 * @param {number} [progressLength]
 */
export function splitForProgress(text, progressLength = 0) {
  const chunks = chunkText(text, { limit: 3900 }).chunks;
  if (!chunks.length) return chunks;
  const budget = Math.max(300, V2_TEXT_LIMIT - progressLength - 80);
  const head = chunks[0];
  if (head.length <= budget) return chunks;
  let cut = head.lastIndexOf('\n', budget);
  if (cut < Math.floor(budget * 0.5)) cut = head.lastIndexOf(' ', budget);
  if (cut < Math.floor(budget * 0.5)) cut = budget;
  const first = head.slice(0, cut).trim();
  const rest = head.slice(cut).trim();
  return [first, rest, ...chunks.slice(1)].filter(Boolean);
}

/**
 * Answer payload that keeps the thinking/tool block above the answer, with images after it.
 * @param {string} progress
 * @param {string} content
 * @param {any[]} [photos]
 * @param {{ephemeral?: boolean}} [options]
 */
export function v2ProgressAnswer(progress, content, photos = [], options = {}) {
  const head = String(progress ?? '').trim().slice(0, 1500);
  if (!head) return v2Answer(content, [], photos, options);
  const answerBudget = Math.max(200, V2_TEXT_LIMIT - head.length - 80);
  const raw = String(content ?? '');
  const answer = raw.length > answerBudget ? `${raw.slice(0, answerBudget - 1)}…` : raw;
  /** @type {any[]} */
  const components = [
    new TextDisplayBuilder().setContent(head),
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    new TextDisplayBuilder().setContent(answer || '…'),
  ];
  const payload = {
    components,
    flags: MessageFlags.IsComponentsV2 | (options.ephemeral ? MessageFlags.Ephemeral : 0),
    allowedMentions: { parse: [] },
  };
  const list = (photos ?? []).slice(0, 10);
  if (!list.length) return payload;
  const gallery = new MediaGalleryBuilder();
  const files = [];
  list.forEach((photo, index) => {
    const extension = photoFilename(photo?.url ?? '', photo?.contentType).split('.').pop() || 'png';
    const name = `image-${index + 1}.${extension}`;
    files.push(
      new AttachmentBuilder(photo?.data ? Buffer.from(photo.data) : String(photo?.url ?? ''), { name }),
    );
    gallery.addItems({ media: { url: `attachment://${name}` } });
  });
  payload.components.push(gallery);
  payload.files = files;
  return payload;
}

/** Components V2 text counts across the whole message, so keep a shared safety margin. */
const PANEL_TEXT_LIMIT = 3900;

/** @param {string} text @param {number} [limit] */
function clipPanelText(text, limit = PANEL_TEXT_LIMIT) {
  const raw = String(text ?? '');
  return raw.length > limit ? `${raw.slice(0, Math.max(0, limit - 1))}…` : raw;
}

/**
 * One compact stats row: `**Name** · value` for short values, a label line for long ones.
 * @param {{name?: string, value?: string}} field
 */
function compactField(field) {
  const name = String(field?.name ?? '').trim();
  const value = String(field?.value ?? '').trim() || '—';
  if (!name) return value;
  return value.includes('\n') || value.length > 64 ? `**${name}**\n${value}` : `**${name}** · ${value}`;
}

/**
 * Components V2 command panel: a Container card with an accent color, an optional header
 * thumbnail, one compact body block, a subtext footer and action rows. Answers stay bare
 * TextDisplays; panels use this card.
 * @param {{title?: string, icon?: string, subtitle?: string, body?: string, description?: string, fields?: Array<{name?: string, value?: string}>, footer?: string, thumbnail?: string|null, headerButton?: {customId: string, label: string, style?: any, emoji?: string}|null, color?: number, rows?: any[], ephemeral?: boolean}} [options]
 */
function v2Panel(options = {}) {
  const container = new ContainerBuilder().setAccentColor(options.color ?? COLORS.info);
  const icon = String(options.icon ?? '').trim();
  const title = String(options.title ?? '').trim();
  const heading = [icon, title].filter(Boolean).join(' ');
  const subtitle = String(options.subtitle ?? '').trim();
  const footer = String(options.footer ?? '').trim();
  const thumbnail = String(options.thumbnail ?? '').trim();
  const fields = options.fields ?? [];
  const body = String(options.body ?? options.description ?? '').trim() || fields.slice(0, 20).map(compactField).join('\n');

  const headerButton = options.headerButton;
  if (heading && (thumbnail || headerButton)) {
    const section = new SectionBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${clipPanelText(heading, 240)}`),
    );
    if (thumbnail) {
      section.setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbnail));
    } else if (headerButton) {
      const button = new ButtonBuilder()
        .setCustomId(String(headerButton.customId))
        .setLabel(clipPanelText(headerButton.label, 80))
        .setStyle(headerButton.style ?? ButtonStyle.Secondary);
      if (headerButton.emoji) button.setEmoji(String(headerButton.emoji));
      section.setButtonAccessory(button);
    }
    container.addSectionComponents(section);
  } else if (heading) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${clipPanelText(heading, 240)}`),
    );
  }
  if (subtitle) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(clipPanelText(`-# ${subtitle}`, 300)),
    );
  }
  if ((heading || subtitle) && (body || footer)) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    );
  }
  const bodyBudget = Math.max(200, PANEL_TEXT_LIMIT - heading.length - subtitle.length - footer.length - 32);
  if (body) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(clipPanelText(body, bodyBudget)),
    );
  }
  if (footer) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small),
    );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(clipPanelText(`-# ${footer}`, 400)),
    );
  }
  return {
    components: [container, ...(options.rows ?? [])],
    flags: MessageFlags.IsComponentsV2 | (options.ephemeral ? MessageFlags.Ephemeral : 0),
    allowedMentions: { parse: [] },
  };
}

/**
 * Simple title + body panel used by command output and pagers.
 * @param {string} title
 * @param {string} text
 * @param {{icon?: string, subtitle?: string, footer?: string, thumbnail?: string|null, rows?: any[], ephemeral?: boolean, color?: number}} [options]
 */
export function textPanel(title, text, options = {}) {
  return v2Panel({ title, body: text, ...options });
}

/** @param {string} message @param {string} [title] */
export function errorPanel(message, title = 'Hold up') {
  return v2Panel({
    icon: '⚠️',
    title,
    body: String(message ?? 'Something broke. Try again?'),
    color: COLORS.error,
  });
}

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

/**
 * Clamp a streaming delta to the Discord limit and balance an unterminated code fence so a
 * half-written answer still renders. Never throws: a broken preview must not kill the turn.
 * @param {string} text
 * @param {number} [limit]
 */
function streamPreview(text, limit = 3800) {
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

/**
 * Multi-line prompt form for `/ask`. Privacy/thread choices travel in the customId.
 * @param {boolean} priv
 * @param {boolean} inThread
 */
export function askModal(priv, inThread) {
  const input = new TextInputBuilder()
    .setCustomId('prompt')
    .setLabel("What's on your mind?")
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(4000)
    .setRequired(true);
  return new ModalBuilder()
    .setCustomId(`ask-form:${priv ? 1 : 0}:${inThread ? 1 : 0}`)
    .setTitle('Ask me anything')
    .addComponents(/** @type {any} */ (new ActionRowBuilder().addComponents(input)));
}

/**
 * @param {{model: any, mode: string, uptimeSec: number, messages: number, turns: number, contextFiles: number, ttlHours: number, ping: number, search: string, metrics: any, avatar?: string|null}} data
 */
export function statusPanel(data) {
  const snapshot = data.metrics?.snapshot?.() ?? {};
  const count = (name) => snapshot.counters?.[name] ?? 0;
  const llm = snapshot.latency?.['llm.latency'];
  const replies = snapshot.latency?.['agent.reply'];
  return v2Panel({
    icon: '📊',
    title: 'Vitals',
    thumbnail: data.avatar,
    ephemeral: true,
    body: [
      `**Model** · \`${data.model.alias}\` — ${data.model.label}`,
      `**Transport** · ${data.mode} · ${data.ping}ms ping`,
      `**Uptime** · ${formatDuration(data.uptimeSec * 1000)}`,
      `**Context** · ${data.messages} messages · ${data.turns} turns · ${data.contextFiles} files`,
      `**Search** · ${data.search}`,
      `**Latency** · LLM p50 ${llm ? `${llm.p50}ms` : 'n/a'} · reply p50 ${replies ? `${replies.p50}ms` : 'n/a'}`,
      `**Traffic** · ${count('messages.in')} in · ${count('messages.replied')} replies · ${count('messages.error')} errors`,
    ].join('\n'),
    footer: `${data.model.provider}/${data.model.model}`,
  });
}

/**
 * Previous / page indicator / Next row for a stored pager.
 * @param {string} pagerId
 * @param {number} page
 * @param {number} total
 */
export function paginationRow(pagerId, page, total) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`page:${pagerId}:${page - 1}`)
      .setLabel('⬅️ Back')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`page:${pagerId}:${page}`)
      .setLabel(`Page ${page + 1}/${total}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`page:${pagerId}:${page + 1}`)
      .setLabel('Next ➡️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= total - 1),
  );
  return [row];
}

/** Add-reminder button shown on the reminder list. */
export function remindButtons() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('remind:new').setLabel('➕ Add reminder').setStyle(ButtonStyle.Primary),
  );
  return [row];
}

/** Modal used by the Add reminder button. */
export function remindModal() {
  const whenRow = /** @type {ActionRowBuilder<TextInputBuilder>} */ (
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('remind-when')
        .setLabel('When? (HH:MM, tomorrow, +10m)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(50),
    )
  );
  const textRow = /** @type {ActionRowBuilder<TextInputBuilder>} */ (
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('remind-text')
        .setLabel('What should I remind you about?')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(500),
    )
  );
  return new ModalBuilder()
    .setCustomId('remind-form')
    .setTitle('New reminder')
    .addComponents(whenRow, textRow);
}

/**
 * @param {Array<{alias: string, label: string, provider: string, model: string}>} models
 * @param {string} current
 */
export function modelSelect(models, current) {
  const select = new StringSelectMenuBuilder()
    .setCustomId('model:select')
    .setPlaceholder('Pick a brain')
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
function photoAttachment(photo) {
  return new AttachmentBuilder(photo.data ? Buffer.from(photo.data) : String(photo.url), {
    name: photoFilename(photo.url ?? '', photo.contentType),
  });
}

/** @param {any[]} photos */
export function photoBatches(photos) {
  /** @type {any[][]} */
  const batches = [];
  for (let index = 0; index < photos.length; index += 10) batches.push(photos.slice(index, index + 10));
  return batches;
}

/** @param {any[]} group */
export function photoPayload(group) {
  const content = group[0]?.caption?.slice(0, 2000) || undefined;
  return {
    files: group.map(photoAttachment),
    content,
    ...(content ? { allowedMentions: { parse: [] } } : {}),
  };
}

/**
 * Reminder list panel; the "Add reminder" row is passed by the command handler.
 * @param {Array<{id: number, at: number, text: string}>} items
 * @param {any[]} [rows]
 */
export function remindersPanel(items, rows = []) {
  if (!items.length) {
    return v2Panel({
      icon: '⏰',
      title: 'Reminders',
      body: 'Nothing scheduled. The future is a blank canvas — use `/remind add` or the button below. 🎨',
      rows,
      ephemeral: true,
    });
  }
  const lines = items
    .slice()
    .sort((a, b) => a.at - b.at)
    .map((item) => {
      const seconds = Math.floor(item.at / 1000);
      return `**#${item.id}** · <t:${seconds}:R> · <t:${seconds}:f>\n> ${item.text}`;
    });
  return v2Panel({
    icon: '⏰',
    title: `Reminders (${items.length})`,
    body: lines.join('\n\n'),
    rows,
    ephemeral: true,
  });
}

/** @type {Array<{value: string, label: string}>} */
export const TONES = [
  { value: '__default', label: 'Default' },
  { value: 'friendly', label: 'Friendly' },
  { value: 'cute', label: 'Cute (cheesy + thirst)' },
  { value: 'grok', label: 'Grok (comedian)' },
  { value: 'roast', label: 'Roast' },
  { value: 'roast-hard', label: 'Roast hard' },
  { value: 'roast-extreme', label: 'Roast extreme' },
];

/** @type {Array<{value: string, label: string}>} */
export const REASONING_MODES = [
  { value: '__default', label: 'Default' },
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

/**
 * Channel settings panel plus its select rows. Reads the same `record.meta` fields the
 * handlers write.
 * @param {any} record
 * @param {any} config
 * @param {{alias: string, label: string}} currentModel
 * @param {{alias: string, label: string}|null} [visionModel]
 * @param {any[]} [rows]
 */
export function settingsPanel(record, config, currentModel, visionModel = null, rows = []) {
  const meta = record?.meta ?? {};
  const tone = typeof meta.tone === 'string' && meta.tone ? meta.tone : `default (${config?.tone ?? 'friendly'})`;
  const reasoning =
    typeof meta.thinking === 'string' && meta.thinking
      ? meta.thinking
      : `default (${config?.ai?.reasoning ?? 'none'})`;
  const vision = visionModel
    ? `${meta.visionModel ? '' : 'default '}(\`${visionModel.alias}\` — ${visionModel.label})`
    : 'not configured yet';
  const showThinking = meta.showThinking !== false;
  return v2Panel({
    icon: '⚙️',
    title: 'Channel controls',
    footer: 'These dials only affect this channel.',
    rows,
    ephemeral: true,
    headerButton: {
      customId: 'settings:thinking',
      label: showThinking ? 'Thinking above answer: on' : 'Thinking above answer: off',
      emoji: '🧠',
      style: showThinking ? ButtonStyle.Success : ButtonStyle.Secondary,
    },
    body: [
      `**Model** · \`${currentModel.alias}\` — ${currentModel.label}`,
      `**Vision** · ${vision}`,
      `**Personality** · ${tone}`,
      `**Think effort** · ${reasoning}`,
      `**Default privacy** · ${meta.privateDefault ? 'private' : 'public'}`,
      `**Auto-thread** · ${meta.autoThread ? 'on' : 'off'}`,
      `**Thinking above answer** · ${showThinking ? 'on' : 'off'}`,
    ].join('\n'),
  });
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
 * At most five action rows (Discord's limit): model, tone, think effort, default privacy,
 * auto-thread.
 * @param {Array<{alias: string, label: string, provider: string, model: string}>} models
 * @param {any} record
 * @param {{alias: string}} currentModel
 */
export function settingsRows(models, record, currentModel) {
  const meta = record?.meta ?? {};
  const model = typeof meta.model === 'string' && meta.model ? meta.model : currentModel.alias;
  const tone = typeof meta.tone === 'string' && meta.tone ? meta.tone : '__default';
  const reasoning = typeof meta.thinking === 'string' && meta.thinking ? meta.thinking : '__default';
  return [
    selectRow({
      customId: 'settings:model',
      placeholder: 'Pick a brain',
      options: models.slice(0, 25).map((item) => ({
        label: item.label,
        value: item.alias,
        description: `${item.provider}/${item.model}`,
        default: item.alias === model,
      })),
    }),
    selectRow({
      customId: 'settings:tone',
      placeholder: 'Pick a personality',
      options: TONES.map((item) => ({ ...item, default: item.value === tone })),
    }),
    selectRow({
      customId: 'settings:reasoning',
      placeholder: 'How hard should I think?',
      options: REASONING_MODES.map((item) => ({ ...item, default: item.value === reasoning })),
    }),
    selectRow({
      customId: 'settings:privacy',
      placeholder: 'Who sees /ask answers?',
      options: [
        { value: 'public', label: 'Public', default: !meta.privateDefault },
        { value: 'private', label: 'Private', default: meta.privateDefault === true },
      ],
    }),
    selectRow({
      customId: 'settings:thread',
      placeholder: 'Answer /ask in a thread?',
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
export function catchupPanel(hours, count, text) {
  return v2Panel({
    icon: '📰',
    title: 'Catch-up',
    subtitle: `last ${hours} hour${hours === 1 ? '' : 's'}`,
    body: String(text ?? '').trim() || 'Nothing to summarize.',
    footer: `${count} message${count === 1 ? '' : 's'} survived the scroll`,
    ephemeral: true,
  });
}
