import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../src/core/logger.js';

function sink() {
  /** @type {string[]} */
  const lines = [];
  return { lines, stream: { write: (line) => lines.push(line) } };
}

function jsonLogger(extra = {}) {
  const out = sink();
  const err = sink();
  const logger = createLogger({
    level: 'info',
    format: 'json',
    secrets: ['super-secret-value'],
    stdout: /** @type {any} */ (out.stream),
    stderr: /** @type {any} */ (err.stream),
    ...extra,
  });
  return { logger, out, err };
}

test('JSON: redacts secrets but keeps non-sensitive keys', () => {
  const { logger, out, err } = jsonLogger();
  logger.info('cfg', {
    token: 'abc',
    nimKey: 'def',
    maxTokens: 'unlimited',
    promptTokens: 10,
    note: 'super-secret-value',
    raw: 'nvapi-abcdefghijklmnopqrstuvwxyz',
  });
  const payload = JSON.parse(out.lines[0]);
  assert.equal(payload.token, '***');
  assert.equal(payload.nimKey, '***');
  assert.equal(payload.maxTokens, 'unlimited');
  assert.equal(payload.promptTokens, 10);
  assert.equal(payload.note, '***');
  assert.equal(payload.raw, '***');
  assert.equal(err.lines.length, 0);
});

test('two file sinks split normal and debug output', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-logs-'));
  const out = sink();
  const logger = createLogger({
    level: 'info',
    format: 'pretty',
    color: 'never',
    stdout: /** @type {any} */ (out.stream),
    stderr: /** @type {any} */ (out.stream),
    files: [
      { path: path.join(dir, 'bot.log'), level: 'info' },
      { path: path.join(dir, 'debug.log'), level: 'debug' },
    ],
  });
  logger.debug('hidden detail');
  logger.info('visible line');
  await logger.close();

  const normal = fs.readFileSync(path.join(dir, 'bot.log'), 'utf8');
  const debug = fs.readFileSync(path.join(dir, 'debug.log'), 'utf8');
  assert.match(normal, /visible line/);
  assert.doesNotMatch(normal, /hidden detail/);
  assert.match(debug, /hidden detail/);
  assert.match(debug, /visible line/);
  assert.equal(normal.includes('\u001b['), false);
});

test('file sink rotates while running when it exceeds rotateBytes', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-log-rotate-'));
  const file = path.join(dir, 'bot.log');
  const out = sink();
  const logger = createLogger({
    level: 'info',
    format: 'pretty',
    color: 'never',
    stdout: /** @type {any} */ (out.stream),
    stderr: /** @type {any} */ (out.stream),
    rotateBytes: 400,
    files: [{ path: file, level: 'info' }],
  });
  for (let index = 0; index < 8; index += 1) logger.info(`line ${index} ${'x'.repeat(60)}`);
  await logger.close();

  const previous = fs.readFileSync(`${file}.1`, 'utf8');
  const current = fs.readFileSync(file, 'utf8');
  assert.ok(previous.length > 0, 'rotated file must exist');
  assert.ok(current.length > 0, 'a fresh file must keep receiving lines');
  const all = previous + current;
  assert.match(all, /line 0 /);
  assert.match(all, /line 7 /);
});

