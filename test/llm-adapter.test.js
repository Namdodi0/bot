import test from 'node:test';
import assert from 'node:assert/strict';
import { DEEPSEEK_REASONING_MAP, createOpenAiCompatAdapter } from '../src/core/ai/llm/adapter-openai.js';
import { LLM_ERROR, LlmError } from '../src/core/ai/llm/errors.js';
import { planAttemptBudget } from '../src/core/ai/agent/helpers.js';
import { HttpError, createHttp } from '../src/core/http.js';
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

test('passes multimodal content blocks through unchanged', async () => {
  const http = fakeHttp([], standardResponse);
  const nim = makeClient(http);
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,cG5n' } },
      ],
    },
  ];
  await nim.chat({ messages, reasoning: 'none' });
  assert.deepEqual(http.calls[0].payload.messages, messages);
});

test('max_tokens is sent only when configured', async () => {
  const http = fakeHttp([], standardResponse);
  const nim = makeClient(http);
  const result = await nim.chat({ messages: [{ role: 'user', content: 'hi' }], reasoning: 'none', maxTokens: null });
  assert.equal(http.calls.length, 1);
  assert.equal('max_tokens' in http.calls[0].payload, false);
  assert.equal(http.calls[0].payload.reasoning_effort, 'none');
  assert.equal(result.content, 'Hello');

  await nim.chat({ messages: [{ role: 'user', content: 'hi' }], reasoning: 'none', maxTokens: 512 });
  assert.equal(http.calls[1].payload.max_tokens, 512);
});

test('reasoning auto maps to low and tools are sent along', async () => {
  const http = fakeHttp([], standardResponse);
  const nim = makeClient(http);
  await nim.chat({
    messages: [{ role: 'user', content: 'hi' }],
    reasoning: 'auto',
    tools: [{ type: 'function', function: { name: 'web_search', parameters: { type: 'object' } } }],
  });
  assert.equal(http.calls[0].payload.reasoning_effort, 'low');
  assert.equal(http.calls[0].payload.tool_choice, 'auto');
  assert.equal(http.calls[0].payload.tools.length, 1);
});

test('sampling parameters are sent only when configured', async () => {
  const http = fakeHttp([], standardResponse);
  const nim = makeClient(http);
  await nim.chat({
    messages: [{ role: 'user', content: 'hi' }],
    reasoning: 'none',
    sampling: {
      topP: 0.98,
      topK: -1,
      minP: 0.02,
      repetitionPenalty: 1.05,
      frequencyPenalty: 0.3,
      presencePenalty: 0.4,
      seed: 42,
    },
  });

  const payload = http.calls[0].payload;
  assert.equal(payload.top_p, 0.98);
  assert.equal(payload.top_k, -1);
  assert.equal(payload.min_p, 0.02);
  assert.equal(payload.repetition_penalty, 1.05);
  assert.equal(payload.frequency_penalty, 0.3);
  assert.equal(payload.presence_penalty, 0.4);
  assert.equal(payload.seed, 42);

  await nim.chat({ messages: [{ role: 'user', content: 'hi' }], reasoning: 'none' });
  const bare = http.calls[1].payload;
  assert.equal('top_p' in bare, false);
  assert.equal('top_k' in bare, false);
});

test('circuit breaker is keyed by provider+model and does not lock the whole provider', async () => {
  const http = fakeHttp([], standardResponse);
  const client = makeClient(http);
  await client.chat({ messages: [{ role: 'user', content: 'hi' }], reasoning: 'none' });
  await client.chat({
    messages: [{ role: 'user', content: 'hi' }],
    reasoning: 'none',
    model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
  });
  assert.equal(http.calls[0].service, 'nim:nvidia/nemotron-3.5-super-vl-120b-a12b');
  assert.equal(http.calls[1].service, 'nim:nvidia/nemotron-3.5-lightning-30b-a3b');
});

test('allows overriding the model (fallback)', async () => {
  const http = fakeHttp([], standardResponse);
  const nim = makeClient(http);
  await nim.chat({
    messages: [{ role: 'user', content: 'hi' }],
    model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    reasoning: 'none',
  });
  assert.equal(http.calls[0].payload.model, 'nvidia/nemotron-3.5-lightning-30b-a3b');
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

test('drops reasoning_content from the returned result', async () => {
  const http = fakeHttp([], {
    choices: [
      {
        message: { content: 'Answer', reasoning_content: 'internal thoughts' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  });
  const nim = makeClient(http);
  const result = await nim.chat({ messages: [{ role: 'user', content: 'x' }], reasoning: 'none' });
  assert.equal(result.content, 'Answer');
  assert.equal(result.reasoning, 'internal thoughts');
});

test('stream: a keepalive chunk alone does not satisfy the first-token guard', async () => {
  const encoder = new TextEncoder();
  const http = {
    async openStream(_url, opts) {
      const body = new ReadableStream({
        start(controller) {
          // Role-only delta: the stream is alive but no real token has arrived yet.
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'));
          opts.signal.addEventListener('abort', () => controller.error(opts.signal.reason));
        },
      });
      return new Response(body, { status: 200 });
    },
  };
  const client = makeClient(http);
  await assert.rejects(
    () =>
      client.chat({
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: 'none',
        stream: true,
        ttftMs: 30,
        timeoutMs: 5000,
      }),
    (error) => {
      assert.equal(error.retryable, true);
      assert.match(error.message, /first token timeout/);
      return true;
    },
  );
});

test('warmup: returns {ok, ms, model}, 1 token, supports a model override', async () => {
  const http = fakeHttp([], standardResponse);
  const client = makeClient(http);

  const result = await client.warmup();
  assert.equal(result.ok, true);
  assert.ok(result.ms >= 0);
  assert.equal(result.model, 'nvidia/nemotron-3.5-super-vl-120b-a12b');
  assert.equal(http.calls[0].payload.max_tokens, 1);
  assert.equal(http.calls[0].payload.temperature, 0);

  await client.warmup({ model: 'nvidia/nemotron-3-ultra-550b-a55b' });
  assert.equal(http.calls[1].payload.model, 'nvidia/nemotron-3-ultra-550b-a55b');
});

test('warmup: a network error returns ok:false and does NOT throw', async () => {
  const client = makeClient({
    async requestJson() {
      throw new Error('timeout after nim request');
    },
  });
  const result = await client.warmup();
  assert.equal(result.ok, false);
  assert.match(result.error, /timeout after nim request/);
});

test('planAttemptBudget clamps the streaming attempt to the provider timeout', () => {
  const result = planAttemptBudget({
    remainingMs: 60_000,
    attempt: 0,
    maxAttempts: 2,
    streaming: true,
    aiTimeoutMs: 5_000,
  });
  assert.equal(result.reserveMs, 8_000);
  assert.equal(result.primaryMs, 52_000);
  assert.equal(result.timeoutMs, 5_000);
});

test('planAttemptBudget keeps the streaming attempt unlimited when aiTimeoutMs <= 0', () => {
  const result = planAttemptBudget({
    remainingMs: 60_000,
    attempt: 0,
    maxAttempts: 2,
    streaming: true,
    aiTimeoutMs: 0,
  });
  assert.equal(result.timeoutMs, 52_000);
});

test('stream: a completed stream records a breaker success', async () => {
  const encoder = new TextEncoder();
  const service = 'nim:nvidia/nemotron-3.5-super-vl-120b-a12b';
  const http = createHttp({
    sleep: async () => {},
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { status: 200 },
      ),
  });
  http.recordStreamFailure(service);
  const client = makeClient(http);
  const result = await client.chat({
    messages: [{ role: 'user', content: 'hi' }],
    reasoning: 'none',
    stream: true,
    ttftMs: 0,
    timeoutMs: 5000,
  });
  assert.equal(result.content, 'Hi');
  assert.equal(http.stateOf(service).failures, 0);
});

test('stream: a mid-stream failure is recorded on the breaker', async () => {
  const service = 'nim:nvidia/nemotron-3.5-super-vl-120b-a12b';
  const http = createHttp({
    sleep: async () => {},
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError('terminated'));
          },
        }),
        { status: 200 },
      ),
  });
  const client = makeClient(http);
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
      assert.equal(error.service, service);
      assert.equal(error.retryable, true);
      assert.match(error.message, /before first token/);
      return true;
    },
  );
  assert.equal(http.stateOf(service).failures, 1);
});

test('stream: a caller abort is not recorded as a breaker failure', async () => {
  const service = 'nim:nvidia/nemotron-3.5-super-vl-120b-a12b';
  const controller = new AbortController();
  const http = createHttp({
    sleep: async () => {},
    fetchImpl: async (_url, opts) =>
      new Response(
        new ReadableStream({
          start(streamController) {
            opts?.signal?.addEventListener('abort', () => streamController.error(/** @type {any} */ (opts.signal).reason));
          },
        }),
        { status: 200 },
      ),
  });
  const client = makeClient(http);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(
    () =>
      client.chat({
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: 'none',
        stream: true,
        ttftMs: 0,
        timeoutMs: 5000,
        signal: controller.signal,
      }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(http.stateOf(service).failures, 0);
});

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

test('non-stream: an empty completion throws a retryable provider error', async () => {
  const http = fakeHttp([], {
    choices: [{ message: { content: '', role: 'assistant' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 0 },
  });
  const client = makeClient(http);
  await assert.rejects(
    () => client.chat({ messages: [{ role: 'user', content: 'hi' }], reasoning: 'none' }),
    (error) => {
      assert.equal(error instanceof LlmError, true);
      assert.equal(error.code, LLM_ERROR.PROVIDER_ERROR);
      assert.equal(error.retryable, true);
      assert.equal(error.status, 200);
      assert.match(error.message, /empty completion/);
      return true;
    },
  );
});

test('stream: a stream that ends with no content and no tool calls is retryable', async () => {
  const client = makeClient(
    streamFrom(['data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n', 'data: [DONE]\n\n']),
  );
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
      assert.equal(error instanceof LlmError, true);
      assert.equal(error.code, LLM_ERROR.PROVIDER_ERROR);
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test('non-stream: object tool arguments are accepted as already parsed', async () => {
  const http = fakeHttp([], {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'web_search', arguments: { query: 'gold' } } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  const client = makeClient(http);
  const result = await client.chat({ messages: [{ role: 'user', content: 'gold?' }], reasoning: 'none' });
  assert.equal(result.toolCalls.length, 1);
  assert.deepEqual(result.toolCalls[0].arguments, { query: 'gold' });
  assert.equal(result.toolCalls[0].rawArguments, '{"query":"gold"}');
});
