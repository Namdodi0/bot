import test from 'node:test';
import assert from 'node:assert/strict';
import { stripBotMention, toDiscordEvent, toDiscordInteractionEvent } from '../src/discord/events.js';

const client = { user: { id: 'bot1', username: 'Bot deepseek' } };

function message(overrides = {}) {
  return {
    id: 'm1',
    content: '<@bot1> hello there',
    createdTimestamp: 1000,
    author: { id: 'u1', username: 'nam', displayName: 'Nam', bot: false },
    member: { displayName: 'Nam', permissions: { has: () => true } },
    channel: { id: 'c1', isDMBased: () => false },
    attachments: { values: () => [] },
    ...overrides,
  };
}

test('discord message: strips the bot mention and keeps sender info', () => {
  const event = toDiscordEvent(message(), client);
  assert.equal(event.chatId, 'discord:c1');
  assert.equal(event.chatType, 'GROUP');
  assert.equal(event.text, 'hello there');
  assert.equal(event.senderName, 'Nam');
  assert.equal(event.isAdmin, true);
  assert.equal(event.platform, 'discord');
  assert.equal(event.botName, 'Bot deepseek');
  assert.equal(event.messageId, 'm1');
});

test('discord message: image attachment becomes an image event', () => {
  const event = toDiscordEvent(
    message({
      content: '',
      attachments: { values: () => [{ contentType: 'image/png', url: 'https://cdn.example/a.png' }] },
    }),
    client,
  );
  assert.equal(event.kind, 'image');
  assert.equal(event.imageUrl, 'https://cdn.example/a.png');
});

test('discord message: DMs are private and empty messages are ignored', () => {
  const dm = toDiscordEvent(message({ channel: { id: 'd1', isDMBased: () => true } }), client);
  assert.equal(dm.chatType, 'PRIVATE');
  assert.equal(toDiscordEvent(message({ content: '<@bot1>' }), client), null);
});

test('stripBotMention removes only the bot mention', () => {
  assert.equal(stripBotMention('<@!bot1> hi <@other>', 'bot1'), 'hi <@other>');
});

test('slash interaction becomes a synthetic text command', () => {
  const interaction = {
    commandName: 'reset',
    channelId: 'c9',
    guildId: 'g1',
    createdTimestamp: 5,
    user: { id: 'u2', username: 'x' },
    member: { displayName: 'X' },
    memberPermissions: { has: () => true },
    options: { data: [{ name: 'all', value: true }] },
  };
  const event = toDiscordInteractionEvent(interaction, client);
  assert.equal(event.text, '/reset all');
  assert.equal(event.chatId, 'discord:c9');
  assert.equal(event.chatType, 'GROUP');
  assert.equal(event.isAdmin, true);
});

test('discord transport constructs without logging in', async () => {
  const { createDiscordTransport } = await import('../src/discord/client.js');
  const transport = createDiscordTransport({
    token: 'dummy',
    config: {},
    onEvent: () => {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  for (const method of ['start', 'stop', 'sendMessage', 'sendPhoto', 'sendSticker', 'startTyping', 'stopAllTyping', 'ping']) {
    assert.equal(typeof transport[method], 'function', method);
  }
  assert.equal(transport.displayName, '');
  assert.equal(transport.ping('discord:1'), 0);
});
