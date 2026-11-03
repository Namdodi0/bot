import { REMINDER_LIMITS, parseReminderArgs } from '../ai/reminders.js';

/**
 * Shared reminder operations. Both command layers map the returned reasons to their own
 * wording; the validation, limits and parsing live here.
 * @param {{reminders: any}} deps
 */
export function createReminderService({ reminders }) {
  function available() {
    return Boolean(reminders);
  }

  /** @param {string} chatId */
  function list(chatId) {
    return reminders ? reminders.list(chatId) : [];
  }

  /** @param {string} chatId @param {string|number} id */
  async function cancel(chatId, id) {
    return reminders ? reminders.remove(chatId, id) : null;
  }

  /**
   * @param {string} chatId
   * @param {number} at
   * @param {string} text
   * @param {string} [createdBy]
   */
  async function addAt(chatId, at, text, createdBy = '') {
    if (!reminders) return { ok: false, reason: 'not-configured' };
    const content = String(text ?? '').trim();
    if (!Number.isFinite(at) || !content) return { ok: false, reason: 'invalid' };
    if (content.length > REMINDER_LIMITS.MAX_REMINDER_CHARS) return { ok: false, reason: 'too-long' };
    const result = await reminders.add({ chatId, text: content, at, createdBy });
    if (result.ok) return { ok: true, item: result.item };
    return { ok: false, reason: /** @type {any} */ (result).reason };
  }

  /**
   * @param {string} chatId
   * @param {string} when
   * @param {string} text
   * @param {string} [createdBy]
   */
  async function add(chatId, when, text, createdBy = '') {
    const parsed = parseReminderArgs(`${String(when ?? '').trim()} x`);
    if (parsed.error || !Number.isFinite(parsed.at)) {
      return { ok: false, reason: 'invalid-time', message: parsed.error ?? 'Invalid reminder time.' };
    }
    return addAt(chatId, /** @type {number} */ (parsed.at), text, createdBy);
  }

  return { available, list, cancel, add, addAt, limits: REMINDER_LIMITS };
}
