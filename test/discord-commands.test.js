import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDiscordCommands as makeCommands, makeInteraction as interaction } from '../test-utils/discord.js';

test('/ask streams a preview edit and then renders the final answer with buttons', async () => {
  const { commands } = makeCommands();
  const i = interaction('ask', { prompt: 'hello', private: true });
  await commands.handleCommand(i);
  assert.equal(i.deferred, true);
  assert.ok(
    i.edits.some((payload) => payload.content === 'Answer ' && !payload.components),
    'a preview edit should arrive before the final answer',
  );
  const finalPayload = i.edits[i.edits.length - 1];
  assert.equal(finalPayload.content, 'Answer text');
  const customId = finalPayload.components[0].components[0].data.custom_id;
  assert.match(customId, /^ask:regen:/);
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
  assert.match(i.edits[0].content, /must be an image/);
});

test('answer feedback buttons record a rating', async () => {
  const { commands, runtime } = makeCommands();
  const ratings = [];
  runtime.metrics.inc = (name) => ratings.push(name);
  const ask = interaction('ask', { prompt: 'hi' });
  await commands.handleCommand(ask);
  const final = ask.edits[ask.edits.length - 1];
  const token = String(final.components[0].components[0].data.custom_id).split(':')[2];
  const click = interaction('', {}, { customId: `ask:good:${token}`, user: { id: 'u1' } });
  await commands.handleButton(click);
  assert.equal(click.replies.length, 1);
  assert.ok(click.replies[0].flags);
  assert.deepEqual(ratings.filter((name) => name.startsWith('feedback')), ['feedback.good']);
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
  assert.equal(i.edits.at(-1).content, 'secret answer');
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
  assert.ok(payloads.some((payload) => payload.content === 'Answer '), 'a preview edit should be present');
  for (const payload of payloads) {
    if (!payload.content) continue;
    assert.deepEqual(payload.allowedMentions, { parse: [] }, `payload ${JSON.stringify(payload.content)} must not ping`);
  }
});

