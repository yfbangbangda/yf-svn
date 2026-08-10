import { SvnItemStatus, SvnStatusEntry } from './types';

const DECORATED_STATUSES = new Set<SvnItemStatus>([
  'added',
  'conflicted',
  'deleted',
  'external',
  'ignored',
  'incomplete',
  'missing',
  'modified',
  'obstructed',
  'replaced',
  'unversioned'
]);

/**
 * 判断 SVN 状态是否需要显示资源装饰。
 *
 * @param entry SVN 状态条目。
 * @returns 文件、属性或树存在可见变化时返回 true。
 */
export function isDecoratedStatus(entry: SvnStatusEntry): boolean {
  const propertyChanged =
    entry.propertyStatus !== 'none' && entry.propertyStatus !== 'normal';
  return propertyChanged || entry.treeConflicted || DECORATED_STATUSES.has(entry.item);
}

/**
 * 返回 SVN 状态对应的 YF SVN 主题颜色。
 *
 * @param entry SVN 状态条目。
 * @returns VS Code 主题颜色标识。
 */
export function getStatusColorId(entry: SvnStatusEntry): string {
  if (
    entry.treeConflicted ||
    entry.item === 'conflicted' ||
    entry.propertyStatus === 'conflicted'
  ) {
    return 'yfSvnDecoration.conflictingResourceForeground';
  }
  switch (entry.item) {
    case 'added':
      return 'yfSvnDecoration.addedResourceForeground';
    case 'unversioned':
      return 'yfSvnDecoration.untrackedResourceForeground';
    case 'deleted':
    case 'missing':
      return 'yfSvnDecoration.deletedResourceForeground';
    case 'replaced':
      return 'yfSvnDecoration.renamedResourceForeground';
    case 'ignored':
      return 'yfSvnDecoration.ignoredResourceForeground';
    case 'external':
      return 'yfSvnDecoration.externalResourceForeground';
    default:
      return 'yfSvnDecoration.modifiedResourceForeground';
  }
}
