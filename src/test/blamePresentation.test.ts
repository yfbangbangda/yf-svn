import assert from 'node:assert/strict';
import test from 'node:test';
import { formatBlameAnnotation } from '../blamePresentation';

test('追溯紧凑模式省略日期，完整模式使用较宽的固定列', () => {
  assert.deepEqual(formatBlameAnnotation('123', 'alice', '2026-10-16T08:00:00Z', 'compact'), { text: 'r123 · alice', width: '24ch' });
  assert.deepEqual(formatBlameAnnotation('123', 'alice', '2026-10-16T08:00:00Z', 'full'), { text: 'r123 · alice · 2026-10-16', width: '46ch' });
});

test('追溯对长作者、中文、表情及换行安全收起，不扩大代码左侧占宽', () => {
  for (const author of ['a'.repeat(100), '中文作者'.repeat(20), '😀'.repeat(50)]) {
    const annotation = formatBlameAnnotation('123', author, '', 'compact');
    assert.ok(annotation.text.endsWith('…'));
    assert.ok([...annotation.text].reduce((width, character) => width + (character.codePointAt(0)! > 0xff ? 2 : 1), 0) <= 24);
    assert.equal(annotation.width, '24ch');
  }
  assert.equal(formatBlameAnnotation('1', 'a\nb\tc', '', 'compact').text, 'r1 · a b c');
  assert.ok(formatBlameAnnotation('1', '', 'invalid', 'full').text.includes('未知作者 · 未知日期'));
});
