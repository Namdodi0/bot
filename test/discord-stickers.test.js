import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDiscordStickerService,
  createStickerToolRunner,
  parseDiscordStickerIds,
} from '../src/platforms/discord/stickers.js';

test('parseDiscordStickerIds keeps snowflake ids and names', () => {
  assert.deepEqual(parseDiscordStickerIds('123456789012345678:wave, 987654321098765432:cat'), [
    { id: '123456789012345678', name: 'wave', tags: [] },
    { id: '987654321098765432', name: 'cat', tags: [] },
  ]);
  assert.deepEqual(parseDiscordStickerIds('not-an-id:oops, 123:short'), []);
});

test('sticker service falls back to configured ids and resolves by name or tag', async () => {
  const config = { discord: { stickers: { enabled: true, ids: '123456789012345678:wave' } } };
  const channel = { guild: { id: 'g1', stickers: { fetch: async () => { throw new Error('missing permission'); } } }, send: async () => {} };
  const client = { channels: { cache: new Map([['c1', channel]]), fetch: async () => channel } };
  const service = createDiscordStickerService({ config, client, logger: null });
  const items = await service.list(channel);
  assert.equal(items.length, 1);
  assert.equal((await service.resolve(channel, 'wave'))?.id, '123456789012345678');
  assert.equal(await service.resolve(channel, 'nope'), null);
});

test('sticker service sends guild stickers', async () => {
  const config = { discord: { stickers: { enabled: true, ids: '' } } };
  const sent = [];
  const guild = {
    id: 'g1',
    stickers: {
      fetch: async () => new Map([['123456789012345678', { id: '123456789012345678', name: 'wave', tags: 'hello' }]]),
    },
  };
  const channel = { guild, send: async (payload) => sent.push(payload) };
  const client = { channels: { cache: new Map([['c1', channel]]), fetch: async () => channel } };
  const service = createDiscordStickerService({ config, client, logger: null, metrics: { inc() {} } });
  const sticker = await service.resolve(channel, 'hello');
  assert.equal(sticker?.name, 'wave');
  await service.send(channel, sticker);
  assert.deepEqual(sent[0], { stickers: ['123456789012345678'], allowedMentions: { parse: [] } });
});

test('sticker tool runner sends through the channel when not suppressed', async () => {
  const config = { discord: { stickers: { enabled: true, ids: '123456789012345678:wave' } } };
  const sent = [];
  const channel = { guild: null, send: async (payload) => sent.push(payload) };
  const client = { channels: { cache: new Map([['c1', channel]]), fetch: async () => channel } };
  const service = createDiscordStickerService({ config, client, logger: null });
  const run = createStickerToolRunner({ stickers: service });

  const result = await run('send_sticker', { emotion: 'wave' }, { chatId: 'c1' });
  assert.deepEqual(result, { ok: true, text: 'Sent the sticker "wave".' });
  assert.deepEqual(sent[0], { stickers: ['123456789012345678'], allowedMentions: { parse: [] } });
});

test('sticker tool runner refuses to post in a private turn', async () => {
  const config = { discord: { stickers: { enabled: true, ids: '123456789012345678:wave' } } };
  const sent = [];
  const channel = { guild: null, send: async (payload) => sent.push(payload) };
  const client = { channels: { cache: new Map([['c1', channel]]), fetch: async () => channel } };
  const service = createDiscordStickerService({ config, client, logger: null });
  const run = createStickerToolRunner({ stickers: service });

  const result = await run('send_sticker', { emotion: 'wave' }, { chatId: 'c1', suppressDirectSend: true });
  assert.deepEqual(result, { ok: false, text: 'Stickers cannot be sent in a private answer.' });
  assert.deepEqual(sent, [], 'nothing may be posted to the channel');
});

test('sticker tool runner ignores other tool names', async () => {
  const service = createDiscordStickerService({ config: { discord: { stickers: { enabled: true, ids: '' } } }, client: null, logger: null });
  const run = createStickerToolRunner({ stickers: service });
  assert.equal(await run('web_search', {}, { chatId: 'c1' }), null);
});
