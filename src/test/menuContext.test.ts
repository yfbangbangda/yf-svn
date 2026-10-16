import assert from 'node:assert/strict';
import test from 'node:test';
import { getSvnMenuCapabilities, SvnMenuCapability } from '../menuContext';
import { SvnItemStatus, SvnStatusEntry } from '../types';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * 创建右键菜单能力测试使用的 SVN 状态。
 *
 * @param item 文件状态。
 * @param propertyStatus 属性状态。
 * @param locked 是否持有 SVN 锁。
 * @returns 完整 SVN 状态条目。
 */
function status(
  item: SvnItemStatus,
  propertyStatus: SvnItemStatus = 'none',
  locked = false
): SvnStatusEntry {
  return {
    absolutePath: 'C:\\working-copy\\file.txt',
    item,
    propertyStatus,
    treeConflicted: false,
    switched: false,
    copied: false,
    locked
  };
}

test('未版本控制文件只显示添加和忽略操作', () => {
  assert.deepEqual(
    [...getSvnMenuCapabilities(status('unversioned'))].sort(),
    ['addable', 'ignorable', 'known']
  );
});

test('正常文件不显示提交、还原和比较操作', () => {
  const capabilities = getSvnMenuCapabilities(status('normal'));
  assert.equal(capabilities.has('committable'), false);
  assert.equal(capabilities.has('revertible'), false);
  assert.equal(capabilities.has('diffable'), false);
  assert.equal(capabilities.has('historical'), true);
  assert.equal(capabilities.has('lockable'), true);
});

test('修改文件显示提交、还原和比较操作', () => {
  const capabilities = getSvnMenuCapabilities(status('modified'));
  assert.equal(capabilities.has('committable'), true);
  assert.equal(capabilities.has('revertible'), true);
  assert.equal(capabilities.has('diffable'), true);
});

test('锁定文件只显示解锁操作', () => {
  const capabilities = getSvnMenuCapabilities(status('normal', 'none', true));
  assert.equal(capabilities.has('lockable'), false);
  assert.equal(capabilities.has('unlockable'), true);
});

test('冲突资源限制为冲突处理与恢复，树冲突不会因基础状态被隐藏', () => {
  const entry = { ...status('modified'), treeConflicted: true };
  const capabilities = getSvnMenuCapabilities(entry);
  assert.equal(capabilities.has('conflicted'), true);
  for (const capability of ['committable', 'diffable', 'lockable', 'mutableVersioned', 'deletable', 'renamable'] as const) {
    assert.equal(capabilities.has(capability), false, capability);
  }
  assert.equal(getSvnMenuCapabilities({ ...status('none'), treeConflicted: true }).has('conflicted'), true);
});

test('目录属性修改可提交和管理属性，但不能显示文件锁、逐行追溯及 Changelist 操作', () => {
  const capabilities = getSvnMenuCapabilities({ ...status('normal', 'modified'), kind: 'dir' });
  assert.equal(capabilities.has('committable'), true);
  assert.equal(capabilities.has('mutableVersioned'), true);
  assert.equal(capabilities.has('historical'), true);
  for (const capability of ['lockable', 'unlockable', 'blamable', 'changelistable'] as const) {
    assert.equal(capabilities.has(capability), false, capability);
  }
});

test('SCM 与编辑器、资源管理器对共享命令使用相同状态能力，强制操作不依赖当前持锁状态', () => {
  const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
  const menus = manifest.contributes.menus as Record<string, Array<{ command: string; when: string }>>;
  for (const entry of menus['scm/resourceState/context']!) {
    const pattern = entry.when.match(/scmResourceState =~ \/(.+)\//)?.[1];
    assert.ok(pattern, entry.command);
    for (const surface of ['yfSvn.explorerContext', 'yfSvn.editorContext']) {
      const counterpart = menus[surface]!.find((item) => item.command === entry.command);
      assert.ok(counterpart, `${surface}: ${entry.command}`);
      const allowed = [...counterpart.when.matchAll(/resource in yfSvn\.(\w+)Resources/g)].map((match) => match[1]!);
      for (const entryStatus of [status('unversioned'), status('normal'), status('modified'), status('modified', 'none', true), status('added'), status('deleted'), status('conflicted'), status('ignored'), { ...status('normal', 'modified'), kind: 'dir' as const }]) {
        const capabilities = getSvnMenuCapabilities(entryStatus);
        const scmVisible = new RegExp(pattern).test([...capabilities].join(' '));
        const otherVisible = allowed.some((capability) => capabilities.has(capability as SvnMenuCapability));
        assert.equal(scmVisible, otherVisible, `${surface}: ${entry.command}: ${entryStatus.item}`);
      }
    }
  }
  for (const command of ['yfSvn.forceLock', 'yfSvn.forceUnlock']) {
    const pattern = menus['scm/resourceState/context']!.find((entry) => entry.command === command)!.when.match(/\/(.+)\//)![1]!;
    assert.equal(new RegExp(pattern).test('lockable'), true);
    assert.equal(new RegExp(pattern).test('unlockable'), true);
  }
});

test('资源管理器只保留一个 SVN 子菜单入口，危险操作在三个界面中独立分组', () => {
  const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
  const menus = manifest.contributes.menus;
  assert.deepEqual(menus['explorer/context'], [{
    submenu: 'yfSvn.explorerContext', when: 'resourceScheme == file && resource in yfSvn.knownResources', group: 'svn@1'
  }]);
  for (const surface of ['yfSvn.explorerContext', 'yfSvn.editorContext', 'scm/resourceState/context']) {
    for (const command of ['yfSvn.forceLock', 'yfSvn.forceUnlock']) {
      const item = menus[surface].find((entry: { command: string }) => entry.command === command);
      assert.ok(item.group.startsWith('6_force@'));
    }
  }
});
