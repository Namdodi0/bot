const TOOL_LABELS = {
  web_search: 'Web search',
  read_url: 'Page read',
  send_image: 'Image search',
  send_sticker: 'Sticker',
  set_reminder: 'Reminder',
};

/** @param {any} event */
function toolLine(event) {
  const query = String(event?.query ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  switch (event?.name) {
    case 'web_search':
      return query ? `🔎 Searching the web: ${query}` : '🔎 Searching the web…';
    case 'read_url':
      return "🌐 Reading the page — it won't read itself…";
    case 'send_image':
      return '🖼️ Hunting for pixels…';
    case 'send_sticker':
      return '🎨 Raiding the sticker drawer…';
    case 'set_reminder':
      return '⏰ Arming a reminder…';
    default:
      return `🛠️ Running ${String(event?.name ?? 'tool')}…`;
  }
}

/** @param {any} event */
function toolResultLine(event) {
  return `${event.ok === false ? '⚠️' : '✅'} ${
    TOOL_LABELS[event.name] ?? String(event.name ?? 'Tool')
  } ${event.ok === false ? 'failed. Pivoting.' : 'done — let me cook.'}`;
}

const MAX_REASONING_CHARS = 800;
const LIVE_REASONING_CHARS = 300;
const LIVE_REASONING_LINES = 3;
const SUMMARY_REASONING_LINES = 12;
const MAX_TOOL_LINES = 6;
const MAX_SUMMARY_CHARS = 1400;
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Newest lines of the reasoning, keeping line breaks so the excerpt stays scannable.
 * A leading … marks a cut (by lines or by characters).
 * @param {string} text
 * @param {number} maxChars
 * @param {number} maxLines
 */
function reasoningTail(text, maxChars, maxLines) {
  const clean = String(text ?? '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!clean || maxChars <= 0) return '';
  let lines = clean.split('\n');
  let truncated = false;
  if (lines.length > maxLines) {
    lines = lines.slice(-maxLines);
    truncated = true;
  }
  let out = lines.join('\n');
  if (out.length > maxChars) {
    out = out.slice(-maxChars);
    truncated = true;
  }
  return truncated ? `…${out}` : out;
}

/**
 * Live status shown above the streaming answer. The same block is kept above the final
 * answer: a spoiler-wrapped reasoning excerpt plus every tool call and its outcome.
 * While no content has arrived yet, a ticker shows elapsed time so the wait is visible.
 * @param {{now?: () => number}} [options]
 */
export function createProgressFeed(options = {}) {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  let mode = 'idle';
  let reasoning = '';
  /** @type {string[]} */
  const toolLines = [];

  /** @param {string} line */
  function addToolLine(line) {
    toolLines.push(String(line).slice(0, 140));
    if (toolLines.length > MAX_TOOL_LINES) {
      toolLines.splice(0, toolLines.length - MAX_TOOL_LINES);
    }
  }

  /** @param {any} event */
  function update(event) {
    switch (event?.type) {
      case 'thinking':
        mode = 'thinking';
        break;
      case 'reasoning':
        mode = 'reasoning';
        reasoning = `${reasoning}${String(event.text ?? '')}`.slice(-8000);
        break;
      case 'tool':
        mode = 'tool';
        addToolLine(toolLine(event));
        break;
      case 'tool-result':
        mode = 'tool';
        addToolLine(toolResultLine(event));
        break;
      case 'finalizing':
        mode = 'finalizing';
        break;
      default:
        break;
    }
  }

  function toolBlock() {
    return toolLines.map((line) => `> ${line}`).join('\n');
  }

  function summary() {
    const tools = toolBlock();
    // Budget the excerpt against the tool lines and the spoiler wrapper so the joined
    // block never exceeds the cap — a cut inside the spoiler would leave an unclosed ||.
    const budget = Math.min(
      MAX_REASONING_CHARS,
      MAX_SUMMARY_CHARS - tools.length - (tools ? 1 : 0) - 8,
    );
    const excerpt = reasoningTail(reasoning, budget, SUMMARY_REASONING_LINES);
    const parts = [];
    if (excerpt) parts.push(`🧠 ||${excerpt}||`);
    if (tools) parts.push(tools);
    return parts.join('\n');
  }

  function text() {
    const tools = toolBlock();
    const excerpt = reasoningTail(reasoning, LIVE_REASONING_CHARS, LIVE_REASONING_LINES);
    const live = excerpt ? `> 🧠 ${excerpt.split('\n').join('\n> ')}` : '';
    const base = [live, tools].filter(Boolean).join('\n');
    if (base) return base;
    const elapsedMs = Math.max(0, now() - startedAt);
    const seconds = Math.floor(elapsedMs / 1000);
    // Rotate once per second so the ticker text changes at most 1/s (one edit/s).
    const frame = SPINNER[seconds % SPINNER.length];
    if (mode === 'thinking') return `> 🧠 Thinking… ${seconds}s ${frame}`;
    if (mode === 'finalizing') return `> ✍️ Writing the answer… ${seconds}s ${frame}`;
    return '';
  }

  return { update, text, summary };
}