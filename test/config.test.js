import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

function baseEnv(extra = {}) {
  return {
    ZALO_BOT_TOKEN: '123:abc',
    NIM_API_KEY: 'nvapi-test',
    DEEPSEEK_API_KEY: 'sk-test',
    TAVILY_API_KEY: 'tvly-test',
    ...extra,
  };
}

function load(settings = {}, env = baseEnv(), argv = []) {
  return loadConfig({ argv, env, config: settings });
}

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-config-'));
}

test('invalid enum values are rejected', () => {
  assert.throws(() => load({ search: { depth: 'turbo' } }), /config\.search\.depth/);
  assert.throws(() => load({ mode: 'carrier-pigeon' }), /config\.mode/);
  assert.throws(() => load({ progressive: 'sometimes' }), /config\.progressive/);
  assert.throws(() => load({ model: { defaultAlias: 'gpt-9' } }), /config\.model\.defaultAlias/);
  assert.throws(() => load({ model: { visionAlias: 'gpt-9' } }), /config\.model\.visionAlias/);
  assert.throws(() => load({ tone: 'shouty' }), /config\.tone/);
  assert.equal(load({ tone: 'unhinged' }).tone, 'grok');
});

test('sampling defaults keep the tail tight to limit language drift', () => {
  const config = load({ dataDir: os.tmpdir() });
  assert.equal(config.nim.temperature, 0.7);
  assert.equal(config.nim.topP, 0.9);
  assert.equal(config.nim.topK, 40);
  assert.equal(config.nim.visionTemperature, 0.6);
  assert.equal(config.nim.visionTimeoutMs, 180000);
  assert.equal(config.nim.mistralModel, 'mistralai/mistral-large-4-1t-a52b');
  assert.equal(config.nim.glmModel, 'z-ai/glm-5.3-flash');
  assert.equal(config.nim.frequencyPenalty, 0);
  assert.equal(config.nim.presencePenalty, 0);
  assert.equal(config.deepseek.temperature, 0.7);
  assert.equal(config.deepseek.topP, 0.9);
  assert.equal(config.refuseless.temperature, 0.7);
  assert.equal(config.refuseless.topP, 0.9);
});

test('FIRECRAWL_API_KEY enables search without a Tavily key', () => {
  const config = loadConfig({
    argv: [],
    env: { ZALO_BOT_TOKEN: '123:abc', NIM_API_KEY: 'nvapi-test', FIRECRAWL_API_KEY: 'fc-test' },
    config: { dataDir: os.tmpdir(), model: { defaultAlias: 'ultra' } },
  });
  assert.equal(config.search.enabled, true);
  assert.equal(config.search.firecrawlApiKey, 'fc-test');
  assert.equal(config.search.apiKey, '');
});

test('visionAlias must point at a vision-capable model', () => {
  assert.throws(() => load({ model: { visionAlias: 'ultra' } }), /vision-capable/);
  assert.equal(load({ model: { visionAlias: 'nim' } }).model.visionAlias, 'nim');
  assert.equal(load({ model: { visionAlias: 'mistral-large' } }).model.visionAlias, 'mistral-large');
});

test('vision reasoning defaults to high and rejects unknown modes', () => {
  assert.equal(load({ dataDir: os.tmpdir() }).model.visionReasoning, 'high');
  assert.equal(load({ model: { visionReasoning: 'medium' } }).model.visionReasoning, 'medium');
  assert.throws(() => load({ model: { visionReasoning: 'max' } }), /config\.model\.visionReasoning/);
});

test('config.webhook.secret overrides the generated secret', () => {
  const config = load({ mode: 'webhook', dataDir: os.tmpdir(), webhook: { secret: 'fixed-secret-123' } });
  assert.equal(config.webhook.secret, 'fixed-secret-123');
  assert.throws(
    () => load({ mode: 'webhook', webhook: { secret: 'short' } }),
    /config\.webhook\.secret/,
  );
});

test('a missing explicit config file throws for configPath and --config', async () => {
  const dir = await tempDir();
  const entryDefault = path.join(dir, 'config.discord.json');
  await fsp.writeFile(entryDefault, JSON.stringify({ dataDir: dir }));
  assert.throws(
    () => loadConfig({ argv: [], env: baseEnv(), configPath: path.join(dir, 'missing.json') }),
    /Config file not found/,
  );
  assert.throws(
    () =>
      loadConfig({
        argv: ['--config', 'missing.json'],
        env: baseEnv(),
        cwd: dir,
        configPath: entryDefault,
      }),
    /Config file not found/,
  );
});

test('unknown config keys are reported instead of silently dropped', () => {
  const config = load({ allowChatIds: ['g1'], dataDir: os.tmpdir(), nim: { temperature: 0.5 } });

  assert.deepEqual(config.unknownConfigKeys, ['allowChatIds']);
  assert.deepEqual(config.allowedChatIds, []);
});

