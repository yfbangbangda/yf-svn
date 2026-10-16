import { SvnStatusEntry } from './types';

/** 保存一次合并的来源快照和目标工作副本信息。 */
export interface SvnMergePlan {
  readonly sourceUrl: string;
  readonly sourceRevision: string;
  readonly targetUrl: string;
  readonly targetRevision: string;
  readonly repositoryUuid: string;
  readonly revisionRange?: string;
}

/**
 * 校验合并来源，要求完整仓库 URL，凭据交给 SVN 原生认证缓存。
 *
 * @param value 用户输入的来源 URL，不包含 peg revision。
 * @returns 输入错误说明；合法时返回 undefined。
 */
export function validateMergeSource(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:', 'svn:', 'svn+ssh:', 'file:'].includes(url.protocol)) {
      return '请输入 http、https、svn、svn+ssh 或 file 协议的完整仓库 URL。';
    }
    if (url.password || url.search || url.hash || /\s/.test(value.trim())) {
      return 'URL 不能包含密码、查询参数、片段或未编码的空白字符，请使用 SVN 认证缓存。';
    }
    return undefined;
  } catch {
    return '请输入完整仓库 URL。';
  }
}

/**
 * 校验正向 revision 范围，空值表示合并全部可合并变更。
 *
 * @param value 用户输入的 N:M 范围，包含 M、不包含 N。
 * @param sourceRevision 预演和实际合并共用的来源快照 revision。
 * @returns 输入错误说明；合法时返回 undefined。
 */
export function validateMergeRange(value: string, sourceRevision: string): string | undefined {
  if (!value.trim()) {
    return undefined;
  }
  const match = /^(\d+):(\d+)$/.exec(value.trim());
  if (!match) {
    return '请输入数字范围 N:M，例如 10:15 表示合并 r11 至 r15；留空合并全部可合并变更。';
  }
  if (BigInt(match[1]!) >= BigInt(match[2]!)) {
    return '起始 revision 必须小于结束 revision，当前仅支持正向合并。';
  }
  if (BigInt(match[2]!) > BigInt(sourceRevision)) {
    return `结束 revision 不能超过来源快照 r${sourceRevision}。`;
  }
  return undefined;
}

/**
 * 构造基础合并参数，实际进程仍统一由 SvnCli 启动。
 *
 * @param plan 已校验的来源快照及可选 revision 范围。
 * @param dryRun 是否只预演而不修改工作副本。
 * @returns 在目标工作副本根目录执行的 SVN 参数数组。
 */
export function buildMergeArguments(plan: SvnMergePlan, dryRun: boolean): readonly string[] {
  if (!/^\d+$/.test(plan.sourceRevision)) {
    throw new Error('合并来源必须固定为数字 revision，请重新预演。');
  }
  const error = validateMergeSource(plan.sourceUrl) ?? validateMergeRange(plan.revisionRange ?? '', plan.sourceRevision);
  if (error) {
    throw new Error(error);
  }
  const args = ['merge', '--accept', 'postpone', '--depth', 'infinity'];
  if (dryRun) {
    args.push('--dry-run');
  }
  if (plan.revisionRange?.trim()) {
    args.push('--revision', plan.revisionRange.trim());
  }
  // 关键逻辑：固定来源 revision；目标用 cwd 下的点路径，避开 merge 对含 @ 的绝对路径的特殊处理。
  args.push('--', `${plan.sourceUrl}@${plan.sourceRevision}`, '.');
  return args;
}

/**
 * 判断状态条目是否含尚未解决的文本、属性或树冲突。
 *
 * @param entry SVN 状态条目。
 * @returns 存在任一类型冲突时返回 true。
 */
export function isMergeConflict(entry: SvnStatusEntry): boolean {
  return entry.treeConflicted || entry.item === 'conflicted' || entry.propertyStatus === 'conflicted';
}

/**
 * 检查基础合并是否可安全开始，不依赖界面配置的扫描深度。
 *
 * @param entries 以 infinity 深度读取的最新工作副本状态。
 * @returns 阻止合并的原因；无阻碍时返回 undefined。
 */
export function getMergeBlockReason(entries: readonly SvnStatusEntry[]): string | undefined {
  if (entries.some(isMergeConflict)) {
    return '工作副本存在未解决冲突，请先解决冲突后重新合并。';
  }
  if (entries.some((entry) => entry.switched)) {
    return '工作副本包含已切换的子路径，请先统一分支后重新合并。';
  }
  const changed = entries.filter((entry) =>
    !['unversioned', 'ignored', 'external'].includes(entry.item) &&
    (!['normal', 'none'].includes(entry.item) || !['normal', 'none'].includes(entry.propertyStatus))
  );
  if (changed.length > 0) {
    return `工作副本存在未提交的版本化修改，请先提交或自行保存并还原后重新合并：\n${changed.slice(0, 10).map((entry) => entry.absolutePath).join('\n')}`;
  }
  return undefined;
}
