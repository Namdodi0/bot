import test from 'node:test';
import assert from 'node:assert/strict';
import { isChannelAllowed, stripBotMention, isBotAddressed, toDiscordEvent, toDiscordInteractionEvent } from '../src/discord/events.js';

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

test('stripBotMention also removes the bot managed role mention', () => {
  assert.equal(stripBotMention('<@&role1> hi', 'bot1', 'role1'), 'hi');
  assert.equal(stripBotMention('<@&other> hi', 'bot1', 'role1'), '<@&other> hi');
});

test('discord message: the managed role mention is stripped from the text', () => {
  const event = toDiscordEvent(
    message({
      content: '<@&role1> hello there',
      mentions: { users: { has: () => false }, roles: { values: () => [{ id: 'role1', tags: { botId: 'bot1' } }] } },
    }),
    client,
  );
  assert.equal(event.text, 'hello there');
});

test('isBotAddressed covers mention, role, reply, DM and respond-to-all channels', () => {
  assert.equal(isBotAddressed({}), false);
  assert.equal(isBotAddressed({ mentioned: true }), true);
  assert.equal(isBotAddressed({ roleMentioned: true }), true);
  assert.equal(isBotAddressed({ repliedToBot: true }), true);
  assert.equal(isBotAddressed({ isDm: true }), true);
  assert.equal(isBotAddressed({ listensHere: true }), true);
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

test('isChannelAllowed allows every channel when the list is empty', () => {
  assert.equal(isChannelAllowed({}, { id: 'c1' }), true);
  assert.equal(isChannelAllowed(undefined, { id: 'c1' }), true);
  assert.equal(isChannelAllowed({ allowedChannelIds: [] }, { id: 'c1' }), true);
});

test('isChannelAllowed always allows DMs', () => {
  const config = { allowedChannelIds: ['c1'] };
  assert.equal(isChannelAllowed(config, { id: 'dm1', isDMBased: () => true }), true);
});

test('isChannelAllowed matches exact channel ids', () => {
  const config = { allowedChannelIds: ['c1'] };
  assert.equal(isChannelAllowed(config, { id: 'c1' }), true);
  assert.equal(isChannelAllowed(config, { id: 'c2' }), false);
});

test('isChannelAllowed lets threads inherit their parent channel entry', () => {
  const config = { allowedChannelIds: ['c1'] };
  assert.equal(isChannelAllowed(config, { id: 't1', parentId: 'c1' }), true);
  assert.equal(isChannelAllowed(config, { id: 't2', parentId: 'c-other' }), false);
});

test('photoCaption clamps the caption to the Discord content limit', async () => {
  const { photoCaption, DISCORD_MAX_CONTENT } = await import('../src/discord/client.js');
  assert.equal(DISCORD_MAX_CONTENT, 2000);
  assert.equal(photoCaption('short'), 'short');
  assert.equal(photoCaption(''), '');
  assert.equal(photoCaption(undefined), '');
  assert.equal(photoCaption('x'.repeat(2500)).length, 2000);
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

test('isBotRoleMentioned accepts the bot managed role only', async () => {
  const { isBotRoleMentioned } = await import('../src/discord/events.js');
  const message = (botId) => ({
    mentions: {
      roles: new Map([['r1', { id: 'r1', tags: { botId } }]]),
    },
  });
  assert.equal(isBotRoleMentioned(message('bot1'), 'bot1'), true);
  assert.equal(isBotRoleMentioned(message('other-bot'), 'bot1'), false);
  assert.equal(isBotRoleMentioned({ mentions: { roles: new Map() } }, 'bot1'), false);
});
