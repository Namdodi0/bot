import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgressFeed } from '../src/platforms/discord/progress.js';
import { createPreviewer } from '../src/platforms/discord/ui.js';

test('progress feed shows thinking, reasoning and tool status', () => {
  const feed = createProgressFeed();

  feed.update({ type: 'thinking' });
  assert.match(feed.text(), /Thinking/);

  feed.update({ type: 'reasoning', text: 'need to search' });
  assert.match(feed.text(), /need to search/);

  feed.update({ type: 'tool', name: 'web_search', query: 'tin tức' });
  assert.match(feed.text(), /Searching the web: tin tức/);

  feed.update({ type: 'tool-result', name: 'web_search', ok: true });
  assert.match(feed.text(), /Web search done/);
  assert.match(feed.summary(), /need to search/);
  assert.match(feed.summary(), /Searching the web: tin tức/);

  feed.update({ type: 'finalizing' });
  assert.match(feed.text(), /need to search/, 'the progress block survives finalizing');

  const fresh = createProgressFeed();
  fresh.update({ type: 'finalizing' });
  assert.match(fresh.text(), /Writing the answer/);
});

test('the previewer coalesces bursts and skips unchanged text', async () => {
  /** @type {string[]} */
  const edits = [];
  const previewer = createPreviewer(async (text) => {
    edits.push(text);
  }, 20);

  previewer.push('a');
  previewer.push('ab');
  previewer.push('abc');
  await previewer.flush();
  assert.deepEqual(edits, ['a', 'abc']);

  previewer.push('abc');
  await previewer.flush();
  assert.deepEqual(edits, ['a', 'abc'], 'unchanged text must not trigger an edit');
});

test('cancel drops the pending preview so the final answer keeps the edit budget', async () => {
  /** @type {string[]} */
  const edits = [];
  const previewer = createPreviewer(async (text) => {
    edits.push(text);
  }, 20);

  previewer.push('a');
  await new Promise((resolve) => setTimeout(resolve, 5));
  previewer.push('abcdefghijklmnopqrst');
  await previewer.cancel();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(edits, ['a']);
});
