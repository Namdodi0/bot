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

/**
 * Live status shown above the streaming answer; it disappears when the final answer
 * replaces the preview. Reasoning is clipped to the newest 600 characters.
 */
export function createProgressFeed() {
  let mode = 'idle';
  let reasoning = '';
  let tool = '';

  /** @param {any} event */
  function update(event) {
    switch (event?.type) {
      case 'thinking':
        mode = 'thinking';
        reasoning = '';
        tool = '';
        break;
      case 'reasoning':
        mode = 'reasoning';
        reasoning = `${reasoning}${String(event.text ?? '')}`.replace(/\s+/g, ' ').slice(-600);
        break;
      case 'tool':
        mode = 'tool';
        reasoning = '';
        tool = toolLine(event);
        break;
      case 'tool-result':
        mode = 'tool';
        tool = `${
          event.ok === false ? '⚠️' : '✅'
        } ${TOOL_LABELS[event.name] ?? String(event.name ?? 'Tool')} ${event.ok === false ? 'failed. Pivoting.' : 'done — let me cook.'}`;
        break;
      case 'finalizing':
        mode = 'finalizing';
        reasoning = '';
        tool = '';
        break;
      default:
        break;
    }
  }

  function text() {
    if (mode === 'tool' && tool) return `> ${tool}`;
    if (mode === 'reasoning' && reasoning) return `> 🧠 ${reasoning}`;
    if (mode === 'thinking') return '> 🧠 Thinking…';
    if (mode === 'finalizing') return '> ✍️ Writing the answer…';
    return '';
  }

  return { update, text };
}
