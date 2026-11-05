import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRateLimiter } from '../src/core/ai/agent/queue.js';

test('rate limit overrides also accept a sender name', () => {
  const limiter = createRateLimiter({ userRateLimitPerMinute: 12, userRateLimits: { 'Lê Việt': 2 } });
  assert.equal(limiter('c1', 'id-1', 'Lê Việt'), false);
  assert.equal(limiter('c1', 'id-1', 'Lê Việt'), false);
  assert.equal(limiter('c1', 'id-1', 'Lê Việt'), true);
  assert.equal(limiter('c1', 'id-2', 'Người khác'), false);
});

test('rate limit windows survive a restart', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-rate-'));
  const file = path.join(dir, 'rate-limits.json');
  const config = { userRateLimitPerMinute: 1 };

  const first = createRateLimiter(config, { file });
  assert.equal(first('c1', 'u1'), false);
  assert.equal(first('c1', 'u1'), true);
  await first.flush();

  const second = createRateLimiter(config, { file });
  assert.equal(second('c1', 'u1'), true, 'the saved window must still block');
  assert.equal(second('c1', 'u2'), false, 'other senders are unaffected');
  await second.flush();
});
