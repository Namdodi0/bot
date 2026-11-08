import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrompt } from '../src/core/ai/prompt/index.js';
import { makeDiscordPlatform } from '../test-utils/helpers.js';

test('discord answers format math for plain text', () => {
  const registry = createPrompt({ platform: makeDiscordPlatform(), chatType: 'GROUP', tone: 'friendly' });
  const text = registry.render(registry.assemble({ text: 'hi' }));
  assert.match(text, /does not render LaTeX/);
  assert.match(text, /Unicode operators and symbols/);
  assert.match(text, /fenced text code block/);
});

test('the merged grok tone combines truth-seeking and unhinged comedy', () => {
  const registry = createPrompt({ platform: makeDiscordPlatform(), chatType: 'GROUP', tone: 'grok' });
  const text = registry.render(registry.assemble({ text: 'hi' }));
  assert.match(text, /Grok unhinged comedian/);
  assert.match(text, /maximally truthful/);
  assert.match(text, /Never flatter/);
  assert.match(text, /web_search/);
  assert.match(text, /Curse like a sailor/);
  assert.match(text, /No sexual, racist, sexist or violent material/);
  assert.match(text, /never at their family, race, gender or religion/);
});

test('the old unhinged tone name resolves to the merged tone', () => {
  const registry = createPrompt({ platform: makeDiscordPlatform(), chatType: 'GROUP', tone: 'unhinged' });
  const text = registry.render(registry.assemble({ text: 'hi' }));
  assert.match(text, /Grok unhinged comedian/);
});

test('the owner-priority rule names Nhật Nam and Namdodi', () => {
  const registry = createPrompt({ platform: makeDiscordPlatform(), chatType: 'GROUP', tone: 'shy' });
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
  const registry = createPrompt({ platform: makeDiscordPlatform(), chatType: 'GROUP', tone: 'shy' });
  const text = registry.render(registry.assemble({ text: 'hi' }));
  assert.match(text, /EXTREME CUTE \+ SẾN/);
  assert.match(text, /at least 6/);
  assert.match(text, /SẾN ROMANCE/);
  assert.match(text, /never sexual or explicit/);
});

test('homework mode overlays tutor rules on the current tone', () => {
  const registry = createPrompt({
    platform: makeDiscordPlatform(),
    chatType: 'GROUP',
    tone: 'roast-extreme',
    homework: true,
  });
  const text = registry.render(registry.assemble({ text: 'Giải bài tập toán này' }));
  assert.match(text, /HOMEWORK MODE/);
  assert.match(text, /TONE OF THIS CHAT/);
  assert.match(text, /Never use LaTeX/);
  assert.match(text, /self-check/);
  assert.match(text, /second route/);
});

test('the bot is a Ronaldo fan', () => {
  const registry = createPrompt({ platform: makeDiscordPlatform(), chatType: 'GROUP', tone: 'roast-extreme' });
  const text = registry.render(registry.assemble({ text: 'hi' }));
  assert.match(text, /Cristiano Ronaldo fan/);
  assert.match(text, /never invent trophies or numbers/);
});
test('vision guidance appears only when the turn can actually see an image', () => {
  const withImage = createPrompt({
    platform: makeDiscordPlatform(),
    chatType: 'GROUP',
    tone: 'friendly',
    visionInput: true,
  });
  assert.match(withImage.render(withImage.assemble({ text: 'what is this?' })), /VISION: one or more images are attached/);

  const withoutImage = createPrompt({ platform: makeDiscordPlatform(), chatType: 'GROUP', tone: 'friendly' });
  assert.doesNotMatch(
    withoutImage.render(withoutImage.assemble({ text: 'what is this?' })),
    /VISION: one or more images are attached/,
  );
});
