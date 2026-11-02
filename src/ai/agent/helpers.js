export const DEFAULT_MAX_TOOL_ROUNDS = 3;
export const TOOL_ROUND_WARN = 20;
export const CHUNK_LIMIT = 1900;
export const FALLBACK_RESERVE_RATIO = 0.25;
export const FALLBACK_RESERVE_MAX_MS = 8000;
export const FALLBACK_MIN_MS = 2500;
export const MIN_ATTEMPT_MS = 1500;
export const SLOW_CALL_WARN_MS = 120_000;
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Split the budget of one attempt, always keeping part of the deadline for the fallback.
 * `aiTimeoutMs <= 0` means the provider request has no timeout: no cap and no TTFT guard.
 * @param {{remainingMs: number, attempt: number, maxAttempts: number, streaming: boolean, aiTimeoutMs: number}} input
 */
export function planAttemptBudget(input) {
  const remaining = Math.max(0, input.remainingMs);
  const aiCap = input.aiTimeoutMs > 0 ? input.aiTimeoutMs : Number.POSITIVE_INFINITY;
  const reserveMs = Math.min(FALLBACK_RESERVE_MAX_MS, Math.floor(remaining * FALLBACK_RESERVE_RATIO));
  const primaryMs = Math.max(0, remaining - reserveMs);
  const attemptsLeft = Math.max(1, input.maxAttempts - input.attempt + 1);
  const ttftMs = Number.isFinite(aiCap)
    ? Math.max(4000, Math.min(aiCap, Math.floor(remaining / 2), 9000))
    : 0;

  if (input.streaming) {
    const timeoutMs = Math.min(remaining, Math.max(MIN_ATTEMPT_MS, primaryMs));
    return { reserveMs, primaryMs, timeoutMs, ttftMs };
  }

  const share = Math.max(MIN_ATTEMPT_MS, Math.floor(primaryMs / attemptsLeft));
  const timeoutMs = Math.max(1000, Math.min(aiCap, share, primaryMs));
  return { reserveMs, primaryMs, timeoutMs, ttftMs };
}

/** @param {number} ms */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** AbortSignal.timeout overflows (fires immediately) above 2^31-1 ms. */
/** @param {number} ms */
export function timeoutSignal(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return AbortSignal.timeout(Math.min(value, MAX_TIMER_MS));
}

/**
 * Turn a tool-call transcript into messages a fallback model without tools can read.
 * Tool history is invalid when no `tools` parameter is sent, so tool results become
 * plain user-visible context instead of `role: "tool"` entries.
 * @param {any[]} messages
 */
export function fallbackMessages(messages) {
  /** @type {any[]} */
  const out = [];
  for (const message of messages ?? []) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      if (typeof message.content === 'string' && message.content.trim()) {
        out.push({ role: 'assistant', content: message.content });
      }
      continue;
    }
    if (message?.role === 'tool') {
      const text =
        typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? {});
      out.push({ role: 'user', content: `[tool result]\n${text}` });
      continue;
    }
    out.push(message);
  }
  return out;
}

/**
 * Shorten text for console logs: drop newlines, trim for readability.
 * @param {unknown} text
 * @param {number} [limit]
 */
export function preview(text, limit = 900) {
  const value = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * @param {string} buffer
 * @returns {number} cut position (includes the trailing punctuation/newline of the segment)
 */
export function findBreak(buffer) {
  const positions = [
    buffer.lastIndexOf('\n\n') + 2,
    buffer.lastIndexOf('. ') + 1,
    buffer.lastIndexOf('! ') + 1,
    buffer.lastIndexOf('? ') + 1,
    buffer.lastIndexOf('\n') + 1,
    buffer.lastIndexOf('… ') + 1,
  ]
    .filter((position) => position > 1)
    .sort((a, b) => b - a);

  for (const position of positions) {
    const head = buffer.slice(0, position);
    // Do not cut right after a dangling bullet / list number ("2.", "- ") — ugly when splitting messages.
    if (/(?:^|\n)\s*(?:\d+[.)]|[-*+])\s*$/.test(head)) continue;
    return position;
  }
  return 0;
}

/**
 * Request timeout for a provider (0 = no limit). Uses the provider's own setting so a
 * DeepSeek call is not governed by NIM_TIMEOUT_MS (or vice versa).
 * @param {any} config
 * @param {string} provider
 */
export function providerTimeout(config, provider) {
  const value = Number(config?.[provider]?.timeoutMs ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

const SAMPLING_KEYS = [
  'topP',
  'topK',
  'minP',
  'repetitionPenalty',
  'frequencyPenalty',
  'presencePenalty',
  'seed',
];

/**
 * Sampling parameters configured for a provider. Only non-null values are sent, so an
 * unset parameter leaves the provider default untouched.
 * @param {any} config
 * @param {string} provider
 */
export function samplingFor(config, provider) {
  /** @type {Record<string, number>} */
  const sampling = {};
  for (const key of SAMPLING_KEYS) {
    const value = config?.[provider]?.[key];
    if (value !== undefined && value !== null) sampling[key] = value;
  }
  return sampling;
}

/**
 * @param {any} config
 * @param {any} record
 * @param {string} text
 */
export function effectiveReasoning(config, record, text) {
  const override = record?.meta?.thinking;
  if (override === 'off') return 'none';
  if (override && ['low', 'medium', 'high'].includes(override)) return override;
  const base = config.ai.reasoning;
  if (base !== 'auto') return base;
  const wantsDepth =
    text.length > 200 ||
    /ph\u00e2n t\u00edch|gi\u1ea3i th\u00edch|so s\u00e1nh|t\u1ea1i sao|v\u00ec sao|chi ti\u1ebft|l\u00ean k\u1ebf ho\u1ea1ch|\b(?:analy[sz]e|explain|compare|why|in detail|plan)\b/i.test(
      text,
    );
  return wantsDepth ? 'low' : 'none';
}
