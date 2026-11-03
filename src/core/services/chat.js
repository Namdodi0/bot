import { SUMMARY_SYSTEM_PROMPT } from '../ai/prompt/index.js';

const SUMMARY_DEFAULT_COUNT = 30;
const SUMMARY_MAX_COUNT = 200;
const SUMMARY_MAX_TRANSCRIPT = 12_000;
const SUMMARY_TIMEOUT_MS = 15_000;

/**
 * Shared chat settings/context operations used by both the Zalo text commands and the
 * native Discord commands. Keeping this in one place prevents the two command layers from
 * drifting on model selection, reset, compaction and summarisation.
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

  function listModels() {
    return models.list();
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
   * @returns {Promise<{ok: true, text: string}|{ok: false, reason: 'empty'}>}
   */
  async function summarizeText(transcript) {
    const timeoutMs =
      config.responseTimeoutMs > 0
        ? Math.max(1500, Math.min(SUMMARY_TIMEOUT_MS, config.responseTimeoutMs - 300))
        : 0;
    const response = await models.chat({
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: String(transcript ?? '').slice(0, SUMMARY_MAX_TRANSCRIPT) },
      ],
      reasoning: 'none',
      temperature: 0.3,
      maxTokens: 300,
      stream: false,
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
   * @returns {Promise<{ok: true, count: number, text: string}|{ok: false, reason: 'not-enough'|'empty'}>}
   */
  async function summarize(chatId, chatType = 'GROUP', count = SUMMARY_DEFAULT_COUNT, record = null) {
    const target = record ?? (await getRecord(chatId, chatType));
    const limit = Number.isInteger(count) ? Math.min(SUMMARY_MAX_COUNT, Math.max(2, count)) : SUMMARY_DEFAULT_COUNT;
    const history = (target.messages ?? [])
      .filter((message) => (message.kind ?? 'turn') === 'turn' && String(message.text ?? '').trim())
      .slice(-limit);
    if (history.length < 2) return { ok: false, reason: 'not-enough' };

    const transcript = history
      .map((message) => `${message.role === 'assistant' ? 'Bot' : message.name || 'User'}: ${String(message.text).trim()}`)
      .join('\n')
      .slice(0, SUMMARY_MAX_TRANSCRIPT);
    const result = await summarizeText(transcript);
    if (!result.ok) return { ok: false, reason: /** @type {any} */ (result).reason };
    return { ok: true, count: history.length, text: result.text };
  }

  return {
    getRecord,
    currentModel,
    listModels,
    findModel,
    setModel,
    reset,
    compact,
    summarize,
    summarizeText,
  };
}
