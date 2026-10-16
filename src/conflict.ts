import * as path from 'node:path';
import { SvnStatusEntry } from './types';
import { isMergeConflict } from './merge';

/**
 * 找出会阻塞所选文件或目录提交的冲突，不阻止无关路径的部分提交。
 * @param entries 当前工作副本状态。
 * @param targets 本次提交的绝对目标路径。
 * @returns 位于提交目标之内的冲突条目。
 */
export function findCommitConflicts(entries: readonly SvnStatusEntry[], targets: readonly string[]): readonly SvnStatusEntry[] {
  return entries.filter((entry) => isMergeConflict(entry) && targets.some((target) => {
    const relative = path.win32.relative(target.toLowerCase(), entry.absolutePath.toLowerCase());
    return !path.win32.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..\\');
  }));
}

/**
 * 判断文本中是否仍包含 SVN 冲突标记。
 *
 * @param content 待检查的文本内容。
 * @returns 存在完整冲突标记组合时返回 true。
 */
export function containsConflictMarkers(content: string): boolean {
  return (
    /^<{7}(?:\s|$)/m.test(content) &&
    /^={7}(?:\s|$)/m.test(content) &&
    /^>{7}(?:\s|$)/m.test(content)
  );
}

export interface SvnConflictVersions {
  readonly mine: string;
  readonly theirs: string;
}

/**
 * 从带有标准 SVN 冲突标记的工作文件中重建本地和传入版本。
 *
 * @param content 包含 SVN 文本冲突标记的完整文件内容。
 * @returns 成功解析时返回两个无冲突标记版本；标记不完整时返回 undefined。
 */
export function extractConflictVersions(content: string): SvnConflictVersions | undefined {
  const lines = content.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter((line) => line.length > 0) ?? [];
  const mine: string[] = [];
  const theirs: string[] = [];
  let state: 'normal' | 'mine' | 'base' | 'theirs' = 'normal';
  let completedConflicts = 0;

  for (const line of lines) {
    if (state === 'normal' && /^<{7}(?:\s|$)/.test(line)) {
      state = 'mine';
      continue;
    }
    if (state === 'mine' && /^\|{7}(?:\s|$)/.test(line)) {
      state = 'base';
      continue;
    }
    if ((state === 'mine' || state === 'base') && /^={7}(?:\s|$)/.test(line)) {
      state = 'theirs';
      continue;
    }
    if (state === 'theirs' && /^>{7}(?:\s|$)/.test(line)) {
      state = 'normal';
      completedConflicts += 1;
      continue;
    }

    if (state === 'normal') {
      mine.push(line);
      theirs.push(line);
    } else if (state === 'mine') {
      mine.push(line);
    } else if (state === 'theirs') {
      theirs.push(line);
    }
  }

  return state === 'normal' && completedConflicts > 0
    ? { mine: mine.join(''), theirs: theirs.join('') }
    : undefined;
}
