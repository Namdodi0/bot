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
const MAX_TOOL_LINES = 6;
const MAX_SUMMARY_CHARS = 1400;

/**
 * Live status shown above the streaming answer. The same block is kept above the final
 * answer: reasoning excerpt plus every tool call and its outcome.
 */
export function createProgressFeed() {
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
        reasoning = `${reasoning}${String(event.text ?? '')}`.replace(/\s+/g, ' ').slice(-8000);
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

  function summary() {
    /** @type {string[]} */
    const lines = [];
    if (reasoning) lines.push(`> 🧠 ${reasoning.slice(-MAX_REASONING_CHARS)}`);
    for (const line of toolLines) lines.push(`> ${line}`);
    return lines.join('\n').slice(0, MAX_SUMMARY_CHARS);
  }

  function text() {
    const base = summary();
    if (base) return base;
    if (mode === 'thinking') return '> 🧠 Thinking…';
    if (mode === 'finalizing') return '> ✍️ Writing the answer…';
    return '';
  }

  return { update, text, summary };
}
