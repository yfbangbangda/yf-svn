import assert from 'node:assert/strict';
import test from 'node:test';
import { containsConflictMarkers, extractConflictVersions } from '../conflict';

test('containsConflictMarkers 只识别完整 SVN 冲突标记组合', () => {
  assert.equal(
    containsConflictMarkers('<<<<<<< .mine\n本地\n=======\n远程\n>>>>>>> .r2\n'),
    true
  );
  assert.equal(containsConflictMarkers('普通文本中只有 ======= 分隔线'), false);
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
