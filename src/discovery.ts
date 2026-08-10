import { readdir } from 'node:fs/promises';
import * as path from 'node:path';

const SKIPPED_DIRECTORIES = new Set([
  '.extension-test',
  '.git',
  '.svn',
  '.test-tmp',
  'node_modules',
  'vendor'
]);

/**
 * 在工作区目录中递归查找包含 `.svn/wc.db` 的工作副本根目录。
 *
 * @param workspaceRoot VS Code 工作区根目录。
 * @param maximumResults 最多返回的工作副本数量，防止异常目录无限扩张。
 * @returns 找到的嵌套 SVN 工作副本根目录。
 */
export async function findNestedWorkingCopyRoots(
  workspaceRoot: string,
  maximumResults = 500
): Promise<readonly string[]> {
  const pending = [workspaceRoot];
  const roots: string[] = [];

  while (pending.length > 0 && roots.length < maximumResults) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      // 关键逻辑：无权限或已被删除的目录不应中断其他工作副本的发现。
      continue;
    }

    const hasWorkingCopyDatabase = entries.some(
      (entry) => entry.isDirectory() && entry.name.toLowerCase() === '.svn'
    );
    if (hasWorkingCopyDatabase) {
      try {
        const administrativeEntries = await readdir(path.join(current, '.svn'));
        if (administrativeEntries.some((name) => name.toLowerCase() === 'wc.db')) {
          roots.push(current);
        }
      } catch {
        // `.svn` 可能是不完整目录，交给后续扫描继续处理其他目录。
      }
    }

    for (const entry of entries) {
      const name = entry.name.toLowerCase();
      if (
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        !SKIPPED_DIRECTORIES.has(name)
      ) {
        pending.push(path.join(current, entry.name));
      }
    }
  }

  return roots;
}
