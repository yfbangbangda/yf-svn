import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { buildCheckoutArguments } from '../checkout';
import { parseInfoXml } from '../xml';
import { escapeSvnTarget } from '../svnTarget';

test('Checkout 保留目标目录原名，选项位于参数终止符之前', () => {
  const destination = 'D:\\中文 path\\project@team';
  assert.deepEqual(buildCheckoutArguments(' https://example.com/repo ', destination, 'HEAD', 'infinity', true), [
    'checkout', '--revision', 'HEAD', '--depth', 'infinity', '--ignore-externals', '--', 'https://example.com/repo', destination
  ]);
  assert.equal(buildCheckoutArguments('https://example.com/repo', destination, '5', 'files', false).includes('--ignore-externals'), false);
});

test('真实 Checkout 使用所选目录，中文空格和 @ 不产生同名带额外 @ 的工作副本', (context) => {
  if (process.platform !== 'win32') {
    context.skip('YF SVN 当前仅支持 Windows。');
    return;
  }
  const base = path.resolve('.test-tmp');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'checkout regression '));
  context.after(() => {
    if (path.dirname(path.resolve(root)) !== base) {
      throw new Error('检出测试清理目录越界。');
    }
    rmSync(root, { recursive: true, force: true });
  });
  const repository = path.join(root, 'repository');
  const seed = path.join(root, 'seed');
  mkdirSync(seed);
  writeFileSync(path.join(seed, '文件.txt'), '检出内容');
  execFileSync('svnadmin', ['create', repository], { windowsHide: true });
  const url = pathToFileURL(repository).href;
  execFileSync('svn', ['import', seed, url, '-m', '初始化', '--non-interactive'], { windowsHide: true });
  for (const name of ['普通 selected folder', '中文 selected folder@team']) {
    const destination = path.join(root, name);
    mkdirSync(destination);
    execFileSync('svn', ['--non-interactive', ...buildCheckoutArguments(url, destination, 'HEAD', 'infinity', false)], { windowsHide: true });
    assert.equal(existsSync(path.join(destination, '.svn')), true);
    assert.equal(existsSync(path.join(destination, '文件.txt')), true);
    assert.equal(existsSync(`${destination}@`), false);
    const xml = execFileSync('svn', ['info', '--xml', '--', escapeSvnTarget(destination)], { encoding: 'utf8', windowsHide: true });
    assert.equal(path.normalize(parseInfoXml(xml).workingCopyRoot).toLowerCase(), destination.toLowerCase());
  }
});
