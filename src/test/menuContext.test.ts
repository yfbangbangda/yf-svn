import assert from 'node:assert/strict';
import test from 'node:test';
import { getSvnMenuCapabilities } from '../menuContext';
import { SvnItemStatus, SvnStatusEntry } from '../types';

/**
 * 创建右键菜单能力测试使用的 SVN 状态。
 *
 * @param item 文件状态。
 * @param propertyStatus 属性状态。
 * @param locked 是否持有 SVN 锁。
 * @returns 完整 SVN 状态条目。
 */
function status(
  item: SvnItemStatus,
  propertyStatus: SvnItemStatus = 'none',
  locked = false
): SvnStatusEntry {
  return {
    absolutePath: 'C:\\working-copy\\file.txt',
    item,
    propertyStatus,
    treeConflicted: false,
    switched: false,
    copied: false,
    locked
  };
}

test('未版本控制文件只显示添加和忽略操作', () => {
  assert.deepEqual(
    [...getSvnMenuCapabilities(status('unversioned'))].sort(),
    ['addable', 'ignorable', 'known']
  );
});

test('正常文件不显示提交、还原和比较操作', () => {
  const capabilities = getSvnMenuCapabilities(status('normal'));
  assert.equal(capabilities.has('committable'), false);
  assert.equal(capabilities.has('revertible'), false);
  assert.equal(capabilities.has('diffable'), false);
  assert.equal(capabilities.has('historical'), true);
  assert.equal(capabilities.has('lockable'), true);
});

test('修改文件显示提交、还原和比较操作', () => {
  const capabilities = getSvnMenuCapabilities(status('modified'));
  assert.equal(capabilities.has('committable'), true);
  assert.equal(capabilities.has('revertible'), true);
  assert.equal(capabilities.has('diffable'), true);
});

test('锁定文件只显示解锁操作', () => {
  const capabilities = getSvnMenuCapabilities(status('normal', 'none', true));
  assert.equal(capabilities.has('lockable'), false);
  assert.equal(capabilities.has('unlockable'), true);
});
