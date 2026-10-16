import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { buildMergeArguments, isMergeConflict, SvnMergePlan } from '../merge';
import { escapeSvnTarget } from '../svnTarget';
import { parseInfoXml, parseStatusXml } from '../xml';
import { createMergeFixture, runFixtureSvn } from './mergeFixture';

test('真实 SVN 完成预演、固定来源合并、Mergeinfo、冲突解决及提交，支持中文空格和 @ 路径', (context) => {
  if (process.platform !== 'win32') {
    context.skip('YF SVN 当前仅支持 Windows。');
    return;
  }
  const base = path.resolve('.test-tmp');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'merge integration '));
  context.after(() => {
    if (path.dirname(path.resolve(root)) !== base) {
      throw new Error('合并测试清理目录越界。');
    }
    rmSync(root, { recursive: true, force: true });
  });
  const fixture = createMergeFixture(root);
  const { sourceUrl, targetUrl, sourcePath, targetPath, sourceRevision, fileName } = fixture;
  const targetFile = path.join(targetPath, fileName);
  const sourceFile = path.join(sourcePath, fileName);
  const targetInfo = parseInfoXml(runFixtureSvn(['info', '--xml', '--', escapeSvnTarget(targetPath)], root));
  const plan: SvnMergePlan = {
    sourceUrl, sourceRevision, targetUrl,
    targetRevision: targetInfo.revision,
    repositoryUuid: targetInfo.repositoryUuid,
    revisionRange: `${Number(sourceRevision) - 1}:${sourceRevision}`
  };
  const before = runFixtureSvn(['status', '--xml', '--', escapeSvnTarget(targetPath)], root);
  runFixtureSvn(buildMergeArguments(plan, true), targetPath);
  assert.equal(readFileSync(targetFile, 'utf8'), '初始内容\n');
  assert.equal(runFixtureSvn(['status', '--xml', '--', escapeSvnTarget(targetPath)], root), before);

  // 关键逻辑：预演之后来源继续提交，实际合并仍只使用预演时固定的快照。
  writeFileSync(sourceFile, '分支修改二\n');
  runFixtureSvn(['commit', '-m', '预演后的新提交', '--', escapeSvnTarget(sourcePath)], root);
  const nextRevision = parseInfoXml(runFixtureSvn(['info', '--xml', '-r', 'HEAD', '--', `${sourceUrl}@HEAD`], root)).revision;
  runFixtureSvn(buildMergeArguments(plan, false), targetPath);
  assert.equal(readFileSync(targetFile, 'utf8'), '分支修改一\n');
  assert.ok(parseStatusXml(runFixtureSvn(['status', '--xml', '--', escapeSvnTarget(targetPath)], root), targetPath).some((entry) => entry.item === 'modified'));
  const merged = runFixtureSvn(['mergeinfo', '--show-revs', 'merged', '--', `${sourceUrl}@HEAD`, escapeSvnTarget(targetPath)], root);
  const eligible = runFixtureSvn(['mergeinfo', '--show-revs', 'eligible', '--', `${sourceUrl}@HEAD`, escapeSvnTarget(targetPath)], root);
  assert.ok(merged.split(/\r?\n/).includes(`r${sourceRevision}`), merged);
  assert.ok(eligible.split(/\r?\n/).includes(`r${nextRevision}`), eligible);
  runFixtureSvn(['commit', '-m', '提交第一次合并', '--', escapeSvnTarget(targetPath)], root);
  runFixtureSvn(['update', '--', escapeSvnTarget(targetPath)], root);

  writeFileSync(targetFile, '主干修改\n');
  runFixtureSvn(['commit', '-m', '制造分支合并冲突', '--', escapeSvnTarget(targetPath)], root);
  runFixtureSvn(['update', '--', escapeSvnTarget(targetPath)], root);
  const conflictRevision = parseInfoXml(runFixtureSvn(['info', '--xml', '-r', 'HEAD', '--', `${sourceUrl}@HEAD`], root)).revision;
  // 当前 sourceRevision 已变化，第二次合并使用新的来源快照并自动筛选未合并 revision。
  const conflictPlan = { ...plan, sourceRevision: conflictRevision, revisionRange: undefined };
  runFixtureSvn(buildMergeArguments(conflictPlan, true), targetPath);
  assert.equal(readFileSync(targetFile, 'utf8'), '主干修改\n');
  runFixtureSvn(buildMergeArguments(conflictPlan, false), targetPath);
  const conflicts = parseStatusXml(runFixtureSvn(['status', '--xml', '--', escapeSvnTarget(targetPath)], root), targetPath).filter(isMergeConflict);
  assert.equal(conflicts.length, 1);
  assert.equal(parseInfoXml(runFixtureSvn(['info', '--xml', '--', escapeSvnTarget(targetFile)], root)).conflict?.operation, 'merge');
  writeFileSync(targetFile, '人工合并主干与分支修改\n');
  runFixtureSvn(['resolve', '--accept', 'working', '--', escapeSvnTarget(targetFile)], root);
  runFixtureSvn(['commit', '-m', '解决并提交合并冲突', '--', escapeSvnTarget(targetPath)], root);
  assert.equal(parseStatusXml(runFixtureSvn(['status', '--xml', '--', escapeSvnTarget(targetPath)], root), targetPath).length, 0);
  assert.equal(runFixtureSvn(['mergeinfo', '--show-revs', 'eligible', '--', `${sourceUrl}@HEAD`, escapeSvnTarget(targetPath)], root).trim(), '');
});
