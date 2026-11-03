import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText } from '../src/core/ai/read-url.js';

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

test('htmlToText keeps out-of-range numeric entities literal', () => {
  const { text } = htmlToText('<p>&#x110000; &#99999999; ok</p>', 'text/html');
  assert.match(text, /&#x110000;/);
  assert.match(text, /&#99999999;/);
  assert.match(text, /ok/);
});

test('htmlToText leaves plain text untouched', () => {
  const { title, text } = htmlToText('just plain text', 'text/plain');
  assert.equal(title, '');
  assert.equal(text, 'just plain text');
});
