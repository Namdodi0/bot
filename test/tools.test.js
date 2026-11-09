import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRuntime } from '../src/core/ai/tools.js';
import { makeTransport, makeDiscordPlatform, silentLogger } from '../test-utils/helpers.js';

const okValidator = {
  validate: async () => ({ ok: true }),
  download: async () => ({ ok: true, data: Buffer.from('img'), contentType: 'image/png' }),
};

function runtime(config, stickerStore) {
  const transport = makeTransport();
  const platform = makeDiscordPlatform({ config, transport, stickers: stickerStore });
  const tools = createToolRuntime({
    config,
    tavily: { search: async () => ({ results: [], images: [] }) },
    platform,
    validator: okValidator,
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

test('send_image tries the next candidate when the platform rejects the first URL', async () => {
  /** @type {string[]} */
  const attempted = [];
  const transport = {
    sendPhoto: async (_chatId, url) => {
      attempted.push(url);
      if (url.endsWith('a.png')) {
        const error = new Error('rejected by the platform');
        /** @type {any} */ (error).status = 400;
        throw error;
      }
      return { ok: true };
    },
    sendSticker: async () => ({ ok: true }),
  };
  const tools = createToolRuntime({
    config: baseConfig(),
    tavily: { search: async () => ({ results: [], images: ['https://x/a.png', 'https://x/b.png'] }) },
    platform: makeDiscordPlatform({ config: baseConfig(), transport, stickers: fakeStickers }),
    validator: okValidator,
    logger: silentLogger,
    metrics: { inc() {}, observe() {} },
  });

  const result = await tools.run('send_image', { query: 'cat' }, { chatId: 'c1' });
  assert.equal(result.ok, true);
  assert.deepEqual(attempted, ['https://x/a.png', 'https://x/b.png']);
});

test('send_image does not duplicate an image after an unconfirmed delivery', async () => {
  /** @type {string[]} */
  const attempted = [];
  const tools = createToolRuntime({
    config: baseConfig(),
    tavily: { search: async () => ({ results: [], images: ['https://x/a.png', 'https://x/b.png'] }) },
    platform: makeDiscordPlatform({
      config: baseConfig(),
      stickers: fakeStickers,
      transport: {
        sendPhoto: async (_chatId, url) => {
          attempted.push(url);
          throw new Error('socket timeout after upload');
        },
        sendSticker: async () => ({ ok: true }),
      },
    }),
    validator: okValidator,
    logger: silentLogger,
    metrics: { inc() {}, observe() {} },
    sendDelayMs: 0,
  });

  const budget = { remaining: 5 };
  const result = await tools.run('send_image', { query: 'cat', count: 2 }, { chatId: 'c1', imageBudget: budget });
  assert.equal(result.ok, true);
  assert.deepEqual(attempted, ['https://x/a.png']);
  assert.match(result.text, /did not confirm delivery/);
  assert.equal(budget.remaining, 4);
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

test('no send_image tool when Tavily (search) is disabled', () => {
  const tools = createToolRuntime({
    config: baseConfig({ search: { enabled: false, auto: false, depth: 'fast', maxResults: 4, country: 'vietnam' } }),
    tavily: null,
    platform: makeDiscordPlatform({ config: baseConfig(), stickers: fakeStickers }),
    validator: okValidator,
    logger: silentLogger,
    metrics: { inc() {}, observe() {} },
  });
  const names = tools.definitions().map((tool) => tool.function.name);
  assert.equal(names.includes('send_image'), false);
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
    platform: makeDiscordPlatform({ config: baseConfig(), stickers: fakeStickers }),
    validator: okValidator,
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

test('set_reminder refuses to mutate state after the turn deadline', async () => {
  let added = 0;
  const tools = createToolRuntime({
    config: baseConfig(),
    tavily: null,
    platform: makeDiscordPlatform({ config: baseConfig(), stickers: fakeStickers }),
    validator: okValidator,
    reminders: {
      add: async () => {
        added += 1;
        return { ok: true, item: { id: 1, at: Date.now(), text: 'x' } };
      },
    },
    logger: silentLogger,
    metrics: { inc() {}, observe() {} },
  });

  const result = await tools.run(
    'set_reminder',
    { when: '+10m', text: 'too late' },
    { chatId: 'c1', deadline: Date.now() - 1 },
  );
  assert.equal(result.ok, false);
  assert.match(result.text, /Ran out of time/);
  assert.equal(added, 0);
});

test('send_image caps the requested count at 2', async () => {
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
    platform: makeDiscordPlatform({ config: baseConfig(), transport, stickers: fakeStickers }),
    validator: okValidator,
    logger: silentLogger,
    metrics: { inc() {}, observe() {} },
    sendDelayMs: 0,
  });

  const result = await tools.run('send_image', { query: 'create mod', count: 10 }, { chatId: 'c1' });
  assert.equal(result.ok, true);
  assert.equal(sent.length, 2);
  assert.match(result.text, /Sent 2 images/);
  assert.match(result.text, /limit is 2/);
});

test('send_image passes the image URL to an injected sink instead of the chat id', async () => {
  /** @type {Array<{url: string, caption: string, asset: any}>} */
  const sent = [];
  const tools = createToolRuntime({
    config: baseConfig(),
    tavily: { search: async () => ({ results: [], images: ['https://img.example/a.png'] }) },
    platform: makeDiscordPlatform({
      config: baseConfig(),
      stickers: fakeStickers,
      transport: {
        sendPhoto: async () => {
          throw new Error('the transport must not be used when a sink is provided');
        },
        sendSticker: async () => ({ ok: true }),
      },
    }),
    validator: okValidator,
    logger: silentLogger,
    metrics: { inc() {}, observe() {} },
    sendDelayMs: 0,
  });

  const result = await tools.run(
    'send_image',
    { query: 'cat' },
    {
      chatId: 'c1',
      sendPhoto: async (url, caption, asset) => {
        sent.push({ url, caption, asset });
        return { ok: true };
      },
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(sent.map((item) => item.url), ['https://img.example/a.png']);
  assert.equal(sent[0].caption, 'cat');
});

test('send_image shares one 2-image budget across calls in a reply', async () => {
  /** @type {string[]} */
  const sent = [];
  const images = Array.from({ length: 10 }, (_, index) => `https://img.example/${index}.png`);
  const transport = {
    sendPhoto: async (_chatId, url) => {
      sent.push(url);
      return { ok: true };
    },
    sendSticker: async () => ({ ok: true }),
  };
  const tools = createToolRuntime({
    config: baseConfig(),
    tavily: { search: async () => ({ results: [], images }) },
    platform: makeDiscordPlatform({ config: baseConfig(), transport, stickers: fakeStickers }),
    validator: okValidator,
    logger: silentLogger,
    metrics: { inc() {}, observe() {} },
    sendDelayMs: 0,
  });
  const imageBudget = { remaining: 2 };

  const first = await tools.run('send_image', { query: 'cat', count: 2 }, { chatId: 'c1', imageBudget });
  const second = await tools.run('send_image', { query: 'cat', count: 2 }, { chatId: 'c1', imageBudget });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(sent.length, 2);
  assert.equal(imageBudget.remaining, 0);
  assert.match(second.text, /limit reached/);

  const third = await tools.run('send_image', { query: 'cat' }, { chatId: 'c1', imageBudget });
  assert.equal(third.ok, false);
  assert.match(third.text, /limit reached/);
});

test('send_image stops after a provider quota error instead of retrying queries', async () => {
  let searches = 0;
  const tools = createToolRuntime({
    config: baseConfig(),
    tavily: {
      search: async () => {
        searches += 1;
        const error = new Error('tavily quota exceeded');
        /** @type {any} */ (error).status = 432;
        throw error;
      },
    },
    platform: makeDiscordPlatform({
      config: baseConfig(),
      stickers: fakeStickers,
      transport: { sendPhoto: async () => ({ ok: true }), sendSticker: async () => ({ ok: true }) },
    }),
    validator: okValidator,
    logger: silentLogger,
    metrics: { inc() {}, observe() {} },
  });

  const result = await tools.run('send_image', { query: 'cat', count: 5 }, { chatId: 'c1' });
  assert.equal(result.ok, false);
  assert.equal(searches, 1, 'a 432 must not trigger the query-variant loop');
});

test('send_image validates candidates in parallel', async () => {
  let active = 0;
  let maxActive = 0;
  const tools = createToolRuntime({
    config: baseConfig(),
    tavily: {
      search: async () => ({
        results: [],
        images: Array.from({ length: 5 }, (_, index) => `https://img.example/${index}.jpg`),
      }),
    },
    platform: makeDiscordPlatform({
      config: baseConfig(),
      stickers: fakeStickers,
      transport: { sendPhoto: async () => ({ ok: true }), sendSticker: async () => ({ ok: true }) },
    }),
    validator: {
      validate: async () => ({ ok: true }),
      download: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active -= 1;
        return { ok: true, data: Buffer.from('img'), contentType: 'image/png' };
      },
    },
    logger: silentLogger,
    metrics: { inc() {}, observe() {} },
  });

  const result = await tools.run('send_image', { query: 'cat', count: 5 }, { chatId: 'c1' });
  assert.equal(result.ok, true);
  assert.ok(maxActive > 1, `validations must overlap (saw ${maxActive})`);
});

test('read_url truncates long pages and marks the cut', async () => {
  const tools = createToolRuntime({
    config: baseConfig(),
    tavily: null,
    platform: {
      transport: { sendPhoto: async () => ({ ok: true }), sendSticker: async () => ({ ok: true }) },
      capabilities: { uploadMedia: false },
      tools: { run: async () => null },
    },
    validator: {
      validate: async () => ({ ok: true }),
      readText: async () => ({
        ok: true,
        text: `<html><body><p>${'word '.repeat(4000)}</p></body></html>`,
        contentType: 'text/html',
        finalUrl: 'https://example.com/long',
      }),
    },
    stickers: fakeStickers,
    logger: silentLogger,
    metrics: { inc() {}, observe() {} },
  });
  const result = await tools.run('read_url', { url: 'https://example.com/long' }, { chatId: 'c1' });
  assert.equal(result.ok, true);
  assert.match(result.text, /content truncated/);
  assert.ok(result.text.length < 12_400, `unexpected length ${result.text.length}`);
});

test('read_url caches page text until the TTL expires', async () => {
  let reads = 0;
  let clock = 1_000;
  const tools = createToolRuntime({
    config: baseConfig(),
    tavily: null,
    platform: {
      transport: { sendPhoto: async () => ({ ok: true }), sendSticker: async () => ({ ok: true }) },
      capabilities: { uploadMedia: false },
      tools: { run: async () => null },
    },
    validator: {
      validate: async () => ({ ok: true }),
      readText: async () => {
        reads += 1;
        return {
          ok: true,
          text: '<html><title>Docs</title><body><p>Cached page.</p></body></html>',
          contentType: 'text/html',
          finalUrl: 'https://example.com/cached',
        };
      },
    },
    logger: silentLogger,
    metrics: { inc() {}, observe() {} },
    readCacheTtlMs: 1000,
    now: () => clock,
  });

  const first = await tools.run('read_url', { url: 'https://example.com/cached' }, { chatId: 'c1' });
  clock += 999;
  const second = await tools.run('read_url', { url: 'https://example.com/cached' }, { chatId: 'c1' });
  assert.equal(first.ok, true);
  assert.equal(second.text, first.text);
  assert.equal(reads, 1, 'a cache hit must not refetch the page');

  clock += 2;
  const third = await tools.run('read_url', { url: 'https://example.com/cached' }, { chatId: 'c1' });
  assert.equal(third.ok, true);
  assert.equal(reads, 2, 'an expired entry must be refetched');
});
