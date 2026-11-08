/**
 * Read text-like attachments (markdown, plain text, code, CSV, JSON...) so a mentioned file
 * reaches the model as context instead of a bare "[attachment]" note. Images stay on the
 * vision path; PDFs and other binaries are ignored.
 */

const TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'md', 'markdown', 'mdx', 'json', 'jsonl', 'ndjson', 'csv', 'tsv',
  'log', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'xml',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'php', 'go', 'rs', 'java', 'kt', 'kts',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'swift', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat',
  'sql', 'css', 'scss', 'sass', 'less', 'vue', 'svelte',
]);

const TEXT_TYPES = ['json', 'xml', 'javascript', 'yaml', 'csv', 'toml', 'markdown'];

export const MAX_TEXT_FILES = 3;
export const MAX_TEXT_CHARS = 16_000;
export const MAX_TEXT_CHARS_PER_FILE = 8_000;
export const MAX_TEXT_BYTES = 1_000_000;

/**
 * @param {any} attachment discord.js Attachment-like
 * @returns {boolean}
 */
export function isTextAttachment(attachment) {
  const name = String(attachment?.name ?? attachment?.url ?? '');
  const extension = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  // HTML is markup noise; read_url is the right path for those.
  if (extension === 'html' || extension === 'htm') return false;
  if (TEXT_EXTENSIONS.has(extension)) return true;
  const type = String(attachment?.contentType ?? '').toLowerCase();
  if (!type || type.startsWith('image/')) return false;
  if (type.startsWith('text/')) return !type.startsWith('text/html');
  return TEXT_TYPES.some((token) => type.includes(token));
}

/**
 * Flatten line endings and cut a file to the per-file budget, marking the cut.
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
export function clipAttachmentText(text, limit = MAX_TEXT_CHARS_PER_FILE) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit))}\n[file truncated]`;
}

/**
 * Download and format readable text attachments. Messages are passed current-first so the
 * file the user just uploaded wins the shared budget.
 * @param {any[]} messages
 * @param {{readText?: (url: string) => Promise<{ok?: boolean, text?: string}|null>, logger?: import('../../core/logger.js').Logger}} [options]
 * @returns {Promise<string>}
 */
export async function collectTextAttachments(messages, options = {}) {
  const readText = options.readText;
  if (typeof readText !== 'function') return '';
  const blocks = [];
  let used = 0;
  let files = 0;
  for (const message of messages) {
    const attachments = [...(message?.attachments?.values?.() ?? [])];
    for (const attachment of attachments) {
      if (files >= MAX_TEXT_FILES || used >= MAX_TEXT_CHARS) break;
      if (!isTextAttachment(attachment)) continue;
      const size = Number(attachment?.size ?? 0);
      if (Number.isFinite(size) && size > MAX_TEXT_BYTES) {
        options.logger?.debug('discord text attachment skipped (too large)', {
          name: attachment?.name,
          size,
        });
        continue;
      }
      files += 1;
      /** @type {{ok?: boolean, text?: string}|null} */
      let result = null;
      try {
        result = await readText(String(attachment?.url ?? ''));
      } catch (error) {
        options.logger?.debug('discord text attachment download failed', {
          name: attachment?.name,
          error: String(/** @type {any} */ (error)?.message ?? error),
        });
        continue;
      }
      if (!result?.ok || !result.text) continue;
      const limit = Math.min(MAX_TEXT_CHARS_PER_FILE, MAX_TEXT_CHARS - used);
      const body = clipAttachmentText(result.text, limit);
      if (!body) continue;
      blocks.push(`[file: ${String(attachment?.name ?? 'attachment')}]\n${body}`);
      used += body.length;
    }
  }
  return blocks.join('\n\n');
}
