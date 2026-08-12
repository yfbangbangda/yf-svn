import { SvnStatusEntry } from './types';

export const SVN_MENU_CAPABILITIES = [
  'known',
  'addable',
  'committable',
  'updatable',
  'diffable',
  'historical',
  'revertible',
  'mutableVersioned',
  'lockable',
  'unlockable',
  'ignorable'
] as const;

export type SvnMenuCapability = (typeof SVN_MENU_CAPABILITIES)[number];

/**
 * 根据单个 SVN 状态计算右键菜单中可执行的操作。
 *
 * @param entry 当前文件或目录的 SVN 状态。
 * @returns 当前资源支持的菜单能力集合。
 */
export function getSvnMenuCapabilities(entry: SvnStatusEntry): ReadonlySet<SvnMenuCapability> {
  const capabilities = new Set<SvnMenuCapability>();
  const conflicted =
    entry.treeConflicted ||
    entry.item === 'conflicted' ||
    entry.propertyStatus === 'conflicted';
  const propertyChanged =
    entry.propertyStatus !== 'none' && entry.propertyStatus !== 'normal';

  if (entry.item === 'unversioned') {
    capabilities.add('known');
    capabilities.add('addable');
    capabilities.add('ignorable');
    return capabilities;
  }
  if (['ignored', 'external', 'none', 'obstructed'].includes(entry.item)) {
    return capabilities;
  }

  capabilities.add('known');
  if (
    !conflicted &&
    (['added', 'deleted', 'modified', 'replaced'].includes(entry.item) || propertyChanged)
  ) {
    capabilities.add('committable');
  }
  if (['normal', 'modified', 'replaced', 'conflicted', 'incomplete', 'missing'].includes(entry.item)) {
    capabilities.add('updatable');
  }
  if (
    !conflicted &&
    (['modified', 'deleted', 'replaced'].includes(entry.item) || propertyChanged)
  ) {
    capabilities.add('diffable');
  }
  if (!['added', 'incomplete'].includes(entry.item)) {
    capabilities.add('historical');
  }
  if (
    conflicted ||
    ['added', 'deleted', 'missing', 'modified', 'replaced'].includes(entry.item) ||
    propertyChanged
  ) {
    capabilities.add('revertible');
  }
  if (['added', 'normal', 'modified', 'replaced'].includes(entry.item)) {
    capabilities.add('mutableVersioned');
  }
  if (entry.locked) {
    capabilities.add('unlockable');
  } else if (['normal', 'modified', 'replaced'].includes(entry.item)) {
    capabilities.add('lockable');
  }
  return capabilities;
}
