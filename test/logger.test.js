import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLogger, printBanner, visualWidth } from '../src/core/logger.js';

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

test('JSON: warn/error go to stderr, debug is filtered', () => {
  const { logger, out, err } = jsonLogger();
  logger.debug('hidden');
  logger.warn('warning');
  logger.error('error');
  assert.equal(out.lines.length, 0);
  assert.equal(err.lines.length, 2);
});

test('pretty: one compact line with time, icon, message, fields', () => {
  const out = sink();
  const logger = createLogger({
    level: 'info',
    format: 'pretty',
    color: 'never',
    stdout: /** @type {any} */ (out.stream),
    now: () => new Date(2026, 9, 26, 18, 31, 2),
  });
  logger.info('zalo bot ready', { id: '2214705736200876533', name: 'Bot deepseek', icon: '🤖' });
  const line = out.lines[0].trimEnd();
  assert.match(line, /^18:31:02 🤖 zalo bot ready\s+id=2214705736200876533 name="Bot deepseek"$/);
  assert.equal(line.includes('\u001b['), false);
});

test('pretty: default icon per level, colored when enabled', () => {
  const out = sink();
  const logger = createLogger({
    level: 'debug',
    format: 'pretty',
    color: 'always',
    stdout: /** @type {any} */ (out.stream),
    stderr: /** @type {any} */ (out.stream),
  });
  logger.info('no icon');
  logger.warn('warning');
  logger.error('error');
  assert.match(out.lines[0], /ℹ/);
  assert.match(out.lines[1], /▲/);
  assert.match(out.lines[2], /✖/);
  for (const line of out.lines) assert.ok(line.includes('\u001b['));
});

test('pretty: still redacts and formats errors compactly', () => {
  const out = sink();
  const logger = createLogger({
    level: 'info',
    format: 'pretty',
    color: 'never',
    secrets: ['super-secret-password'],
    stdout: /** @type {any} */ (out.stream),
    stderr: /** @type {any} */ (out.stream),
  });
  logger.error('send failed', { token: 'super-secret-password', error: new Error('connection lost') });
  const line = out.lines[0];
  assert.equal(line.includes('super-secret-password'), false);
  assert.match(line, /token=\*\*\*/);
  assert.match(line, /connection lost/);
  assert.equal(line.includes('\n'), true); // trailing newline
});

test('pretty: long values are truncated, objects compacted to JSON', () => {
  const out = sink();
  const logger = createLogger({
    level: 'info',
    format: 'pretty',
    color: 'never',
    stdout: /** @type {any} */ (out.stream),
  });
  logger.info('x', { long: 'a'.repeat(200), obj: { a: 1 } });
  const line = out.lines[0];
  assert.ok(line.includes('…'), 'must contain an ellipsis');
  assert.match(line, /obj=\{"a":1\}/);
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

test('banner stays aligned even with emoji', () => {
  const out = sink();
  printBanner(out.stream, ['🤖 Bot deepseek', 'nvidia/nemotron-3.5-super-vl-120b-a12b'], { color: 'never' });
  const lines = out.lines.join('').trimEnd().split('\n');
  assert.equal(lines.length, 4);
  const widths = lines.map((line) => visualWidth(line));
  assert.equal(new Set(widths).size, 1, `misaligned columns: ${widths.join(',')}`);
  assert.match(lines[0], /^╭─+╮$/);
  assert.match(lines[3], /^╰─+╯$/);
});

test('JSON: redacts DeepSeek-style sk- keys', () => {
  const { logger, out, err } = jsonLogger();
  logger.info('provider failed', { body: 'invalid key sk-abcdefghijklmnopqrstuvwxyz123456' });
  const text = [...out.lines, ...err.lines].join('');
  assert.equal(text.includes('sk-abcdefghijklmnopqrstuvwxyz123456'), false);
  assert.match(text, /\*\*\*/);
});
