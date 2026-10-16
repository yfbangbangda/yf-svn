import assert from 'node:assert/strict';
import test from 'node:test';
import { nextLogRange } from '../logPagination';
import { SvnLogEntry } from '../types';

/**
 * 生成可包含不连续 revision 的原始日志页。
 *
 * @param revisions SVN 返回顺序中的 revision 列表。
 * @returns 供分页游标测试使用的完整日志记录。
 */
function entries(...revisions: string[]): readonly SvnLogEntry[] {
  return revisions.map((revision) => ({ revision, author: 'alice', date: '', message: '', paths: [] }));
}

test('历史降序分页保留终点，按原始页末尾推进且不重复', () => {
  assert.deepEqual(nextLogRange({ start: 100n, end: 50n }, entries('100', '90', '70'), 3), { start: 69n, end: 50n });
  assert.equal(nextLogRange({ start: 69n, end: 50n }, entries('65', '60', '50'), 3), undefined);
  assert.equal(nextLogRange({ start: 100n, end: 50n }, entries('90'), 3), undefined);
});

test('历史升序日期范围可继续翻页，稀疏 revision 不越过上限', () => {
  assert.deepEqual(nextLogRange({ start: 5n, end: 20n }, entries('8', '12'), 2), { start: 13n, end: 20n });
  assert.equal(nextLogRange({ start: 13n, end: 20n }, entries('18', '20'), 2), undefined);
  assert.equal(nextLogRange({ start: 5n, end: 20n }, [], 2), undefined);
});

test('历史分页支持大 revision，异常的未推进结果不会形成循环', () => {
  assert.deepEqual(nextLogRange({ start: 9007199254741000n, end: 1n }, entries('9007199254740999'), 1), { start: 9007199254740998n, end: 1n });
  assert.equal(nextLogRange({ start: 10n, end: 1n }, entries('11'), 1), undefined);
});
