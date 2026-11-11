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

test('the waiting ticker shows elapsed time and animates', () => {
  let t = 1_000_000;
  const feed = createProgressFeed({ now: () => t });
  feed.update({ type: 'thinking' });
  const first = feed.text();
  assert.match(first, /Thinking… 0s/);
  t += 2500;
  const later = feed.text();
  assert.match(later, /Thinking… 2s/);
  assert.notEqual(first, later, 'the spinner frame must advance');
  feed.update({ type: 'reasoning', text: 'actual thought' });
  assert.match(feed.text(), /actual thought/, 'real content replaces the ticker');
});

test('reasoning keeps line breaks, tails by lines live, and hides behind a spoiler in the final block', () => {
  const feed = createProgressFeed();
  feed.update({ type: 'reasoning', text: 'line one\nline two\nline three\nline four\nline five' });
  const live = feed.text();
  assert.match(live, /line five/);
  assert.doesNotMatch(live, /line one/, 'the live view shows only the newest lines');
  assert.match(live, /…/, 'a cut excerpt signals the truncation');
  const final = feed.summary();
  assert.match(final, /^🧠 \|\|/, 'the final excerpt opens a spoiler');
  assert.match(final, /\|\|$/, 'the spoiler must stay closed');
  assert.match(final, /line one/, 'the final block keeps more context than the live view');
});

test('the final block never cuts inside the spoiler when tool lines fill the budget', () => {
  const feed = createProgressFeed();
  feed.update({ type: 'reasoning', text: 'r'.repeat(3000) });
  for (let i = 0; i < 6; i += 1) {
    feed.update({ type: 'tool', name: 'web_search', query: `q${i}` });
    feed.update({ type: 'tool-result', name: 'web_search', ok: true });
  }
  const final = feed.summary();
  assert.ok(final.length <= 1400);
  const opens = (final.match(/\|\|/g) ?? []).length;
  assert.equal(opens % 2, 0, 'spoiler markers must stay paired');
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
