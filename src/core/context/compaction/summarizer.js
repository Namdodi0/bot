import { MESSAGE_KIND, summaryEntry, toolPairingBalanced } from '../record.js';

/**
 * Drop tool entries that cannot be part of a complete pair: a standalone result, or a call
 * whose results are missing/partial (a crash or early save can leave such a block anywhere,
 * not only at the head). Without this, every prefix covering the block is unbalanced and
 * compaction can never move past it. Complete call/result pairs, including one at the head,
 * are preserved.
 * @param {any[]} messages
 * @returns {{messages: any[], changed: boolean}}
 */
function repairToolBlocks(messages) {
  /** @type {any[]} */
  const out = [];
  let changed = false;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const kind = message.kind ?? MESSAGE_KIND.TURN;
    if (kind === MESSAGE_KIND.TOOL_RESULT) {
      changed = true;
      continue;
    }
    if (kind !== MESSAGE_KIND.TOOL_CALL) {
      out.push(message);
      continue;
    }
    const ids = new Set((message.toolCalls ?? []).map((/** @type {any} */ call) => call.id));
    /** @type {any[]} */
    const results = [];
    let cursor = index + 1;
    while (cursor < messages.length && (messages[cursor].kind ?? MESSAGE_KIND.TURN) === MESSAGE_KIND.TOOL_RESULT) {
      results.push(messages[cursor]);
      cursor += 1;
    }
    const answered = new Set(results.map((result) => result.toolCallId));
    const complete = [...ids].every((id) => answered.has(id));
    if (!complete) {
      changed = true;
    } else {
      const paired = results.filter((result) => ids.has(result.toolCallId));
      if (paired.length !== results.length) changed = true;
      out.push(message, ...paired);
    }
    index = cursor - 1;
  }
  return { messages: changed ? out : messages, changed };
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

  // Repair orphan tool entries wherever they sit, so a mid-history crash cannot make
  // every prefix unbalanced forever.
  const repaired = repairToolBlocks(messages);
  if (repaired.changed) {
    messages = repaired.messages;
    record.messages = messages;
  }

  let cut = Math.max(0, messages.length - keepRecent);
  if (cut <= 0) return { changed: false };

  while (cut > 0 && !toolPairingBalanced(messages, 0, cut)) cut -= 1;
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
