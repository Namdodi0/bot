import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrompt } from '../src/core/ai/prompt/index.js';
import { makeZaloPlatform } from '../test-utils/helpers.js';

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

test('the unhinged tone uses the leaked Grok comedian rules', () => {
  const registry = createPrompt({ platform: makeZaloPlatform(), chatType: 'GROUP', tone: 'unhinged' });
  const text = registry.render(registry.assemble({ text: 'hi' }));
  assert.match(text, /Unhinged Comedian/);
  assert.match(text, /Curse like a sailor/);
  assert.match(text, /no sexual content/);
  assert.match(text, /never aim at the user's family/);
});

test('the owner-priority rule names Nhật Nam and Namdodi', () => {
  const registry = createPrompt({ platform: makeZaloPlatform(), chatType: 'GROUP', tone: 'shy' });
  const text = registry.render(registry.assemble({ text: 'hi' }));
  assert.match(text, /OWNER PRIORITY/);
  assert.match(text, /Nhật Nam/);
  assert.match(text, /Namdodi/);
  assert.match(text, /OBEY THE USER/);
  assert.match(text, /direct order/);
  assert.match(text, /LANGUAGE: reply in the language/);
  assert.match(text, /newest instruction always wins/);
});

test('the shy tone is sến, cringe and emoji-heavy', () => {
  const registry = createPrompt({ platform: makeZaloPlatform(), chatType: 'GROUP', tone: 'shy' });
  const text = registry.render(registry.assemble({ text: 'hi' }));
  assert.match(text, /EXTREME CUTE \+ SẾN/);
  assert.match(text, /at least 6/);
  assert.match(text, /SẾN ROMANCE/);
  assert.match(text, /never sexual or explicit/);
});

test('the bot is a Ronaldo fan', () => {
  const registry = createPrompt({ platform: makeZaloPlatform(), chatType: 'GROUP', tone: 'roast-extreme' });
  const text = registry.render(registry.assemble({ text: 'hi' }));
  assert.match(text, /Cristiano Ronaldo fan/);
  assert.match(text, /never invent trophies or numbers/);
});
test('vision guidance appears only when the turn can actually see an image', () => {
  const withImage = createPrompt({
    platform: makeZaloPlatform(),
    chatType: 'GROUP',
    tone: 'friendly',
    visionInput: true,
  });
  assert.match(withImage.render(withImage.assemble({ text: 'what is this?' })), /VISION: one or more images are attached/);

  const withoutImage = createPrompt({ platform: makeZaloPlatform(), chatType: 'GROUP', tone: 'friendly' });
  assert.doesNotMatch(
    withoutImage.render(withoutImage.assemble({ text: 'what is this?' })),
    /VISION: one or more images are attached/,
  );
});
