import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_ALIASES } from '../src/core/ai/models.js';

/**
 * Fast model smoke test: a model passes only when it emits visible `content` before the
 * timeout. Reasoning tokens do not count, so a model that thinks forever fails quickly.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = Math.max(1000, Number(process.env.MODEL_TEST_TIMEOUT_MS) || 20_000);
const BASE_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const IMAGE_URL = 'https://httpbin.org/image/png';

function readKey() {
  const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const key = (env.match(/^NIM_API_KEY=(.+)$/m) || [])[1]?.trim();
  if (!key) throw new Error('NIM_API_KEY is missing from .env');
  return key;
}

function models() {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.discord.json'), 'utf8'));
  const nim = config.nim ?? {};
  return Object.entries(MODEL_ALIASES)
    .filter(([, meta]) => meta.provider === 'nim' && nim[meta.modelKey])
    .map(([alias, meta]) => ({ alias, model: String(nim[meta.modelKey]), vision: meta.vision === true }));
}

/** @param {string} key @param {{alias: string, model: string, vision: boolean}} entry @param {boolean} vision */
async function testModel(key, entry, vision) {
  const content = vision
    ? [
        { type: 'text', text: 'Mô tả ảnh này bằng một câu tiếng Việt.' },
        { type: 'image_url', image_url: { url: IMAGE_URL } },
      ]
    : 'Trả lời bằng tiếng Việt trong 2 câu: vì sao bầu trời có màu xanh?';
  const body = {
    model: entry.model,
    messages: [{ role: 'user', content }],
    max_tokens: 256,
    temperature: 0.7,
    top_p: 0.9,
    top_k: 40,
    reasoning_effort: 'low',
    stream: true,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = performance.now();
  let ttft = null;
  let reasoningChars = 0;
  let buffer = '';
  try {
    const response = await fetch(BASE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ...entry,
        vision,
        ok: false,
        ttft: null,
        reasoningChars: 0,
        reason: `HTTP ${response.status} ${(await response.text()).slice(0, 120)}`,
      };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === '[DONE]') continue;
          let json;
          try {
            json = JSON.parse(raw);
          } catch {
            continue;
          }
          const delta = json.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.reasoning_content) reasoningChars += String(delta.reasoning_content).length;
          if (delta.content) {
            ttft = Math.round(performance.now() - started);
            // Stop as soon as the model proves it can answer; full latency is not needed.
            controller.abort();
            return { ...entry, vision, ok: true, ttft, reasoningChars, reason: '' };
          }
        }
      }
    }
    return {
      ...entry,
      vision,
      ok: false,
      ttft: null,
      reasoningChars,
      reason: 'stream ended without content',
    };
  } catch (error) {
    const aborted = /** @type {any} */ (error)?.name === 'AbortError';
    return {
      ...entry,
      vision,
      ok: false,
      ttft: null,
      reasoningChars,
      reason: aborted ? `no content within ${Math.round(TIMEOUT_MS / 1000)}s` : String(error?.message ?? error),
    };
  } finally {
    clearTimeout(timer);
  }
}

const key = readKey();
const args = process.argv.find((value) => value.startsWith('--models='));
const list = args
  ? args
      .slice('--models='.length)
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => ({ alias: id.split('/').pop() || id, model: id, vision: false }))
  : models();
const results = [];
for (const entry of list) {
  const modes = entry.vision ? ['text', 'vision'] : ['text'];
  for (const mode of modes) {
    const result = await testModel(key, entry, mode === 'vision');
    results.push(result);
    console.log(
      `${result.ok ? 'PASS' : 'FAIL'} ${result.alias} (${mode})` +
        `${result.ok ? ` ttft=${result.ttft}ms reasoning=${result.reasoningChars}` : ` — ${result.reason}`}`,
    );
  }
}
const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed (timeout ${TIMEOUT_MS / 1000}s)`);
if (failed.length) process.exitCode = 1;
