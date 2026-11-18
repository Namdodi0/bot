import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgent } from '../src/core/ai/agent.js';
import { createToolRuntime } from '../src/core/ai/tools.js';
import { createCompactionEngine } from '../src/core/context/compaction/engine.js';
import { createContextStore } from '../src/core/context/store.js';
import { MESSAGE_KIND, searchEntry, turnEntry } from '../src/core/context/record.js';
import { createMetrics } from '../src/core/metrics.js';
import { makeConfig, makeDiscordPlatform, silentLogger, textEvent } from '../test-utils/helpers.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function setup(t, { chat, search = async () => ({ results: [] }), context = {}, summarize = async () => 'summary memory' }) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-history-test-'));
  const config = makeConfig({
    maxConcurrentPerChat: 2,
    responseTimeoutMs: 0,
    context: { dir, maxTokens: 0, ...context },
  });
  const logger = silentLogger;
  const metrics = createMetrics();
  const platform = makeDiscordPlatform();
  const store = createContextStore({ dir, logger });
  await store.init();
  const requests = [];
  const target = { alias: 'deepseek', provider: 'deepseek', model: 'test-model', vision: false };
  const llm = {
    resolve: () => target,
    find: () => target,
    fallbackFor: () => null,
    chat: async (input) => {
      requests.push(structuredClone(input.messages));
      return chat(input);
    },
  };
  const tools = createToolRuntime({
    config, logger, metrics, platform,
    tavily: { search },
    validator: { validate: async () => { throw new Error('Unexpected image validation'); } },
    fetch: async () => { throw new Error('Unexpected network request'); },
  });
  const compaction = createCompactionEngine({ config, logger, metrics, summarize });
  const agent = createAgent({ config, logger, metrics, platform, llm, store, tools, compaction });
  t.after(async () => {
    agent.stopAccepting();
    agent.stop('chat-1');
    await agent.drain();
    await store.flush();
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return { agent, store, requests, dir };
}

function question(messages) {
  return messages.findLast((message) => message.role === 'user').content.replace('Nam: question ', '');
}

function storedLabels(messages) {
  return messages.filter((message) => message.kind !== MESSAGE_KIND.CONTEXT).map((message) => {
    if (message.toolCalls) return `call:${message.toolCalls.map((call) => call.id).join(',')}`;
    if (message.toolCallId) return `result:${message.toolCallId}`;
    return message.text;
  });
}

for (const privateFork of [false, true]) {
  test(`a completed ${privateFork ? 'private' : 'public'} fork cannot split a live tool block`, { timeout: 5000 }, async (t) => {
    const toolStarted = deferred();
    const releaseTool = deferred();
    const { agent, store, requests, dir } = await setup(t, {
      chat: async ({ messages }) => {
        const id = question(messages);
        if (id === 'C' || messages.at(-1).role === 'tool') return { content: `answer ${id}` };
        return {
          content: '',
          toolCalls: (id === 'A' ? ['A-first', 'A-last'] : ['B']).map((callId) => ({
            id: callId, name: 'web_search', arguments: { query: callId },
          })),
        };
      },
      search: async (query) => {
        if (query === 'A-last') {
          toolStarted.resolve();
          await releaseTool.promise;
        }
        return { results: [{ title: query, url: 'https://example.test/result', content: `found ${query}` }] };
      },
    });
    const record = await store.get('chat-1');
    const live = agent.collect(textEvent('question A', { messageId: 'a' }));
    try {
      await toolStarted.promise;
      const unfinished = ['Nam: question A', 'call:A-first,A-last', 'result:A-first'];
      assert.deepEqual(storedLabels(record.messages), unfinished);
      const before = structuredClone(record.messages);
      const fork = await agent.collect(textEvent('question B', { messageId: 'b', private: privateFork }));
      assert.equal(fork.text, 'answer B');
      const completed = privateFork ? [] : ['Nam: question B', 'call:B', 'result:B', 'answer B'];
      assert.deepEqual(storedLabels(record.messages), [...completed, ...unfinished]);
      assert.deepEqual(record.messages.slice(-unfinished.length), before.slice(-unfinished.length));
      if (!privateFork) {
        const merged = record.messages.filter((message) => message.kind !== MESSAGE_KIND.CONTEXT).slice(0, completed.length);
        assert.ok(merged.every((message) => !message.turnId && !message.private));
      }
      for (const request of requests.filter((messages) => question(messages) === 'B')) {
        assert.doesNotMatch(JSON.stringify(request), /question A|A-first|A-last/);
      }
      releaseTool.resolve();
      assert.equal((await live).text, 'answer A');
      const expected = [...completed, ...unfinished, 'result:A-last', 'answer A'];
      assert.deepEqual(storedLabels(record.messages), expected);
      assert.ok(record.messages.every((message) => !message.private));
      await store.flush();
      const reloaded = await createContextStore({ dir, logger: silentLogger }).get('chat-1');
      assert.deepEqual(reloaded.messages, record.messages, 'the same intact public history reaches disk');

      assert.equal((await agent.collect(textEvent('question C', { messageId: 'c' }))).text, 'answer C');
      const next = requests.at(-1);
      const callIndex = next.findIndex((message) => message.tool_calls?.[0]?.id === 'A-first');
      assert.ok(callIndex >= 0, 'the next request must retain the live turn tool call');
      assert.deepEqual(next.slice(callIndex, callIndex + 3).map((message) => message.role), ['assistant', 'tool', 'tool']);
      assert.deepEqual(next.slice(callIndex + 1, callIndex + 3).map((message) => message.tool_call_id), ['A-first', 'A-last']);
      if (privateFork) assert.doesNotMatch(JSON.stringify(next), /question B|answer B|found B/);
      else {
        const forkCallIndex = next.findIndex((message) => message.tool_calls?.[0]?.id === 'B');
        assert.ok(forkCallIndex >= 0 && forkCallIndex < callIndex);
        assert.equal(next[forkCallIndex + 1].tool_call_id, 'B');
      }
    } finally {
      releaseTool.resolve();
      await live;
    }
  });
}

for (const firstFinished of ['A', 'B']) {
  test(`parallel merge preserves compacted history when ${firstFinished} finishes first`, { timeout: 5000 }, async (t) => {
    const started = { A: deferred(), B: deferred() };
    const release = { A: deferred(), B: deferred() };
    const summaries = [];
    const { agent, store, requests } = await setup(t, {
      context: { maxMessages: 8, keepRecent: 4 },
      summarize: async (messages) => {
        summaries.push(structuredClone(messages));
        return 'summary memory';
      },
      chat: async ({ messages }) => {
        const id = question(messages);
        if (started[id]) {
          started[id].resolve();
          await release[id].promise;
        }
        return { content: `answer ${id}` };
      },
    });
    const record = await store.get('chat-1');
    const history = Array.from({ length: 20 }, (_, index) => turnEntry({
      role: index % 2 ? 'assistant' : 'user', text: `old ${index}`, ts: index + 1,
    }));
    record.messages.push(...history, searchEntry('retained search', 21));
    store.touch('chat-1');
    const turns = { A: agent.collect(textEvent('question A', { messageId: 'a' })) };
    try {
      await started.A.promise;
      assert.equal(summaries.length, 1, 'the live turn must actually compact');
      assert.equal(record.messages[0].kind, MESSAGE_KIND.SUMMARY);
      assert.ok(record.messages[0].ts > history.at(-1).ts, 'the summary is newer than the retained history');
      const prefix = structuredClone(record.messages.slice(0, -1));
      assert.deepEqual(storedLabels(prefix), ['summary memory', 'old 18', 'old 19']);
      turns.B = agent.collect(textEvent('question B', { messageId: 'b' }));
      await started.B.promise;
      assert.doesNotMatch(JSON.stringify(requests.at(-1)), /question A/);
      assert.equal(summaries.length, 1, 'the fork must not compact the shared record');
      release[firstFinished].resolve();
      assert.equal((await turns[firstFinished]).text, `answer ${firstFinished}`);
      const lastFinished = firstFinished === 'A' ? 'B' : 'A';
      release[lastFinished].resolve();
      assert.equal((await turns[lastFinished]).text, `answer ${lastFinished}`);
      assert.deepEqual(record.messages.slice(0, prefix.length), prefix, 'summary/context boundaries cannot move');
      const expected = [
        'summary memory', 'old 18', 'old 19',
        `Nam: question ${firstFinished}`, `answer ${firstFinished}`,
        `Nam: question ${lastFinished}`, `answer ${lastFinished}`,
      ];
      assert.deepEqual(storedLabels(record.messages), expected);
      assert.equal(record.turns, 2, 'merge must count the fork only once');

      assert.equal((await agent.collect(textEvent('question C', { messageId: 'c' }))).text, 'answer C');
      const next = requests.at(-1);
      assert.equal(next[1].content, 'summary memory');
      assert.ok(next.some((message) => message.content === 'retained search'));
      assert.deepEqual(
        next.slice(1).filter((message) => expected.includes(message.content)).map((message) => message.content),
        expected,
        'retained messages must not disappear behind the summary in the next request',
      );
      assert.equal(next.at(-1).content, 'Nam: question C');
      assert.equal(summaries.length, 1);
    } finally {
      release.A.resolve();
      release.B.resolve();
      await Promise.all(Object.values(turns));
    }
  });
}
