import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgressFeed } from '../src/platforms/discord/progress.js';

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
