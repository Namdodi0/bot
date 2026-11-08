import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgressFeed, thinkingBlock } from '../src/platforms/discord/progress.js';

test('progress feed shows thinking, reasoning and tool status', () => {
  const feed = createProgressFeed();

  feed.update({ type: 'thinking' });
  assert.match(feed.text(), /Thinking/);

  feed.update({ type: 'reasoning', text: 'need to search' });
  assert.match(feed.text(), /need to search/);
  assert.equal(feed.thinking(), 'need to search');

  feed.update({ type: 'tool', name: 'web_search', query: 'tin tức' });
  assert.match(feed.text(), /Searching the web: tin tức/);

  feed.update({ type: 'tool-result', name: 'web_search', ok: true });
  assert.match(feed.text(), /Web search done/);

  feed.update({ type: 'finalizing' });
  assert.match(feed.text(), /Writing the answer/);
});

test('thinking block is clipped and formatted for the follow-up message', () => {
  assert.equal(thinkingBlock('  first\nsecond  '), '> 🧠 **Thinking**\n> first second');
  const clipped = thinkingBlock('x'.repeat(4000));
  assert.ok(clipped.endsWith('…'));
  assert.ok(clipped.length < 3100);
  assert.equal(thinkingBlock('   '), '');
});
