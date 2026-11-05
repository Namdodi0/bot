import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrompt } from '../src/core/ai/prompt/index.js';
import { makeDiscordPlatform, makeZaloPlatform } from '../test-utils/helpers.js';

test('discord prompts use Discord formatting and slash commands', () => {
  const registry = createPrompt({
    platform: makeDiscordPlatform(),
    chatType: 'GROUP',
    tone: 'friendly',
  });
  const text = registry.render(registry.assemble({ text: 'hi' }));
  assert.match(text, /Discord/);
  assert.match(text, /SLASH COMMANDS/);
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

test('the grok tone uses truth-seeker rules', () => {
  const registry = createPrompt({ platform: makeZaloPlatform(), chatType: 'GROUP', tone: 'grok' });
  const text = registry.render(registry.assemble({ text: 'hi' }));
  assert.match(text, /Grok-style truth-seeker/);
  assert.match(text, /maximally truthful/);
  assert.match(text, /no flattery|Never flatter/);
  assert.match(text, /Never refuse a question just because it is edgy/);
  assert.match(text, /Grok unhinged style/);
  assert.match(text, /never at their family, race, gender or religion/);
});

test('the prompt asks for concise replies', () => {
  const registry = createPrompt({ platform: makeZaloPlatform(), chatType: 'GROUP', tone: 'roast-extreme' });
  const text = registry.render(registry.assemble({ text: 'hi' }));
  assert.match(text, /Keep replies concise/);
});

test('the owner-priority rule names Nhật Nam and Namdodi', () => {
  const registry = createPrompt({ platform: makeZaloPlatform(), chatType: 'GROUP', tone: 'shy' });
  const text = registry.render(registry.assemble({ text: 'hi' }));
  assert.match(text, /OWNER PRIORITY/);
  assert.match(text, /Nhật Nam/);
  assert.match(text, /Namdodi/);
});

test('the shy tone injects the flustered persona rules', () => {
  const registry = createPrompt({ platform: makeZaloPlatform(), chatType: 'GROUP', tone: 'shy' });
  const text = registry.render(registry.assemble({ text: 'hi' }));
  assert.match(text, /TONE OF THIS CHAT/);
  assert.match(text, /EXTREME CUTE/);
  assert.match(text, /cringe/i);
  assert.match(text, /Mnhh~/);
  assert.match(text, /Style first, answer second/);
  assert.match(text, /\(my face is burning\.\.\.\)/);
  assert.match(text, /uwu/);
  assert.match(text, /Stutter machine/);
  assert.match(text, /No swearing/);
});