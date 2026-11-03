import { MESSAGE_KIND, summaryEntry, toolPairingBalanced } from '../record.js';

/**
 * Remove leading tool entries that cannot be part of a balanced pair (a crash/early save
 * can leave a call with missing results, or a result with no call). Without this, every
 * prefix is unbalanced and compaction can never move past that block.
 * @param {any[]} messages
 */
function dropLeadingOrphanBlock(messages) {
  let start = 0;
  while (start < messages.length) {
    const message = messages[start];
    const kind = message.kind ?? MESSAGE_KIND.TURN;
    if (kind === MESSAGE_KIND.TOOL_RESULT) {
      start += 1;
      continue;
    }
    if (kind !== MESSAGE_KIND.TOOL_CALL) break;
    const ids = (message.toolCalls ?? []).map((/** @type {any} */ call) => call.id);
    const results = new Set();
    let cursor = start + 1;
    while (cursor < messages.length && (messages[cursor].kind ?? MESSAGE_KIND.TURN) === MESSAGE_KIND.TOOL_RESULT) {
      results.add(messages[cursor].toolCallId);
      cursor += 1;
    }
    if (ids.every((/** @type {string} */ id) => results.has(id))) break;
    start = cursor;
  }
  return start ? messages.slice(start) : messages;
}

/**
 * Compress an old range into a SINGLE summary message (user role), replacing exactly
 * that range. The range must have balanced tool-call/tool-result pairs.
 * @param {any} record
 * @param {{keepRecent: number, summaryMaxChars: number, deadline?: number, summarize: (messages: any[], deadline?: number, record?: any) => Promise<string>}} options
 */
export async function summarizeRange(record, options) {
  let messages = record.messages ?? [];
  const keepRecent = Math.max(1, Number(options.keepRecent ?? 8));
  let cut = Math.max(0, messages.length - keepRecent);
  if (cut <= 0) return { changed: false };

  while (cut > 0 && !toolPairingBalanced(messages, 0, cut)) cut -= 1;
  if (cut <= 0) {
    const repaired = dropLeadingOrphanBlock(messages);
    if (repaired.length === messages.length) return { changed: false };
    record.messages = messages = repaired;
    cut = Math.max(0, messages.length - keepRecent);
    while (cut > 0 && !toolPairingBalanced(messages, 0, cut)) cut -= 1;
  }
  if (cut <= 0) return { changed: false };

  // Private turns never belong in shared compressed memory.
  const range = messages.slice(0, cut).filter((message) => !message.private);
  if (!range.some((message) => (message.kind ?? MESSAGE_KIND.TURN) === MESSAGE_KIND.TURN)) {
    return { changed: false };
  }

  const summary = await options.summarize(range, options.deadline, record);
  const text = String(summary ?? '').trim();
  if (!text) return { changed: false };

  const maxChars = Math.max(100, Number(options.summaryMaxChars ?? 1200));
  const clipped = text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text;
  record.messages = [summaryEntry(clipped), ...messages.slice(cut)];
  return { changed: true };
}
