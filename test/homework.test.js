import test from 'node:test';
import assert from 'node:assert/strict';
import { isHomeworkRequest } from '../src/core/ai/prompt/homework.js';
import { createPrompt } from '../src/core/ai/prompt/index.js';

test('homework detection covers problems but not casual chat', () => {
  assert.equal(isHomeworkRequest('Giải bài tập toán này: 2x + 3 = 7'), true);
  assert.equal(isHomeworkRequest('solve for x: 3x - 5 = 10'), true);
  assert.equal(isHomeworkRequest('Tính đạo hàm của f(x) = x^2'), true);
  assert.equal(isHomeworkRequest('2 + 2 = ?'), true);
  assert.equal(isHomeworkRequest('Câu 1:\nA. 1\nB. 2\nC. 3\nD. 4'), true);
  assert.equal(isHomeworkRequest('giải trí tối nay làm gì'), false);
  assert.equal(isHomeworkRequest('giải thích phim này hay không'), false);
  assert.equal(isHomeworkRequest('Messi hay Ronaldo?'), false);
  assert.equal(isHomeworkRequest('hello'), false);
});

test('date-shaped numbers do not trigger homework mode', () => {
  assert.equal(isHomeworkRequest('remind me at 9:30 05/11'), false);
  assert.equal(isHomeworkRequest('nhắc tôi lúc 20:00 ngày 05-11'), false);
  assert.equal(isHomeworkRequest('25/12 là ngày gì'), false);
  assert.equal(isHomeworkRequest('tính 1/2 + 3/4'), true);
  assert.equal(isHomeworkRequest('2 + 2 = ?'), true);
});

test('homework overlay keeps compact solutions as the default', () => {
  const registry = createPrompt({ homework: true, tone: 'roast-extreme' });
  const assembly = registry.assemble({ text: '2 + 2 = ?' });
  const homework = assembly.sections.find((section) => section.name === 'core:homework')?.text;
  assert.ok(homework);
  assert.match(homework, /Default to a compact solution/);
  assert.match(homework, /detailed derivation only when requested or needed/);
  assert.doesNotMatch(homework, /overrides the concise default|never skip algebraic or arithmetic steps/);
});