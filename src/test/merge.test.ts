import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMergeArguments, getMergeBlockReason, SvnMergePlan, validateMergeRange, validateMergeSource } from '../merge';
import { SvnStatusEntry } from '../types';

const PLAN: SvnMergePlan = {
  sourceUrl: 'https://example.com/svn/branches/feature@team',
  sourceRevision: '20',
  targetUrl: 'https://example.com/svn/trunk',
  targetRevision: '20',
  repositoryUuid: 'test-repository'
};

/**
 * 创建状态样本，覆盖合并前的本地修改与不同类型冲突。
 *
 * @param overrides 要覆盖的 SVN 状态字段。
 * @returns 完整的状态条目。
 */
function status(overrides: Partial<SvnStatusEntry>): SvnStatusEntry {
  return {
    absolutePath: 'D:\\工作副本@team\\子目录\\file.txt',
    item: 'normal', propertyStatus: 'none',
    treeConflicted: false, switched: false, copied: false, locked: false,
    ...overrides
  };
}

test('合并范围只允许来源快照以内的正向数字范围，明确排除起点', () => {
  assert.equal(validateMergeRange('', '20'), undefined);
  assert.equal(validateMergeRange(' 0:20 ', '20'), undefined);
  assert.equal(validateMergeRange('10:15', '20'), undefined);
  for (const range of ['15:10', '10:10', '0:21', '-1:5', '1:HEAD', '1:2 --force', '1.5:2']) {
    assert.ok(validateMergeRange(range, '20'), range);
  }
});

test('合并来源校验拒绝密码和非 SVN 协议，保留 SSH 用户名及路径中的 @', () => {
  for (const source of [PLAN.sourceUrl, 'file:///D:/svn/repo/trunk', 'svn+ssh://user@example.com/repo/trunk']) {
    assert.equal(validateMergeSource(source), undefined, source);
  }
  for (const source of ['', 'D:\\repo', '--force', 'ftp://example.com/repo', 'https://user:secret@example.com/repo', 'https://example.com/repo#fragment', 'https://example.com/repo?key=value', 'https://example.com/a b']) {
    assert.ok(validateMergeSource(source), source);
  }
});

test('预演和实际合并使用相同的来源快照，点路径避免目标目录的 @ 解析问题', () => {
  const plan = { ...PLAN, revisionRange: '10:15' };
  const preview = buildMergeArguments(plan, true);
  const actual = buildMergeArguments(plan, false);
  assert.deepEqual(preview.filter((argument) => argument !== '--dry-run'), actual);
  assert.deepEqual(actual, ['merge', '--accept', 'postpone', '--depth', 'infinity', '--revision', '10:15', '--', `${PLAN.sourceUrl}@20`, '.']);
  assert.equal(buildMergeArguments(PLAN, false).includes('--revision'), false);
  assert.throws(() => buildMergeArguments({ ...PLAN, revisionRange: '20:10' }, false));
  assert.throws(() => buildMergeArguments({ ...PLAN, sourceRevision: 'HEAD' }, false));
});

test('合并保护覆盖文本、属性、树冲突及版本化修改，不阻止无关未跟踪文件', () => {
  for (const entry of [status({ item: 'conflicted' }), status({ propertyStatus: 'conflicted' }), status({ treeConflicted: true })]) {
    assert.match(getMergeBlockReason([entry])!, /未解决冲突/);
  }
  for (const item of ['added', 'modified', 'deleted', 'missing', 'replaced', 'obstructed', 'incomplete'] as const) {
    assert.match(getMergeBlockReason([status({ item })])!, /未提交/);
  }
  assert.match(getMergeBlockReason([status({ propertyStatus: 'modified' })])!, /未提交/);
  assert.match(getMergeBlockReason([status({ switched: true })])!, /已切换/);
  assert.equal(getMergeBlockReason([status({}), status({ item: 'unversioned' }), status({ item: 'ignored' }), status({ item: 'external' })]), undefined);
});
