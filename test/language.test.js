import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasForeignScript,
  isVietnameseText,
  languageAllowsForeign,
  stripForeignScript,
} from '../src/core/text/language.js';

test('foreign-script leakage is stripped from Vietnamese replies', () => {
  assert.equal(stripForeignScript('Xin chào 你好 bạn'), 'Xin chào  bạn');
  assert.equal(stripForeignScript('こんにちは bạn'), ' bạn');
  assert.equal(stripForeignScript('안녕 bạn'), ' bạn');
  assert.equal(stripForeignScript('Xin chào bạn'), 'Xin chào bạn');
});

test('foreign script is kept when the user writes it or asks for that language', () => {
  assert.equal(languageAllowsForeign('你好'), true);
  assert.equal(languageAllowsForeign('dịch sang tiếng Trung giúp mình'), true);
  assert.equal(languageAllowsForeign('xin chào'), false);
  assert.equal(hasForeignScript('xin chào'), false);
  assert.equal(isVietnameseText('xin chào'), true);
  assert.equal(isVietnameseText('hello'), false);
});
