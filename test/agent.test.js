import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { __test__ as agentTest, createAgent } from '../src/core/ai/agent.js';
import { LLM_ERROR, LlmError } from '../src/core/ai/llm/errors.js';
import { createToolRuntime } from '../src/core/ai/tools.js';
import { createCommands } from '../src/core/commands/index.js';
import { createCompactionEngine } from '../src/core/context/compaction/engine.js';
import { createContextStore } from '../src/core/context/store.js';
import { HttpError } from '../src/core/http.js';
import { createMetrics } from '../src/core/metrics.js';
import { makeConfig, makeDiscordPlatform, makeZaloPlatform, silentLogger, textEvent } from '../test-utils/helpers.js';
import { createZaloAdmission } from '../src/platforms/zalo/incoming.js';

/**
 * @param {{replies?: any[], configOverrides?: Record<string, any>, tavily?: any, nimError?: any, delayMs?: number, deltaText?: string, logger?: any, toolRuntime?: any}} [options]
 */
async function setup(options = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-bot-test-'));
  const config = makeConfig({
    ...(options.configOverrides ?? {}),
    context: { dir, ...(options.configOverrides?.context ?? {}) },
  });
  const metrics = createMetrics();
  const logger = options.logger ?? silentLogger;
  const store = createContextStore({ dir, logger, debounceMs: 2 });
  await store.init();

  /** @type {any[]} */
  const sent = [];
  /** @type {string[]} */
  const events = [];
  /** @type {any[]} */
  const sentStickers = [];
  const transport = {
    displayName: 'Bot deepseek',
    sendMessage: async (chatId, text, opts) => {
      events.push('send');
      sent.push({ chatId, text, opts });
      return { ok: true };
    },
    sendPhoto: async (chatId, url, caption) => {
      sent.push({ chatId, text: caption, photo: url });
      return { ok: true };
    },
    sendSticker: async (chatId, stickerId) => {
      sentStickers.push({ chatId, stickerId });
      return { ok: true };
    },
    sendChatAction: async () => ({ ok: true }),
    startTyping: () => async () => {
      events.push('typing:stop');
    },
    stopAllTyping: () => {},
  };

  /** @type {any[]} */
  const nimCalls = [];
  const replies = options.replies ?? [{ content: 'Hello 👋', toolCalls: [] }];
  let index = 0;
  let primaryCalls = 0;
  let overflowed = false;
  const target = {
    alias: 'deepseek',
    provider: 'deepseek',
    model: 'deepseek-flash',
    label: 'DeepSeek V4.1 Flash',
  };
  async function reply(input, viaFallback = false) {
    nimCalls.push(input);
    if (!viaFallback) primaryCalls += 1;
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (options.overflowFirst && !overflowed) {
      overflowed = true;
      throw new LlmError(LLM_ERROR.CONTEXT_WINDOW_EXCEEDED, 'maximum context length exceeded', { status: 400 });
    }
    if (options.nimError) throw options.nimError;
    if (options.primaryError && !viaFallback) throw options.primaryError;
    if (options.failPrimaryAfterFirst && !viaFallback && primaryCalls > 1) {
      throw new HttpError('upstream down', { status: 503 });
    }
    if (options.fallbackError && viaFallback) throw options.fallbackError;
    if (options.finalContent && !input.tools?.length) {
      return {
        content: options.finalContent,
        reasoning: '',
        toolCalls: [],
        usage: { prompt_tokens: 20, completion_tokens: 10 },
        latencyMs: 1,
        completionTokens: 10,
        completionMs: 1,
        aborted: false,
      };
    }
    if (options.deltaText && input.onDelta) await input.onDelta(options.deltaText);
    const item = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return {
      content: item.content ?? '',
      reasoning: item.reasoning ?? '',
      toolCalls: item.toolCalls ?? [],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
      latencyMs: 1,
      completionTokens: 10,
      completionMs: 1,
      aborted: false,
    };
  }
  const llm = {
    resolve: () => target,
    find: () => target,
    list: () => [target],
    fallbackAlias: 'nim-light',
    fallbackFor: () => 'nim-light',
    chat: (input) => reply(input),
    chatWith: (_alias, input) => reply(input, true),
    async warmup() {
      return 1;
    },
  };

  const stickers = {
    find: (query) => (String(query).includes('greeting') ? { id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi' } : null),
    random: () => ({ id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi' }),
    list: () => [{ id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi', tags: ['greeting'] }],
    curated: () => [{ id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi', tags: ['greeting'] }],
    size: () => 1,
  };

  const platform =
    options.platformName === 'discord'
      ? makeDiscordPlatform({ transport })
      : makeZaloPlatform({ config, transport, stickers, logger, metrics });
  const tools =
    options.toolRuntime ??
    createToolRuntime({
      config,
      tavily: options.tavily ?? null,
      platform,
      validator: { validate: async () => ({ ok: true }) },
      logger,
      metrics,
    });
  const compaction = createCompactionEngine({
    config,
    logger,
    metrics,
    summarize: async () => 'test summary',
  });
  const commands = createCommands({
    config,
    store,
    metrics,
    platform,
    http: {
      stateOf: () => ({ failures: 0, open: false, openedUntil: 0 }),
      listStates: () => [],
    },
    models: llm,
    logger,
    compaction,
  });
  const agent = createAgent({ config, logger, metrics, platform, llm, store, tools, commands, compaction });

  return { agent, sent, sentStickers, events, nimCalls, store, config, metrics, dir, platform };
}

test('replies in a group, strips the mention, stores context', async () => {
  const { agent, sent, store } = await setup();
  await agent.handle(textEvent('@Bot deepseek hello there'));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 'chat-1');
  assert.match(sent[0].text, /Hello/);

  const record = await store.get('chat-1');
  assert.equal(record.turns, 1);
  assert.equal(record.messages.length, 2);
  assert.equal(record.messages[0].text, 'Nam: hello there');
  assert.equal(record.messages[1].role, 'assistant');
});

test('dedupes by message_id', async () => {
  const { agent, sent } = await setup();
  const event = textEvent('hi', { messageId: 'same-id' });
  await agent.handle(event);
  await agent.handle(event);
  assert.equal(sent.length, 1);
});

test('skips messages sent by the bot', async () => {
  const { agent, sent } = await setup();
  await agent.handle(textEvent('hi', { isBot: true }));
  assert.equal(sent.length, 0);
});

test('the Zalo admission gate rejects chats outside the allowlist', () => {
  const admits = createZaloAdmission(makeConfig({ allowedChatIds: ['other-chat'] }));
  assert.equal(admits(textEvent('hi')), false);
  assert.equal(admits(textEvent('hi', { chatId: 'other-chat' })), true);
});

test('splits a long reply into several messages, at most maxMessagesPerReply', async () => {
  const { agent, sent } = await setup({ replies: [{ content: 'A'.repeat(5000) }] });
  await agent.handle(textEvent('write something long'));
  assert.equal(sent.length, 3);
  for (const message of sent) assert.ok(message.text.length <= 1910, `long ${message.text.length}`);
});

test('/help is handled before the model', async () => {
  const { agent, sent, nimCalls } = await setup();
  await agent.handle(textEvent('/help'));
  assert.equal(nimCalls.length, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /\/status/);
});

test('images sent by users are only noted, image_url is not sent', async () => {
  const { agent, nimCalls } = await setup();
  await agent.handle(
    textEvent('', {
      kind: 'image',
      imageUrl: 'https://example.com/cat.png',
      eventName: 'message.image.received',
    }),
  );
  const messages = nimCalls[0].messages;
  assert.equal(messages.some((message) => Array.isArray(message.content)), false);
  assert.match(String(messages.at(-1).content), /The user sent an image/);
});

test('an image sent with text is noted and image content never reaches the model', async () => {
  const { agent, nimCalls } = await setup();
  await agent.handle(textEvent('look at this image', { imageUrl: 'https://example.com/cat.png' }));
  const messages = nimCalls[0].messages;
  assert.equal(messages.some((message) => Array.isArray(message.content)), false);
  const last = String(messages.at(-1).content);
  assert.match(last, /look at this image/);
  assert.match(last, /attached an image/);
});

test('web_search tool call, then an answer with the source', async () => {
  const tavily = {
    search: async () => ({
      results: [{ title: 'Gold price', url: 'https://vnexpress.net/abc', content: 'Gold price rises' }],
      images: [],
    }),
  };
  const { agent, sent, nimCalls } = await setup({
    tavily,
    replies: [
      { toolCalls: [{ id: 'call-1', name: 'web_search', arguments: { query: 'gold price' }, rawArguments: '{"query":"gold price"}' }] },
      { content: 'Gold price is up today (https://vnexpress.net/abc)' },
    ],
  });

  await agent.handle(textEvent('@Bot deepseek gold price today?'));
  assert.equal(nimCalls.length, 2);
  assert.equal(nimCalls[1].messages.some((message) => message.role === 'tool'), true);
  assert.match(sent.at(-1).text, /vnexpress/);
});

test('model errors produce an apology instead of a crash', async () => {
  const { agent, sent } = await setup({ nimError: new Error('boom') });
  await agent.handle(textEvent('hi'));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Sorry/);
});

test('stops typing BEFORE sending the first message', async () => {
  const { agent, events } = await setup({ configOverrides: { typing: true } });
  await agent.handle(textEvent('hi'));
  assert.equal(events[0], 'typing:stop');
  assert.ok(events.includes('send'));
});

test('no reply-message limit when MAX_MESSAGES_PER_REPLY=0', async () => {
  const { agent, sent } = await setup({
    replies: [{ content: 'A'.repeat(12_000) }],
    configOverrides: { maxMessagesPerReply: 0 },
  });
  await agent.handle(textEvent('write something long'));
  assert.ok(sent.length >= 7, `only sent ${sent.length} messages`);
});

test('an incoming sticker is echoed back unchanged', async () => {
  const { agent, sentStickers, sent } = await setup();
  await agent.handle(
    textEvent('', {
      kind: 'sticker',
      sticker: '0e078a2fb66a5f34067b',
      eventName: 'message.sticker.received',
    }),
  );
  assert.equal(sentStickers.length, 1);
  assert.equal(sentStickers[0].stickerId, '0e078a2fb66a5f34067b');
  assert.equal(sent.length, 0);
});

test('an incoming sticker with the feature disabled gets the normal text reply', async () => {
  const { agent, sent } = await setup({
    configOverrides: { sticker: { enabled: false, echo: true, file: './data/test/stickers.json' } },
  });
  await agent.handle(
    textEvent('', {
      kind: 'sticker',
      sticker: '0e078a2fb66a5f34067b',
      eventName: 'message.sticker.received',
      messageId: 'sticker-disabled',
    }),
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /cannot view stickers/);
});

test('/sticker sends a sticker for the given mood', async () => {
  const { agent, sentStickers } = await setup();
  await agent.handle(textEvent('/sticker greeting'));
  assert.equal(sentStickers.length, 1);
  assert.equal(sentStickers[0].stickerId, 'd8fa8021bc64553a0c75');
});

test('keeps the question when the model fails', async () => {
  const { agent, store } = await setup({ nimError: new Error('boom') });
  await agent.handle(textEvent('hi'));
  const record = await store.get('chat-1');
  assert.equal(record.messages[0].role, 'user');
  assert.match(String(record.messages[0].text), /hi/);
  assert.equal(record.turns, 1);
});

test('PROGRESSIVE=on sends split segments early', async () => {
  const head = `${'a'.repeat(140)}. `;
  const { agent, sent } = await setup({
    replies: [{ content: `${head}the rest` }],
    deltaText: head,
    configOverrides: { progressive: 'on' },
  });
  await agent.handle(textEvent('tell me a long story'));
  assert.ok(sent.length >= 2, `only sent ${sent.length} messages`);
  assert.match(sent[0].text, /^a+\./);
});

test('meta.split=off merges the reply into one message even with PROGRESSIVE=on', async () => {
  const head = `${'a'.repeat(140)}. `;
  const { agent, sent, store } = await setup({
    replies: [{ content: `${head}the rest` }],
    deltaText: head,
    configOverrides: { progressive: 'on' },
  });
  const record = await store.get('chat-1');
  record.meta.split = 'off';
  await agent.handle(textEvent('tell me a long story'));
  assert.equal(sent.length, 1, `sent ${sent.length} messages`);
  assert.match(sent[0].text, /the rest/);
});

test('durable dedupe: a message_id already stored in context is skipped', async () => {
  const { agent, sent, store } = await setup();
  const record = await store.get('chat-1');
  record.seen = ['msg-old'];
  await agent.handle(textEvent('hello again', { messageId: 'msg-old' }));
  assert.equal(sent.length, 0);
});

test('USER_RATE_LIMIT_PER_MINUTE blocks spam per sender', async () => {
  const { agent, sent } = await setup({ configOverrides: { userRateLimitPerMinute: 1 } });
  await agent.handle(textEvent('one'));
  await agent.handle(textEvent('two'));
  assert.equal(sent.length, 1);
});

test('drain waits for in-flight messages to finish sending', async () => {
  const { agent, sent } = await setup({ delayMs: 60 });
  const task = agent.enqueue(textEvent('wait for me'));
  const left = await agent.drain(5000);
  assert.equal(left, 0);
  await task;
  assert.equal(sent.length, 1);
});

test('a tool round does not lose the final part of the reply', async () => {
  const head = `${'a'.repeat(140)}. `;
  const { agent, sent } = await setup({
    replies: [
      { content: head, toolCalls: [{ id: 'c1', name: 'web_search', arguments: { query: 'x' } }] },
      { content: 'final answer' },
    ],
    deltaText: head,
    configOverrides: { progressive: 'on' },
  });
  await agent.handle(textEvent('search for me'));
  assert.ok(
    sent.some((message) => /final answer/.test(message.text)),
    `sent=${JSON.stringify(sent)}`,
  );
});

test('MAX_MESSAGES_PER_REPLY=1 does not split early and loses nothing', async () => {
  const head = `${'b'.repeat(140)}. `;
  const { agent, sent } = await setup({
    replies: [{ content: `${head}the ending` }],
    deltaText: head,
    configOverrides: { progressive: 'on', maxMessagesPerReply: 1 },
  });
  await agent.handle(textEvent('tell me a story'));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /the ending/);
});

test('a full queue drops the message and reports busy', async () => {
  const { agent, sent } = await setup({ delayMs: 40, configOverrides: { maxQueueDepth: 1 } });
  const first = agent.enqueue(textEvent('one'));
  const second = agent.enqueue(textEvent('two'));
  await Promise.all([first, second]);
  assert.ok(sent.some((message) => /too many messages/.test(message.text)));
});

test('planAttemptBudget: non-streaming reserves 25% of the deadline for fallback', () => {
  const first = agentTest.planAttemptBudget({
    remainingMs: 30_000,
    attempt: 1,
    maxAttempts: 2,
    streaming: false,
    aiTimeoutMs: 15_000,
  });
  assert.equal(first.reserveMs, 7500);
  assert.equal(first.primaryMs, 22_500);
  assert.equal(first.timeoutMs, 11_250);
  assert.ok(first.ttftMs <= 9000);

  const second = agentTest.planAttemptBudget({
    remainingMs: 17_500,
    attempt: 2,
    maxAttempts: 2,
    streaming: false,
    aiTimeoutMs: 15_000,
  });
  assert.equal(second.timeoutMs, 13_125);
  assert.ok(second.reserveMs >= 2500);
});

test('planAttemptBudget: streaming still reserves room for the fallback', () => {
  const plan = agentTest.planAttemptBudget({
    remainingMs: 30_000,
    attempt: 1,
    maxAttempts: 2,
    streaming: true,
    aiTimeoutMs: 15_000,
  });
  assert.equal(plan.reserveMs, 7500);
  assert.equal(plan.primaryMs, 22_500);
  assert.equal(plan.timeoutMs, 22_500);
  assert.equal(plan.ttftMs, 9000);
});

test('planAttemptBudget: a streaming retry also leaves the fallback reserve', () => {
  const plan = agentTest.planAttemptBudget({
    remainingMs: 20_000,
    attempt: 2,
    maxAttempts: 2,
    streaming: true,
    aiTimeoutMs: 15_000,
  });
  assert.equal(plan.reserveMs, 5000);
  assert.equal(plan.timeoutMs, 15_000);
  assert.ok(20_000 - plan.timeoutMs >= 2500);
});

test('planAttemptBudget: unlimited AI timeout removes the cap and the TTFT guard', () => {
  const plan = agentTest.planAttemptBudget({
    remainingMs: Number.POSITIVE_INFINITY,
    attempt: 1,
    maxAttempts: 2,
    streaming: false,
    aiTimeoutMs: 0,
  });
  assert.equal(plan.timeoutMs, Number.POSITIVE_INFINITY);
  assert.equal(plan.ttftMs, 0);
});

test('planAttemptBudget: a tight deadline gives a short attempt with no room for fallback', () => {
  const plan = agentTest.planAttemptBudget({
    remainingMs: 3000,
    attempt: 1,
    maxAttempts: 2,
    streaming: false,
    aiTimeoutMs: 15_000,
  });
  assert.equal(plan.reserveMs, 750);
  assert.ok(plan.reserveMs < 2500);
  assert.equal(plan.timeoutMs, 1500);
});

test('retryable primary failure: retry then fallback, the user still gets an answer', async () => {
  const { agent, sent, nimCalls } = await setup({
    primaryError: new HttpError('upstream down', { status: 503 }),
  });
  await agent.handle(textEvent('hi'));

  assert.equal(nimCalls.length, 3); // 2 primary attempts + 1 fallback
  assert.match(sent.at(-1).text, /Hello/);
});

test('budget abort is not retried: the remaining time goes to the fallback', async () => {
  const { agent, sent, nimCalls } = await setup({
    primaryError: new HttpError('nim:model aborted by caller', { status: 0, aborted: true }),
  });
  await agent.handle(textEvent('hi'));

  assert.equal(nimCalls.length, 2); // 1 primary attempt (no retry) + 1 fallback
  assert.match(sent.at(-1).text, /Hello/);
});

test('time context: a separate, durable user message that never alters the user turn', async () => {
  const { agent, store } = await setup({ replies: [{ content: 'A' }, { content: 'B' }] });
  await agent.handle(textEvent('h\u00f4m nay th\u1ebf n\u00e0o', { messageId: 'm1' }));

  const record = await store.get('chat-1');
  const timeEntries = record.messages.filter((m) => m.kind === 'context' && m.source === 'runtime:time');
  assert.equal(timeEntries.length, 1);
  assert.match(timeEntries[0].text, /Current time/);
  const userTurn = record.messages.find((m) => m.kind === 'turn' && m.role === 'user');
  assert.equal(userTurn.text.includes('Current time'), false);
});

test('time context is refreshed and never duplicated across turns', async () => {
  const { agent, store } = await setup({ replies: [{ content: 'A' }, { content: 'B' }] });
  await agent.handle(textEvent('h\u00f4m nay th\u1ebf n\u00e0o', { messageId: 'm1' }));
  await agent.handle(textEvent('mai \u0111i h\u1ecdc kh\u00f4ng', { messageId: 'm2' }));

  const record = await store.get('chat-1');
  const timeEntries = record.messages.filter((m) => m.kind === 'context' && m.source === 'runtime:time');
  assert.equal(timeEntries.length, 1);
});

test('time context disappears when the new turn mentions no time marker', async () => {
  const { agent, store } = await setup({ replies: [{ content: 'A' }, { content: 'B' }] });
  await agent.handle(textEvent('h\u00f4m nay th\u1ebf n\u00e0o', { messageId: 'm1' }));
  await agent.handle(textEvent('explain TCP', { messageId: 'm2' }));

  const record = await store.get('chat-1');
  assert.equal(record.messages.some((m) => m.kind === 'context' && m.source === 'runtime:time'), false);
});

test('ordinary questions do not inject date/time into the prompt sent to the model', async () => {
  const { agent, nimCalls } = await setup();
  await agent.handle(textEvent('explain TCP'));
  const lastUser = [...nimCalls.at(-1).messages].reverse().find((message) => message.role === 'user');
  assert.equal(lastUser.content.includes('Current time'), false);
  assert.equal(lastUser.content.includes('Length'), false);
});

test('short requests do not inject a length note into the prompt sent to the model', async () => {
  const { agent, nimCalls } = await setup();
  await agent.handle(textEvent('explain TCP briefly'));
  const lastUser = [...nimCalls.at(-1).messages].reverse().find((message) => message.role === 'user');
  assert.equal(lastUser.content.includes('Length'), false);
});

test('context overflow: compacts the context then retries, no error shown to the user', async () => {
  const { agent, sent, store } = await setup({
    overflowFirst: true,
    replies: [{ content: 'Answered after compaction' }],
    configOverrides: { context: { keepRecent: 4 } },
  });
  const record = await store.get('chat-1', { chatType: 'GROUP' });
  for (let index = 0; index < 16; index += 1) {
    record.messages.push({
      role: index % 2 ? 'assistant' : 'user',
      kind: 'turn',
      text: `old message ${index}`,
      ts: index,
    });
  }
  store.touch('chat-1');

  await agent.handle(textEvent('new question', { messageId: 'overflow-1' }));

  assert.match(sent.at(-1).text, /after compaction/);
  const updated = await store.get('chat-1');
  assert.equal(updated.messages.some((message) => message.kind === 'summary'), true);
});

test('turn 2 sends turn 1 user and assistant messages to the API', async () => {
  const { agent, nimCalls } = await setup({
    replies: [{ content: 'Hi Nam' }, { content: 'Your name is Nam' }],
  });

  await agent.handle(textEvent('my name is Nam'));
  await agent.handle(textEvent('what is my name'));

  const payload = nimCalls.at(-1).messages;
  assert.equal(
    payload.some((message) => message.role === 'user' && String(message.content).includes('my name is Nam')),
    true,
  );
  assert.equal(
    payload.some((message) => message.role === 'assistant' && String(message.content).includes('Hi Nam')),
    true,
  );
  // The newest question is still last in the payload.
  assert.match(String(payload.at(-1).content), /what is my name/);
});

test('console log shows the user message, bot message, model name, tok/s and thinking', async () => {
  /** @type {string[]} */
  const lines = [];
  const capture = {
    debug: (msg, fields) => lines.push(`debug ${msg} ${JSON.stringify(fields ?? {})}`),
    info: (msg, fields) => lines.push(`info ${msg} ${JSON.stringify(fields ?? {})}`),
    warn: () => {},
    error: () => {},
  };
  capture.child = () => capture;

  const { agent } = await setup({
    logger: capture,
    replies: [{ content: 'Hi Nam, how are you?', reasoning: 'The user is named Nam.' }],
  });
  await agent.handle(textEvent('my name is Nam'));

  const log = lines.join('\n');
  assert.match(log, /💬 Nam: my name is Nam/);
  assert.match(log, /🧠 thinking: The user is named Nam\./);
  assert.match(log, /🤖 bot: Hi Nam, how are you\?/);
  assert.match(log, /✅ replied · deepseek-flash · 10000 tok\/s/);
  assert.match(log, /"model":"deepseek-flash"/);
  assert.match(log, /"tps":10000/);
});

test('findBreak cuts right after punctuation without repeating the mark', () => {
  const buffer = `${'a'.repeat(100)}. Next part`;
  const cut = agentTest.findBreak(buffer);
  assert.equal(buffer.slice(0, cut), `${'a'.repeat(100)}.`);
  assert.equal(buffer.slice(cut), ' Next part');

  const paragraph = `${'b'.repeat(80)}\n\nNew paragraph`;
  assert.equal(paragraph.slice(0, agentTest.findBreak(paragraph)), `${'b'.repeat(80)}\n\n`);

  // do not cut right after a dangling list number
  const danglingList = `${'c'.repeat(120)}\n2. `;
  const danglingCut = agentTest.findBreak(danglingList);
  assert.equal(danglingCut, 121);
  assert.equal(danglingList.slice(0, danglingCut).includes('2.'), false);
});

test('fallback after a tool round sends a clean transcript without tools', async () => {
  const tavily = {
    search: async () => ({ results: [{ title: 'Gold', url: 'https://x', content: 'price' }], images: [] }),
  };
  const { agent, sent, nimCalls } = await setup({
    tavily,
    failPrimaryAfterFirst: true,
    replies: [
      {
        content: '',
        toolCalls: [{ id: 'call_1', name: 'web_search', arguments: { query: 'gold' }, rawArguments: '{"query":"gold"}' }],
      },
      { content: 'Fallback answer' },
    ],
  });

  await agent.handle(textEvent('gold price?'));

  const fallbackCall = nimCalls.at(-1);
  assert.equal(fallbackCall.tools, undefined);
  assert.equal(fallbackCall.messages.some((message) => message.role === 'tool'), false);
  assert.equal(fallbackCall.messages.some((message) => Array.isArray(message.tool_calls)), false);
  assert.match(
    fallbackCall.messages.map((message) => String(message.content ?? '')).join('\n'),
    /\[tool result\]/,
  );
  assert.match(sent.at(-1).text, /Fallback answer/);
});

test('a throwing tool still records a paired result, so the next turn builds clean messages', async () => {
  let runCount = 0;
  const toolRuntime = {
    definitions: () => [
      {
        type: 'function',
        function: { name: 'web_search', description: 'search', parameters: { type: 'object', properties: {} } },
      },
    ],
    run: async () => {
      runCount += 1;
      throw new Error('disk full');
    },
  };
  const { agent, sent, store, nimCalls } = await setup({
    toolRuntime,
    replies: [
      {
        toolCalls: [{ id: 'call-1', name: 'web_search', arguments: { query: 'x' }, rawArguments: '{"query":"x"}' }],
      },
      { content: 'answered anyway' },
    ],
  });

  await agent.handle(textEvent('search please', { messageId: 'm1' }));
  const record = await store.get('chat-1');
  const call = record.messages.find((message) => message.kind === 'tool-call');
  const results = record.messages.filter((message) => message.kind === 'tool-result');
  assert.ok(call);
  assert.equal(results.length, call.toolCalls.length);
  assert.equal(results[0].toolCallId, 'call-1');
  assert.match(results[0].text, /Tool web_search failed: disk full/);
  assert.match(sent.at(-1).text, /answered anyway/);

  await agent.handle(textEvent('second question', { messageId: 'm2' }));
  const messages = nimCalls.at(-1).messages;
  const callIndex = messages.findIndex((message) => Array.isArray(message.tool_calls));
  assert.ok(callIndex >= 0);
  assert.equal(messages[callIndex + 1].role, 'tool');
  assert.equal(messages[callIndex + 1].tool_call_id, messages[callIndex].tool_calls[0].id);
  assert.ok(runCount >= 1);
});

test('the no-tools fallback prompt does not advertise tool guidance', async () => {
  const tavily = {
    search: async () => ({ results: [{ title: 'Gold', url: 'https://x', content: 'price' }], images: [] }),
  };
  const { agent, nimCalls } = await setup({
    tavily,
    failPrimaryAfterFirst: true,
    replies: [
      {
        content: '',
        toolCalls: [{ id: 'call_1', name: 'web_search', arguments: { query: 'gold' }, rawArguments: '{"query":"gold"}' }],
      },
      { content: 'Fallback answer' },
    ],
  });

  await agent.handle(textEvent('gold price?'));

  const primary = nimCalls[0];
  const fallback = nimCalls.at(-1);
  assert.ok(primary.tools?.length);
  assert.equal(fallback.tools, undefined);
  assert.equal(primary.messages[0].role, 'system');
  assert.equal(fallback.messages[0].role, 'system');
  assert.match(String(primary.messages[0].content), /call the `web_search` tool/);
  assert.doesNotMatch(String(fallback.messages[0].content), /call the `web_search` tool/);
});

test('the final answer call after tool rounds also sends no tool guidance', async () => {
  const tavily = {
    search: async () => ({ results: [{ title: 'Gold', url: 'https://x', content: 'price' }], images: [] }),
  };
  const toolRound = {
    content: '',
    toolCalls: [{ id: 'call_1', name: 'web_search', arguments: { query: 'gold' }, rawArguments: '{"query":"gold"}' }],
  };
  const { agent, nimCalls } = await setup({
    tavily,
    configOverrides: { ai: { maxToolRounds: 1 } },
    replies: [toolRound],
    finalContent: 'Final synthesis from search results',
  });

  await agent.handle(textEvent('gold price?'));

  const finalCall = nimCalls.at(-1);
  assert.equal(finalCall.tools, undefined);
  assert.doesNotMatch(String(finalCall.messages[0].content), /call the `web_search` tool/);
  assert.match(String(nimCalls[0].messages[0].content), /call the `web_search` tool/);
});

test('after MAX_TOOL_ROUNDS a final no-tools call answers from the tool results', async () => {
  const tavily = {
    search: async () => ({ results: [{ title: 'Gold', url: 'https://x', content: 'price' }], images: [] }),
  };
  const toolRound = {
    content: '',
    toolCalls: [{ id: 'call_1', name: 'web_search', arguments: { query: 'gold' }, rawArguments: '{"query":"gold"}' }],
  };
  const { agent, sent, nimCalls } = await setup({
    tavily,
    replies: [toolRound],
    finalContent: 'Final synthesis from search results',
  });

  await agent.handle(textEvent('gold price?'));

  assert.equal(nimCalls.length, 4);
  assert.equal(nimCalls.at(-1).tools, undefined);
  assert.match(sent.at(-1).text, /Final synthesis/);
});

test('STICKER_ECHO=off sends nothing when a sticker arrives', async () => {
  const { agent, sent, sentStickers } = await setup({
    configOverrides: { sticker: { enabled: true, echo: false, file: './data/test/stickers.json' } },
  });
  await agent.handle(
    textEvent('', { kind: 'sticker', sticker: '0e078a2fb66a5f34067b', messageId: 'sticker-1' }),
  );
  assert.equal(sentStickers.length, 0);
  assert.equal(sent.length, 0);
});

test('passes the configured sampling parameters to the LLM', async () => {
  const { agent, nimCalls } = await setup({
    configOverrides: {
      deepseek: { topP: 0.9, frequencyPenalty: 0.2, presencePenalty: 0.3 },
    },
  });
  await agent.handle(textEvent('hi'));
  assert.deepEqual(nimCalls[0].sampling, {
    topP: 0.9,
    frequencyPenalty: 0.2,
    presencePenalty: 0.3,
  });
});

test('the sender rate limit is scoped per chat', async () => {
  const { agent, nimCalls } = await setup({ configOverrides: { userRateLimitPerMinute: 1 } });
  await agent.handle(textEvent('one', { messageId: 'rl-1', chatId: 'chat-1' }));
  await agent.handle(textEvent('two', { messageId: 'rl-2', chatId: 'chat-1' }));
  await agent.handle(textEvent('three', { messageId: 'rl-3', chatId: 'chat-2' }));
  assert.equal(nimCalls.length, 2);
});

test('Discord splits long text at its 2000-character limit, Zalo at 1900', async () => {
  const content = 'x'.repeat(2500);
  const configOverrides = { maxMessagesPerReply: 0, progressive: 'off' };

  const discord = await setup({ platformName: 'discord', replies: [{ content, toolCalls: [] }], configOverrides });
  await discord.agent.handle(textEvent('long', { platform: 'discord', chatId: 'discord:c1' }));
  assert.deepEqual(discord.sent.map((item) => item.text.length), [2000, 500]);

  const zalo = await setup({ replies: [{ content, toolCalls: [] }], configOverrides });
  await zalo.agent.handle(textEvent('long'));
  assert.deepEqual(zalo.sent.map((item) => item.text.length), [1900, 600]);
});

test('discord replies reference the triggering message', async () => {
  const { agent, sent } = await setup({ platformName: 'discord' });
  await agent.handle(
    textEvent('hello', {
      platform: 'discord',
      chatId: 'discord:chan-1',
      botName: 'Bot',
      messageId: 'm-1',
    }),
  );
  assert.equal(sent[0].chatId, 'discord:chan-1');
  assert.equal(sent[0].opts?.replyToMessageId, 'm-1');
});
