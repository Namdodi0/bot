import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleRequest } from '../src/core/context/assembler.js';
import {
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

test('summary is always kept when trimming', () => {
  const messages = [summaryEntry('remember the name Nam', 0)];
  for (let i = 0; i < 30; i += 1) messages.push({ role: i % 2 ? 'assistant' : 'user', text: `msg ${i}`, ts: i + 1 });
  const built = assemble(messages, { maxMessages: 4 });
  assert.equal(built.messages[1].role, 'user');
  assert.match(String(built.messages[1].content), /Nam/);
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
