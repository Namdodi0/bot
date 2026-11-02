import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMAND_SPECS,
  commandSpecsFor,
  helpBullets,
  slashCommandPayloads,
} from '../src/commands/registry.js';

/** @param {string[]} bullets */
const namesIn = (bullets) => bullets.map((line) => /^• `\/([a-z]+)/.exec(line)?.[1]);

test('slashCommandPayloads returns the 14 Discord commands without Zalo-only sticker', () => {
  const payloads = slashCommandPayloads();
  assert.equal(payloads.length, 14);
  assert.equal(payloads.some((payload) => payload.name === 'sticker'), false);
  assert.equal(payloads.some((payload) => payload.name === 'help'), true);
});

test('slashCommandPayloads keeps Discord option definitions', () => {
  const payloads = slashCommandPayloads();
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
  assert.match(helpBullets('zalo').join('\n'), /`\/sticker \[mood\]`/);
  assert.doesNotMatch(helpBullets('discord').join('\n'), /\/sticker/);
});

test('ping help wording depends on the platform', () => {
  const zaloPing = helpBullets('zalo').find((line) => line.includes('`/ping`'));
  const discordPing = helpBullets('discord').find((line) => line.includes('`/ping`'));
  assert.equal(zaloPing, '• `/ping` — check the connection to Zalo');
  assert.equal(discordPing, '• `/ping` — check the Discord connection');
});

test('helpBullets keeps the original help order and contents for Zalo', () => {
  assert.deepEqual(namesIn(helpBullets('zalo')), [
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
  const bullets = helpBullets('zalo');
  assert.equal(bullets.length, 15);
  assert.equal(bullets[0], '• `/help` — list of commands');
  assert.equal(
    bullets[4],
    '• `/compact` — compact the context now (admin)',
  );
  assert.equal(
    bullets[14],
    '• `/ping` — check the connection to Zalo',
  );
});

test('commandSpecsFor filters by platform and every spec has metadata', () => {
  assert.equal(commandSpecsFor('discord').length, 14);
  assert.equal(commandSpecsFor('zalo').length, 15);
  for (const spec of COMMAND_SPECS) {
    assert.equal(typeof spec.name, 'string');
    assert.equal(typeof spec.description, 'string');
    assert.equal(typeof spec.help, 'string');
    assert.doesNotMatch(spec.help, /^• /);
  }
});
