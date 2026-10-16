import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMergeFixture } from './mergeFixture';

/**
 * 使用本机 VS Code 启动隔离的扩展宿主测试，不下载编辑器或安装额外测试框架。
 */
async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('扩展宿主测试需要 Windows 和本机 VS Code。');
  }
  const project = path.resolve(__dirname, '../..');
  const configured = process.env.YF_SVN_TEST_CODE;
  // 关键逻辑：通过 PATH 定位标准 VS Code 安装，也允许显式指定 Code.exe。
  const command = configured ?? execFileSync('where.exe', ['code.cmd'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]!;
  const executable = /\.cmd$/i.test(command) ? path.resolve(path.dirname(command), '..', 'Code.exe') : command;
  if (!existsSync(executable)) {
    throw new Error('找不到 Code.exe，请通过 YF_SVN_TEST_CODE 指定完整路径。');
  }
  mkdirSync(path.join(project, '.test-tmp'), { recursive: true });
  const root = mkdtempSync(path.join(project, '.test-tmp', 'host smoke '));
  try {
    const repository = path.join(root, 'repository');
    const workspace = path.join(root, 'working copy@smoke');
    const seed = path.join(root, 'seed');
    mkdirSync(seed);
    writeFileSync(path.join(seed, 'tracked.txt'), '初始内容\n');
    execFileSync('svnadmin', ['create', repository], { windowsHide: true });
    // import 的本地源和 checkout 的本地目标不是 peg revision 参数，必须保留真实目录名。
    execFileSync('svn', ['import', seed, pathToFileURL(repository).href, '-m', '初始化', '--non-interactive'], { windowsHide: true, stdio: 'inherit' });
    execFileSync('svn', ['checkout', pathToFileURL(repository).href, workspace, '--non-interactive'], { windowsHide: true, stdio: 'inherit' });
    writeFileSync(path.join(workspace, 'tracked.txt'), '修改后的内容\n');
    writeFileSync(path.join(workspace, '新增 file.txt'), '尚未版本控制\n');
    createMergeFixture(root);
    const interactionRoot = path.join(root, 'interaction fixture');
    mkdirSync(interactionRoot);
    createMergeFixture(interactionRoot);
    const userData = path.join(root, 'user-data');
    mkdirSync(path.join(userData, 'User'), { recursive: true });
    writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
      'yfSvn.autoRefresh': false,
      'extensions.autoUpdate': false,
      'update.mode': 'none',
      'telemetry.telemetryLevel': 'off',
      'workbench.startupEditor': 'none'
    }));
    await new Promise<void>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env, YF_SVN_TEST_NODE: process.execPath, YF_SVN_TEST_ROOT: root };
      // 关键逻辑：使用全新用户目录和扩展目录，避免影响用户已打开的编辑器及扩展。
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(executable, [
        '--new-window', '--disable-extensions', '--disable-workspace-trust',
        '--skip-welcome', '--skip-release-notes',
        '--user-data-dir', userData,
        '--extensions-dir', path.join(root, 'extensions'),
        `--extensionDevelopmentPath=${project}`,
        `--extensionTestsPath=${path.join(__dirname, 'host', 'index.js')}`,
        workspace
      ], { env, shell: false, windowsHide: true, stdio: 'inherit' });
      // 测试超时只终止本次隔离实例及其子进程，不触碰用户现有 VS Code。
      const timer = setTimeout(() => {
        if (child.pid) {
          try {
            execFileSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          } catch (error) {
            reject(error);
          }
        }
      }, 90_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && existsSync(path.join(root, 'host-passed'))) {
          resolve();
        } else {
          reject(new Error(`扩展宿主测试失败，退出码：${code}。`));
        }
      });
    });
  } finally {
    // 关键逻辑：递归删除前检查绝对路径，确保清理目标是项目 .test-tmp 的直接子目录。
    if (path.dirname(path.resolve(root)) !== path.join(project, '.test-tmp')) {
      throw new Error('测试清理目录超出项目 .test-tmp 范围，已停止清理。');
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
