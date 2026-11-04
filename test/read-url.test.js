import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, youtubeVideoId } from '../src/core/ai/read-url.js';

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

test('htmlToText drops an unclosed block and everything after it', () => {
  for (const tag of ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'object']) {
    const { text } = htmlToText(`<html><body><p>visible before</p><${tag} class="x">LEAKED ${tag} payload`, 'text/html');
    assert.match(text, /visible before/);
    assert.doesNotMatch(text, /LEAKED/);
    assert.doesNotMatch(text, /payload/);
  }
});

test('htmlToText leaves plain text untouched', () => {
  const { title, text } = htmlToText('just plain text', 'text/plain');
  assert.equal(title, '');
  assert.equal(text, 'just plain text');
});

test('youtubeVideoId covers watch, short, shorts and embed links', () => {
  assert.equal(youtubeVideoId('https://youtu.be/GGlt8rLwWzQ?si=x'), 'GGlt8rLwWzQ');
  assert.equal(youtubeVideoId('https://www.youtube.com/watch?v=GGlt8rLwWzQ&t=5'), 'GGlt8rLwWzQ');
  assert.equal(youtubeVideoId('https://m.youtube.com/watch?v=GGlt8rLwWzQ'), 'GGlt8rLwWzQ');
  assert.equal(youtubeVideoId('https://youtube.com/shorts/GGlt8rLwWzQ'), 'GGlt8rLwWzQ');
  assert.equal(youtubeVideoId('https://www.youtube.com/embed/GGlt8rLwWzQ'), 'GGlt8rLwWzQ');
  assert.equal(youtubeVideoId('https://example.com/watch?v=GGlt8rLwWzQ'), '');
  assert.equal(youtubeVideoId('not a url'), '');
});
