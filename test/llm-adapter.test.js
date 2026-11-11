import test from 'node:test';
import assert from 'node:assert/strict';
import { DEEPSEEK_REASONING_MAP, createOpenAiCompatAdapter } from '../src/core/ai/llm/adapter-openai.js';
import { CircuitOpenError, HttpError, createHttp } from '../src/core/http.js';
import { createSilentLogger } from '../src/core/logger.js';

const logger = createSilentLogger();

function fakeHttp(payloads, responseBody) {
  const http = {
    calls: [],
    async requestJson(url, opts) {
      http.calls.push({ url, payload: JSON.parse(opts.body), service: opts.service });
      return { status: 200, data: responseBody, headers: new Headers(), latencyMs: 1 };
    },
    async openStream() {
      throw new Error('not used');
    },
  };
  return http;
}

const standardResponse = {
  choices: [{ message: { content: 'Hello', role: 'assistant' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 0 } },
};

function makeClient(http, overrides = {}) {
  return createOpenAiCompatAdapter({
    provider: 'nim',
    apiKey: 'k',
    baseUrl: 'https://nim.test/v1',
    model: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
    http,
    logger,
    ...overrides,
  });
}

/** @param {string[]} frames */
function streamFrom(frames, { failWith } = {}) {
  const encoder = new TextEncoder();
  return {
    async openStream() {
      const body = new ReadableStream({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
        },
        // Terminal step runs once the queued frames have been read.
        pull(controller) {
          if (failWith) controller.error(failWith);
          else controller.close();
        },
      });
      return new Response(body, { status: 200 });
    },
    recordStreamFailure() {},
    recordStreamSuccess() {},
  };
}

const TOOL_DELTA =
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"web_search","arguments":"{\\"que"}}]}}]}\n\n';

test('DeepSeek maps medium to high, none stays none', async () => {
  const http = fakeHttp([], standardResponse);
  const client = makeClient(http, {
    provider: 'deepseek',
    reasoningMap: DEEPSEEK_REASONING_MAP,
    model: 'deepseek-flash',
  });
  await client.chat({ messages: [{ role: 'user', content: 'x' }], reasoning: 'medium' });
  assert.equal(http.calls[0].payload.reasoning_effort, 'high');
  await client.chat({ messages: [{ role: 'user', content: 'x' }], reasoning: 'none' });
  assert.equal(http.calls[1].payload.reasoning_effort, 'none');
  assert.equal(http.calls[1].payload.model, 'deepseek-flash');
});

test('a docs-profile model sends chat_template_kwargs instead of sampling or reasoning_effort', async () => {
  const http = fakeHttp([], standardResponse);
  const client = makeClient(http, {
    samplingDefaultsFor: ['nvidia/nemotron-3-ultra-550b-a55b'],
    reasoningBudget: 16384,
  });
  const tools = [{ type: 'function', function: { name: 'web_search', parameters: { type: 'object' } } }];
  await client.chat({
    model: 'nvidia/nemotron-3-ultra-550b-a55b',
    messages: [{ role: 'user', content: 'x' }],
    reasoning: 'high',
    temperature: 0.3,
    sampling: { topP: 0.85, topK: 40, frequencyPenalty: 0, presencePenalty: 0 },
    tools,
  });
  const payload = http.calls[0].payload;
  assert.deepEqual(payload.chat_template_kwargs, {
    enable_thinking: true,
    force_nonempty_content: true,
  });
  assert.equal(payload.reasoning_budget, 16384);
  for (const key of [
    'reasoning_effort',
    'temperature',
    'top_p',
    'top_k',
    'frequency_penalty',
    'presence_penalty',
  ]) {
    assert.equal(payload[key], undefined, `${key} must stay at the provider default`);
  }

  await client.chat({
    model: 'nvidia/nemotron-3-ultra-550b-a55b',
    messages: [{ role: 'user', content: 'x' }],
    reasoning: 'none',
  });
  assert.deepEqual(http.calls[1].payload.chat_template_kwargs, { enable_thinking: false });

  await client.chat({
    model: 'nvidia/nemotron-3-ultra-550b-a55b',
    messages: [{ role: 'user', content: 'x' }],
    reasoning: 'medium',
  });
  assert.deepEqual(http.calls[2].payload.chat_template_kwargs, {
    enable_thinking: true,
    medium_effort: true,
  });
});

test('reads cached prompt tokens from OpenAI and DeepSeek usage shapes', async () => {
  /** @type {Record<string, number>} */
  const counters = {};
  const metrics = {
    inc: (name, value = 1) => {
      counters[name] = (counters[name] ?? 0) + value;
    },
    observe() {},
    gauge() {},
  };
  const openaiUsage = {
    prompt_tokens: 100,
    completion_tokens: 5,
    prompt_tokens_details: { cached_tokens: 80 },
  };
  const openai = makeClient(fakeHttp([], { ...standardResponse, usage: openaiUsage }), { metrics });
  const first = await openai.chat({ messages: [{ role: 'user', content: 'x' }], reasoning: 'none' });
  assert.equal(first.cachedTokens, 80);
  assert.equal(counters['llm.cachedPromptTokens'], 80);

  const deepseekUsage = { prompt_tokens: 50, completion_tokens: 2, prompt_cache_hit_tokens: 30 };
  const deepseek = makeClient(fakeHttp([], { ...standardResponse, usage: deepseekUsage }), {
    provider: 'deepseek',
    metrics,
  });
  const second = await deepseek.chat({ messages: [{ role: 'user', content: 'x' }], reasoning: 'none' });
  assert.equal(second.cachedTokens, 30);
  assert.equal(counters['llm.cachedPromptTokens'], 110);
});

test('parses tool_calls from the response', async () => {
  const http = fakeHttp([], {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id: 'call-1', type: 'function', function: { name: 'web_search', arguments: '{"query":"gold price"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 3 },
  });
  const nim = makeClient(http);
  const result = await nim.chat({ messages: [{ role: 'user', content: 'gold price?' }], reasoning: 'none' });
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'web_search');
  assert.equal(result.toolCalls[0].arguments.query, 'gold price');
  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(result.reasoning, '');
});

test('an empty 200 completion is reported to the breaker as a protocol failure', async () => {
  /** @type {string[]} */
  const failures = [];
  const client = makeClient({
    async requestJson() {
      return {
        status: 200,
        data: { choices: [{ message: { content: '' }, finish_reason: 'stop' }] },
        headers: new Headers(),
      };
    },
    async openStream() {
      throw new Error('not used');
    },
    recordStreamFailure: () => failures.push('failure'),
  });
  await assert.rejects(
    () => client.chat({ messages: [{ role: 'user', content: 'x' }], reasoning: 'none' }),
    /empty completion/,
  );
  assert.deepEqual(failures, ['failure']);
});

test('persistent empty 200 completions trip the breaker through the real HTTP layer', async () => {
  const http = createHttp({
    logger,
    fetchImpl: async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  });
  const client = makeClient(http);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      () => client.chat({ messages: [{ role: 'user', content: 'x' }], reasoning: 'none' }),
      /empty completion/,
    );
  }
  await assert.rejects(
    () => client.chat({ messages: [{ role: 'user', content: 'x' }], reasoning: 'none' }),
    (error) => error instanceof CircuitOpenError,
  );
});

test('a valid completion resets the breaker failure count', async () => {
  let empty = true;
  const http = createHttp({
    logger,
    fetchImpl: async () =>
      new Response(
        JSON.stringify(
          empty
            ? { choices: [{ message: { content: '' }, finish_reason: 'stop' }] }
            : standardResponse,
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
  });
  const client = makeClient(http);
  const call = () => client.chat({ messages: [{ role: 'user', content: 'x' }], reasoning: 'none' });
  for (let attempt = 0; attempt < 4; attempt += 1) await assert.rejects(call, /empty completion/);
  empty = false;
  await call();
  empty = true;
  for (let attempt = 0; attempt < 4; attempt += 1) await assert.rejects(call, /empty completion/);
  const state = http.stateOf('nim:nvidia/nemotron-3.5-super-vl-120b-a12b');
  assert.equal(state.failures, 4);
  assert.equal(state.open, false);
});

test('stream: a final event without a trailing newline is still processed', async () => {
  const tail = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}';
  const client = makeClient(streamFrom([TOOL_DELTA, tail]));
  const result = await client.chat({
    messages: [{ role: 'user', content: 'x' }],
    stream: true,
    reasoning: 'none',
  });
  assert.equal(result.aborted, false);
  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(result.toolCalls.length, 1, 'the completion marker in the tail must release tool calls');
});

test('stream: a tool-call delta then a stream error rejects as retryable', async () => {
  const client = makeClient(streamFrom([TOOL_DELTA], { failWith: new TypeError('terminated') }));
  await assert.rejects(
    () =>
      client.chat({
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: 'none',
        stream: true,
        ttftMs: 0,
        timeoutMs: 5000,
      }),
    (error) => {
      assert.equal(error instanceof HttpError, true);
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test('stream: clean EOF without a completion marker never releases tool calls', async () => {
  const client = makeClient(streamFrom([TOOL_DELTA]));
  await assert.rejects(
    () =>
      client.chat({
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: 'none',
        stream: true,
        ttftMs: 0,
        timeoutMs: 5000,
      }),
    (error) => {
      assert.equal(error instanceof HttpError, true);
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test('stream: partial content without a completion marker is aborted and tool calls are dropped', async () => {
  const client = makeClient(
    streamFrom(['data: {"choices":[{"index":0,"delta":{"content":"Partial answer"}}]}\n\n', TOOL_DELTA]),
  );
  const result = await client.chat({
    messages: [{ role: 'user', content: 'hi' }],
    reasoning: 'none',
    stream: true,
    ttftMs: 0,
    timeoutMs: 5000,
  });
  assert.equal(result.content, 'Partial answer');
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.aborted, true);
});

test('stream: plain text from a provider without a completion marker stays usable', async () => {
  const client = makeClient(streamFrom(['data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n']));
  const result = await client.chat({
    messages: [{ role: 'user', content: 'hi' }],
    reasoning: 'none',
    stream: true,
    ttftMs: 0,
    timeoutMs: 5000,
  });
  assert.equal(result.content, 'Hello');
  assert.equal(result.aborted, false);
  assert.deepEqual(result.toolCalls, []);
});

test('truncated tool-call arguments are marked as a parse error, not executed as {}', async () => {
  const client = makeClient(
    streamFrom([
      TOOL_DELTA,
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]),
  );
  const result = await client.chat({
    messages: [{ role: 'user', content: 'hi' }],
    reasoning: 'none',
    stream: true,
    ttftMs: 0,
    timeoutMs: 5000,
  });
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].parseError, true);
  assert.deepEqual(result.toolCalls[0].arguments, {});
  assert.equal(result.toolCalls[0].rawArguments, '{}');
});

test('stream: content plus a partial tool-call delta returns no tool calls and is aborted', async () => {
  const client = makeClient(
    streamFrom(['data: {"choices":[{"index":0,"delta":{"content":"Partial answer"}}]}\n\n', TOOL_DELTA], {
      failWith: new TypeError('terminated'),
    }),
  );
  const result = await client.chat({
    messages: [{ role: 'user', content: 'hi' }],
    reasoning: 'none',
    stream: true,
    ttftMs: 0,
    timeoutMs: 5000,
  });
  assert.equal(result.content, 'Partial answer');
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.aborted, true);
});
