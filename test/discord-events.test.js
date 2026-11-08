import test from 'node:test';
import assert from 'node:assert/strict';
import { createInteractionRouter } from '../src/platforms/discord/interaction-router.js';
import {
  isBotAddressed,
  isChannelAllowed,
  isRespondToAllChannel,
  messageText,
  replyQuote,
  toDiscordEvent,
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

test('discord message: DMs are private and empty messages are ignored', () => {
  const dm = toDiscordEvent(message({ channel: { id: 'd1', isDMBased: () => true } }), client);
  assert.equal(dm.chatType, 'PRIVATE');
  assert.equal(toDiscordEvent(message({ content: '<@bot1>' }), client), null);
});

test('discord message: a text file alone is a text event, binary-only messages are ignored', () => {
  const withFile = message({
    content: '<@bot1>',
    attachments: {
      values: () => [{ name: 'notes.md', contentType: 'text/markdown', url: 'https://cdn/notes.md' }],
    },
  });
  const event = toDiscordEvent(withFile, client);
  assert.equal(event.kind, 'text');
  assert.equal(event.text, '');

  const withPdf = message({
    content: '<@bot1>',
    attachments: {
      values: () => [{ name: 'doc.pdf', contentType: 'application/pdf', url: 'https://cdn/doc.pdf' }],
    },
  });
  assert.equal(toDiscordEvent(withPdf, client), null);
});

test('reply quotes read text from a Components V2 message', () => {
  const referenced = {
    author: { username: 'Bot' },
    content: '',
    components: [{ toJSON: () => ({ type: 10, content: 'Câu trả lời cũ' }) }],
  };
  assert.equal(messageText(referenced), 'Câu trả lời cũ');
  assert.equal(replyQuote(referenced, 'bot1'), '[Replying to Bot: Câu trả lời cũ]');
});

test('isBotAddressed covers mention, role, reply, DM and respond-to-all channels', () => {
  assert.equal(isBotAddressed({}), false);
  assert.equal(isBotAddressed({ mentioned: true }), true);
  assert.equal(isBotAddressed({ roleMentioned: true }), true);
  assert.equal(isBotAddressed({ repliedToBot: true }), true);
  assert.equal(isBotAddressed({ isDm: true }), true);
  assert.equal(isBotAddressed({ listensHere: true }), true);
});

test('native interactions use the Discord allow-list, not the root config', async () => {
  const config = { discord: { allowedChannelIds: ['allowed'] } };
  let handled = 0;
  const route = createInteractionRouter({ config, commands: { handleCommand: async () => { handled += 1; } } });
  /** @param {string} channelId */
  function interaction(channelId) {
    return {
      guildId: 'guild-1',
      channelId,
      channel: { id: channelId },
      isAutocomplete: () => false,
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => true,
      isMessageContextMenuCommand: () => false,
      isRepliable: () => true,
      replies: [],
      async reply(payload) {
        this.replies.push(payload);
      },
    };
  }

  const blocked = interaction('blocked');
  await route(blocked);
  assert.equal(handled, 0);
  assert.match(String(blocked.replies[0]?.content), /guest list/);

  const allowed = interaction('allowed');
  await route(allowed);
  assert.equal(handled, 1);
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


test('discord message: the largest image attachment wins', () => {
  const small = { url: 'https://cdn.example/small.png', contentType: 'image/png', width: 32, height: 32, size: 900 };
  const big = { url: 'https://cdn.example/photo.jpg', contentType: 'image/jpeg', width: 1920, height: 1080, size: 5000 };
  const event = toDiscordEvent(
    message({ content: '', attachments: { values: () => [small, big] } }),
    client,
  );
  assert.equal(event.imageUrl, 'https://cdn.example/photo.jpg');
  assert.deepEqual(event.imageUrls, ['https://cdn.example/photo.jpg', 'https://cdn.example/small.png']);
});

test('discord message: image urls are capped at five, largest first', () => {
  const attachments = Array.from({ length: 8 }, (_, index) => ({
    url: `https://cdn.example/${index}.png`,
    contentType: 'image/png',
    width: 100 + index,
    height: 100,
  }));
  attachments.splice(3, 0, { url: 'https://cdn.example/note.txt', contentType: 'text/plain', size: 9999 });
  const event = toDiscordEvent(message({ content: 'look', attachments: { values: () => attachments } }), client);
  assert.equal(event.imageUrls.length, 5);
  assert.deepEqual(
    event.imageUrls,
    [7, 6, 5, 4, 3].map((index) => `https://cdn.example/${index}.png`),
  );
  assert.equal(event.imageUrl, 'https://cdn.example/7.png');
});
