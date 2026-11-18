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

test('ambiguous task words do not turn narrative dialogue into homework', () => {
  for (const text of [
    'I draw my sword. Prove your loyalty to the king.',
    'The commander hands me my next assignment.',
    'Tôi nhìn vào mắt anh: chứng minh tình yêu của anh đi.',
    'Please prove your identity.',
    'I calculate my next move.',
    'We need to solve this mystery.',
    'I used to study math. Prove your loyalty to the king.',
  ]) {
    assert.equal(isHomeworkRequest(text), false, text);
  }
});

test('ambiguous task words still recognize academic objects and requests', () => {
  for (const text of [
    'Solve for x.',
    'Solve this inequality.',
    'Prove the Pythagorean theorem.',
    'Prove this algebraic identity.',
    'Prove that the sum of two even integers is even.',
    'Prove a + b = b + a.',
    'Calculate the area of a circle with radius 5.',
    'Calculate the physics result and explain your reasoning.',
    'Chứng minh định lý Pythagoras.',
    'Chứng minh tổng hai số chẵn là số chẵn.',
    'Help me with my assignment.',
    'Please complete this assignment.',
    'Can you explain this assignment?',
    'My chemistry assignment is about acids.',
  ]) {
    assert.equal(isHomeworkRequest(text), true, text);
  }
});

test('narrowing task words preserves Vietnamese homework, coding and essays', () => {
  for (const text of [
    'Giải phương trình x + 2 = 5.',
    'Giải giúp mình bài này.',
    'Viết code sắp xếp một mảng.',
    'Explain this programming algorithm.',
    'Viết bài nghị luận về tình yêu quê hương.',
  ]) {
    assert.equal(isHomeworkRequest(text), true, text);
  }
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