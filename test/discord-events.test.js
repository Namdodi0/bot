import test from 'node:test';
import assert from 'node:assert/strict';
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

