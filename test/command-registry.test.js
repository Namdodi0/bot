import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_SPECS, helpBullets } from '../src/core/commands/registry.js';
import { COMMANDS, HELP_NOTE } from '../src/platforms/discord/specs.js';
import { ZALO_COMMAND_SPECS, ZALO_HELP_OVERRIDES } from '../src/platforms/zalo/commands.js';

/** @param {string[]} bullets */
const namesIn = (bullets) => bullets.map((line) => /^• `\/([a-z]+)/.exec(line)?.[1]);

test('Discord exposes a slash-first command surface', () => {
  const names = COMMANDS.map((command) => command.name);
  assert.deepEqual(names, [
    'ask',
    'help',
    'status',
    'ping',
    'model',
    'settings',
    'reset',
    'compact',
    'summary',
    'catchup',
    'search',
    'image',
    'remind',
    'Explain message',
    'Summarize message',
  ]);
  for (const legacy of ['sticker', 'tone', 'split', 'think', 'id']) {
    assert.equal(names.includes(legacy), false, legacy);
  }
  assert.equal(COMMANDS.filter((command) => command.type === 1).length, 13);
  assert.equal(COMMANDS.filter((command) => command.type === 3).length, 2);
  assert.equal(COMMANDS.length, 15);
});

test('Discord admin commands are hidden behind Manage Server by default', () => {
  for (const name of ['model', 'settings', 'reset', 'compact']) {
    assert.equal(COMMANDS.find((command) => command.name === name)?.default_member_permissions, '32', name);
  }
});

test('Discord command options cover the native interactions', () => {
  const ask = COMMANDS.find((command) => command.name === 'ask');
  assert.deepEqual(
    ask?.options?.map((option) => option.name),
    ['prompt', 'private', 'thread', 'image'],
  );
  assert.equal(ask?.options?.find((option) => option.name === 'image')?.type, 11);
  const image = COMMANDS.find((command) => command.name === 'image');
  const count = image?.options?.find((option) => option.name === 'count');
  assert.equal(count?.min_value, 1);
  assert.equal(count?.max_value, 25);
  const catchup = COMMANDS.find((command) => command.name === 'catchup');
  const hours = catchup?.options?.find((option) => option.name === 'hours');
  assert.equal(hours?.min_value, 1);
  assert.equal(hours?.max_value, 168);
  const remind = COMMANDS.find((command) => command.name === 'remind');
  assert.deepEqual(
    remind?.options?.map((option) => option.name),
    ['add', 'list', 'cancel'],
  );
});

test('Discord help has no Zalo-only features', () => {
  const bullets = helpBullets(COMMANDS, {}).join('\n');
  assert.match(bullets, /`\/ask`/);
  assert.doesNotMatch(bullets, /`\/(sticker|tone|split|think)`/);
  assert.match(HELP_NOTE, /Explain message/);
  assert.match(HELP_NOTE, /Summarize message/);
});

test('Zalo help still includes the sticker command and its order', () => {
  const bullets = helpBullets(ZALO_COMMAND_SPECS, ZALO_HELP_OVERRIDES);
  assert.deepEqual(namesIn(bullets), [
    'help',
    'status',
    'id',
    'reset',
    'compact',
    'summary',
    'search',
    'image',
    'sticker',
    'remind',
    'model',
    'tone',
    'think',
    'split',
    'ping',
  ]);
  assert.equal(bullets.length, 15);
  assert.match(bullets.join('\n'), /`\/sticker \[mood\]`/);
});

test('shared and platform specs have complete metadata', () => {
  assert.equal(COMMAND_SPECS.length, 14);
  assert.equal(ZALO_COMMAND_SPECS.length, 15);
  for (const spec of [...COMMAND_SPECS, ...ZALO_COMMAND_SPECS, ...COMMANDS]) {
    assert.equal(typeof spec.name, 'string');
    assert.equal(typeof spec.help, 'string');
    assert.doesNotMatch(spec.help, /^• /);
  }
});
