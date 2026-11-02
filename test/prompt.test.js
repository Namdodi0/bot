import test from 'node:test';
import assert from 'node:assert/strict';
import { STYLE_SEEDS, pickStyleSeed } from '../src/ai/prompt/sections.js';
import { createZaloPrompt } from '../src/ai/prompt/index.js';

function renderPrompt(options) {
  const registry = createZaloPrompt({ tone: 'roast-hard', ...options });
  return registry.render(registry.assemble({ text: 'hi' }));
}

test('pickStyleSeed rotates deterministically and wraps around', () => {
  assert.equal(pickStyleSeed(1), STYLE_SEEDS[0]);
  assert.equal(pickStyleSeed(STYLE_SEEDS.length + 1), STYLE_SEEDS[0]);
  assert.notEqual(pickStyleSeed(1), pickStyleSeed(2));
});

test('roast prompts carry the per-turn style seed; friendly prompts do not', () => {
  const roast = renderPrompt({ styleSeed: 'street food' });
  assert.match(roast, /STYLE SEED for this reply/);
  assert.match(roast, /street food/);

  const friendlyRegistry = createZaloPrompt({ tone: 'friendly', styleSeed: 'street food' });
  const friendly = friendlyRegistry.render(friendlyRegistry.assemble({ text: 'hi' }));
  assert.equal(friendly.includes('STYLE SEED'), false);
});

test('discord prompts use Discord formatting and slash commands', () => {
  const registry = createZaloPrompt({ platform: 'discord', chatType: 'GROUP', tone: 'friendly' });
  const text = registry.render(registry.assemble({ text: 'hi' }));
  assert.match(text, /Discord/);
  assert.match(text, /slash commands/);
  assert.equal(text.includes('Zalo does not render markdown headings'), false);
});
