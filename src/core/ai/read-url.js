const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

/** @param {string} value */
function decodeEntities(value) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const key = String(entity).toLowerCase();
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[/** @type {keyof typeof ENTITIES} */ (key)] ?? match;
  });
}

/**
 * Turn a fetched HTML document into readable text for the model. Not a full parser:
 * removes scripts/styles/SVG, keeps block breaks and decodes common entities.
 * @param {string} input
 * @param {string} [contentType]
 * @returns {{title: string, text: string}}
 */
export function htmlToText(input, contentType = '') {
  const raw = String(input ?? '');
  if (!/html|xml/i.test(contentType) && !/<(?:html|body|p|div|h[1-6])\b/i.test(raw)) {
    return { title: '', text: raw.replace(/\r\n?/g, '\n').trim() };
  }
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].replace(/<[^>]+>/g, '')).trim() : '';
  let text = raw
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|object)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    // An unclosed block means the rest of the document is untrusted script/markup: drop it.
    .replace(/<(script|style|noscript|svg|template|iframe|object)\b[^>]*>[\s\S]*$/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}
