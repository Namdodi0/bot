import test from 'node:test';
import assert from 'node:assert/strict';
import { createSummarizer } from '../src/core/ai/summarize.js';
import { buildSummaryInput, SUMMARY_SYSTEM_PROMPT } from '../src/core/ai/prompt/index.js';
import { createCompactionEngine } from '../src/core/context/compaction/engine.js';
import { summarizeRange } from '../src/core/context/compaction/summarizer.js';
import { pruneToolResults } from '../src/core/context/compaction/tool-result-pruner.js';
import { freshRecord, toolCallEntry, toolResultEntry } from '../src/core/context/record.js';
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

test('compaction preserves a completed parallel turn inserted while summarization is pending', async () => {
  const original = turns(12);
  const record = recordWith([...original]);
  let finishSummary;
  const pending = summarizeRange(record, {
    keepRecent: 4,
    summaryMaxChars: 1200,
    summarize: async (messages) => {
      assert.deepEqual(messages, original.slice(0, 8));
      return new Promise((resolve) => { finishSummary = resolve; });
    },
  });
  const completed = [
    { role: 'user', kind: 'turn', text: 'parallel question', ts: 100 },
    { role: 'assistant', kind: 'turn', text: 'parallel answer', ts: 101 },
  ];
  record.messages.splice(4, 0, ...completed);
  finishSummary('Summary of the original prefix.');
  assert.equal((await pending).changed, true);
  assert.deepEqual(record.messages.slice(1), [...completed, ...original.slice(8)]);
});

test('summary input keeps the full transcript and removes only malformed UTF-16', () => {
  const text = 'x'.repeat(13_000);
  const transcript = buildSummaryInput([
    { role: 'user', kind: 'summary', text: 'PRIOR_CANON' },
    { role: 'user', name: 'Ali\ud800ce', text: `${text}\udc00\u{1f680}` },
    { role: 'assistant', text: 'END' },
  ]);
  assert.equal(transcript, `User: PRIOR_CANON\nAlice: ${text}\u{1f680}\nBot: END`);
  assert.equal(transcript.isWellFormed(), true);
});

test('real summarizer carries prior canon through every batch before replacing the range', async () => {
  const selected = [
    { role: 'user', kind: 'summary', text: 'CANON_HOME', ts: 1 },
    ...turns(4).map((message, index) => ({
      ...message,
      text: `CANON_${index} ${'filler '.repeat(1000)}`,
    })),
  ];
  const recent = turns(2);
  const record = recordWith([...selected, ...recent]);
  record.meta.model = 'pro';
  const before = structuredClone(record);
  const chunks = [];
  let carried = '';
  const summarize = createSummarizer({
    llm: {
      chat: async (request) => {
        assert.equal(request.record, record);
        assert.deepEqual(record, before);
        assert.equal(request.maxTokens, 200);
        assert.equal(request.reasoning, 'none');
        assert.equal(request.messages[0].content, SUMMARY_SYSTEM_PROMPT);
        const input = request.messages[1].content;
        assert.ok(input.length <= 12_000);
        const prefix = carried ? `Previous summary:\n${carried}\n\nTranscript continuation:\n` : '';
        assert.ok(input.startsWith(prefix));
        assert.ok(input.includes('CANON_HOME'));
        chunks.push(input.slice(prefix.length));
        // Only facts visible in THIS request survive; no hidden state in the fake model.
        const facts = [...new Set(input.match(/CANON_\w+/g))].join(' ');
        carried = `${facts} ${'padding '.repeat(30)}`.trim();
        return { content: carried };
      },
    },
  });
  const config = makeConfig({ context: { summaryMaxChars: 150 } });
  const result = await summarizeRange(record, {
    keepRecent: recent.length,
    summaryMaxChars: config.context.summaryMaxChars,
    summarize,
  });
  assert.equal(result.changed, true);
  assert.ok(chunks.length >= 3);
  assert.equal(chunks.join(''), buildSummaryInput(selected));
  assert.equal(record.messages[0].kind, 'summary');
  assert.equal(record.messages[0].text.length, config.context.summaryMaxChars);
  for (const fact of ['CANON_HOME', 'CANON_0', 'CANON_1', 'CANON_2', 'CANON_3']) {
    assert.ok(record.messages[0].text.includes(fact));
  }
  assert.deepEqual(record.messages.slice(1), recent);
});

test('real summarizer covers an oversized message without splitting UTF-16 pairs', async () => {
  // The first pair straddles the old 12,000-code-unit boundary including "User: ".
  const selected = [{
    role: 'user', kind: 'turn', ts: 1,
    text: `${'a'.repeat(11_993)}${'\u{1f680}'.repeat(8000)}\nEND`,
  }];
  const record = recordWith([...selected, ...turns(1)]);
  const chunks = [];
  let carried = '';
  const summarize = createSummarizer({
    llm: {
      chat: async ({ messages }) => {
        const input = messages[1].content;
        const prefix = carried ? `Previous summary:\n${carried}\n\nTranscript continuation:\n` : '';
        assert.ok(input.startsWith(prefix));
        assert.ok(input.length <= 12_000);
        assert.equal(input.isWellFormed(), true);
        chunks.push(input.slice(prefix.length));
        // Exercise the existing 900-character carry/output guard at another pair boundary.
        carried = `${'s'.repeat(898)}\u2026`;
        return { content: `${'s'.repeat(898)}\u{1f680}end` };
      },
    },
  });
  const result = await summarizeRange(record, { keepRecent: 1, summaryMaxChars: 1200, summarize });
  assert.equal(result.changed, true);
  assert.ok(chunks.length >= 3);
  assert.equal(chunks.join(''), buildSummaryInput(selected));
  assert.equal(record.messages[0].text, carried);
  assert.equal(record.messages[0].text.isWellFormed(), true);
});

for (const failure of ['empty', 'missing', 'malformed', 'throw']) {
  test(`real summarizer leaves the original range intact after an intermediate ${failure} result`, async () => {
    const record = recordWith([
      { role: 'user', kind: 'summary', text: 'PRIOR_CANON', ts: 1 },
      { role: 'user', kind: 'turn', text: 'x'.repeat(40_000), ts: 2 },
      ...turns(1),
    ]);
    const before = structuredClone(record);
    let calls = 0;
    const error = new Error('summary provider failed');
    const summarize = createSummarizer({
      llm: {
        chat: async () => {
          calls += 1;
          if (calls === 1) return { content: 'PARTIAL' };
          if (failure === 'throw') throw error;
          return { content: failure === 'empty' ? ' \n ' : failure === 'malformed' ? '\ud800 \udc00' : undefined };
        },
      },
    });
    const pending = summarizeRange(record, { keepRecent: 1, summaryMaxChars: 1200, summarize });
    if (failure === 'throw') await assert.rejects(pending, (actual) => actual === error);
    else assert.equal((await pending).changed, false);
    assert.equal(calls, 2);
    assert.deepEqual(record, before);
  });
}

for (const budget of [15_000, 2500]) {
  test(`real summarizer shares one ${budget}ms budget and cannot commit partial coverage`, async (t) => {
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);
    const timeouts = [];
    const signals = [];
    const record = recordWith([
      { role: 'user', kind: 'turn', text: 'x'.repeat(50_000), ts: 1 },
      ...turns(1),
    ]);
    const before = structuredClone(record);
    const elapsed = budget === 15_000 ? 6000 : 1000;
    const summarize = createSummarizer({
      llm: {
        chat: async (request) => {
          timeouts.push(request.timeoutMs);
          signals.push(request.signal);
          now += elapsed;
          return { content: 'PARTIAL' };
        },
      },
    });
    const result = await summarizeRange(record, {
      keepRecent: 1,
      summaryMaxChars: 1200,
      ...(budget === 15_000 ? {} : { deadline: now + budget }),
      summarize,
    });
    assert.equal(result.changed, false);
    assert.deepEqual(timeouts, [budget, budget - elapsed, budget - 2 * elapsed]);
    assert.ok(signals[0] instanceof AbortSignal);
    assert.ok(signals.every((signal) => signal === signals[0]));
    assert.deepEqual(record, before);
  });
}

test('real summarizer rejects even a final response arriving past the deadline', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const record = recordWith(turns(3));
  const before = structuredClone(record);
  let calls = 0;
  const summarize = createSummarizer({
    llm: {
      chat: async () => {
        calls += 1;
        now += 100;
        return { content: 'LATE' };
      },
    },
  });
  const options = { keepRecent: 1, summaryMaxChars: 1200, deadline: now + 100, summarize };
  assert.equal((await summarizeRange(record, options)).changed, false);
  assert.equal(calls, 1);
  // An already exhausted deadline must not dispatch another request with a fresh budget.
  assert.equal((await summarizeRange(record, options)).changed, false);
  assert.equal(calls, 1);
  assert.deepEqual(record, before);
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
