import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandRuntime } from '../src/platforms/discord/commands.js';
import { streamPreview } from '../src/platforms/discord/ui.js';
import { makeConfig, silentLogger } from '../test-utils/helpers.js';

function makePlatform() {
  return {
    name: 'discord',
    label: 'Discord',
    transportMode: 'gateway',
    transport: {
      client: { user: { username: 'Bot' } },
      displayName: 'Bot',
      ping: () => 12,
    },
    capabilities: { uploadMedia: true, stickers: false, nativeInteractions: true },
    limits: { text: 2000, caption: 2000 },
    formatOutgoing: (text) => String(text),
    isAdmin: () => true,
    prompt: {},
    commands: { specs: [] },
    tools: {},
    healthServices: ['tavily'],
    explainError: () => null,
  };
}

function makeRuntime() {
  const record = { messages: [], turns: 0, meta: {} };
  return {
    record,
    store: {
      get: async () => record,
      touch: () => {},
      reset: async () => {},
      count: async () => 0,
    },
    models: {
      resolve: () => ({ alias: 'deepseek', label: 'DeepSeek', provider: 'deepseek', model: 'deepseek-flash' }),
      list: () => [
        { alias: 'deepseek', label: 'DeepSeek', provider: 'deepseek', model: 'deepseek-flash' },
        { alias: 'nim', label: 'NIM', provider: 'nim', model: 'nvidia/model' },
      ],
      find: (value) => (String(value) === 'nim' ? { alias: 'nim', label: 'NIM', provider: 'nim', model: 'nvidia/model' } : null),
      chat: async () => ({ content: 'summary text' }),
    },
    metrics: {
      inc() {},
      snapshot: () => ({ uptimeSec: 10, counters: {}, latency: {} }),
    },
    tools: { run: async () => ({ ok: true, text: 'search result' }) },
    reminders: {
      list: () => [],
      add: async () => ({ ok: true, item: { id: 1, at: Date.now() + 60_000, text: 'x' } }),
      remove: async () => ({ id: 1 }),
    },
    compaction: { compactIfNeeded: async () => ({ changed: false }) },
    tavily: null,
    validator: {
      validate: async () => ({ ok: true }),
      download: async () => ({ ok: true, data: Buffer.from('image'), contentType: 'image/png' }),
    },
    commands: { parseCommand: () => null },
    agent: {
      collect: async () => ({ text: 'Answer text', photos: [] }),
      stream: async (_event, options = {}) => {
        options.onDelta?.('Answer ');
        options.onDelta?.('text');
        return { text: 'Answer text', photos: [] };
      },
    },
  };
}

function makeCommands() {
  const config = makeConfig();
  const platform = makePlatform();
  const runtime = makeRuntime();
  const commands = createCommandRuntime({ config, logger: silentLogger, metrics: runtime.metrics, platform, runtime });
  return { commands, runtime, platform };
}

/**
 * @param {string} name
 * @param {Record<string, any>} [options]
 * @param {Record<string, any>} [overrides]
 */
function interaction(name, options = {}, overrides = {}) {
  const replies = [];
  const edits = [];
  const follows = [];
  const values = new Map(Object.entries(options));
  return {
    commandName: name,
    guildId: 'g1',
    channelId: 'c1',
    user: { id: 'u1', username: 'user' },
    member: { displayName: 'User' },
    memberPermissions: { has: () => true },
    createdTimestamp: Date.now(),
    isChatInputCommand: () => true,
    isMessageContextMenuCommand: () => false,
    options: {
      getString: (key) => values.get(key) ?? null,
      getBoolean: (key) => values.get(key) ?? null,
      getInteger: (key) => values.get(key) ?? null,
      getAttachment: (key) => values.get(key) ?? null,
      getSubcommand: () => values.get('__sub') ?? null,
      getFocused: () => '',
    },
    async reply(payload) {
      replies.push(payload);
      this.replied = true;
    },
    async deferReply(payload) {
      this.deferred = true;
      this.deferPayload = payload;
    },
    async editReply(payload) {
      edits.push(payload);
    },
    async followUp(payload) {
      follows.push(payload);
    },
    async update(payload) {
      edits.push(payload);
    },
    replies,
    edits,
    follows,
    ...overrides,
  };
}

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
    ['settings:model', 'settings:tone', 'settings:privacy', 'settings:thread'],
  );

  const tone = interaction('', {}, { customId: 'settings:tone', values: ['roast'] });
  await commands.handleSelect(tone);
  assert.equal(runtime.record.meta.tone, 'roast');
  assert.deepEqual(touched, ['c1']);
  assert.match(JSON.stringify(tone.edits[0].embeds[0].data), /roast/);

  const privacy = interaction('', {}, { customId: 'settings:privacy', values: ['private'] });
  await commands.handleSelect(privacy);
  assert.equal(runtime.record.meta.privateDefault, true);

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
