import test from 'node:test';
import assert from 'node:assert/strict';
import { allowsForeignScript, containsForeignScript } from '../src/core/text/language.js';

test('language drift detection covers CJK and explicit requests', () => {
  assert.equal(containsForeignScript('Xin chào 你好'), true);
  assert.equal(containsForeignScript('Xin chào bạn'), false);
  assert.equal(allowsForeignScript('Xin chào bạn'), false);
  assert.equal(allowsForeignScript('你好'), true);
  assert.equal(allowsForeignScript('dịch sang tiếng Trung giúp mình'), true);
});