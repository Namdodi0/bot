import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_SPECS, helpBullets, slashCommandPayloads } from '../src/core/commands/registry.js';
import {
  DISCORD_COMMAND_SPECS,
  DISCORD_HELP_OVERRIDES,
} from '../src/platforms/discord/commands.js';
import { ZALO_COMMAND_SPECS, ZALO_HELP_OVERRIDES } from '../src/platforms/zalo/commands.js';

/** @param {string[]} bullets */
const namesIn = (bullets) => bullets.map((line) => /^• `\/([a-z]+)/.exec(line)?.[1]);

test('slashCommandPayloads returns the 14 Discord commands without Zalo-only sticker', () => {
  const payloads = slashCommandPayloads(DISCORD_COMMAND_SPECS);
  assert.equal(payloads.length, 14);
  assert.equal(payloads.some((payload) => payload.name === 'sticker'), false);
  assert.equal(payloads.some((payload) => payload.name === 'help'), true);
  assert.equal(payloads.find((payload) => payload.name === 'ping')?.description, 'Check the Discord connection');
});

test('slashCommandPayloads keeps Discord option definitions', () => {
  const payloads = slashCommandPayloads(DISCORD_COMMAND_SPECS);
  const reset = payloads.find((payload) => payload.name === 'reset');
  assert.deepEqual(reset?.options, [
    { name: 'all', description: 'Also clear per-chat settings', type: 5 },
  ]);
  const remind = payloads.find((payload) => payload.name === 'remind');
  assert.deepEqual(
    remind?.options?.map((option) => option.name),
    ['when', 'text'],
  );
  const help = payloads.find((payload) => payload.name === 'help');
  assert.equal('options' in (help ?? {}), false);
});

test('helpBullets includes /sticker on Zalo and hides it on Discord', () => {
  assert.match(helpBullets(ZALO_COMMAND_SPECS, ZALO_HELP_OVERRIDES).join('\n'), /`\/sticker \[mood\]`/);
  assert.doesNotMatch(helpBullets(DISCORD_COMMAND_SPECS, DISCORD_HELP_OVERRIDES).join('\n'), /\/sticker/);
});

test('ping help wording depends on the platform', () => {
  const zaloPing = helpBullets(ZALO_COMMAND_SPECS, ZALO_HELP_OVERRIDES).find((line) => line.includes('`/ping`'));
  const discordPing = helpBullets(DISCORD_COMMAND_SPECS, DISCORD_HELP_OVERRIDES).find((line) =>
    line.includes('`/ping`'),
  );
  assert.equal(zaloPing, '• `/ping` — check the connection to Zalo');
  assert.equal(discordPing, '• `/ping` — check the Discord connection');
});

test('helpBullets keeps the original help order and contents for Zalo', () => {
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
  assert.equal(bullets[0], '• `/help` — list of commands');
  assert.equal(bullets[4], '• `/compact` — compact the context now (admin)');
  assert.equal(bullets[14], '• `/ping` — check the connection to Zalo');
});

test('shared and platform specs have complete metadata', () => {
  assert.equal(COMMAND_SPECS.length, 14);
  assert.equal(DISCORD_COMMAND_SPECS.length, 14);
  assert.equal(ZALO_COMMAND_SPECS.length, 15);
  for (const spec of [...COMMAND_SPECS, ...ZALO_COMMAND_SPECS, ...DISCORD_COMMAND_SPECS]) {
    assert.equal(typeof spec.name, 'string');
    assert.equal(typeof spec.description, 'string');
    assert.equal(typeof spec.help, 'string');
    assert.doesNotMatch(spec.help, /^• /);
  }
});