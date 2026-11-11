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
  // Surrogate code points are not valid characters: decoding one would poison every
  // later provider request with an unpaired surrogate.
  const valid = (code) => Number.isInteger(code) && code >= 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const key = String(entity).toLowerCase();
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16);
      return valid(code) ? String.fromCodePoint(code) : match;
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10);
      return valid(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[/** @type {keyof typeof ENTITIES} */ (key)] ?? match;
  });
}

/**
 * Extract the video id from common YouTube URL forms, else an empty string.
 * @param {string} url
 */
export function youtubeVideoId(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ''));
  } catch {
    return '';
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const valid = (value) => (/^[A-Za-z0-9_-]{6,}$/.test(value) ? value : '');
  if (host === 'youtu.be') return valid(parsed.pathname.replace(/^\//, '').split('/')[0]);
  if (['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
    const fromQuery = valid(parsed.searchParams.get('v') ?? '');
    if (fromQuery) return fromQuery;
    const match = parsed.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{6,})/);
    return match ? match[1] : '';
  }
  return '';
}

/**
 * Decode a fetched page with the charset from the HTTP header or a `<meta charset>` tag,
 * honoring BOMs and falling back to UTF-8. Without this, windows-1252/legacy pages turn
 * into mojibake before the model ever sees them.
 * @param {Buffer|string} input
 * @param {string} [contentType]
 * @returns {string}
 */
export function decodeBody(input, contentType = '') {
  if (typeof input === 'string') return input.replace(/^\uFEFF/, '');
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input ?? '');
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    try {
      return new TextDecoder('utf-16le').decode(buffer.subarray(2));
    } catch {
      // fall through to the charset logic below
    }
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    try {
      return new TextDecoder('utf-16be').decode(buffer.subarray(2));
    } catch {
      // fall through to the charset logic below
    }
  }
  const fromHeader = /charset\s*=\s*["']?([\w.:+-]+)/i.exec(String(contentType))?.[1] ?? '';
  let label = fromHeader;
  if (!label) {
    // Meta tags sit at the top; sniff only that prefix so the full document stays untouched.
    const head = buffer.subarray(0, 4096).toString('latin1');
    label = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:+-]+)/i.exec(head)?.[1] ?? '';
  }
  try {
    return new TextDecoder((label || 'utf-8').trim().toLowerCase()).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

/**
 * Read `<meta>` tags once and index them by name/property. Description and og:title are the
 * only reliable content on script-rendered pages, where the body itself is nearly empty.
 * @param {string} raw
 * @returns {Record<string, string>}
 */
function metaTags(raw) {
  /** @type {Record<string, string>} */
  const map = {};
  for (const match of raw.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const key = /\b(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? '';
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
    if (key && content) map[key.trim().toLowerCase()] = decodeEntities(content).trim();
  }
  return map;
}

/** @param {string} html */
function bodyContent(html) {
  const match = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html);
  return match ? match[1] : html;
}

/**
 * Extract the inner HTML of a div that starts at `start`, using a small balanced-div scan.
 * @param {string} html
 * @param {number} start
 */
function divInner(html, start) {
  const openEnd = html.indexOf('>', start);
  if (openEnd < 0) return '';
  const tags = /<div\b[^>]*>|<\/div\s*>/gi;
  tags.lastIndex = openEnd + 1;
  let depth = 1;
  let match;
  while ((match = tags.exec(html))) {
    if (match[0][1] === '/') {
      depth -= 1;
      if (depth === 0) return html.slice(openEnd + 1, match.index);
    } else {
      depth += 1;
    }
  }
  return '';
}

/**
 * Common article-body containers (MediaWiki, news CMSs, blog themes). When one exists it is
 * far more precise than `<main>`, which often also wraps language menus and page tools.
 */
const CONTENT_MARKER =
  /\bid\s*=\s*["'][^"']*\b(?:mw-content-text|article-body|article-content|story-body|entry-content|post-content|markdown-body|content-body|post-body)\b[^"']*["']|\bclass\s*=\s*["'][^"']*\b(?:mw-parser-output|article-body|article__body|article-content|story-body|entry-content|post-content|markdown-body|content-body|post-body)\b[^"']*["']/i;

/** @param {string} html */
function plainText(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Rank a candidate block by readable prose, discounting link text: navigation, language
 * lists and tag clouds are mostly anchors, while an article body is mostly prose.
 * @param {string} html
 */
function contentScore(html) {
  const plain = plainText(html);
  if (!plain) return 0;
  const links = [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((match) => match[1]).join(' ');
  const linkRatio = Math.min(1, plainText(links).length / plain.length);
  return plain.length * (1 - linkRatio * 0.85);
}

/**
 * Collect article-body containers plus `<main>`/`<article>` blocks, then pick the block with
 * the most prose. `<main>` alone is unreliable: MediaWiki and some CMSs put menus inside it.
 * @param {string} html
 */
function mainContent(html) {
  /** @type {Array<{html: string, kind: string}>} */
  const candidates = [];
  const divs = /<div\b[^>]*>/gi;
  let match;
  while ((match = divs.exec(html))) {
    if (CONTENT_MARKER.test(match[0])) candidates.push({ html: divInner(html, match.index), kind: 'container' });
  }
  let articleCount = 0;
  for (const tag of ['main', 'article']) {
    const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi');
    for (const block of html.matchAll(pattern)) {
      if (tag === 'article') articleCount += 1;
      candidates.push({ html: block[1], kind: tag });
    }
  }
  let best = '';
  let bestKind = '';
  let bestScore = 0;
  for (const candidate of candidates) {
    if (plainText(candidate.html).length < 200) continue;
    const score = contentScore(candidate.html);
    if (score > bestScore) {
      best = candidate.html;
      bestKind = candidate.kind;
      bestScore = score;
    }
  }
  // A listing page (many teaser articles) would otherwise reduce to one story; return the
  // whole body so every headline and blurb survives.
  if (best && bestKind === 'article' && articleCount >= 4) {
    const bodyLength = plainText(html).length;
    if (bodyLength > 0 && plainText(best).length < bodyLength * 0.3) return html;
  }
  return best || html;
}

const BOILERPLATE = /<(nav|aside|footer|form|dialog|button|select|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const HIDDEN = /<(script|style|noscript|svg|template|iframe|object|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const HIDDEN_UNCLOSED = /<(script|style|noscript|svg|template|iframe|object|head)\b[^>]*>[\s\S]*$/gi;

/**
 * Drop long, nearly all-link lists (language pickers, tag clouds, nav menus) while keeping
 * short or prose-heavy lists. These live inside `<main>` on MediaWiki and some CMS themes.
 * @param {string} html
 */
function dropLinkLists(html) {
  return html.replace(/<(ul|ol)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (block) => {
    const items = (block.match(/<li\b/gi) ?? []).length;
    if (items < 20) return block;
    const links = (block.match(/<a\b/gi) ?? []).length;
    return links >= items * 0.8 ? ' ' : block;
  });
}

/**
 * Turn a fetched HTML document into readable text for the model. Not a full parser: prefers
 * the main/article block, removes chrome and scripts, keeps headings/lists/tables and
 * decodes common entities.
 * @param {string} input
 * @param {string} [contentType]
 * @returns {{title: string, text: string, description: string}}
 */
export function htmlToText(input, contentType = '') {
  const raw = String(input ?? '');
  if (!/html|xml/i.test(contentType) && !/<(?:html|body|p|div|h[1-6])\b/i.test(raw)) {
    return { title: '', text: raw.replace(/\r\n?/g, '\n').trim(), description: '' };
  }
  const meta = metaTags(raw);
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = (titleMatch ? decodeEntities(titleMatch[1].replace(/<[^>]+>/g, '')).trim() : '') ||
    meta['og:title'] ||
    meta['twitter:title'] ||
    '';
  const description = meta.description || meta['og:description'] || '';

  const selected = mainContent(bodyContent(raw));
  let text = dropLinkLists(selected)
    // MediaWiki keeps template JSON in attributes; it can contain ">" and leak into the text.
    .replace(/\s(?:data-mw|data-parsoid)(?:-[\w-]+)?\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(HIDDEN, ' ')
    // An unclosed hidden block means the rest of the document is untrusted script/markup: drop it.
    .replace(HIDDEN_UNCLOSED, ' ')
    .replace(BOILERPLATE, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<h([1-6])[^>]*>/gi, (_match, level) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // Nothing readable in the body: the meta description is still useful for JS-only pages.
  if (text.length < 160 && description) {
    text = text ? `${text}\n\n${description}` : description;
  }
  return { title, text, description };
}