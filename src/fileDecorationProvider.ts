import * as vscode from 'vscode';
import { SvnManager } from './manager';
import { getStatusBadge, getStatusColorId, getStatusTooltip } from './statusDecoration';

/**
 * 在 VS Code 资源管理器中按 SVN 状态提供主题自适应颜色。
 */
export class SvnFileDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<undefined>();
  private readonly statusSubscription: vscode.Disposable;
  public readonly onDidChangeFileDecorations = this.changeEmitter.event;

  /**
   * 创建 SVN 文件装饰提供器。
   *
   * @param manager SVN 工作副本管理器。
   */
  public constructor(private readonly manager: SvnManager) {
    this.statusSubscription = manager.onDidChangeStatus(() => this.changeEmitter.fire(undefined));
  }

  /**
   * 返回资源当前的 SVN 颜色装饰。
   *
   * @param uri 待装饰的文件或目录 URI。
   * @param _token VS Code 取消令牌。
   * @returns 存在可见 SVN 状态时返回文件装饰。
   */
  public provideFileDecoration(
    uri: vscode.Uri,
    _token: vscode.CancellationToken
  ): vscode.FileDecoration | undefined {
    const status = this.manager.findRepository(uri)?.getStatus(uri);
    if (!status) {
      return undefined;
    }
    return new vscode.FileDecoration(
      getStatusBadge(status),
      `SVN：${getStatusTooltip(status)}`,
      new vscode.ThemeColor(getStatusColorId(status))
    );
  }

  /**
   * 释放状态监听器和文件装饰事件。
   */
  public dispose(): void {
    this.statusSubscription.dispose();
    this.changeEmitter.dispose();
  }
}
