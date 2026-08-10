import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBlameXml, parseInfoXml, parseLogXml, parseStatusXml } from '../xml';

/**
 * 执行集成测试所需的 SVN 命令并返回 UTF-8 文本。
 *
 * @param executable svn 或 svnadmin 可执行文件名。
 * @param args 完整参数数组。
 * @param cwd 命令工作目录。
 * @returns 命令标准输出。
 */
function run(executable: string, args: readonly string[], cwd: string): string {
  return execFileSync(executable, [...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true
  });
}

test('SVN CLI 核心闭环支持含空格的路径', (context) => {
  if (process.platform !== 'win32') {
    context.skip('YF SVN 当前仅支持 Windows。');
    return;
  }
  try {
    run('svn', ['--version', '--quiet'], process.cwd());
    run('svnadmin', ['--version', '--quiet'], process.cwd());
  } catch {
    context.skip('未安装 SVN CLI 或 svnadmin。');
    return;
  }

  const testRoot = path.join(process.cwd(), '.test-tmp', `yf svn integration ${Date.now()}`);
  const repository = path.join(testRoot, 'repo');
  const seed = path.join(testRoot, 'seed');
  const firstWorkingCopy = path.join(testRoot, 'working copy one');
  const secondWorkingCopy = path.join(testRoot, 'working copy two');
  const fileName = 'file with spaces.txt';
  mkdirSync(seed, { recursive: true });
  context.after(() => rmSync(testRoot, { recursive: true, force: true }));

  writeFileSync(path.join(seed, fileName), '初始内容\r\n', 'utf8');
  run('svnadmin', ['create', repository], testRoot);
  const repositoryUrl = pathToFileURL(repository).href;
  run('svn', ['import', seed, repositoryUrl, '-m', '初始化', '--non-interactive'], testRoot);
  run('svn', ['checkout', repositoryUrl, firstWorkingCopy, '--non-interactive'], testRoot);
  run('svn', ['checkout', repositoryUrl, secondWorkingCopy, '--non-interactive'], testRoot);

  appendFileSync(path.join(firstWorkingCopy, fileName), '来自工作副本一\r\n', 'utf8');
  const statusXml = run(
    'svn',
    ['status', '--xml', '--', firstWorkingCopy],
    firstWorkingCopy
  );
  const changed = parseStatusXml(statusXml, firstWorkingCopy);
  assert.equal(changed.length, 1);
  assert.equal(changed[0]?.item, 'modified');
  assert.equal(path.basename(changed[0]?.absolutePath ?? ''), fileName);

  // 关键逻辑：提交说明使用现有文件名，覆盖 SVN E205005 路径误判场景。
  run(
    'svn',
    [
      'commit',
      firstWorkingCopy,
      '--message',
      fileName,
      '--force-log',
      '--non-interactive'
    ],
    testRoot
  );
  appendFileSync(path.join(secondWorkingCopy, fileName), '来自工作副本二的本地内容\r\n', 'utf8');
  appendFileSync(path.join(firstWorkingCopy, fileName), '来自工作副本一的第二次修改\r\n', 'utf8');
  run('svn', ['commit', firstWorkingCopy, '-m', '制造更新冲突', '--non-interactive'], testRoot);
  run('svn', ['update', secondWorkingCopy, '--non-interactive'], testRoot);

  const conflictXml = run(
    'svn',
    ['status', '--xml', '--', secondWorkingCopy],
    secondWorkingCopy
  );
  const conflicts = parseStatusXml(conflictXml, secondWorkingCopy).filter(
    (entry) => entry.item === 'conflicted' || entry.treeConflicted
  );
  assert.equal(conflicts.length, 1);

  const conflictInfoXml = run(
    'svn',
    ['info', '--xml', '--', path.join(secondWorkingCopy, fileName)],
    secondWorkingCopy
  );
  const conflictInfo = parseInfoXml(conflictInfoXml).conflict;
  assert.equal(conflictInfo?.type, 'text');
  assert.equal(conflictInfo?.operation, 'update');
  assert.ok(
    conflictInfo?.previousBaseFile && existsSync(conflictInfo.previousBaseFile),
    conflictInfoXml
  );
  const localConflictFile =
    conflictInfo?.previousWorkingFile ?? path.join(secondWorkingCopy, `${fileName}.mine`);
  if (existsSync(localConflictFile)) {
    assert.ok(readFileSync(localConflictFile, 'utf8').length > 0);
  } else {
    const workingConflictContent = readFileSync(path.join(secondWorkingCopy, fileName), 'utf8');
    assert.ok(
      workingConflictContent.includes('来自工作副本二的本地内容'),
      `${conflictInfoXml}\n工作文件：\n${workingConflictContent}`
    );
  }
  assert.ok(
    conflictInfo?.currentBaseFile && existsSync(conflictInfo.currentBaseFile),
    conflictInfoXml
  );

  run(
    'svn',
    [
      'resolve',
      '--accept',
      'theirs-full',
      '--non-interactive',
      '--',
      path.join(secondWorkingCopy, fileName)
    ],
    secondWorkingCopy
  );

  run(
    'svn',
    ['propset', 'svn:global-ignores', 'ignored.tmp', '--', secondWorkingCopy],
    secondWorkingCopy
  );
  writeFileSync(path.join(secondWorkingCopy, 'ignored.tmp'), '应被全局忽略属性匹配', 'utf8');
  const ignoredXml = run(
    'svn',
    ['status', '--xml', '--no-ignore', '--', secondWorkingCopy],
    secondWorkingCopy
  );
  assert.ok(
    parseStatusXml(ignoredXml, secondWorkingCopy).some(
      (entry) => entry.item === 'ignored' && path.basename(entry.absolutePath) === 'ignored.tmp'
    )
  );

  const logXml = run(
    'svn',
    ['log', '--xml', '--verbose', '--limit', '10', `${repositoryUrl}@HEAD`],
    firstWorkingCopy
  );
  const logEntries = parseLogXml(logXml);
  assert.ok(logEntries.length >= 3, `历史条目数量异常：${logEntries.length}\n${logXml}`);
  const blameXml = run(
    'svn',
    ['blame', '--xml', '--force', '--', path.join(secondWorkingCopy, fileName)],
    secondWorkingCopy
  );
  const blameLines = parseBlameXml(blameXml);
  assert.ok(blameLines.length > 0);
  assert.ok(blameLines.every((line) => line.revision && line.author));
});
