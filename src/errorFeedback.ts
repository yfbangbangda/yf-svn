import * as vscode from 'vscode';
import { getSvnErrorAdvice } from './errorAdvice';
import { redactText } from './redact';

/**
 * 展示脱敏后的错误与恢复入口；所有写操作都由用户再次明确发起。
 * @param error SVN 或插件错误。
 * @param output 插件输出通道。
 * @param root 可选的目标工作副本，缺省时仅提供设置和日志入口。
 */
export function showSvnError(error: unknown, output: vscode.OutputChannel, root?: vscode.Uri): void {
  if (error instanceof vscode.CancellationError) {
    return;
  }
  const message = redactText(error instanceof Error ? error.message : String(error));
  output.appendLine(`[错误] ${message}`);
  const advice = getSvnErrorAdvice(message);
  const labels = { settings: '打开 SVN 设置', cleanup: '清理工作副本…', conflicts: '查看冲突', update: '更新工作副本…', merge: '重新预演合并…' };
  const action = advice.action && (root || advice.action === 'settings') ? labels[advice.action] : undefined;
  const detail = [advice.summary, ...(root ? [`工作副本：${root.fsPath}`] : []), message].join('\n');
  void vscode.window.showErrorMessage(detail, ...[...(action ? [action] : []), '显示 SVN 输出']).then(async (selected) => {
    if (selected === '显示 SVN 输出') {
      output.show();
    } else if (action && selected === action) {
      if (advice.action === 'settings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'yfSvn');
      } else if (advice.action === 'conflicts') {
        await vscode.commands.executeCommand('workbench.view.scm');
      } else if (root) {
        if (advice.action === 'cleanup') {
          const confirmed = await vscode.window.showWarningMessage('确认清理该 SVN 工作副本？', { modal: true, detail: root.fsPath }, '清理');
          if (confirmed !== '清理') {
            return;
          }
        }
        const command = { cleanup: 'yfSvn.cleanup', update: 'yfSvn.update', merge: 'yfSvn.merge' }[advice.action as 'cleanup' | 'update' | 'merge'];
        if (command) {
          await vscode.commands.executeCommand(command, root);
        }
      }
    }
  }).then(undefined, (failure: unknown) => {
    output.appendLine(`[恢复入口失败] ${redactText(failure instanceof Error ? failure.message : String(failure))}`);
  });
}
