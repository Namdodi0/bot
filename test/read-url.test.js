import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeBody, htmlToText, youtubeVideoId } from '../src/core/ai/read-url.js';

test('htmlToText extracts title, text, lists and entities', () => {
  const html = `
    <html><head><title>Docs &amp; Guide</title><style>.x{}</style></head>
    <body><h1>Hello</h1><p>Use &lt;code&gt; &amp; read the docs.</p>
    <ul><li>One</li><li>Two</li></ul>
    <script>alert('no')</script></body></html>`;
  const { title, text } = htmlToText(html, 'text/html; charset=utf-8');
  assert.equal(title, 'Docs & Guide');
  assert.match(text, /Hello/);
  assert.match(text, /Use <code> & read the docs\./);
  assert.match(text, /- One/);
  assert.match(text, /- Two/);
  assert.doesNotMatch(text, /alert|no|\.x/);
});

test('entity decoding refuses surrogate code points', () => {
  const { text } = htmlToText('<p>&#xD800; &#55296; ok</p>', 'text/html');
  assert.match(text, /ok/);
  assert.doesNotMatch(text, /[\uD800-\uDFFF]/);
});

test('htmlToText drops an unclosed block and everything after it', () => {
  for (const tag of ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'object']) {
    const { text } = htmlToText(`<html><body><p>visible before</p><${tag} class="x">LEAKED ${tag} payload`, 'text/html');
    assert.match(text, /visible before/);
    assert.doesNotMatch(text, /LEAKED/);
    assert.doesNotMatch(text, /payload/);
  }
});

test('htmlToText prefers the main/article block and drops site chrome', () => {
  const html = `
    <html><body>
      <nav>Home | Login | Subscribe</nav>
      <main><h1>Real story</h1><p>${'Body sentence. '.repeat(20)}</p></main>
      <aside>Related links</aside>
      <footer>Copyright 2026</footer>
    </body></html>`;
  const { text } = htmlToText(html, 'text/html');
  assert.match(text, /Real story/);
  assert.match(text, /Body sentence\./);
  assert.doesNotMatch(text, /Home \| Login/);
  assert.doesNotMatch(text, /Related links/);
  assert.doesNotMatch(text, /Copyright 2026/);
});

test('htmlToText falls back to og metadata when the body is empty', () => {
  const html = `
    <html><head>
      <meta property="og:title" content="Rendered &amp; Fast">
      <meta name="description" content="A client-rendered page description.">
    </head><body><div id="root"></div></body></html>`;
  const { title, text } = htmlToText(html, 'text/html');
  assert.equal(title, 'Rendered & Fast');
  assert.match(text, /A client-rendered page description\./);
});

test('decodeBody honors the HTTP charset and meta charset', () => {
  // 0xE9 = é in windows-1252, but invalid on its own in UTF-8.
  const legacy = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
  assert.equal(decodeBody(legacy, 'text/html; charset=windows-1252'), 'café');
  const sniffed = Buffer.concat([Buffer.from('<meta charset="windows-1252">caf'), Buffer.from([0xe9])]);
  assert.equal(decodeBody(sniffed, 'text/html'), '<meta charset="windows-1252">café');
  assert.equal(decodeBody(Buffer.from('plain utf8 ✓')), 'plain utf8 ✓');
});
