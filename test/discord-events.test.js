import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isBotAddressed,
  isChannelAllowed,
  isRespondToAllChannel,
  stripBotMention,
  toDiscordEvent,
  toDiscordInteractionEvent,
} from '../src/platforms/discord/events.js';

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

test('respond-to-all channels also cover their threads', () => {
  const config = { respondToAllChannelIds: ['general'] };
  assert.equal(isRespondToAllChannel(config, { id: 'general' }), true);
  assert.equal(isRespondToAllChannel(config, { id: 'thread-1', parentId: 'general' }), true);
  assert.equal(isRespondToAllChannel(config, { id: 'other' }), false);
  assert.equal(isRespondToAllChannel({}, { id: 'general' }), false);
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
  const { photoCaption, DISCORD_MAX_CONTENT } = await import('../src/platforms/discord/client.js');
  assert.equal(DISCORD_MAX_CONTENT, 2000);
  assert.equal(photoCaption('short'), 'short');
  assert.equal(photoCaption(''), '');
  assert.equal(photoCaption(undefined), '');
  assert.equal(photoCaption('x'.repeat(2500)).length, 2000);
});

test('discord transport constructs without logging in', async () => {
  const { createDiscordTransport } = await import('../src/platforms/discord/client.js');
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
  assert.equal(transport.ping('discord:1'), 0);
});

function fakeDiscordClient() {
  /** @type {Record<string, Function>} */
  const handlers = {};
  return {
    handlers,
    client: {
      user: { id: 'bot1', username: 'Bot deepseek' },
      ws: { ping: 42 },
      channels: { cache: new Map() },
      application: null,
      on(event, handler) {
        handlers[event] = handler;
      },
      once() {},
      async login() {},
      async destroy() {},
    },
  };
}

test('photo uploads keep an image extension so Discord renders them inline', async () => {
  const { photoFilename, createDiscordTransport } = await import('../src/platforms/discord/client.js');
  assert.equal(photoFilename('https://x/a.PNG', undefined), 'image.png');
  assert.equal(photoFilename('https://x/a', 'image/jpeg'), 'image.jpg');
  assert.equal(photoFilename('https://x/a.webp?x=1', 'application/octet-stream'), 'image.webp');
  assert.equal(photoFilename('https://x/a', 'image/avif'), 'image.png');

  /** @type {any[]} */
  const sent = [];
  const { client } = fakeDiscordClient();
  client.channels.cache.set('c1', { send: async (payload) => sent.push(payload) });
  const transport = createDiscordTransport({
    token: 'dummy',
    config: {},
    onEvent: () => {},
    createClient: () => client,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });

  await transport.sendPhoto('discord:c1', 'https://x/a', 'caption', {
    data: Buffer.from('webp-bytes'),
    contentType: 'image/webp',
  });
  assert.equal(sent[0].files[0].name, 'image.webp');
  assert.equal(sent[0].content, 'caption');
});

test('native slash handlers bypass the text router', async () => {
  const { createDiscordTransport } = await import('../src/platforms/discord/client.js');
  const { handlers, client } = fakeDiscordClient();
  const calls = { native: 0, defer: 0, delete: 0, events: 0 };
  /** @type {any} */
  let received = null;
  const transport = createDiscordTransport({
    token: 'dummy',
    config: {},
    commandSpecs: [],
    nativeCommands: {
      custom: async (interaction) => {
        calls.native += 1;
        received = interaction;
      },
    },
    onEvent: () => {
      calls.events += 1;
    },
    createClient: () => client,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  await transport.start();

  const interaction = {
    isChatInputCommand: () => true,
    commandName: 'custom',
    channelId: 'c1',
    guildId: 'g1',
    async deferReply() {
      calls.defer += 1;
    },
    async deleteReply() {
      calls.delete += 1;
    },
  };
  handlers.interactionCreate(interaction);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.native, 1);
  assert.equal(received, interaction);
  assert.equal(calls.defer, 0);
  assert.equal(calls.delete, 0);
  assert.equal(calls.events, 0);
});

test('non-native slash commands still become synthetic text events', async () => {
  const { createDiscordTransport } = await import('../src/platforms/discord/client.js');
  const { handlers, client } = fakeDiscordClient();
  const calls = { defer: 0, delete: 0 };
  /** @type {any} */
  let event = null;
  const transport = createDiscordTransport({
    token: 'dummy',
    config: {},
    commandSpecs: [],
    nativeCommands: {},
    onEvent: (incoming) => {
      event = incoming;
    },
    createClient: () => client,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  await transport.start();

  handlers.interactionCreate({
    isChatInputCommand: () => true,
    commandName: 'help',
    channelId: 'c1',
    guildId: 'g1',
    createdTimestamp: 1,
    user: { id: 'u1', username: 'nam' },
    member: { displayName: 'Nam' },
    memberPermissions: { has: () => false },
    options: { data: [] },
    async deferReply() {
      calls.defer += 1;
    },
    async deleteReply() {
      calls.delete += 1;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(event.text, '/help');
  assert.equal(event.rawInteraction?.commandName, 'help');
  assert.equal(calls.defer, 1);
  assert.equal(calls.delete, 1);
});

test('isBotRoleMentioned accepts the bot managed role only', async () => {
  const { isBotRoleMentioned } = await import('../src/platforms/discord/events.js');
  const message = (botId) => ({
    mentions: {
      roles: new Map([['r1', { id: 'r1', tags: { botId } }]]),
    },
  });
  assert.equal(isBotRoleMentioned(message('bot1'), 'bot1'), true);
  assert.equal(isBotRoleMentioned(message('other-bot'), 'bot1'), false);
  assert.equal(isBotRoleMentioned({ mentions: { roles: new Map() } }, 'bot1'), false);
});
