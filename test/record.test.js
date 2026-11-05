import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA_VERSION,
  freshRecord,
  normalizeRecord,
} from '../src/core/context/record.js';

test('normalizeRecord upgrades a v1 record with a summary into a summary node', () => {
  const record = {
    chatId: 'c',
    chatType: 'GROUP',
    summary: 'old summary',
    messages: [{ role: 'user', text: 'hi', ts: 1 }],
    turns: 1,
    updatedAt: 5,
    meta: {},
  };
  normalizeRecord(record);
  assert.equal(record.schemaVersion, SCHEMA_VERSION);
  assert.equal('summary' in record, false);
  assert.equal(record.messages[0].kind, 'summary');
  assert.equal(record.messages[0].role, 'user');
  assert.equal(record.messages[0].text, 'old summary');
  assert.equal(record.messages[1].kind, 'turn');
  assert.deepEqual(record.seen, []);
});

test('normalizeRecord idempotent', () => {
  const record = freshRecord('c', 'GROUP', 1);
  normalizeRecord(record);
  normalizeRecord(record);
  assert.equal(record.messages.length, 0);
  assert.equal(record.schemaVersion, SCHEMA_VERSION);
});
