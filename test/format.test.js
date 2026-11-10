import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, truncate } from '../src/core/text/format.js';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test('text limits never cut an emoji surrogate pair in half', () => {
  // The pair sits exactly on the truncate boundary and on the hard-split boundary.
  const pairAtLimit = `${'a'.repeat(3998)}😀tail`;
  assert.equal(LONE_SURROGATE.test(truncate(pairAtLimit, 3999)), false);

  const longWord = `${'b'.repeat(99)}😀${'c'.repeat(50)}`;
  const chunks = chunkText(longWord, { limit: 100 }).chunks;
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.equal(LONE_SURROGATE.test(chunk), false);
});
