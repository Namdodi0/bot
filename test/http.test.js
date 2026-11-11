import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitOpenError, HttpError, createHttp } from '../src/core/http.js';

/** @param {unknown} body @param {number} [status] */
function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const noSleep = async () => {};

test('requestJson retries then succeeds', async () => {
  let calls = 0;
  const http = createHttp({
    sleep: noSleep,
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) return response({ error: 'boom' }, 503);
      return response({ ok: true, value: 42 });
    },
  });
  const result = await http.requestJson('https://example.com', { service: 'test', retries: 2 });
  assert.equal(calls, 3);
  assert.equal(result.data.value, 42);
});

test('requestJson does not retry on 400', async () => {
  let calls = 0;
  const http = createHttp({
    sleep: noSleep,
    fetchImpl: async () => {
      calls += 1;
      return response({ error: 'bad' }, 400);
    },
  });
  await assert.rejects(
    () => http.requestJson('https://example.com', { service: 'test', retries: 2 }),
    (error) => error instanceof HttpError && error.status === 400 && error.retryable === false,
  );
  assert.equal(calls, 1);
});

test('no retry and no breaker trip when the caller aborts', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const http = createHttp({
    sleep: noSleep,
    fetchImpl: async () => {
      calls += 1;
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    },
  });
  for (let i = 0; i < 6; i += 1) {
    await assert.rejects(() =>
      http.requestJson('https://example.com', { service: 'abort-svc', retries: 2, signal: controller.signal }),
    );
  }
  assert.equal(calls, 6);
  assert.equal(http.stateOf('abort-svc').open, false);
});

test('circuit breaker opens after 5 server failures', async () => {
  let calls = 0;
  const http = createHttp({
    sleep: noSleep,
    fetchImpl: async () => {
      calls += 1;
      return response({ error: 'nope' }, 500);
    },
  });
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(() => http.requestJson('https://example.com', { service: 'breaker', retries: 0 }));
  }
  await assert.rejects(
    () => http.requestJson('https://example.com', { service: 'breaker', retries: 0 }),
    (error) => error instanceof CircuitOpenError,
  );
  assert.equal(calls, 5);
  assert.equal(http.stateOf('breaker').open, true);
});

test('a 200 with an unparseable body counts as a breaker failure', async () => {
  const http = createHttp({
    sleep: noSleep,
    fetchImpl: async () => response('<html>not json</html>'),
  });
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(
      () => http.requestJson('https://example.com', { service: 'bad-json', retries: 0 }),
      (error) => error instanceof HttpError && error.retryable === false,
    );
  }
  await assert.rejects(
    () => http.requestJson('https://example.com', { service: 'bad-json', retries: 0 }),
    (error) => error instanceof CircuitOpenError,
  );
});

test('client errors (4xx) do not trip the circuit breaker', async () => {
  let calls = 0;
  const http = createHttp({
    sleep: noSleep,
    fetchImpl: async () => {
      calls += 1;
      return response({ error: 'unauthorized' }, 401);
    },
  });
  for (let i = 0; i < 8; i += 1) {
    await assert.rejects(() => http.requestJson('https://example.com', { service: 'auth', retries: 0 }));
  }
  assert.equal(calls, 8);
  assert.equal(http.stateOf('auth').open, false);
});

/** @param {number} status @param {Record<string,string>} headers */
function errorResponse(status, headers) {
  return {
    ok: false,
    status,
    headers: new Headers(headers),
    text: async () => '{"error":"busy"}',
  };
}

test('requestJson waits for the Retry-After delta-seconds hint', async () => {
  let calls = 0;
  /** @type {number[]} */
  const delays = [];
  const http = createHttp({
    sleep: async (ms) => {
      delays.push(ms);
    },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return errorResponse(429, { 'retry-after': '2' });
      return response({ ok: true });
    },
  });

  const result = await http.requestJson('https://example.com', { service: 'retry-after', retries: 1 });
  assert.equal(result.data.ok, true);
  assert.equal(delays.length, 1);
  assert.ok(delays[0] >= 2000, `expected >= 2000ms, got ${delays[0]}`);
  assert.ok(delays[0] <= 30_000, `expected a bounded wait, got ${delays[0]}`);
});

test('an attempt timeout (TimeoutError signal) is retried, not treated as a caller abort', async () => {
  let calls = 0;
  const attemptSignal = AbortSignal.timeout(1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(attemptSignal.aborted, true);

  const http = createHttp({
    sleep: noSleep,
    fetchImpl: async () => {
      calls += 1;
      if (calls < 2) throw Object.assign(new Error('the operation timed out'), { name: 'TimeoutError' });
      return response({ ok: true });
    },
  });

  const result = await http.requestJson('https://example.com', {
    service: 'attempt-timeout',
    retries: 1,
    signal: attemptSignal,
  });
  assert.equal(result.data.ok, true);
  assert.equal(calls, 2);
});

test('openStream does not mark the breaker healthy on headers alone', async () => {
  const http = createHttp({
    sleep: noSleep,
    fetchImpl: async () => new Response(new ReadableStream({ start: (controller) => controller.close() }), { status: 200 }),
  });
  http.recordStreamFailure('stream-svc');
  const result = await http.openStream('https://example.com', { service: 'stream-svc' });
  assert.equal(result.status, 200);
  assert.equal(http.stateOf('stream-svc').failures, 1);

  http.recordStreamSuccess('stream-svc');
  assert.equal(http.stateOf('stream-svc').failures, 0);
});
