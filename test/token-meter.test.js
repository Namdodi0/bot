import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalibrator, createTokenMeter } from '../src/core/context/token-meter.js';

test('request sums system + tool + message and applies the calibrator', () => {
  const meter = createTokenMeter({ calibrator: { estimate: (raw) => raw * 2, observe: () => {}, ratio: () => 2 } });
  const result = meter.request({
    systemPrompt: 'abcd'.repeat(8),
    tools: [{ type: 'function', function: { name: 'x' } }],
    messages: [{ role: 'user', text: 'hello' }],
  });
  assert.ok(result.promptTokens > 0);
  assert.equal(result.promptTokens, result.systemTokens + result.toolTokens + result.messageTokens);
  assert.equal(result.contextWindow, 0);
  assert.equal(result.pressure, null);
});

test('observing raw estimates converges to the true ratio, not at its square root', () => {
  // max above 4 so the clamp does not hide the result.
  const meter = createTokenMeter({ calibrator: createCalibrator({ max: 6 }) });
  const input = { systemPrompt: 'abcd'.repeat(80), messages: [{ role: 'user', text: 'hello there' }] };
  const trueRatio = 4;
  for (let round = 0; round < 20; round += 1) {
    const raw = meter.request(input).rawPromptTokens;
    meter.observe(raw, raw * trueRatio);
  }
  const ratio = meter.ratio();
  assert.ok(Math.abs(ratio - trueRatio) < 0.05, `ratio ${ratio} should converge to ${trueRatio}`);
  // Feeding the calibrated estimate back would settle at sqrt(4) = 2 instead.
  assert.ok(ratio > 3.5, `ratio ${ratio} looks like the old sqrt convergence`);
});
