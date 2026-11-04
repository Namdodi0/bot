import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewer, streamPreview } from '../src/platforms/discord/ui.js';
import { makeDiscordCommands as makeCommands, makeInteraction as interaction } from '../test-utils/discord.js';

test('/help replies with a native ephemeral embed', async () => {
  const { commands } = makeCommands();
  const i = interaction('help');
  await commands.handleCommand(i);
  assert.equal(i.replies.length, 1);
  assert.ok(i.replies[0].flags);
  assert.match(i.replies[0].embeds[0].data.title, /commands/i);
  assert.match(JSON.stringify(i.replies[0].embeds[0].data), /\/ask/);
});

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

test('/ask downloads the image attachment and passes it to the agent as imageData', async () => {
  const { commands, runtime } = makeCommands();
  const downloads = [];
  runtime.validator.download = async (url) => {
    downloads.push(url);
    return { ok: true, data: Buffer.from('png-bytes'), contentType: 'image/png' };
  };
  let seen = null;
  runtime.agent.stream = async (event) => {
    seen = event;
    return { text: 'it is a cat', photos: [] };
  };

  const i = interaction('ask', {
    prompt: 'what is this?',
    image: { contentType: 'image/png', size: 1024, url: 'https://cdn.example/cat.png' },
  });
  await commands.handleCommand(i);

  assert.deepEqual(downloads, ['https://cdn.example/cat.png']);
  assert.equal(seen.imageData.contentType, 'image/png');
  assert.equal(seen.imageData.data.toString(), 'png-bytes');
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

test('/settings replies with an ephemeral panel and selects update record.meta', async () => {
  const { commands, runtime } = makeCommands();
  const touched = [];
  runtime.store.touch = (chatId) => touched.push(chatId);

  const panel = interaction('settings');
  await commands.handleCommand(panel);
  assert.equal(panel.replies.length, 1);
  assert.ok(panel.replies[0].flags);
  assert.deepEqual(
    panel.replies[0].components.map((row) => row.components[0].data.custom_id),
    ['settings:model', 'settings:tone', 'settings:reasoning', 'settings:privacy', 'settings:thread'],
  );

  const tone = interaction('', {}, { customId: 'settings:tone', values: ['roast'] });
  await commands.handleSelect(tone);
  assert.equal(runtime.record.meta.tone, 'roast');
  assert.deepEqual(touched, ['c1']);
  assert.match(JSON.stringify(tone.edits[0].embeds[0].data), /roast/);

  const privacy = interaction('', {}, { customId: 'settings:privacy', values: ['private'] });
  await commands.handleSelect(privacy);
  assert.equal(runtime.record.meta.privateDefault, true);

  const reasoning = interaction('', {}, { customId: 'settings:reasoning', values: ['medium'] });
  await commands.handleSelect(reasoning);
  assert.equal(runtime.record.meta.thinking, 'medium');

  const reasoningDefault = interaction('', {}, { customId: 'settings:reasoning', values: ['__default'] });
  await commands.handleSelect(reasoningDefault);
  assert.equal(runtime.record.meta.thinking, null);

  const thread = interaction('', {}, { customId: 'settings:thread', values: ['on'] });
  await commands.handleSelect(thread);
  assert.equal(runtime.record.meta.autoThread, true);

  const model = interaction('', {}, { customId: 'settings:model', values: ['nim'] });
  await commands.handleSelect(model);
  assert.equal(runtime.record.meta.model, 'nim');
});

test('/catchup summarizes the channel transcript within the requested window', async () => {
  const { commands, runtime } = makeCommands();
  const now = Date.now();
  const messages = [
    { id: 'm1', createdTimestamp: now, author: { username: 'ann', bot: false }, member: { displayName: 'Ann' }, content: 'hello team', attachments: { size: 0 } },
    { id: 'm2', createdTimestamp: now - 1000, author: { username: 'helper', bot: true }, member: { displayName: 'Bot' }, content: 'beep', attachments: { size: 0 } },
    { id: 'm3', createdTimestamp: now - 2000, author: { username: 'bob', bot: false }, member: { displayName: 'Bob' }, content: 'look at this', attachments: { size: 1 } },
    { id: 'm4', createdTimestamp: now - 3 * 24 * 3_600_000, author: { username: 'old', bot: false }, member: { displayName: 'Old' }, content: 'ancient', attachments: { size: 0 } },
  ];
  const channel = { messages: { fetch: async () => new Map(messages.map((message) => [message.id, message])) } };
  let transcript = '';
  runtime.models.chat = async (payload) => {
    transcript = payload.messages[1].content;
    return { content: 'summary text' };
  };

  const i = interaction('catchup', { hours: 24 }, { channel });
  await commands.handleCommand(i);

  assert.equal(i.deferred, true);
  assert.match(transcript, /Ann: hello team/);
  assert.match(transcript, /Bob: look at this \[attachment\]/);
  assert.doesNotMatch(transcript, /beep|ancient/);
  assert.ok(transcript.indexOf('Bob: look at this') < transcript.indexOf('Ann: hello team'));

  const embed = i.edits[0].embeds[0].data;
  assert.match(embed.title, /Catch-up — last 24 hours/);
  assert.match(embed.description, /summary text/);
  assert.match(embed.footer.text, /2 messages/);
});

test('/catchup reports when the channel has nothing in the window', async () => {
  const { commands } = makeCommands();
  const channel = { messages: { fetch: async () => new Map() } };
  const i = interaction('catchup', {}, { channel });
  await commands.handleCommand(i);
  assert.match(i.edits[0].content, /No messages in the last 24 hours/);
});

test('streamPreview clamps length and balances code fences', () => {
  assert.equal(streamPreview(''), '');
  assert.equal(streamPreview(null), '');
  assert.equal(streamPreview('x'.repeat(2500)).length, 1900);
  const fenced = streamPreview('before\n```js\nconst a = 1;');
  assert.equal((fenced.match(/```/g) ?? []).length % 2, 0);
});

test('previewer skips identical clamped text instead of re-editing', async () => {
  /** @type {string[]} */
  const edits = [];
  const previewer = createPreviewer(async (text) => {
    edits.push(text);
  }, 0);
  previewer.push('a'.repeat(2500));
  await previewer.flush();
  previewer.push('a'.repeat(3200));
  await previewer.flush();
  assert.equal(edits.length, 1, 'the clamped preview is byte-identical, so no second edit');

  previewer.push('b'.repeat(2500));
  await previewer.flush();
  assert.equal(edits.length, 2);
});

test('previewer stops pushing after a failed edit', async () => {
  let calls = 0;
  const previewer = createPreviewer(async () => {
    calls += 1;
    throw new Error('missing permissions');
  }, 0);
  previewer.push('one');
  await previewer.flush();
  previewer.push('two');
  await previewer.flush();
  assert.equal(calls, 1);
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

test('thread answers disable mention parsing in the thread and the notice', async () => {
  const { commands } = makeCommands();
  const sent = [];
  const placeholder = {
    edit: async (payload) => {
      sent.push(payload);
      return payload;
    },
  };
  const thread = {
    id: 't1',
    send: async (payload) => {
      sent.push(payload);
      return placeholder;
    },
  };
  const channel = { id: 'c1', threads: { create: async () => thread } };
  const i = interaction('ask', { prompt: 'hello', thread: true }, { channel, guild: { id: 'g1' } });
  await commands.handleCommand(i);

  assert.match(i.edits.at(-1).content, /^Answered in /);
  for (const payload of [...sent, ...i.edits]) {
    assert.deepEqual(payload.allowedMentions, { parse: [] }, `payload ${JSON.stringify(payload.content)} must not ping`);
  }
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

test('public asks are not flagged private', async () => {
  const { commands, runtime } = makeCommands();
  let seen = null;
  runtime.agent.stream = async (event) => {
    seen = event;
    return { text: 'ok', photos: [] };
  };
  await commands.handleCommand(interaction('ask', { prompt: 'hi' }));
  assert.equal(seen.private, undefined);
  assert.equal(seen.chatId, 'c1');
});

test('context-menu answers are flagged private for the core', async () => {
  const { commands, runtime } = makeCommands();
  let seen = null;
  runtime.agent.stream = async (event) => {
    seen = event;
    return { text: 'explained', photos: [] };
  };
  const i = interaction(
    'Explain message',
    {},
    {
      isChatInputCommand: () => false,
      isMessageContextMenuCommand: () => true,
      targetMessage: { content: 'hello there' },
    },
  );
  await commands.handleCommand(i);
  assert.equal(seen.private, true);
});

test('regenerating an ephemeral answer flags the turn private', async () => {
  const { commands, runtime } = makeCommands();
  const first = interaction('ask', { prompt: 'hello', private: true });
  await commands.handleCommand(first);
  const customId = first.edits[first.edits.length - 1].components[0].components[0].data.custom_id;

  /** @type {any[]} */
  const edits = [];
  const message = {
    edit: async (payload) => {
      edits.push(payload);
    },
  };
  const button = interaction('', {}, { customId, message, deferUpdate: async () => {} });
  let seen = null;
  runtime.agent.stream = async (event) => {
    seen = event;
    return { text: 'again', photos: [] };
  };
  await commands.handleButton(button);

  assert.equal(seen.private, true);
  assert.equal(edits.at(-1).content, 'again');
  assert.deepEqual(edits.at(-1).allowedMentions, { parse: [] });
});

test('/ping reports the gateway and roundtrip latency', async () => {
  const { commands } = makeCommands();
  const i = interaction('ping');
  await commands.handleCommand(i);
  assert.match(i.replies[0].content, /gateway 12ms/);
});

test('/search returns an embed from the shared tool', async () => {
  const { commands } = makeCommands();
  const i = interaction('search', { query: 'gold price', private: true });
  await commands.handleCommand(i);
  assert.equal(i.deferred, true);
  assert.match(i.edits[0].embeds[0].data.description, /search result/);
});

test('/remind add uses Discord timestamps', async () => {
  const { commands } = makeCommands();
  const i = interaction('remind', { __sub: 'add', when: '+10m', text: 'drink water' });
  await commands.handleCommand(i);
  assert.match(i.replies[0].content, /<t:\d+:f>/);
  assert.match(i.replies[0].content, /drink water/);
});

test('/reset is deferred and runs through the per-chat exclusive queue', async () => {
  const { commands, runtime } = makeCommands();
  const order = [];
  runtime.agent.exclusive = async (chatId, task) => {
    order.push(`exclusive:${chatId}`);
    return task();
  };
  runtime.store.reset = async (chatId) => {
    order.push(`reset:${chatId}`);
  };
  const i = interaction('reset');
  await commands.handleCommand(i);

  assert.deepEqual(order, ['exclusive:c1', 'reset:c1']);
  assert.ok(i.deferPayload.flags, 'reset must defer before waiting for a turn');
  assert.match(i.edits.at(-1).content, /settings kept/);
});

test('expensive native commands share the per-user rate limit', async () => {
  const { commands, runtime } = makeCommands();
  runtime.agent.rateLimited = () => true;
  let chatCalled = false;
  runtime.models.chat = async () => {
    chatCalled = true;
    return { content: 'summary text' };
  };
  const i = interaction('summary');
  await commands.handleCommand(i);

  assert.equal(i.replies.length, 1);
  assert.match(i.replies[0].content, /too quickly/);
  assert.equal(chatCalled, false);
});

test('buttons reject another user', async () => {
  const { commands } = makeCommands();
  const i = interaction('ask', { prompt: 'hello' });
  await commands.handleCommand(i);
  const customId = i.edits[i.edits.length - 1].components[0].components[0].data.custom_id;
  const other = interaction('', {}, { customId, user: { id: 'u2', username: 'other' } });
  await commands.handleButton(other);
  assert.match(other.replies[0].content, /not your conversation/);
});

test('regenerate streams into the existing message', async () => {
  const { commands, runtime } = makeCommands();
  const first = interaction('ask', { prompt: 'hello' });
  await commands.handleCommand(first);
  const customId = first.edits[first.edits.length - 1].components[0].components[0].data.custom_id;

  /** @type {string[]} */
  const edits = [];
  const message = { edit: async (payload) => edits.push(payload.content) };
  const button = interaction(
    '',
    {},
    {
      customId,
      message,
      deferUpdate: async () => {
        button.deferred = true;
      },
    },
  );
  runtime.agent.stream = async (_event, { onDelta }) => {
    onDelta('streamed ');
    return { text: 'final answer', photos: [] };
  };
  await commands.handleButton(button);
  assert.ok(edits.some((text) => text.includes('streamed')));
  assert.equal(edits.at(-1), 'final answer');
});

test('context menus stream into the ephemeral reply', async () => {
  const { commands, runtime } = makeCommands();
  runtime.agent.stream = async (_event, { onDelta }) => {
    onDelta('explaining ');
    return { text: 'final explanation', photos: [] };
  };
  const i = interaction(
    'Explain message',
    {},
    {
      isChatInputCommand: () => false,
      isMessageContextMenuCommand: () => true,
      targetMessage: { content: 'hello there' },
    },
  );
  await commands.handleCommand(i);
  assert.equal(i.deferred, true);
  assert.ok(i.edits.some((payload) => String(payload.content).includes('explaining')));
  assert.equal(i.edits.at(-1).content, 'final explanation');
});

test('/ask without a prompt opens the modal form', async () => {
  const { commands } = makeCommands();
  const i = interaction('ask', {});
  await commands.handleCommand(i);
  assert.ok(i.modal);
  assert.match(String(i.modal.data.custom_id), /^ask-form:/);
  assert.equal(i.deferred, undefined);
});

test('modal submission runs the ask flow', async () => {
  const { commands, runtime } = makeCommands();
  runtime.agent.stream = async (_event, { onDelta }) => {
    onDelta('modal ');
    return { text: 'modal answer', photos: [] };
  };
  const i = interaction(
    '',
    {},
    {
      isModalSubmit: () => true,
      customId: 'ask-form:0:0',
      fields: { getTextInputValue: () => 'hello from the form' },
    },
  );
  await commands.handleModal(i);
  assert.equal(i.deferred, true);
  assert.equal(i.edits.at(-1).content, 'modal answer');
});

test('/sticker sends a server sticker', async () => {
  const { commands } = makeCommands();
  const i = interaction('sticker', { name: 'wave' });
  await commands.handleCommand(i);
  assert.equal(i.deferred, true);
  assert.match(i.edits.at(-1).content, /Sent the sticker/);
});
