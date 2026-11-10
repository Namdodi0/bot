import { MESSAGE_KIND } from './record.js';
import { truncate, wellFormed } from '../text/format.js';
import { estimateMessageTokens, estimateTextTokens } from './token-meter.js';

/**
 * Build a request from a record.
 *
 * Invariant "model-visible means logged": every message/tool/summary sent to the
 * model lives in the record; the system prompt, tool schema and runtime context are
 * pure functions of config + record, so they can always be rebuilt from stored data.
 */

const DEFAULT_MAX_MESSAGE_CHARS = 12_000;

/**
 * @param {string} text
 * @param {number} limit 0 = no clipping
 */
function clip(text, limit) {
  const value = wellFormed(text);
  if (!limit || limit <= 0 || value.length <= limit) return value;
  return truncate(value, limit);
}

/**
 * @param {import('./store.js').StoredMessage} message
 * @param {number} maxChars
 */
function toNimMessage(message, maxChars = DEFAULT_MAX_MESSAGE_CHARS) {
  const kind = message.kind ?? MESSAGE_KIND.TURN;
  const text = clip(message.text, maxChars);

  if (kind === MESSAGE_KIND.SUMMARY || kind === MESSAGE_KIND.CONTEXT) {
    return { role: 'user', content: text };
  }

  if (kind === MESSAGE_KIND.TOOL_CALL) {
    return {
      role: 'assistant',
      content: text || null,
      tool_calls: (message.toolCalls ?? []).map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: wellFormed(call.rawArguments || JSON.stringify(call.arguments ?? {})),
        },
      })),
    };
  }

  if (kind === MESSAGE_KIND.TOOL_RESULT) {
    return { role: 'tool', tool_call_id: message.toolCallId, content: text };
  }

  if (message.role === 'assistant') {
    return { role: 'assistant', content: text };
  }

  return { role: 'user', content: text };
}

/**
 * Drop an assistant tool-call message unless every one of its calls is answered by the
 * tool results immediately following it. A partial pair is invalid on the wire, so the
 * call and its partial results are removed together.
 * @param {import('./store.js').StoredMessage[]} messages
 */
function repairToolPairs(messages) {
  /** @type {import('./store.js').StoredMessage[]} */
  const out = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if ((message.kind ?? MESSAGE_KIND.TURN) !== MESSAGE_KIND.TOOL_CALL) {
      out.push(message);
      continue;
    }
    const ids = (message.toolCalls ?? []).map((call) => call.id);
    /** @type {import('./store.js').StoredMessage[]} */
    const results = [];
    let cursor = index + 1;
    while (cursor < messages.length && (messages[cursor].kind ?? MESSAGE_KIND.TURN) === MESSAGE_KIND.TOOL_RESULT) {
      results.push(messages[cursor]);
      cursor += 1;
    }
    const answered = new Set(results.map((result) => result.toolCallId));
    if (ids.every((id) => answered.has(id))) out.push(message, ...results);
    index = cursor - 1;
  }
  return out;
}

/**
 * @param {{systemPrompt: string, tools?: any[], record: any, maxTokens?: number, maxMessages?: number, maxCharsPerMessage?: number, contextWindow?: number, meter?: any}} input
 */
export function assembleRequest(input) {
  const systemPrompt = input.systemPrompt ?? '';
  const tools = input.tools ?? [];
  const record = input.record;
  const all = record?.messages ?? [];
  const calibrate = input.meter?.calibrator?.estimate ?? ((raw) => raw);
  const maxChars = input.maxCharsPerMessage ?? DEFAULT_MAX_MESSAGE_CHARS;
  const budget = input.maxTokens > 0 ? input.maxTokens : Number.POSITIVE_INFINITY;
  const messageCap = input.maxMessages > 0 ? input.maxMessages : Number.POSITIVE_INFINITY;

  const systemCost = estimateMessageTokens({ text: systemPrompt });
  // The tool schema travels with every request too; charging it here keeps the budget honest.
  const toolCost = tools.length
    ? typeof input.meter?.tools === 'function'
      ? input.meter.tools(tools)
      : estimateTextTokens(JSON.stringify(tools))
    : 0;
  let used = calibrate(systemCost + toolCost);
  let rawUsed = systemCost + toolCost;
  /** @type {number[]} */
  const keptIndexes = [];
  let dropped = 0;

  for (let index = all.length - 1; index >= 0; index -= 1) {
    const message = all[index];
    // Summary is compressed memory: always keep it, and cut everything older than it.
    if ((message.kind ?? MESSAGE_KIND.TURN) === MESSAGE_KIND.SUMMARY) {
      keptIndexes.unshift(index);
      dropped = index;
      break;
    }
    const rawCost = estimateMessageTokens(message);
    const cost = calibrate(rawCost);
    const overCount = keptIndexes.length >= messageCap;
    const overBudget = used + cost > budget && keptIndexes.length >= 4;
    if (overCount || overBudget) {
      dropped = index + 1;
      break;
    }
    keptIndexes.unshift(index);
    used += cost;
    rawUsed += rawCost;
  }

  // Never start with an orphaned tool-result (its tool-call was cut).
  let start = keptIndexes.length ? keptIndexes[0] : all.length;
  while (start < all.length && (all[start].kind ?? '') === MESSAGE_KIND.TOOL_RESULT) {
    start += 1;
    dropped += 1;
  }
  // Summary is the only compressed memory left: keep the newest one even when it
  // falls outside the range just trimmed (every message older than it was dropped).
  let kept = all.slice(start);
  for (let index = start - 1; index >= 0; index -= 1) {
    if ((all[index].kind ?? '') === MESSAGE_KIND.SUMMARY) {
      kept = [all[index], ...kept];
      break;
    }
  }

  /** @type {any[]} */
  const messages = [{ role: 'system', content: systemPrompt }];
  // Trimming can cut a tool result while its call stays: never send an incomplete pair.
  const repaired = repairToolPairs(kept);
  for (const message of repaired) {
    messages.push(toNimMessage(message, maxChars));
  }

  const measured = input.meter
    ? input.meter.request({
        systemPrompt,
        tools,
        messages: repaired,
        contextWindow: input.contextWindow ?? 0,
      })
    : null;

  return {
    messages,
    tools,
    estimatedTokens: measured?.promptTokens ?? calibrate(used),
    // Uncalibrated estimate: the token meter must observe this, never `estimatedTokens`.
    rawEstimatedTokens: measured?.rawPromptTokens ?? rawUsed,
    pressure: measured?.pressure ?? null,
    contextWindow: measured?.contextWindow ?? 0,
    dropped,
    keptMessages: repaired.length,
    needsSummary: dropped >= 6,
  };
}
