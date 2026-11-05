import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadEnvFiles } from '../src/core/env.js';

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-env-'));
}

test('loadEnvFiles: loads .env, variables already in the environment win over the file', async () => {
  const dir = await tempDir();
  await fsp.writeFile(path.join(dir, '.env'), 'ZALO_BOT_TOKEN=from-file\nNIM_API_KEY=nvapi-file\n');
  const env = { NIM_API_KEY: 'nvapi-panel' };
  const report = loadEnvFiles({ cwd: dir, env });

  assert.equal(env.ZALO_BOT_TOKEN, 'from-file');
  assert.equal(env.NIM_API_KEY, 'nvapi-panel');
  assert.equal(report.applied.includes('ZALO_BOT_TOKEN'), true);
  assert.equal(report.applied.includes('NIM_API_KEY'), false);
  assert.deepEqual(report.missing, ['.env.local']);
});

test('loadEnvFiles: a whitespace-only variable is treated as empty and filled from the file', async () => {
  const dir = await tempDir();
  await fsp.writeFile(path.join(dir, '.env'), 'ZALO_BOT_TOKEN=from-file\nNIM_API_KEY=nvapi-file\n');
  const env = { ZALO_BOT_TOKEN: '   ', NIM_API_KEY: 'nvapi-panel' };
  loadEnvFiles({ cwd: dir, env });
  assert.equal(env.ZALO_BOT_TOKEN, 'from-file');
  assert.equal(env.NIM_API_KEY, 'nvapi-panel');
});

