import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { VERSION, readVersion, __test__ as versionTest } from '../src/core/version.js';
import { createLogger } from '../src/core/logger.js';
import { createMetrics } from '../src/core/metrics.js';
import { __test__ as nimTest } from '../src/core/ai/llm/adapter-openai.js';

const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));

function sink() {
  /** @type {string[]} */
  const lines = [];
  return { lines, stream: { write: (line) => lines.push(line) } };
}

test('VERSION matches package.json', () => {
  assert.equal(VERSION, pkg.version);
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});

test('readVersion returns 0.0.0 when package.json cannot be read', () => {
  versionTest.reset();
  assert.equal(readVersion(new URL('file:///khong-ton-tai/package.json')), '0.0.0');
});

test('the JSON logger adds the version to every log line', () => {
  const out = sink();
  const logger = createLogger({
    level: 'info',
    format: 'json',
    version: '9.9.9',
    stdout: /** @type {any} */ (out.stream),
    stderr: /** @type {any} */ (out.stream),
  });
  logger.info('hello', { a: 1 });
  logger.warn('warning');
  const records = out.lines.map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.equal(records[0].version, '9.9.9');
  assert.equal(records[1].version, '9.9.9');
});

test('metrics.gauge stores the instantaneous value, the snapshot exposes gauges', () => {
  const metrics = createMetrics();
  metrics.gauge('llm.tokensPerSec', 42.7);
  metrics.gauge('llm.tokensPerSec', 51.2);
  metrics.gauge('khong-hop-le', Number.NaN);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.gauges['llm.tokensPerSec'], 51.2);
  assert.equal(snapshot.gauges['khong-hop-le'], undefined);
});

test('tokensPerSec: tokens/second, rounded to 1 decimal, rejects meaningless numbers', () => {
  assert.equal(nimTest.tokensPerSec(100, 2000), 50);
  assert.equal(nimTest.tokensPerSec(150, 3600), 41.7);
  assert.equal(nimTest.tokensPerSec(0, 1000), 0);
  assert.equal(nimTest.tokensPerSec(100, 0), 0);
  assert.equal(nimTest.tokensPerSec(Number.NaN, 1000), 0);
});
