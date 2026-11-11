import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireInstanceLock } from '../src/core/instance-lock.js';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bot-lock-test-'));
}

test('a second process cannot take the lock while the holder is alive', async () => {
  const dir = await tempDir();
  const first = await acquireInstanceLock({ dir });
  await assert.rejects(
    () => acquireInstanceLock({ dir }),
    (error) => /already running/.test(String(error?.message)) && String(error.message).includes(String(process.pid)),
  );
  await first.release();
  const again = await acquireInstanceLock({ dir });
  await again.release();
  await fs.rm(dir, { recursive: true, force: true });
});

test('a lock left by a dead pid is taken over', async () => {
  const dir = await tempDir();
  const child = execFile(process.execPath, ['-e', '']);
  const deadPid = child.pid;
  await new Promise((resolve) => child.on('exit', resolve));
  const file = path.join(dir, 'bot.lock');
  await fs.writeFile(file, `${deadPid}\n`);

  const lock = await acquireInstanceLock({ dir });
  assert.equal(lock.pid, process.pid);
  assert.equal((await fs.readFile(file, 'utf8')).trim(), String(process.pid));
  await lock.release();
  await fs.rm(dir, { recursive: true, force: true });
});

test('release never deletes a lock another process now owns', async () => {
  const dir = await tempDir();
  const lock = await acquireInstanceLock({ dir });
  await fs.writeFile(lock.path, '999999\n');
  await lock.release();
  assert.equal((await fs.readFile(lock.path, 'utf8')).trim(), '999999');
  await fs.rm(dir, { recursive: true, force: true });
});
