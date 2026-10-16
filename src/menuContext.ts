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
  'ignorable',
  'deletable',
  'renamable',
  'conflicted',
  'blamable',
  'changelistable'
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
  if (!conflicted && ['ignored', 'external', 'none', 'obstructed'].includes(entry.item)) {
    return capabilities;
  }

  capabilities.add('known');
  if (conflicted) {
    capabilities.add('conflicted');
  }
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
    if (entry.kind !== 'dir') {
      capabilities.add('blamable');
    }
  }
  if (
    conflicted ||
    ['added', 'deleted', 'missing', 'modified', 'replaced'].includes(entry.item) ||
    propertyChanged
  ) {
    capabilities.add('revertible');
  }
  if (!conflicted && ['added', 'normal', 'modified', 'replaced'].includes(entry.item)) {
    capabilities.add('mutableVersioned');
    if (entry.kind !== 'dir') {
      capabilities.add('changelistable');
    }
    capabilities.add('deletable');
    capabilities.add('renamable');
  }
  if (entry.locked && entry.kind !== 'dir') {
    capabilities.add('unlockable');
  } else if (!conflicted && entry.kind !== 'dir' && ['normal', 'modified', 'replaced'].includes(entry.item)) {
    capabilities.add('lockable');
  }
  return capabilities;
}
