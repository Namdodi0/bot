import test from 'node:test';
import assert from 'node:assert/strict';
import { STYLE_SEEDS, pickStyleSeed } from '../src/core/ai/prompt/sections.js';
import { createPrompt } from '../src/core/ai/prompt/index.js';
import { makeDiscordPlatform, makeZaloPlatform } from '../test-utils/helpers.js';

function renderPrompt(options) {
  const registry = createPrompt({ tone: 'roast-hard', platform: makeZaloPlatform(), ...options });
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

  const friendlyRegistry = createPrompt({
    platform: makeZaloPlatform(),
    tone: 'friendly',
    styleSeed: 'street food',
  });
  const friendly = friendlyRegistry.render(friendlyRegistry.assemble({ text: 'hi' }));
  assert.equal(friendly.includes('STYLE SEED'), false);
});

test('discord prompts use Discord formatting and slash commands', () => {
  const registry = createPrompt({
    platform: makeDiscordPlatform(),
    chatType: 'GROUP',
    tone: 'friendly',
  });
  const text = registry.render(registry.assemble({ text: 'hi' }));
  assert.match(text, /Discord/);
  assert.match(text, /slash commands/);
  assert.equal(text.includes('Zalo does not render markdown headings'), false);
});

test('zalo prompts use Zalo formatting and the Zalo command list', () => {
  const registry = createPrompt({ platform: makeZaloPlatform(), chatType: 'GROUP', tone: 'friendly' });
  const text = registry.render(registry.assemble({ text: 'hi' }));
  assert.match(text, /Zalo/);
  assert.match(text, /Zalo does not render markdown headings/);
  assert.match(text, /\/sticker/);
  assert.equal(text.includes('slash commands'), false);
});