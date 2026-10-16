import assert from 'node:assert/strict';
import test from 'node:test';
import { containsConflictMarkers, extractConflictVersions, findCommitConflicts } from '../conflict';
import { SvnStatusEntry } from '../types';

test('containsConflictMarkers 只识别完整 SVN 冲突标记组合', () => {
  assert.equal(
    containsConflictMarkers('<<<<<<< .mine\n本地\n=======\n远程\n>>>>>>> .r2\n'),
    true
  );
  assert.equal(containsConflictMarkers('普通文本中只有 ======= 分隔线'), false);
});

test('提交冲突检查覆盖父目录和三类冲突，不误匹配同名前缀或无关文件', () => {
  const base: SvnStatusEntry = {
    absolutePath: 'D:\\wc\\folder\\file.txt', item: 'normal', propertyStatus: 'none',
    treeConflicted: false, switched: false, copied: false, locked: false
  };
  const entries = [
    { ...base, item: 'conflicted' as const },
    { ...base, absolutePath: 'D:\\wc\\folder\\props.txt', propertyStatus: 'conflicted' as const },
    { ...base, absolutePath: 'D:\\wc\\folder\\tree', treeConflicted: true },
    { ...base, absolutePath: 'D:\\wc\\folder2\\outside.txt', treeConflicted: true }
  ];
  assert.equal(findCommitConflicts(entries, ['d:\\WC\\folder']).length, 3);
  assert.equal(findCommitConflicts(entries, ['D:\\wc\\folder\\file.txt']).length, 1);
  assert.equal(findCommitConflicts(entries, ['D:\\wc\\folder\\safe.txt']).length, 0);
  assert.equal(findCommitConflicts(entries, ['D:\\wc\\folder\\file.txt.bak']).length, 0);
  assert.equal(findCommitConflicts(entries, ['C:\\wc']).length, 0);
});

test('extractConflictVersions 能重建包含基准区块的本地与传入版本', () => {
  const content =
    '公共开头\r\n<<<<<<< .mine\r\n本地内容\r\n||||||| .r1\r\n基准内容\r\n=======\r\n传入内容\r\n>>>>>>> .r2\r\n公共结尾\r\n';
  assert.deepEqual(extractConflictVersions(content), {
    mine: '公共开头\r\n本地内容\r\n公共结尾\r\n',
    theirs: '公共开头\r\n传入内容\r\n公共结尾\r\n'
  });
  assert.equal(extractConflictVersions('<<<<<<< .mine\n未结束'), undefined);
});
