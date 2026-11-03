import { normalizeWhitespace } from '../../core/text/format.js';

/**
 * Zalo only supports a small markdown subset: convert links/images/tables to plain text.
 * @param {string} text
 */
export function sanitizeZaloMarkdown(text) {
  let out = String(text ?? '');
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_match, alt, url) => (alt ? `${alt} (${url})` : url));
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_match, label, url) => `${label} (${url})`);
  out = out
    .split('\n')
    .filter((line) => {
      const isTable = line.includes('|');
      if (!isTable) return true;
      return !/^\s*\|?[\s|:\-]*-{2,}[\s|:\-]*\|?\s*$/.test(line);
    })
    .map((line) => {
      if (!line.includes('|')) return line;
      if (!/^\s*\|.*\|\s*$/.test(line) && (line.match(/\|/g) ?? []).length < 2) return line;
      return line
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(' · ');
    })
    .join('\n');
  out = out.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '———');
  return normalizeWhitespace(out);
}

/**
 * Prepare the final text to send to Zalo.
 * @param {string} text
 * @param {{parseMode?: 'markdown'|'none'}} [options]
 */
export function prepareOutgoing(text, options = {}) {
  let out = normalizeWhitespace(String(text ?? ''));
  if (options.parseMode !== 'none') out = sanitizeZaloMarkdown(out);
  return out;
}