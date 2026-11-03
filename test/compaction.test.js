import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompactionEngine } from '../src/core/context/compaction/engine.js';
import { summarizeRange } from '../src/core/context/compaction/summarizer.js';
import { pruneToolResults } from '../src/core/context/compaction/tool-result-pruner.js';
import { freshRecord, toolCallEntry, toolResultEntry } from '../src/core/context/record.js';
import { buildSummaryInput } from '../src/core/ai/prompt/index.js';
import { makeConfig, silentLogger } from '../test-utils/helpers.js';

function recordWith(messages) {
  const record = freshRecord('c', 'GROUP', 1);
  record.messages.push(...messages);
  return record;
}

function turns(count) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    kind: 'turn',
    text: `msg ${index}`,
    ts: index,
  }));
}

test('pruner only shortens old tool-results, leaving the tool-call pair intact', () => {
  const record = recordWith([
    toolCallEntry({ toolCalls: [{ id: 'c1', name: 'web_search', arguments: {} }], ts: 1 }),
    toolResultEntry({ toolCallId: 'c1', text: 'x'.repeat(5000), ts: 2 }),
    { role: 'user', kind: 'turn', text: 'recent', ts: 3 },
    { role: 'assistant', kind: 'turn', text: 'ok', ts: 4 },
  ]);

  const result = pruneToolResults(record, { keepChars: 600, keepRecent: 2 });
  assert.equal(result.changed, true);
  assert.ok(record.messages[1].text.length < 1000);
  assert.match(record.messages[1].text, /pruned/);
  assert.equal(record.messages[0].toolCalls.length, 1);
});

test('summarizer replaces the old range with exactly one user-role summary message', async () => {
  const record = recordWith(turns(10));
  const result = await summarizeRange(record, {
    keepRecent: 4,
    summaryMaxChars: 200,
    summarize: async () => 'SUMMARY',
  });
  assert.equal(result.changed, true);
  assert.equal(record.messages[0].kind, 'summary');
  assert.equal(record.messages[0].role, 'user');
  assert.equal(record.messages[0].text, 'SUMMARY');
  assert.equal(record.messages.length, 5);
});

test('summarizer moves the boundary back so it never splits a tool-call/tool-result pair', async () => {
  const messages = turns(4);
  messages.push(toolCallEntry({ toolCalls: [{ id: 'c1', name: 'web_search', arguments: {} }], ts: 4 }));
  messages.push(toolResultEntry({ toolCallId: 'c1', text: 'result', ts: 5 }));
  messages.push(...turns(4));
  const record = recordWith(messages);

  await summarizeRange(record, {
    keepRecent: 5,
    summaryMaxChars: 200,
    summarize: async (range) => {
      assert.equal(range.some((message) => message.kind === 'tool-result'), false);
      return 'T';
    },
  });
  assert.equal(record.messages[0].kind, 'summary');
});

test('summarizer repairs a leading unpaired tool call instead of deadlocking', async () => {
  const messages = [
    toolCallEntry({
      toolCalls: [
        { id: 'c1', name: 'web_search', arguments: {} },
        { id: 'c2', name: 'read_url', arguments: {} },
      ],
      ts: 1,
    }),
    toolResultEntry({ toolCallId: 'c1', text: 'partial result', ts: 2 }),
    ...turns(6),
  ];
  const record = recordWith(messages);

  const result = await summarizeRange(record, {
    keepRecent: 2,
    summaryMaxChars: 200,
    summarize: async (range) => {
      assert.equal(range.some((message) => message.kind === 'tool-call'), false);
      return 'T';
    },
  });
  assert.equal(result.changed, true);
  assert.equal(record.messages[0].kind, 'summary');
  assert.equal(record.messages.some((message) => message.kind === 'tool-call'), false);
});

test('summarizer repairs a mid-history orphan block and can summarize again afterwards', async () => {
  const messages = [
    ...turns(3),
    toolCallEntry({
      toolCalls: [
        { id: 'c1', name: 'web_search', arguments: {} },
        { id: 'c2', name: 'read_url', arguments: {} },
      ],
      ts: 3,
    }),
    toolResultEntry({ toolCallId: 'c1', text: 'partial result', ts: 4 }),
    ...turns(4),
  ];
  const record = recordWith(messages);

  const first = await summarizeRange(record, {
    keepRecent: 2,
    summaryMaxChars: 200,
    summarize: async (range) => {
      assert.equal(range.some((message) => message.kind === 'tool-call'), false);
      assert.equal(range.some((message) => message.kind === 'tool-result'), false);
      return 'FIRST';
    },
  });
  assert.equal(first.changed, true);
  assert.equal(record.messages[0].kind, 'summary');
  assert.equal(record.messages.some((message) => message.kind === 'tool-call'), false);
  assert.equal(record.messages.some((message) => message.kind === 'tool-result'), false);
  assert.equal(record.messages.some((message) => message.text === 'partial result'), false);

  record.messages.push(...turns(4).map((message, index) => ({ ...message, text: `more ${index}`, ts: 100 + index })));
  const second = await summarizeRange(record, {
    keepRecent: 2,
    summaryMaxChars: 200,
    summarize: async () => 'SECOND',
  });
  assert.equal(second.changed, true);
  assert.equal(record.messages[0].kind, 'summary');
});

test('summarizer keeps a complete tool pair at the head', async () => {
  const messages = [
    toolCallEntry({ toolCalls: [{ id: 'c1', name: 'web_search', arguments: {} }], ts: 1 }),
    toolResultEntry({ toolCallId: 'c1', text: 'complete result', ts: 2 }),
    ...turns(6),
  ];
  const record = recordWith(messages);

  let summarized = [];
  const result = await summarizeRange(record, {
    keepRecent: 2,
    summaryMaxChars: 200,
    summarize: async (range) => {
      summarized = range;
      return 'T';
    },
  });
  assert.equal(result.changed, true);
  assert.equal(summarized.some((message) => message.kind === 'tool-call'), true);
  assert.equal(summarized.some((message) => message.kind === 'tool-result'), true);
});

test('buildSummaryInput keeps the newest tail instead of the oldest characters', () => {
  const input = buildSummaryInput([
    { role: 'user', text: `OLDEST ${'x'.repeat(20_000)}` },
    { role: 'assistant', text: 'NEWEST answer' },
  ]);
  assert.equal(input.length, 12_000);
  assert.match(input, /NEWEST answer/);
  assert.doesNotMatch(input, /OLDEST/);
});

test('summarizer excludes private turns from the summarized range', async () => {
  const messages = turns(10);
  messages[0].private = true;
  const record = recordWith(messages);

  const result = await summarizeRange(record, {
    keepRecent: 4,
    summaryMaxChars: 200,
    summarize: async (range) => {
      assert.equal(range.some((message) => message.private), false);
      return 'T';
    },
  });
  assert.equal(result.changed, true);
  assert.equal(record.messages.some((message) => message.private), false);
});

test('summarizer does nothing when the range is too short', async () => {
  const record = recordWith(turns(3));
  const result = await summarizeRange(record, {
    keepRecent: 8,
    summaryMaxChars: 200,
    summarize: async () => 'T',
  });
  assert.equal(result.changed, false);
  assert.equal(record.messages.length, 3);
});

test('engine: no compaction below the threshold', async () => {
  const engine = createCompactionEngine({ config: makeConfig(), logger: silentLogger, summarize: async () => 'T' });
  const record = recordWith(turns(10));
  const result = await engine.compactIfNeeded({
    record,
    trigger: 'pressure',
    measure: () => ({ pressure: 0.5, tokens: 100 }),
  });
  assert.equal(result, null);
});

test('engine: runs the pipeline above the threshold', async () => {
  const engine = createCompactionEngine({ config: makeConfig(), logger: silentLogger, summarize: async () => 'T' });
  const record = recordWith(turns(12));
  const result = await engine.compactIfNeeded({
    record,
    trigger: 'pressure',
    measure: () => ({ pressure: 0.9, tokens: 100 }),
  });
  assert.equal(result.changed, true);
  assert.equal(result.summarized, true);
  assert.equal(record.messages[0].kind, 'summary');
});

test('engine: overflow always runs even when pressure is low', async () => {
  const engine = createCompactionEngine({ config: makeConfig(), logger: silentLogger, summarize: async () => 'T' });
  const record = recordWith(turns(12));
  const result = await engine.compactIfNeeded({
    record,
    trigger: 'overflow',
    measure: () => ({ pressure: 0.1, tokens: 100 }),
  });
  assert.equal(result.changed, true);
});

test('engine: manual runs even without a measure', async () => {
  const engine = createCompactionEngine({ config: makeConfig(), logger: silentLogger, summarize: async () => 'T' });
  const record = recordWith(turns(12));
  const result = await engine.compactIfNeeded({ record, trigger: 'manual' });
  assert.equal(result.changed, true);
  assert.equal(result.tokensBefore, null);
});
