import { normalizeWhitespace } from '../../core/text/format.js';

const FENCE_RE = /^\s*(?:```|~~~)/;

/**
 * A markdown table delimiter row such as `| --- | :---: |`. Requires a pipe so a plain
 * `---` horizontal rule is not mistaken for a table separator.
 * @param {string} line
 */
function isSeparatorRow(line) {
  if (!line.includes('|')) return false;
  if (!/^[\s|:-]+$/.test(line)) return false;
  return line.includes('-');
}

/**
 * Join the cells of one table row. Pipes are only treated as separators inside a block,
 * so prose such as `a || b` outside a table keeps its pipes.
 * @param {string} line
 */
function rowToText(line) {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);
  return body
    .split('|')
    .map((cell) => cell.trim())
    .filter(Boolean)
    .join(' · ');
}

/**
 * Convert real table blocks (rows adjacent to a delimiter row) and drop the delimiter rows.
 * Fenced code is skipped so pipes inside code samples survive.
 * @param {string} text
 */
function convertTables(text) {
  const lines = text.split('\n');
  /** @type {string[]} */
  const out = [];
  let inFence = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      out.push(line);
      i += 1;
      continue;
    }
    if (inFence || !isSeparatorRow(line)) {
      out.push(line);
      i += 1;
      continue;
    }

    // Rows directly above the delimiter (already emitted) belong to the same table.
    let start = out.length;
    while (start > 0) {
      const previous = out[start - 1];
      if (!previous.includes('|') || isSeparatorRow(previous) || FENCE_RE.test(previous)) break;
      start -= 1;
    }
    const head = out.splice(start);

    // Rows directly below the delimiter close the table.
    /** @type {string[]} */
    const body = [];
    let next = i + 1;
    while (next < lines.length) {
      const row = lines[next];
      if (!row.includes('|') || isSeparatorRow(row) || FENCE_RE.test(row)) break;
      body.push(rowToText(row));
      next += 1;
    }

    out.push(...head.map(rowToText), ...body);
    i = next;
  }

  return out.join('\n');
}

/**
 * Zalo only supports a small markdown subset: convert links/images/tables to plain text.
 * @param {string} text
 */
export function sanitizeZaloMarkdown(text) {
  let out = String(text ?? '');
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_match, alt, url) => (alt ? `${alt} (${url})` : url));
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_match, label, url) => `${label} (${url})`);
  out = convertTables(out);
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