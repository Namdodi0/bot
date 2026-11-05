import test from 'node:test';
import assert from 'node:assert/strict';
import { LLM_ERROR, LlmError, asLlmError } from '../src/core/ai/llm/errors.js';
import { createRetryExecutor } from '../src/core/ai/llm/retry.js';
import { createLlmService } from '../src/core/ai/llm/service.js';
import { CircuitOpenError, HttpError } from '../src/core/http.js';
import { silentLogger } from '../test-utils/helpers.js';

function makeAdapter(id, chat, overrides = {}) {
  return {
    id,
    model: `${id}-model`,
    credentialed: true,
    chat,
    async warmup() {
      return { ok: true, ms: 1, model: `${id}-model` };
    },
    ...overrides,
  };
}

test('service: a missing credential gives MISSING_CREDENTIAL', async () => {
  const service = createLlmService({ logger: silentLogger });
  service.register(makeAdapter('deepseek', async () => ({ content: '' }), { credentialed: false }));
  await assert.rejects(() => service.chat({ provider: 'deepseek', messages: [] }), (error) => {
    assert.equal(error.code, LLM_ERROR.MISSING_CREDENTIAL);
    return true;
  });
});

test('errors: map status/body to stable codes', () => {
  assert.equal(asLlmError(new HttpError('x', { status: 401 })).code, LLM_ERROR.AUTH);
  assert.equal(asLlmError(new HttpError('x', { status: 403 })).code, LLM_ERROR.AUTH);
  assert.equal(asLlmError(new HttpError('x', { status: 408 })).code, LLM_ERROR.TIMEOUT);
  assert.equal(asLlmError(new HttpError('x', { status: 503 })).code, LLM_ERROR.PROVIDER_ERROR);
  assert.equal(asLlmError(new HttpError('x', { status: 400 })).code, LLM_ERROR.BAD_REQUEST);
  assert.equal(asLlmError(new HttpError('x', { status: 0 })).code, LLM_ERROR.PROVIDER_ERROR);
  assert.equal(asLlmError(new HttpError('x', { status: 0 })).retryable, false);
  assert.equal(asLlmError(new HttpError('x', { status: 0, retryable: true })).code, LLM_ERROR.TIMEOUT);
  assert.equal(asLlmError(new HttpError('x', { status: 0, retryable: true })).retryable, true);

  const rateLimited = asLlmError(new HttpError('x', { status: 429, retryAfterMs: 2500 }));
  assert.equal(rateLimited.code, LLM_ERROR.RATE_LIMIT);
  assert.equal(rateLimited.retryAfterMs, 2500);

  const abortedByCaller = asLlmError(new HttpError('x aborted by caller', { status: 0, aborted: true }));
  assert.equal(abortedByCaller.code, LLM_ERROR.ABORTED);
  assert.equal(abortedByCaller.retryable, false);

  const overflow = asLlmError(
    new HttpError('bad request', { status: 400, body: '{"error":"maximum context length exceeded"}' }),
  );
  assert.equal(overflow.code, LLM_ERROR.CONTEXT_WINDOW_EXCEEDED);

  const circuit = asLlmError(new CircuitOpenError('nim', 1000));
  assert.equal(circuit.code, LLM_ERROR.PROVIDER_ERROR);
  assert.equal(circuit.retryable, false);

  const abort = asLlmError(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  assert.equal(abort.code, LLM_ERROR.ABORTED);
});

test('retry: does not retry a non-retryable error and keeps the last error', async () => {
  let attempts = 0;
  const executor = createRetryExecutor({ sleep: async () => {}, shouldRetry: (error) => error.retryable });
  await assert.rejects(
    () =>
      executor.execute(async () => {
        attempts += 1;
        throw new LlmError(LLM_ERROR.AUTH, 'bad key', { retryable: false });
      }),
    (error) => error.code === LLM_ERROR.AUTH,
  );
  assert.equal(attempts, 1);
});

test('retry: honors retryAfterMs over the configured backoff', async () => {
  /** @type {number[]} */
  const delays = [];
  let attempts = 0;
  const executor = createRetryExecutor({
    sleep: async (ms) => {
      delays.push(ms);
    },
    backoffMs: () => 10,
    shouldRetry: (error) => error instanceof LlmError && error.retryable,
  });
  const result = await executor.execute(async () => {
    attempts += 1;
    if (attempts < 2) throw new LlmError(LLM_ERROR.RATE_LIMIT, 'slow down', { retryable: true, retryAfterMs: 2500 });
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.deepEqual(delays, [2500]);
});

test('retry: a huge retryAfterMs is capped at 30s without a deadline', async () => {
  /** @type {number[]} */
  const delays = [];
  let attempts = 0;
  const executor = createRetryExecutor({
    sleep: async (ms) => {
      delays.push(ms);
    },
    shouldRetry: () => true,
  });
  await executor.execute(async () => {
    attempts += 1;
    if (attempts < 2) throw new LlmError(LLM_ERROR.RATE_LIMIT, 'slow down', { retryable: true, retryAfterMs: 600_000 });
    return 'ok';
  });
  assert.deepEqual(delays, [30_000]);
});
