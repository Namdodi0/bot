import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleRequest } from '../src/core/context/assembler.js';
import {
  contextEntry,
  freshRecord,
  summaryEntry,
  toolCallEntry,
  toolResultEntry,
} from '../src/core/context/record.js';
import { createTokenMeter } from '../src/core/context/token-meter.js';

function assemble(messages, overrides = {}) {
  const record = freshRecord('chat-1', 'GROUP', 0);
  record.messages.push(...messages);
  return assembleRequest({ systemPrompt: 'system', record, maxTokens: 0, maxMessages: 0, ...overrides });
}

test('assemble keeps system + most recent turns, reports dropped/needsSummary', () => {
  const messages = [];
  for (let i = 0; i < 60; i += 1) {
    messages.push({ role: i % 2 ? 'assistant' : 'user', text: `msg ${i}`, ts: i });
  }
  const built = assemble(messages, { maxTokens: 6000, maxMessages: 10, meter: createTokenMeter() });
  assert.equal(built.messages[0].role, 'system');
  assert.equal(built.messages[0].content, 'system');
  const convo = built.messages.slice(1);
  assert.ok(convo.length <= 10);
  assert.equal(convo.at(-1).content, 'msg 59');
  assert.equal(built.needsSummary, true);
});

test('summary is a user message, not a system one', () => {
  const built = assemble([summaryEntry('The user is named Nam.', 1), { role: 'user', text: 'hello', ts: 2 }]);
  assert.equal(built.messages[1].role, 'user');
  assert.match(String(built.messages[1].content), /Nam/);
  assert.equal(built.messages.filter((message) => message.role === 'system').length, 1);
});

test('summary is always kept when trimming', () => {
  const messages = [summaryEntry('remember the name Nam', 0)];
  for (let i = 0; i < 30; i += 1) messages.push({ role: i % 2 ? 'assistant' : 'user', text: `msg ${i}`, ts: i + 1 });
  const built = assemble(messages, { maxMessages: 4 });
  assert.equal(built.messages[1].role, 'user');
  assert.match(String(built.messages[1].content), /Nam/);
});

test('no limit when maxTokens/maxMessages = 0', () => {
  const messages = [];
  for (let i = 0; i < 80; i += 1) {
    messages.push({ role: i % 2 ? 'assistant' : 'user', text: `msg ${i}`, ts: i });
  }
  const built = assemble(messages);
  assert.equal(built.messages.length, 81);
  assert.equal(built.dropped, 0);
  assert.equal(built.needsSummary, false);
  assert.equal(built.messages.at(-1).content, 'msg 79');
});

test('maxCharsPerMessage=0 does not clip long messages', () => {
  const built = assemble([{ role: 'user', text: 'x'.repeat(20_000), ts: 1 }], { maxCharsPerMessage: 0 });
  assert.equal(String(built.messages[1].content).length, 20_000);
});

test('tool-call/tool-result map to the right wire format, never starting with an orphaned tool-result', () => {
  const messages = [
    toolCallEntry({ toolCalls: [{ id: 'c1', name: 'web_search', arguments: { query: 'x' } }], ts: 1 }),
    toolResultEntry({ toolCallId: 'c1', text: 'result', ts: 2 }),
    { role: 'user', text: 'thanks', ts: 3 },
  ];
  const built = assemble(messages, { maxMessages: 10 });
  assert.equal(built.messages[1].role, 'assistant');
  assert.equal(built.messages[1].tool_calls[0].function.name, 'web_search');
  assert.equal(built.messages[2].role, 'tool');
  assert.equal(built.messages[2].tool_call_id, 'c1');
  assert.equal(built.messages[3].content, 'thanks');

  const trimmed = assemble(messages, { maxMessages: 2 });
  assert.equal(trimmed.messages[1].content, 'thanks');
});

test('context entry is sent with the user role', () => {
  const built = assemble([contextEntry({ source: 'runtime:time', text: '[Current time: today]', ts: 1 })]);
  assert.equal(built.messages[1].role, 'user');
  assert.equal(built.messages[1].content, '[Current time: today]');
});

test('an incomplete tool call is dropped with its partial results, complete pairs stay', () => {
  const messages = [
    toolCallEntry({ toolCalls: [{ id: 'c1', name: 'web_search', arguments: { query: 'x' } }], ts: 1 }),
    toolResultEntry({ toolCallId: 'c1', text: 'complete result', ts: 2 }),
    toolCallEntry({
      toolCalls: [
        { id: 'c2', name: 'web_search', arguments: { query: 'y' } },
        { id: 'c3', name: 'web_search', arguments: { query: 'z' } },
      ],
      ts: 3,
    }),
    toolResultEntry({ toolCallId: 'c2', text: 'partial result', ts: 4 }),
  ];
  const built = assemble(messages);
  const wire = built.messages.slice(1);
  assert.equal(wire.length, 2);
  assert.deepEqual(
    wire.map((message) => message.role),
    ['assistant', 'tool'],
  );
  assert.equal(wire[0].tool_calls[0].id, 'c1');
  assert.equal(wire[1].tool_call_id, 'c1');
  assert.equal(JSON.stringify(built.messages).includes('partial result'), false);
  assert.equal(built.keptMessages, 2);
});

test('rawEstimatedTokens is the uncalibrated estimate', () => {
  const meter = createTokenMeter({ calibrator: { estimate: (raw) => raw * 2, observe: () => {}, ratio: () => 2 } });
  const built = assemble([{ role: 'user', text: 'hello', ts: 1 }], { meter });
  assert.equal(built.rawEstimatedTokens * 2, built.estimatedTokens);
});

test('budget accounts for tool schema tokens', () => {
  const tools = [
    {
      type: 'function',
      function: { name: 'big_tool', description: 'd'.repeat(8000), parameters: { type: 'object', properties: {} } },
    },
  ];
  const messages = [];
  for (let i = 0; i < 12; i += 1) {
    messages.push({ role: i % 2 ? 'assistant' : 'user', text: `msg ${i} `.repeat(60), ts: i });
  }
  const meter = createTokenMeter();
  const budget = meter.tools(tools) + 1000;
  const built = assemble(messages, { tools, meter, maxTokens: budget });
  assert.ok(built.keptMessages < messages.length);
  assert.ok(built.keptMessages >= 4);
  assert.ok(built.estimatedTokens <= budget);
  assert.match(String(built.messages.at(-1).content), /msg 11/);

  const withoutTools = assemble(messages, { meter: createTokenMeter(), maxTokens: budget });
  assert.ok(withoutTools.keptMessages > built.keptMessages);
});

test('budget accounts for tool schema tokens without a meter', () => {
  const tools = [{ type: 'function', function: { name: 'big_tool', description: 'd'.repeat(8000) } }];
  const messages = [];
  for (let i = 0; i < 12; i += 1) {
    messages.push({ role: i % 2 ? 'assistant' : 'user', text: `msg ${i} `.repeat(60), ts: i });
  }
  const built = assemble(messages, { tools, maxTokens: 600 });
  assert.ok(built.keptMessages < messages.length);
  assert.equal(built.keptMessages, 4);
});

test('pressure is computed when the context window is known', () => {
  const built = assemble([{ role: 'user', text: 'x'.repeat(400), ts: 1 }], {
    meter: createTokenMeter(),
    contextWindow: 100,
  });
  assert.ok(built.pressure > 0);
  assert.equal(built.contextWindow, 100);
});