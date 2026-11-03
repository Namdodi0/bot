import test from 'node:test';
import assert from 'node:assert/strict';
import {
  eventFromInteraction,
  isBotAddressed,
  isChannelAllowed,
  isRespondToAllChannel,
  stripBotMention,
  toDiscordEvent,
} from '../src/platforms/discord/events.js';
import { photoCaption, photoFilename } from '../src/platforms/discord/transport.js';

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

test('discord message: raw channel id, mention stripped, sender info kept', () => {
  const event = toDiscordEvent(message(), client);
  assert.equal(event.chatId, 'c1');
  assert.equal(event.chatType, 'GROUP');
  assert.equal(event.text, 'hello there');
  assert.equal(event.senderName, 'Nam');
  assert.equal(event.isAdmin, true);
  assert.equal(event.platform, 'discord');
  assert.equal(event.botName, 'Bot deepseek');
  assert.equal(event.messageId, 'm1');
});

test('discord message: first image attachment becomes an image event', () => {
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

test('the bot managed role mention is stripped from the text', () => {
  const event = toDiscordEvent(
    message({
      content: '<@&role1> hello there',
      mentions: { users: { has: () => false }, roles: { values: () => [{ id: 'role1', tags: { botId: 'bot1' } }] } },
    }),
    client,
  );
  assert.equal(event.text, 'hello there');
});

test('stripBotMention removes bot and managed-role mentions only', () => {
  assert.equal(stripBotMention('<@!bot1> hi <@other>', 'bot1'), 'hi <@other>');
  assert.equal(stripBotMention('<@&role1> hi', 'bot1', 'role1'), 'hi');
  assert.equal(stripBotMention('<@&other> hi', 'bot1', 'role1'), '<@&other> hi');
});

test('isBotAddressed covers mention, role, reply, DM and respond-to-all channels', () => {
  assert.equal(isBotAddressed({}), false);
  assert.equal(isBotAddressed({ mentioned: true }), true);
  assert.equal(isBotAddressed({ roleMentioned: true }), true);
  assert.equal(isBotAddressed({ repliedToBot: true }), true);
  assert.equal(isBotAddressed({ isDm: true }), true);
  assert.equal(isBotAddressed({ listensHere: true }), true);
});

test('allowed channels cover DMs and threads, respond-to-all covers threads', () => {
  const config = { allowedChannelIds: ['general'], respondToAllChannelIds: ['chatty'] };
  assert.equal(isChannelAllowed(config, { id: 'general' }), true);
  assert.equal(isChannelAllowed(config, { id: 'thread-1', parentId: 'general' }), true);
  assert.equal(isChannelAllowed(config, { id: 'other' }), false);
  assert.equal(isChannelAllowed(config, { id: 'dm', isDMBased: () => true }), true);
  assert.equal(isChannelAllowed({}, { id: 'other' }), true);

  assert.equal(isRespondToAllChannel(config, { id: 'chatty' }), true);
  assert.equal(isRespondToAllChannel(config, { id: 'thread-2', parentId: 'chatty' }), true);
  assert.equal(isRespondToAllChannel(config, { id: 'general' }), false);
});

test('interactions become the same normalized event as messages', () => {
  const interaction = {
    id: 'i1',
    channelId: 'c9',
    guildId: 'g1',
    createdTimestamp: 5,
    user: { id: 'u2', username: 'x' },
    member: { displayName: 'X' },
    memberPermissions: { has: () => true },
    options: { data: [] },
  };
  const event = eventFromInteraction(interaction, client, 'hello');
  assert.equal(event.chatId, 'c9');
  assert.equal(event.text, 'hello');
  assert.equal(event.chatType, 'GROUP');
  assert.equal(event.isAdmin, true);
  assert.equal(event.messageId, 'interaction:i1');

  const dm = eventFromInteraction({ ...interaction, guildId: null }, client, 'hi');
  assert.equal(dm.chatType, 'PRIVATE');
  assert.equal(dm.isAdmin, false);
});

test('photo files get an image extension and captions respect the limit', () => {
  assert.equal(photoFilename('https://x/a.PNG'), 'image.png');
  assert.equal(photoFilename('https://x/a', 'image/jpeg'), 'image.jpg');
  assert.equal(photoFilename('https://x/a.webp?x=1', 'application/octet-stream'), 'image.webp');
  assert.equal(photoFilename('https://x/a'), 'image.png');
  assert.equal(photoCaption('short'), 'short');
  assert.equal(photoCaption(''), '');
  assert.equal(photoCaption('x'.repeat(2500)).length, 2000);
});

test('discord transport constructs without logging in', async () => {
  const { createDiscordTransport } = await import('../src/platforms/discord/transport.js');
  const transport = createDiscordTransport({
    token: 'dummy',
    config: {},
    onEvent: () => {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  for (const method of [
    'start',
    'stop',
    'sendMessage',
    'sendPhoto',
    'sendSticker',
    'editMessage',
    'react',
    'sendEmbed',
    'createThread',
    'startTyping',
    'stopAllTyping',
    'ping',
  ]) {
    assert.equal(typeof transport[method], 'function', method);
  }
  assert.equal(transport.displayName, '');
  assert.equal(transport.ping(), 0);
});
