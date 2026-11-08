import test from 'node:test';
import assert from 'node:assert/strict';
import { collectTextAttachments, isTextAttachment } from '../src/platforms/discord/attachments.js';

/** @param {any[]} attachments */
function fakeMessage(attachments) {
  return { attachments: new Map(attachments.map((item, index) => [String(index), item])) };
}

test('text attachments: markdown/text/json are readable, images/PDF/HTML are not', () => {
  assert.equal(isTextAttachment({ name: 'README.md', contentType: 'text/markdown' }), true);
  assert.equal(isTextAttachment({ name: 'notes', contentType: 'text/plain' }), true);
  assert.equal(isTextAttachment({ name: 'data.json', contentType: 'application/octet-stream' }), true);
  assert.equal(isTextAttachment({ name: 'photo.png', contentType: 'image/png' }), false);
  assert.equal(isTextAttachment({ name: 'doc.pdf', contentType: 'application/pdf' }), false);
  assert.equal(isTextAttachment({ name: 'page.html', contentType: 'text/html' }), false);
});

test('text attachments: clips each file, skips oversized files and caps the total', async () => {
  const readText = async (/** @type {string} */ url) => ({
    ok: true,
    text: url.endsWith('big.md') ? 'x'.repeat(20_000) : `body of ${url}`,
  });
  const text = await collectTextAttachments(
    [
      fakeMessage([
        { name: 'big.md', url: 'https://cdn/big.md', size: 10 },
        { name: 'huge.txt', url: 'https://cdn/huge.txt', size: 5_000_000 },
        { name: 'a.txt', url: 'https://cdn/a.txt', size: 10 },
        { name: 'b.json', url: 'https://cdn/b.json', size: 10 },
        { name: 'c.csv', url: 'https://cdn/c.csv', size: 10 },
      ]),
    ],
    { readText },
  );

  assert.match(text, /^\[file: big\.md\]/);
  assert.match(text, /\[file truncated\]/);
  assert.equal(text.includes('huge.txt'), false);
  assert.equal((text.match(/\[file: /g) ?? []).length, 3);
  assert.ok(text.length < 16_200, `unexpected length ${text.length}`);
});

test('text attachments: a failed download is skipped without breaking the turn', async () => {
  const text = await collectTextAttachments(
    [fakeMessage([{ name: 'notes.md', url: 'https://cdn/notes.md', size: 10 }])],
    {
      readText: async () => {
        throw new Error('download failed');
      },
    },
  );
  assert.equal(text, '');
});
