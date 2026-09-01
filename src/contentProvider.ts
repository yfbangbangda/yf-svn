import * as vscode from 'vscode';
import * as path from 'node:path';
import { SvnCli } from './svnCli';
import { escapeSvnTarget } from './svnTarget';

export const SVN_CONTENT_SCHEME = 'yf-svn';

/**
 * 创建指向某个 SVN revision 内容的虚拟文档 URI。
 *
 * @param file 本地工作副本文件。
 * @param revision BASE、HEAD 或数字 revision。
 * @returns 可由 SVN 内容提供器读取的 URI。
 */
export function createSvnContentUri(file: vscode.Uri, revision: string): vscode.Uri {
  const query = new URLSearchParams({
    file: file.fsPath,
    revision
  });
  return vscode.Uri.from({
    scheme: SVN_CONTENT_SCHEME,
    path: `/${revision}/${file.path.split('/').at(-1) ?? 'content'}`,
    query: query.toString()
  });
}

/**
 * 为 VS Code Diff Editor 提供指定 SVN revision 的只读文件内容。
 */
export class SvnContentProvider implements vscode.TextDocumentContentProvider {
  /**
   * 创建 SVN 内容提供器。
   *
   * @param cli SVN CLI 适配器。
   */
  public constructor(private readonly cli: SvnCli) {}

  /**
   * 读取虚拟 URI 对应的 SVN 文件内容。
   *
   * @param uri 由 createSvnContentUri 创建的虚拟 URI。
   * @param token VS Code 取消令牌。
   * @returns 指定 revision 的文件文本。
   */
  public async provideTextDocumentContent(
    uri: vscode.Uri,
    token: vscode.CancellationToken
  ): Promise<string> {
    const query = new URLSearchParams(uri.query);
    const file = query.get('file');
    const revision = query.get('revision');
    if (!file || !revision) {
      throw new Error('SVN 虚拟文档缺少文件路径或 revision。');
    }
    // 关键逻辑：使用 -- 与尾部 @ 转义，防止路径中的 @ 被解析为 peg revision。
    const result = await this.cli.run(
      ['cat', '--revision', revision, '--', escapeSvnTarget(file)],
      {
        cwd: path.dirname(file),
        token
      }
    );
    if (result.stdout.includes('\0')) {
      throw new Error('该 SVN revision 是二进制文件，VS Code 文本 Diff 无法显示其内容。');
    }
    return result.stdout;
  }
}
