import { SvnLogEntry } from './types';

/** 使用已解析的数字 revision 固定历史查询的方向和终点。 */
export interface SvnLogRange {
  readonly start: bigint;
  readonly end: bigint;
}

/**
 * 按原始 SVN 日志页推进游标，不受作者筛选后的匹配数量影响。
 *
 * @param range 当前数字 revision 查询范围。
 * @param entries SVN 返回的原始日志页，顺序与查询方向一致。
 * @param limit 本页请求的最大记录数。
 * @returns 下一页范围；已到边界或记录不足一页时返回 undefined。
 */
export function nextLogRange(
  range: SvnLogRange,
  entries: readonly SvnLogEntry[],
  limit: number
): SvnLogRange | undefined {
  const last = entries.at(-1);
  if (!last || entries.length < limit) {
    return undefined;
  }
  const ascending = range.start <= range.end;
  const next = BigInt(last.revision) + (ascending ? 1n : -1n);
  if (ascending ? next <= range.start || next > range.end : next >= range.start || next < range.end) {
    return undefined;
  }
  return { start: next, end: range.end };
}
