import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { escapeSvnTarget } from '../svnTarget';
import { parseInfoXml } from '../xml';

/** 供 Node 集成测试与真实扩展宿主共用的独立分支合并数据。 */
export interface MergeFixture {
  readonly sourceUrl: string;
  readonly targetUrl: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly sourceRevision: string;
  readonly fileName: string;
}

/**
 * 在测试目录中准备有共同祖先的主干和分支，目标工作副本保持干净且版本一致。
 *
 * @param root 调用方负责清理的隔离测试目录。
 * @returns 合并测试需要的 URL、路径和来源 revision。
 */
export function createMergeFixture(root: string): MergeFixture {
  const repository = path.join(root, 'merge repository');
  const seed = path.join(root, 'merge seed');
  const targetPath = path.join(root, '合并 target@team');
  const sourcePath = path.join(root, '合并 source@team');
  const fileName = '文件 with spaces.txt';
  mkdirSync(path.join(seed, '子目录'), { recursive: true });
  writeFileSync(path.join(seed, fileName), '初始内容\n');
  writeFileSync(path.join(seed, '子目录', 'guard.txt'), '深层文件\n');
  execFileSync('svnadmin', ['create', repository], { windowsHide: true });
  const repositoryUrl = pathToFileURL(repository).href;
  const targetUrl = `${repositoryUrl}/trunk`;
  const sourceUrl = `${repositoryUrl}/branches/feature@team`;
  runFixtureSvn(['mkdir', targetUrl, `${repositoryUrl}/branches`, '-m', '初始化布局'], root);
  runFixtureSvn(['import', seed, targetUrl, '-m', '初始内容'], root);
  runFixtureSvn(['copy', `${targetUrl}@HEAD`, `${sourceUrl}@`, '-m', '创建分支'], root);
  runFixtureSvn(['checkout', targetUrl, targetPath], root);
  runFixtureSvn(['checkout', `${sourceUrl}@HEAD`, sourcePath], root);
  writeFileSync(path.join(sourcePath, fileName), '分支修改一\n');
  runFixtureSvn(['commit', '-m', '分支修改一', '--', escapeSvnTarget(sourcePath)], sourcePath);
  runFixtureSvn(['update', '--', escapeSvnTarget(targetPath)], targetPath);
  const sourceRevision = parseInfoXml(runFixtureSvn(['info', '--xml', '-r', 'HEAD', '--', `${sourceUrl}@HEAD`], root)).revision;
  return { sourceUrl, targetUrl, sourcePath, targetPath, sourceRevision, fileName };
}

/**
 * 执行测试数据准备及集成验收所需的 SVN 命令。
 *
 * @param args SVN 命令参数数组。
 * @param cwd 测试命令工作目录。
 * @returns 命令标准输出。
 */
export function runFixtureSvn(args: readonly string[], cwd: string): string {
  return execFileSync('svn', ['--non-interactive', ...args], { cwd, encoding: 'utf8', windowsHide: true });
}
