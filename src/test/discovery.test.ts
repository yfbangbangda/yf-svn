import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { findNestedWorkingCopyRoots } from '../discovery';

test('findNestedWorkingCopyRoots 能发现嵌套工作副本并跳过依赖目录', async (context) => {
  const root = path.join(process.cwd(), '.test-tmp', `discovery-${Date.now()}`);
  const nestedWorkingCopy = path.join(root, 'project', 'os');
  const ignoredWorkingCopy = path.join(root, 'node_modules', 'package');
  mkdirSync(path.join(nestedWorkingCopy, '.svn'), { recursive: true });
  mkdirSync(path.join(ignoredWorkingCopy, '.svn'), { recursive: true });
  writeFileSync(path.join(nestedWorkingCopy, '.svn', 'wc.db'), '');
  writeFileSync(path.join(ignoredWorkingCopy, '.svn', 'wc.db'), '');
  context.after(() => rmSync(root, { recursive: true, force: true }));

  const roots = await findNestedWorkingCopyRoots(root);
  assert.deepEqual(roots, [nestedWorkingCopy]);
});
