import test from 'node:test';
import assert from 'node:assert/strict';
import { isHomeworkRequest } from '../src/core/ai/prompt/homework.js';

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