import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeSvnTarget, escapeSvnTargets } from '../svnTarget';

test('escapeSvnTarget 在路径末尾追加 @ 以禁用 peg revision 解析', () => {
  // 关键逻辑：含 @ 的目录名会被 SVN 误解析为 peg revision，尾部 @ 是官方转义约定。
  assert.equal(
    escapeSvnTarget('D:\\code\\project@47.96.177.169'),
    'D:\\code\\project@47.96.177.169@'
  );
  assert.equal(escapeSvnTarget('D:\\code\\normal'), 'D:\\code\\normal@');
});

test('escapeSvnTargets 逐条转义本地路径列表', () => {
  assert.deepEqual(
    escapeSvnTargets(['D:\\a@1.2\\file.txt', 'D:\\b']),
    ['D:\\a@1.2\\file.txt@', 'D:\\b@']
  );
});
