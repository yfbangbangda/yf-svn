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

const STATUS_NAMES: Record<SvnItemStatus, string> = {
  added: '已添加', conflicted: '有冲突', deleted: '已删除', external: '外部定义',
  ignored: '已忽略', incomplete: '不完整', missing: '本地缺失', modified: '已修改',
  none: '无状态', normal: '正常', obstructed: '路径被阻塞', replaced: '已替换', unversioned: '未版本控制'
};

/**
 * 返回文件、属性及树冲突共用的状态标记，避免仅靠颜色区分状态。
 * @param entry SVN 状态条目。
 * @returns 不超过两个字符的资源标记。
 */
export function getStatusBadge(entry: SvnStatusEntry): string {
  if (entry.treeConflicted || entry.item === 'conflicted' || entry.propertyStatus === 'conflicted') {
    return 'C';
  }
  const badges: Partial<Record<SvnItemStatus, string>> = {
    added: 'A', deleted: 'D', external: 'X', ignored: 'I', incomplete: '!', missing: '!',
    modified: 'M', obstructed: '!', replaced: 'R', unversioned: '?'
  };
  return badges[entry.item] ?? (isDecoratedStatus(entry) ? 'M' : '');
}

/**
 * 返回与状态标记一致的 VS Code 原生图标。
 * @param entry SVN 状态条目。
 * @returns Codicon 图标标识。
 */
export function getStatusIconId(entry: SvnStatusEntry): string {
  const icons: Record<string, string> = {
    A: 'diff-added', D: 'diff-removed', X: 'link-external', I: 'circle-slash',
    '!': 'warning', M: 'diff-modified', R: 'diff-renamed', '?': 'question', C: 'warning'
  };
  return icons[getStatusBadge(entry)] ?? 'check';
}

/**
 * 生成资源管理器、SCM 和提交选择器共用的中文状态说明。
 * @param entry SVN 状态条目。
 * @returns 包含属性、树冲突、锁及 Changelist 的中文说明。
 */
export function getStatusTooltip(entry: SvnStatusEntry): string {
  const details = [STATUS_NAMES[entry.item]];
  if (entry.propertyStatus !== 'none' && entry.propertyStatus !== 'normal') {
    details.push(`属性：${STATUS_NAMES[entry.propertyStatus]}`);
  }
  if (entry.treeConflicted) { details.push('树冲突'); }
  if (entry.switched) { details.push('已切换路径'); }
  if (entry.copied) { details.push('带历史复制'); }
  if (entry.locked) { details.push('持有文件锁'); }
  if (entry.changelist) { details.push(`Changelist：${entry.changelist}`); }
  return details.join('；');
}

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
