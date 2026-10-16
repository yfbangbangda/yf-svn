import assert from 'node:assert/strict';
import test from 'node:test';
import { getStatusBadge, getStatusColorId, getStatusIconId, getStatusTooltip, isDecoratedStatus } from '../statusDecoration';
import { SvnItemStatus, SvnStatusEntry } from '../types';

/**
 * 创建颜色映射测试使用的 SVN 状态。
 *
 * @param item 文件状态。
 * @param propertyStatus 属性状态。
 * @param treeConflicted 是否存在树冲突。
 * @returns 完整 SVN 状态条目。
 */
function status(
  item: SvnItemStatus,
  propertyStatus: SvnItemStatus = 'none',
  treeConflicted = false
): SvnStatusEntry {
  return {
    absolutePath: 'C:\\working-copy\\file.txt',
    item,
    propertyStatus,
    treeConflicted,
    switched: false,
    copied: false,
    locked: false
  };
}

test('getStatusColorId 为不同 SVN 状态返回对应主题颜色', () => {
  assert.equal(getStatusColorId(status('modified')), 'yfSvnDecoration.modifiedResourceForeground');
  assert.equal(getStatusColorId(status('added')), 'yfSvnDecoration.addedResourceForeground');
  assert.equal(getStatusColorId(status('unversioned')), 'yfSvnDecoration.untrackedResourceForeground');
  assert.equal(getStatusColorId(status('deleted')), 'yfSvnDecoration.deletedResourceForeground');
  assert.equal(getStatusColorId(status('replaced')), 'yfSvnDecoration.renamedResourceForeground');
  assert.equal(getStatusColorId(status('ignored')), 'yfSvnDecoration.ignoredResourceForeground');
  assert.equal(getStatusColorId(status('external')), 'yfSvnDecoration.externalResourceForeground');
  assert.equal(
    getStatusColorId(status('modified', 'conflicted')),
    'yfSvnDecoration.conflictingResourceForeground'
  );
});

test('isDecoratedStatus 排除正常文件并保留属性变化', () => {
  assert.equal(isDecoratedStatus(status('normal')), false);
  assert.equal(isDecoratedStatus(status('normal', 'modified')), true);
  assert.equal(isDecoratedStatus(status('ignored')), true);
});

test('状态标记、原生图标与中文说明覆盖属性和树冲突，冲突具有最高优先级', () => {
  assert.equal(getStatusBadge(status('normal')), '');
  assert.equal(getStatusBadge(status('normal', 'modified')), 'M');
  assert.equal(getStatusBadge(status('unversioned')), '?');
  assert.equal(getStatusBadge(status('missing')), '!');
  assert.equal(getStatusBadge(status('added', 'conflicted')), 'C');
  assert.equal(getStatusBadge(status('modified', 'none', true)), 'C');
  assert.equal(getStatusIconId(status('modified', 'none', true)), 'warning');
  assert.equal(getStatusIconId(status('deleted')), 'diff-removed');
  assert.equal(getStatusTooltip({ ...status('normal', 'conflicted', true), switched: true, copied: true, locked: true, changelist: '本次修复' }),
    '正常；属性：有冲突；树冲突；已切换路径；带历史复制；持有文件锁；Changelist：本次修复');
});
