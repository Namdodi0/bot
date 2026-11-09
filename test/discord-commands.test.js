import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { COMMANDS } from '../src/platforms/discord/specs.js';
import { makeDiscordCommands as makeCommands, makeInteraction as interaction } from '../test-utils/discord.js';

test('slash command descriptions stay within the Discord 100-char limit', () => {
  /** @param {any[]} items @param {string} [prefix] */
  const check = (items, prefix = '') => {
    for (const item of items) {
      const label = `${prefix}${item.name}`;
      assert.ok(String(item.description ?? '').length <= 100, `${label} description is too long`);
      if (item.options) check(item.options, `${label}:`);
    }
  };
  check(COMMANDS);
});

function isV2(payload) {
  return Boolean(payload?.flags && (payload.flags & MessageFlags.IsComponentsV2) !== 0);
}

function payloadJson(payload) {
  return (payload?.components ?? []).map((component) => component?.toJSON?.()).filter(Boolean);
}

function payloadText(payload) {
  if (!isV2(payload)) return String(payload?.content ?? '');
  return String(payloadJson(payload).find((component) => component.type === 10)?.content ?? '');
}

test('/ask streams a preview edit and then renders the final answer', async () => {
  const { commands } = makeCommands();
  const i = interaction('ask', { prompt: 'hello', private: true });
  await commands.handleCommand(i);
  assert.equal(i.deferred, true);
  assert.ok(
    i.edits.some((payload) => isV2(payload) && payloadText(payload) === 'Answer '),
    'a V2 preview edit should arrive before the final answer',
  );
  const finalPayload = i.edits[i.edits.length - 1];
  assert.equal(payloadText(finalPayload), 'Answer text');
  assert.ok(isV2(finalPayload), 'the final answer must use Components V2');
  assert.equal(
    payloadJson(finalPayload).some((component) => component.type === 1),
    false,
    'answers must not carry an action row',
  );
});

test('/ask puts images in the same V2 answer message', async () => {
  const { commands, runtime } = makeCommands();
  runtime.agent.stream = async () => ({
    text: 'Here are the cats.',
    photos: [{ url: 'https://x/a.png', caption: 'cat', data: Buffer.from('png'), contentType: 'image/png' }],
  });
  const i = interaction('ask', { prompt: 'cats', private: true });
  await commands.handleCommand(i);

  const final = i.edits.at(-1);
  assert.equal(final.files?.length, 1);
  assert.ok(payloadJson(final).some((component) => component.type === 12), 'a MediaGallery is required');
  assert.equal(i.follows.some((payload) => payload.files?.length), false, 'no separate photo message');
});

test('/ask rejects a non-image attachment without calling the agent', async () => {
  const { commands, runtime } = makeCommands();
  let called = false;
  runtime.agent.stream = async () => {
    called = true;
    return { text: '', photos: [] };
  };
  const i = interaction('ask', {
    prompt: 'read this',
    image: { contentType: 'application/pdf', size: 1024, url: 'https://cdn.example/doc.pdf' },
  });
  await commands.handleCommand(i);
  assert.equal(called, false);
  assert.equal(i.deferred, true);
  assert.match(payloadText(i.edits[0]), /must be an image/);
});

test('/stop stops the current turn in this channel', async () => {
  const { commands, runtime } = makeCommands();
  let stopped = null;
  runtime.agent.stop = (chatId) => {
    stopped = chatId;
    return true;
  };
  const i = interaction('stop');
  await commands.handleCommand(i);
  assert.equal(stopped, 'c1');
  assert.match(i.replies[0].content, /Stopped/);
});

test('the remind modal creates a reminder', async () => {
  const { commands, runtime } = makeCommands();
  const added = [];
  runtime.reminders.add = async (input) => {
    added.push(input);
    return { ok: true, item: { id: 3, at: input.at, text: input.text } };
  };
  const modal = {
    customId: 'remind-form',
    channelId: 'c1',
    user: { id: 'u1' },
    fields: { getTextInputValue: (key) => (key === 'remind-when' ? '+10m' : 'water') },
    reply: async (payload) => {
      modal.payload = payload;
    },
  };
  await commands.handleModal(modal);
  assert.equal(added[0].chatId, 'c1');
  assert.equal(added[0].text, 'water');
  assert.equal(added[0].createdBy, 'u1');
  assert.ok(added[0].at > Date.now());
  assert.match(modal.payload.content, /Reminder #3/);
});

test('a native command reports busy when the shared chat queue rejects it', async () => {
  const { commands, runtime } = makeCommands();
  runtime.agent.exclusive = async () => {
    const error = new Error('queue is full');
    error.name = 'QueueFullError';
    throw error;
  };
  const i = interaction('summary', { count: 5 });
  await commands.handleCommand(i);
  assert.match(String(i.edits.at(-1)?.content), /too many messages/);
});

test('/catchup requires the requester to have Read Message History', async () => {
  const { commands } = makeCommands();
  const i = interaction('catchup', { hours: 1 }, { memberPermissions: { has: () => false } });
  await commands.handleCommand(i);
  assert.equal(Boolean(i.deferred), false);
  assert.match(String(i.replies[0]?.content), /Read Message History/);
});

test('private /ask wins over thread and never creates a public thread', async () => {
  const { commands, runtime } = makeCommands();
  const threads = [];
  const channel = {
    id: 'c1',
    threads: {
      create: async () => {
        threads.push('created');
        return { id: 't1', send: async () => ({ edit: async () => {} }) };
      },
    },
  };
  let seen = null;
  runtime.agent.stream = async (event) => {
    seen = event;
    return { text: 'secret answer', photos: [] };
  };

  const i = interaction('ask', { prompt: 'top secret', private: true, thread: true }, { channel, guild: { id: 'g1' } });
  await commands.handleCommand(i);

  assert.deepEqual(threads, [], 'a private answer must not post to a thread');
  assert.ok(i.deferPayload.flags, 'the deferral must be ephemeral');
  assert.equal(payloadText(i.edits.at(-1)), 'secret answer');
  assert.equal(seen.private, true);
  const note = i.follows.at(-1);
  assert.match(note.content, /skip threads/);
  assert.ok(note.flags, 'the note must be ephemeral too');
});

test('every model-text payload from /ask disables mention parsing', async () => {
  const { commands } = makeCommands();
  const i = interaction('ask', { prompt: 'hello @everyone', private: true });
  await commands.handleCommand(i);
  const payloads = [...i.edits, ...i.follows];
  assert.ok(payloads.some((payload) => payloadText(payload) === 'Answer '), 'a preview edit should be present');
  for (const payload of payloads) {
    assert.deepEqual(payload.allowedMentions, { parse: [] }, 'every answer payload must not ping');
  }
});

test('/help returns an ephemeral V2 Container panel', async () => {
  const { commands } = makeCommands();
  const i = interaction('help');
  await commands.handleCommand(i);
  const payload = i.replies.at(-1);
  assert.ok(isV2(payload), 'panels must use Components V2');
  assert.ok((payload.flags & MessageFlags.Ephemeral) !== 0, 'the V2 flag must survive the ephemeral wrap');
  const [container] = payloadJson(payload);
  assert.equal(container.type, 17);
  assert.equal(container.components[0].type, 10);
});

test('/settings toggles thinking-after-answer for the channel', async () => {
  const { commands, runtime } = makeCommands();
  const click = interaction('', {}, { customId: 'settings:thinking' });
  await commands.handleButton(click);
  assert.equal(runtime.record.meta.showThinking, false);
  assert.match(JSON.stringify(click.edits.at(-1)), /Thinking above answer/);

  const again = interaction('', {}, { customId: 'settings:thinking' });
  await commands.handleButton(again);
  assert.equal(runtime.record.meta.showThinking, true);
});

test('/settings vision stores a per-channel vision model and can reset it', async () => {
  const { commands, runtime } = makeCommands();
  const pick = interaction('settings', { vision: 'mistral-large' });
  await commands.handleCommand(pick);

  assert.equal(runtime.record.meta.visionModel, 'mistral-large');
  assert.match(String(pick.replies.at(-1)?.content ?? ''), /Vision model is now/);

  const reset = interaction('settings', { vision: 'default' });
  await commands.handleCommand(reset);
  assert.equal(runtime.record.meta.visionModel, undefined);
  assert.match(String(reset.replies.at(-1)?.content ?? ''), /reset to the default/);
});

test('/settings vision rejects text-only models', async () => {
  const { commands, runtime } = makeCommands();
  const i = interaction('settings', { vision: 'deepseek' });
  await commands.handleCommand(i);

  assert.equal(runtime.record.meta.visionModel, undefined);
  assert.match(JSON.stringify(i.replies.at(-1)), /not a vision-capable model/);
});

test('/reasoning shows the latest answer thinking only to the caller', async () => {
  const { commands, runtime } = makeCommands();
  runtime.record.messages.push(
    { role: 'assistant', kind: 'turn', text: 'older', reasoning: 'older thinking' },
    { role: 'user', kind: 'turn', text: 'next question' },
    { role: 'assistant', kind: 'turn', text: 'latest', reasoning: 'latest thinking' },
  );
  const i = interaction('reasoning');
  await commands.handleCommand(i);

  assert.equal(i.deferred, true);
  assert.equal(i.deferPayload?.flags, MessageFlags.Ephemeral);
  assert.match(payloadText(i.edits.at(-1)), /latest thinking/);
  assert.doesNotMatch(payloadText(i.edits.at(-1)), /older thinking/);
});

test('/reasoning says when the latest answer has no reasoning', async () => {
  const { commands, runtime } = makeCommands();
  runtime.record.messages.push({ role: 'assistant', kind: 'turn', text: 'latest' });
  const i = interaction('reasoning');
  await commands.handleCommand(i);

  assert.match(payloadText(i.edits.at(-1)), /without any reasoning/);
});

