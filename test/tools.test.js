import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRuntime } from '../src/core/ai/tools.js';
import { makeDiscordPlatform, makeTransport, makeZaloPlatform, silentLogger } from '../test-utils/helpers.js';

function runtime(config, stickerStore) {
  const transport = makeTransport();
  const platform = makeZaloPlatform({ config, transport, stickers: stickerStore });
  const tools = createToolRuntime({
    config,
    tavily: { search: async () => ({ results: [], images: [] }) },
    platform,
    validator: { validate: async () => ({ ok: true }) },
    logger: silentLogger,
    metrics: { inc() {}, observe() {} },
    sendDelayMs: 0,
  });
  return { tools, transport, platform };
}

const fakeStickers = {
  find: (query) =>
    String(query).includes('greeting')
      ? { id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi' }
      : null,
  random: () => ({ id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi' }),
};

function baseConfig(overrides = {}) {
  return {
    search: { enabled: true, auto: true, depth: 'fast', maxResults: 4, country: 'vietnam' },
    image: { enabled: true },
    sticker: { enabled: true },
    ...overrides,
  };
}

test('SEARCH_AUTO=off: the model has no web_search tool', () => {
  const { tools } = runtime(
    baseConfig({ search: { enabled: true, auto: false, depth: 'fast', maxResults: 4, country: 'vietnam' } }),
    fakeStickers,
  );
  const names = tools.definitions().map((tool) => tool.function.name);
  assert.equal(names.includes('web_search'), false);
  assert.equal(names.includes('send_image'), true);
});

test('web_search still works when auto=off (used by /search)', async () => {
  const { tools } = runtime(
    baseConfig({ search: { enabled: true, auto: false, depth: 'fast', maxResults: 4, country: 'vietnam' } }),
    fakeStickers,
  );
  const result = await tools.run('web_search', { query: 'gold price' }, { chatId: 'c1' });
  assert.equal(result.ok, true);
});

test('the image tool stops once the deadline passes', async () => {
  const { tools } = runtime(baseConfig(), fakeStickers);
  const result = await tools.run('send_image', { query: 'cat' }, { chatId: 'c1', deadline: Date.now() - 1 });
  assert.equal(result.ok, false);
  assert.match(result.text, /Ran out of time/);
});

test('send_image tries the next candidate when Zalo rejects the first URL', async () => {
  /** @type {string[]} */
  const attempted = [];
  const transport = {
    sendPhoto: async (_chatId, url) => {
      attempted.push(url);
      if (url.endsWith('a.png')) throw new Error('rejected by Zalo');
      return { ok: true };
    },
    sendSticker: async () => ({ ok: true }),
  };
  const tools = createToolRuntime({
    config: baseConfig(),
    tavily: { search: async () => ({ results: [], images: ['https://x/a.png', 'https://x/b.png'] }) },
    platform: makeZaloPlatform({ config: baseConfig(), transport, stickers: fakeStickers }),
    validator: { validate: async () => ({ ok: true }) },
    logger: silentLogger,
    metrics: { inc() {}, observe() {} },
  });

  const result = await tools.run('send_image', { query: 'cat' }, { chatId: 'c1' });
  assert.equal(result.ok, true);
  assert.deepEqual(attempted, ['https://x/a.png', 'https://x/b.png']);
});

test('send_sticker is in definitions when enabled and sends the right id', async () => {
  const { tools, transport } = runtime(baseConfig(), fakeStickers);
  const names = tools.definitions().map((tool) => tool.function.name);
  assert.equal(names.includes('send_sticker'), true);

  const result = await tools.run('send_sticker', { emotion: 'greeting' }, { chatId: 'c1' });
  assert.equal(result.ok, true);
  assert.match(result.text, /Anh Tre Say Hi/);
  assert.equal(transport.lastSticker.stickerId, 'd8fa8021bc64553a0c75');
});

test('when send_sticker is off there is no tool and nothing is sent', async () => {
  const { tools, transport } = runtime(baseConfig({ sticker: { enabled: false } }), fakeStickers);
  assert.equal(tools.definitions().some((tool) => tool.function.name === 'send_sticker'), false);
  const result = await tools.run('send_sticker', { emotion: 'greeting' }, { chatId: 'c1' });
  assert.equal(result.ok, false);
  assert.equal(transport.lastSticker, null);
});

test('read_url fetches a page and converts it to text', async () => {
  const transport = { sendPhoto: async () => ({ ok: true }), sendSticker: async () => ({ ok: true }) };
  const tools = createToolRuntime({
    config: baseConfig(),
    tavily: null,
    platform: {
      transport,
      capabilities: { uploadMedia: false },
      tools: { run: async () => null },
    },
    validator: {
      validate: async () => ({ ok: true }),
      readText: async () => ({
        ok: true,
        text: '<html><title>Docs</title><body><p>Hello from the page.</p></body></html>',
        contentType: 'text/html',
        finalUrl: 'https://example.com/page',
      }),
    },
    stickers: fakeStickers,
    logger: silentLogger,
    metrics: { inc() {}, observe() {} },
  });
  assert.equal(tools.definitions().some((tool) => tool.function.name === 'read_url'), true);
  const result = await tools.run('read_url', { url: 'https://example.com/page' }, { chatId: 'c1' });
  assert.equal(result.ok, true);
  assert.match(result.text, /Hello from the page/);
  assert.match(result.text, /Title: Docs/);
});

test('read_url uses YouTube oEmbed for YouTube links', async () => {
  const transport = { sendPhoto: async () => ({ ok: true }), sendSticker: async () => ({ ok: true }) };
  const calls = [];
  const tools = createToolRuntime({
    config: baseConfig(),
    tavily: null,
    platform: {
      transport,
      capabilities: { uploadMedia: false },
      tools: { run: async () => null },
    },
    validator: {
      validate: async () => ({ ok: true }),
      readText: async (url) => {
        calls.push(url);
        return {
          ok: true,
          text: JSON.stringify({ title: 'Test video', author_name: 'Some channel' }),
          contentType: 'application/json',
          finalUrl: url,
        };
      },
    },
    stickers: fakeStickers,
    logger: silentLogger,
    metrics: { inc() {}, observe() {} },
  });
  const result = await tools.run('read_url', { url: 'https://youtu.be/GGlt8rLwWzQ' }, { chatId: 'c1' });
  assert.equal(result.ok, true);
  assert.match(result.text, /YouTube video: Test video/);
  assert.match(result.text, /Channel: Some channel/);
  assert.match(calls[0], /youtube\.com\/oembed/);
});

test('no send_image tool when Tavily (search) is disabled', () => {
  const tools = createToolRuntime({
    config: baseConfig({ search: { enabled: false, auto: false, depth: 'fast', maxResults: 4, country: 'vietnam' } }),
    tavily: null,
    platform: makeZaloPlatform({ config: baseConfig(), stickers: fakeStickers }),
    validator: { validate: async () => ({ ok: true }) },
    logger: silentLogger,
    metrics: { inc() {}, observe() {} },
  });
  const names = tools.definitions().map((tool) => tool.function.name);
  assert.equal(names.includes('send_image'), false);
});

test('send_image refuses a direct private send without a sink', async () => {
  const { tools } = runtime(baseConfig(), fakeStickers);
  const result = await tools.run(
    'send_image',
    { query: 'cat' },
    { chatId: 'c1', suppressDirectSend: true },
  );
  assert.equal(result.ok, false);
  assert.match(result.text, /private answer/);
});

test('set_reminder tool: definition, add and validation', async () => {
  /** @type {any[]} */
  const added = [];
  const reminders = {
    add: async (input) => {
      added.push(input);
      return { ok: true, item: { id: 4, at: input.at, text: input.text } };
    },
  };
  const tools = createToolRuntime({
    config: baseConfig(),
    tavily: null,
    platform: makeZaloPlatform({ config: baseConfig(), stickers: fakeStickers }),
    validator: { validate: async () => ({ ok: true }) },
    reminders,
    logger: silentLogger,
    metrics: { inc() {}, observe() {} },
  });
  assert.equal(tools.definitions().some((tool) => tool.function.name === 'set_reminder'), true);

  let result = await tools.run('set_reminder', { when: '+10m', text: 'uống nước' }, { chatId: 'c1', senderId: 'u1' });
  assert.equal(result.ok, true);
  assert.match(result.text, /Reminder #4/);
  assert.equal(added[0].chatId, 'c1');
  assert.equal(added[0].createdBy, 'u1');
  assert.equal(added[0].text, 'uống nước');
  assert.ok(added[0].at > Date.now());

  result = await tools.run('set_reminder', { when: '99:99', text: 'x' }, { chatId: 'c1' });
  assert.equal(result.ok, false);
  result = await tools.run('set_reminder', { when: '+10m' }, { chatId: 'c1' });
  assert.equal(result.ok, false);
});

test('set_reminder refuses to schedule from a private answer', async () => {
  let added = 0;
  const reminders = {
    add: async () => {
      added += 1;
      return { ok: true, item: { id: 5, at: Date.now() + 60_000, text: 'x' } };
    },
  };
  const tools = createToolRuntime({
    config: baseConfig(),
    tavily: null,
    platform: makeZaloPlatform({ config: baseConfig(), stickers: fakeStickers }),
    validator: { validate: async () => ({ ok: true }) },
    reminders,
    logger: silentLogger,
    metrics: { inc() {}, observe() {} },
  });

  const result = await tools.run(
    'set_reminder',
    { when: '+10m', text: 'secret reminder' },
    { chatId: 'c1', suppressDirectSend: true },
  );
  assert.equal(result.ok, false);
  assert.match(result.text, /private answer/);
  assert.equal(added, 0);
});

test('set_reminder tool: reports the per-chat limit and is absent without a store', async () => {
  const make = (reminders) =>
    createToolRuntime({
      config: baseConfig(),
      tavily: null,
      platform: makeZaloPlatform({ config: baseConfig(), stickers: fakeStickers }),
      validator: { validate: async () => ({ ok: true }) },
      reminders,
      logger: silentLogger,
      metrics: { inc() {}, observe() {} },
    });

  const limited = { add: async () => ({ ok: false, reason: 'chat-limit' }) };
  const result = await make(limited).run('set_reminder', { when: '+10m', text: 'x' }, { chatId: 'c1' });
  assert.equal(result.ok, false);
  assert.match(result.text, /5 reminders/);

  assert.equal(make(null).definitions().some((tool) => tool.function.name === 'set_reminder'), false);
});

test('send_image sends the requested count', async () => {
  /** @type {string[]} */
  const sent = [];
  const images = Array.from({ length: 12 }, (_, index) => `https://img.example/${index}.png`);
  const transport = {
    sendPhoto: async (_chatId, url) => {
      sent.push(url);
      return { ok: true };
    },
    sendSticker: async () => ({ ok: true }),
  };
  const tools = createToolRuntime({
    config: baseConfig(),
    tavily: {
      search: async (query) => ({
        results: [],
        images: String(query).endsWith('2') ? images.slice(6) : images.slice(0, 6),
      }),
    },
    platform: makeZaloPlatform({ config: baseConfig(), transport, stickers: fakeStickers }),
    validator: { validate: async () => ({ ok: true }) },
    logger: silentLogger,
    metrics: { inc() {}, observe() {} },
    sendDelayMs: 0,
  });

  const result = await tools.run('send_image', { query: 'create mod', count: 10 }, { chatId: 'c1' });
  assert.equal(result.ok, true);
  assert.equal(sent.length, 10);
  assert.match(result.text, /Sent 10 images/);
});

test('send_image on Discord downloads validated bytes instead of passing the URL', async () => {
  /** @type {any} */
  let photoOptions = null;
  const transport = {
    sendPhoto: async (_chatId, _url, _caption, options) => {
      photoOptions = options;
      return { ok: true };
    },
    sendSticker: async () => ({ ok: true }),
  };
  const tools = createToolRuntime({
    config: baseConfig(),
    tavily: { search: async () => ({ results: [], images: ['https://img.example/a.png'] }) },
    platform: makeDiscordPlatform({ transport }),
    validator: {
      validate: async () => {
        throw new Error('validate must not run on Discord');
      },
      download: async () => ({ ok: true, data: Buffer.from('png'), contentType: 'image/png' }),
    },
    logger: silentLogger,
    metrics: { inc() {}, observe() {} },
    sendDelayMs: 0,
  });

  const result = await tools.run('send_image', { query: 'cat' }, { chatId: 'discord:9' });
  assert.equal(result.ok, true);
  assert.deepEqual(photoOptions, { data: Buffer.from('png'), contentType: 'image/png' });
});

test('send_image on Discord skips URLs whose pinned download fails', async () => {
  let sent = 0;
  const transport = {
    sendPhoto: async () => {
      sent += 1;
      return { ok: true };
    },
    sendSticker: async () => ({ ok: true }),
  };
  const tools = createToolRuntime({
    config: baseConfig(),
    tavily: { search: async () => ({ results: [], images: ['https://img.example/private.png'] }) },
    platform: makeDiscordPlatform({ transport }),
    validator: {
      validate: async () => ({ ok: true }),
      download: async () => ({ ok: false, reason: 'internal address blocked' }),
    },
    logger: silentLogger,
    metrics: { inc() {}, observe() {} },
    sendDelayMs: 0,
  });

  const result = await tools.run('send_image', { query: 'cat' }, { chatId: 'discord:9' });
  assert.equal(result.ok, false);
  assert.equal(sent, 0);
});

test('send_image reports a partial batch when there are not enough unique images', async () => {
  /** @type {string[]} */
  const sent = [];
  const transport = {
    sendPhoto: async (_chatId, url) => {
      sent.push(url);
      return { ok: true };
    },
    sendSticker: async () => ({ ok: true }),
  };
  const tools = createToolRuntime({
    config: baseConfig(),
    tavily: { search: async () => ({ results: [], images: ['https://img.example/a.png', 'https://img.example/b.png'] }) },
    platform: makeZaloPlatform({ config: baseConfig(), transport, stickers: fakeStickers }),
    validator: { validate: async () => ({ ok: true }) },
    logger: silentLogger,
    metrics: { inc() {}, observe() {} },
    sendDelayMs: 0,
  });

  const result = await tools.run('send_image', { query: 'cat', count: 5 }, { chatId: 'c1' });
  assert.equal(result.ok, true);
  assert.equal(sent.length, 2);
  assert.match(result.text, /2 of 5/);
});

test('Discord uses its own server sticker tool', async () => {
  const tools = createToolRuntime({
    config: baseConfig(),
    tavily: null,
    platform: makeDiscordPlatform(),
    validator: { validate: async () => ({ ok: true }) },
    logger: silentLogger,
    metrics: { inc() {}, observe() {} },
  });
  assert.equal(tools.definitions().some((tool) => tool.function.name === 'send_sticker'), true);
  const result = await tools.run('send_sticker', { emotion: 'wave' }, { chatId: 'discord:c1' });
  assert.equal(result.ok, true);
  assert.match(result.text, /Sent the sticker/);
});
