import { SUMMARY_SYSTEM_PROMPT } from '../ai/prompt/index.js';

const SUMMARY_DEFAULT_COUNT = 30;
const SUMMARY_MAX_COUNT = 200;
const SUMMARY_MAX_TRANSCRIPT = 12_000;
const SUMMARY_TIMEOUT_MS = 15_000;

/**
 * Keep the newest whole lines within the character cap; summaries must not silently
 * drop the most recent part of a busy channel.
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
 * Shared chat settings/context operations used by the native Discord commands. Keeping
 * model selection, reset, compaction and summarisation in one place keeps the handlers
 * consistent.
 * @param {{config: any, store: any, models: any, compaction: any}} deps
 */
export function createChatServices({ config, store, models, compaction }) {
  /** @param {string} chatId @param {string} chatType */
  function getRecord(chatId, chatType) {
    return store.get(chatId, { chatType });
  }

  /** @param {any} record */
  function currentModel(record) {
    return models.resolve(record);
  }

  /**
   * The vision model this chat uses for image turns: the per-chat override when it still
   * resolves to a vision-capable alias, else the configured default.
   * @param {any} record
   */
  function currentVisionModel(record) {
    const wanted = record?.meta?.visionModel;
    const picked = wanted ? models.find(wanted) : null;
    if (picked?.vision) return picked;
    return models.find(config.model?.visionAlias ?? 'nim');
  }

  function listModels() {
    return models.list();
  }

  function listVisionModels() {
    return models.list().filter((item) => item.vision === true);
  }

  /** @param {string} value */
  function findModel(value) {
    return models.find(value);
  }

  /** @param {string} chatId @param {string} value @param {string} [chatType] @param {any} [record] */
  async function setModel(chatId, value, chatType = 'GROUP', record = null) {
    const picked = models.find(value);
    if (!picked) return { ok: false, reason: 'unknown' };
    const target = record ?? (await getRecord(chatId, chatType));
    if (!target.meta) target.meta = { thinking: null };
    target.meta.model = picked.alias;
    store.touch?.(chatId);
    return { ok: true, model: picked };
  }

  /**
   * Set or clear (`default`) the per-chat vision model. Text-only aliases are rejected:
   * image turns would otherwise fall back to a model that cannot see the image.
   * @param {string} chatId @param {string} value @param {string} [chatType] @param {any} [record]
   */
  async function setVisionModel(chatId, value, chatType = 'GROUP', record = null) {
    const target = record ?? (await getRecord(chatId, chatType));
    if (!target.meta) target.meta = { thinking: null };
    const needle = String(value ?? '').trim();
    if (!needle || needle === 'default' || needle === '__default') {
      delete target.meta.visionModel;
      store.touch?.(chatId);
      return { ok: true, model: currentVisionModel(target) };
    }
    const picked = models.find(needle);
    if (!picked?.vision) return { ok: false, reason: 'not-vision' };
    target.meta.visionModel = picked.alias;
    store.touch?.(chatId);
    return { ok: true, model: picked };
  }

  /** @param {string} chatId @param {{all?: boolean}} [options] */
  async function reset(chatId, options = {}) {
    await store.reset(chatId, { keepMeta: options.all !== true });
  }

  /** @param {string} chatId @param {string} [chatType] @param {any} [record] */
  async function compact(chatId, chatType = 'GROUP', record = null) {
    const target = record ?? (await getRecord(chatId, chatType));
    const result = await compaction.compactIfNeeded({ record: target, trigger: 'manual' });
    if (result?.changed) store.touch?.(chatId);
    return result;
  }

  /**
   * Summarize an arbitrary transcript through the configured model.
   * @param {string} transcript
   * @param {{onDelta?: (delta: string) => void, record?: any}} [options]
   * @returns {Promise<{ok: true, text: string}|{ok: false, reason: 'empty'}>}
   */
  async function summarizeText(transcript, options = {}) {
    const timeoutMs =
      config.responseTimeoutMs > 0
        ? Math.max(1500, Math.min(SUMMARY_TIMEOUT_MS, config.responseTimeoutMs - 300))
        : 0;
    const onDelta = options.onDelta;
    const response = await models.chat({
      ...(options.record ? { record: options.record } : {}),
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: String(transcript ?? '').slice(-SUMMARY_MAX_TRANSCRIPT) },
      ],
      reasoning: 'none',
      temperature: 0.3,
      maxTokens: 300,
      stream: typeof onDelta === 'function',
      ...(onDelta ? { onDelta } : {}),
      timeoutMs,
      ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    const text = String(response?.content ?? '').trim();
    return text ? { ok: true, text } : { ok: false, reason: 'empty' };
  }

  /**
   * @param {string} chatId
   * @param {string} [chatType]
   * @param {number} [count]
   * @param {any} [record]
   * @param {{onDelta?: (delta: string) => void}} [options]
   * @returns {Promise<{ok: true, count: number, text: string}|{ok: false, reason: 'not-enough'|'empty'}>}
   */
  async function summarize(chatId, chatType = 'GROUP', count = SUMMARY_DEFAULT_COUNT, record = null, options = {}) {
    const target = record ?? (await getRecord(chatId, chatType));
    const limit = Number.isInteger(count) ? Math.min(SUMMARY_MAX_COUNT, Math.max(2, count)) : SUMMARY_DEFAULT_COUNT;
    const history = (target.messages ?? [])
      .filter(
        (message) =>
          (message.kind ?? 'turn') === 'turn' &&
          !message.private &&
          String(message.text ?? '').trim(),
      )
      .slice(-limit);
    if (history.length < 2) return { ok: false, reason: 'not-enough' };

    const lines = history.map(
      (message) =>
        `${message.role === 'assistant' ? 'Bot' : message.name || 'User'}: ${String(message.text).trim()}`,
    );
    const transcript = tailTranscript(lines, SUMMARY_MAX_TRANSCRIPT);
    const result = await summarizeText(transcript.text, { record: target, ...options });
    if (!result.ok) return { ok: false, reason: /** @type {any} */ (result).reason };
    return { ok: true, count: transcript.count, text: result.text };
  }

  /**
   * Keep the group sender prefix and a stored "[Replying to ...]" quote when the body changes.
   * @param {any} entry
   * @param {string} text
   * @param {boolean} isGroup
   * @param {string} name
   */
  function editedTurnText(entry, text, isGroup, name) {
    const oldPrefix = entry.name ? `${entry.name}: ` : '';
    const body = String(entry.text ?? '').startsWith(oldPrefix)
      ? String(entry.text).slice(oldPrefix.length)
      : String(entry.text ?? '');
    const quote = body.match(/^(\[Replying to [^\n]*\])\n/)?.[1] ?? '';
    const prefix = isGroup && name ? `${name}: ` : '';
    return `${prefix}${quote ? `${quote}\n` : ''}${text}`;
  }

  /**
   * Update the stored text of a user turn by its platform message id.
   * The caller must serialize this with turns (agent.exclusive).
   * @param {string} chatId
   * @param {{messageId: string, text: string, senderName?: string, chatType?: string}} input
   */
  async function editTurn(chatId, input) {
    const messageId = String(input?.messageId ?? '');
    const text = String(input?.text ?? '').trim();
    if (!messageId || !text) return { ok: false, reason: 'invalid' };
    if (typeof store.exists === 'function' && !(await store.exists(chatId))) {
      return { ok: false, reason: 'missing' };
    }
    const record = await store.get(chatId, input.chatType ? { chatType: input.chatType } : {});
    const entry = (record.messages ?? []).find(
      (message) => message.role === 'user' && (message.kind ?? 'turn') === 'turn' && message.messageId === messageId,
    );
    if (!entry) return { ok: false, reason: 'missing' };
    const name = String(input.senderName ?? entry.name ?? '');
    const isGroup = String(input.chatType ?? record.chatType ?? 'GROUP') !== 'PRIVATE';
    if (name) entry.name = name;
    entry.text = editedTurnText(entry, text, isGroup, name);
    store.touch?.(chatId);
    return { ok: true };
  }

  /**
   * Remove user turns by platform message id (assistant/tool entries are kept).
   * The caller must serialize this with turns (agent.exclusive).
   * @param {string} chatId
   * @param {string[]} messageIds
   */
  async function deleteTurns(chatId, messageIds) {
    const ids = new Set((messageIds ?? []).map(String).filter(Boolean));
    if (!ids.size) return { ok: false, reason: 'invalid', removed: 0 };
    if (typeof store.exists === 'function' && !(await store.exists(chatId))) {
      return { ok: false, reason: 'missing', removed: 0 };
    }
    const record = await store.get(chatId);
    const before = record.messages?.length ?? 0;
    record.messages = (record.messages ?? []).filter(
      (message) =>
        !(
          message.role === 'user' &&
          (message.kind ?? 'turn') === 'turn' &&
          ids.has(String(message.messageId ?? ''))
        ),
    );
    const removed = before - record.messages.length;
    if (removed) store.touch?.(chatId);
    return { ok: removed > 0, removed };
  }

  return {
    getRecord,
    currentModel,
    currentVisionModel,
    listModels,
    listVisionModels,
    findModel,
    setModel,
    setVisionModel,
    reset,
    compact,
    summarize,
    summarizeText,
    editTurn,
    deleteTurns,
  };
}
