import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgent } from '../src/core/ai/agent.js';
import { LLM_ERROR, LlmError } from '../src/core/ai/llm/errors.js';
import { createToolRuntime } from '../src/core/ai/tools.js';
import { createCompactionEngine } from '../src/core/context/compaction/engine.js';
import { createContextStore } from '../src/core/context/store.js';
import { HttpError } from '../src/core/http.js';
import { createMetrics } from '../src/core/metrics.js';
import { makeConfig, makeDiscordPlatform, silentLogger, textEvent } from '../test-utils/helpers.js';

/**
 * @param {{replies?: any[], configOverrides?: Record<string, any>, tavily?: any, nimError?: any, delayMs?: number, deltaText?: string, logger?: any, toolRuntime?: any}} [options]
 */
async function setup(options = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'discord-bot-test-'));
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
    vision: false,
  };
  const visionTarget = {
    alias: 'nim',
    provider: 'nim',
    model: 'nemotron-vl',
    label: 'Nemotron VL',
    vision: true,
  };
  const visionFallbackTarget = {
    alias: 'mistral-large',
    provider: 'nim',
    model: 'mistral-large',
    label: 'Mistral Large',
    vision: true,
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
    find: (alias) => (alias === 'nim' ? visionTarget : alias === 'mistral-large' ? visionFallbackTarget : target),
    list: () => [target],
    fallbackAlias: 'nim-light',
    fallbackFor: (_record, _attempted, opts) => (opts?.requireVision ? 'mistral-large' : 'nim-light'),
    chat: (input) => reply(input),
    chatWith: (alias, input) => reply({ ...input, alias }, true),
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

  const platform = makeDiscordPlatform({ transport });
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
  const agent = createAgent({ config, logger, metrics, platform, llm, store, tools, compaction });

  return { agent, sent, sentStickers, events, nimCalls, store, config, metrics, dir, platform };
}

test('vision turns send the image as an image_url block', async () => {
  const { agent, nimCalls, store } = await setup({ replies: [{ content: 'I see a cat' }] });
  await agent.handle(
    textEvent('what is this', {
      imageUrl: 'https://cdn.example/cat.png',
      imageData: { data: Buffer.from('png-bytes'), contentType: 'image/png' },
      messageId: 'vision-1',
    }),
  );
  assert.equal(nimCalls[0].alias, 'nim', 'the vision alias must be the one actually called');
  assert.equal(nimCalls[0].reasoning, 'high', 'vision turns always use the highest reasoning');
  const lastUser = [...nimCalls[0].messages].reverse().find((message) => message.role === 'user');
  assert.ok(Array.isArray(lastUser.content));
  const image = lastUser.content.find((part) => part.type === 'image_url');
  assert.match(image.image_url.url, /^data:image\/png;base64,/);
  assert.equal(lastUser.content.some((part) => /cannot see/.test(String(part.text ?? ''))), false);
  const record = await store.get('chat-1');
  assert.match(String(record.messages[0].text), /attached an image/);
  assert.doesNotMatch(String(record.messages[0].text), /cannot see/);
});

test('vision turns send up to five image_url blocks from one message', async () => {
  const { agent, nimCalls } = await setup({ replies: [{ content: 'I see them' }] });
  const imageDataList = Array.from({ length: 7 }, (_, index) => ({
    data: Buffer.from(`image-${index}`),
    contentType: 'image/png',
  }));
  await agent.handle(
    textEvent('compare these', {
      imageUrls: imageDataList.map((_, index) => `https://cdn.example/${index}.png`),
      imageDataList,
      messageId: 'vision-many',
    }),
  );
  assert.equal(nimCalls[0].alias, 'nim');
  const lastUser = [...nimCalls[0].messages].reverse().find((message) => message.role === 'user');
  assert.ok(Array.isArray(lastUser.content));
  const blocks = lastUser.content.filter((part) => part.type === 'image_url');
  assert.equal(blocks.length, 5, 'the per-turn limit is five images');
  assert.match(blocks[4].image_url.url, /^data:image\/png;base64,/);
  assert.match(String(lastUser.content[0].text), /attached 5 images/);
});

test('vision fallback keeps the image and uses a vision model', async () => {
  const { agent, nimCalls } = await setup({
    primaryError: new HttpError('upstream down', { status: 503 }),
    replies: [{ content: 'I see the cat' }],
  });
  await agent.handle(
    textEvent('what is this', {
      imageData: { data: Buffer.from('png-bytes'), contentType: 'image/png' },
      messageId: 'vision-fallback',
    }),
  );

  assert.equal(nimCalls.length, 3); // 2 failed vision attempts + 1 fallback
  const fallbackCall = nimCalls.at(-1);
  assert.equal(fallbackCall.alias, 'mistral-large', 'the fallback must be a vision model');
  assert.equal(fallbackCall.tools, undefined);
  const lastUser = [...fallbackCall.messages].reverse().find((message) => message.role === 'user');
  const image = lastUser.content.find((part) => part.type === 'image_url');
  assert.match(image.image_url.url, /^data:image\/png;base64,/);
  assert.match(String(fallbackCall.messages[0].content), /VISION:/);
});

test('a per-chat vision model overrides the configured vision alias', async () => {
  const { agent, nimCalls, store } = await setup({ replies: [{ content: 'I see it' }] });
  const record = await store.get('chat-1', { chatType: 'GROUP' });
  record.meta.visionModel = 'mistral-large';
  store.touch('chat-1');

  await agent.handle(
    textEvent('what is this', {
      imageData: { data: Buffer.from('png-bytes'), contentType: 'image/png' },
      messageId: 'vision-override',
    }),
  );

  assert.equal(nimCalls[0].alias, 'mistral-large');
});


test('private turns are never kept in the shared record', async () => {
  const { agent, sent, store } = await setup();
  await agent.handle(textEvent('my secret', { private: true, messageId: 'private-1' }));
  assert.equal(sent.length, 1);
  const record = await store.get('chat-1');
  assert.equal(record.messages.length, 0);
  assert.deepEqual(record.seen, ['private-1']);
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

test('an image sent with text is noted and image content never reaches the model', async () => {
  const { agent, nimCalls } = await setup();
  await agent.handle(textEvent('look at this image', { imageUrl: 'https://example.com/cat.png' }));
  const messages = nimCalls[0].messages;
  assert.equal(messages.some((message) => Array.isArray(message.content)), false);
  const last = String(messages.at(-1).content);
  assert.match(last, /look at this image/);
  assert.match(last, /attached an image/);
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

test('a full queue drops the message and reports busy', async () => {
  const { agent, sent } = await setup({ delayMs: 40, configOverrides: { maxQueueDepth: 1 } });
  const first = agent.enqueue(textEvent('one'));
  const second = agent.enqueue(textEvent('two'));
  await Promise.all([first, second]);
  assert.ok(sent.some((message) => /too many messages/.test(message.text)));
});

test('a full queue also rejects collected turns with a busy answer', async () => {
  const { agent, sent } = await setup({ delayMs: 40, configOverrides: { maxQueueDepth: 1 } });
  const first = agent.collect(textEvent('one'));
  const second = await agent.collect(textEvent('two'));
  assert.match(second.text, /too many messages/);
  await first;
  assert.equal(sent.length, 0);
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

test('two messages in one chat run in parallel', async () => {
  const { agent, sent, store } = await setup({
    delayMs: 150,
    configOverrides: { userRateLimitPerMinute: 0, maxMessagesPerReply: 1 },
  });
  const started = Date.now();
  await Promise.all([
    agent.enqueue(textEvent('first question', { messageId: 'parallel-1' })),
    agent.enqueue(textEvent('second question', { messageId: 'parallel-2' })),
  ]);
  const elapsed = Date.now() - started;

  assert.ok(sent.length >= 2, 'both turns should send an answer');
  assert.ok(elapsed < 260, `parallel turns took ${elapsed}ms`);
  const record = await store.get('chat-1');
  assert.ok(
    record.messages.filter((message) => message.role === 'user').length >= 2,
    'both user turns must be merged',
  );
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

test('the sender rate limit is scoped per chat', async () => {
  const { agent, nimCalls } = await setup({ configOverrides: { userRateLimitPerMinute: 1 } });
  await agent.handle(textEvent('one', { messageId: 'rl-1', chatId: 'chat-1' }));
  await agent.handle(textEvent('two', { messageId: 'rl-2', chatId: 'chat-1' }));
  await agent.handle(textEvent('three', { messageId: 'rl-3', chatId: 'chat-2' }));
  assert.equal(nimCalls.length, 2);
});

test('stopAccepting drops new messages and rejects new exclusive work', async () => {
  const { agent, nimCalls } = await setup();
  agent.stopAccepting();
  await agent.enqueue(textEvent('too late'));
  assert.equal(nimCalls.length, 0);
  await assert.rejects(
    () => agent.exclusive('chat-1', async () => {}),
    (error) => /** @type {any} */ (error)?.name === 'QueueFullError',
  );
});

test('exclusive work also respects maxQueueDepth', async () => {
  const { agent } = await setup({ configOverrides: { maxQueueDepth: 1 } });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = agent.exclusive('chat-1', () => gate);
  await assert.rejects(
    () => agent.exclusive('chat-1', async () => {}),
    (error) => /** @type {any} */ (error)?.name === 'QueueFullError',
  );
  release();
  await first;
});

test('a tool call with unparseable arguments is recorded as an error instead of executed', async () => {
  let ran = false;
  const toolRuntime = {
    definitions: () => [
      {
        type: 'function',
        function: { name: 'web_search', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
      },
    ],
    run: async () => {
      ran = true;
      return { ok: true, text: 'should not run' };
    },
  };
  const { agent, store } = await setup({
    toolRuntime,
    replies: [
      {
        content: '',
        toolCalls: [{ id: 'call_1', name: 'web_search', arguments: {}, rawArguments: '{}', parseError: true }],
      },
      { content: 'Recovered answer', toolCalls: [] },
    ],
  });

  await agent.handle(textEvent('search something'));
  assert.equal(ran, false);
  const record = await store.get('chat-1');
  assert.ok(
    record.messages.some(
      (message) => message.kind === 'tool-result' && /not valid JSON/.test(String(message.text)),
    ),
  );
});

test('a progressive head that failed to send is included in the final answer', async () => {
  const longText = `${'A'.repeat(90)}. ${'B'.repeat(90)}`;
  const { agent, platform } = await setup({
    configOverrides: { progressive: 'on', maxMessagesPerReply: 3 },
    replies: [{ content: longText, toolCalls: [] }],
    deltaText: longText,
  });
  /** @type {string[]} */
  const delivered = [];
  let sends = 0;
  platform.transport.sendMessage = async (_chatId, text) => {
    sends += 1;
    if (sends === 1) throw new Error('transport rejected the progressive head');
    delivered.push(String(text));
    return { ok: true };
  };

  await agent.handle(textEvent('write a long answer'));
  const joined = delivered.join('\n');
  assert.match(joined, /^A{80}/, 'the final delivery must include the unsent head');
  assert.match(joined, /B{80}/);
});
