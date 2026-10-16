import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { SvnMergePlan } from './merge';
import { redactText } from './redact';

export const MERGE_PREVIEW_SCHEME = 'yf-svn-merge-preview';

/** 一个与来源快照绑定的合并预演，执行状态限制同一预演重复提交。 */
export interface MergePreview {
  readonly root: vscode.Uri;
  readonly plan: SvnMergePlan;
  readonly content: string;
  state: 'ready' | 'running' | 'applied' | 'invalid';
}

/** 为合并预演提供只读文档，并保留关闭通知后仍可访问的执行上下文。 */
class MergePreviewProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly previews = new Map<string, MergePreview>();
  private readonly changes = new vscode.EventEmitter<vscode.Uri>();
  private nextId = 0;
  // 关键逻辑：重新加载扩展后不能复用旧标签页 URI，避免旧文档缓存对应到新预演。
  private readonly sessionId = randomUUID();
  public readonly onDidChange = this.changes.event;

  /**
   * 保存已经完成的预演及固定参数。
   * @param root 目标工作副本根目录。
   * @param plan 预演实际使用的来源和目标快照。
   * @param content 已完成预演的输出内容。
   * @returns 可打开的只读预演文档 URI。
   */
  public create(root: vscode.Uri, plan: SvnMergePlan, content: string): vscode.Uri {
    // 关键逻辑：新预演取代同一工作副本旧的可执行预演，旧文档仍保留结果但不能继续执行。
    for (const [key, preview] of this.previews) {
      if (preview.root.toString() === root.toString() && preview.state === 'ready') {
        preview.state = 'invalid';
        this.changes.fire(vscode.Uri.parse(key));
      }
    }
    const uri = vscode.Uri.from({ scheme: MERGE_PREVIEW_SCHEME, path: `/SVN 合并预演 ${++this.nextId}.txt`, query: this.sessionId });
    this.previews.set(uri.toString(), { root, plan: { ...plan }, content: redactText(content), state: 'ready' });
    return uri;
  }

  /**
   * 查询已经创建的预演，拒绝用户构造的无效 URI。
   * @param uri 预演文档 URI。
   * @returns 预演上下文；不存在时返回 undefined。
   */
  public get(uri: vscode.Uri): MergePreview | undefined {
    return uri.scheme === MERGE_PREVIEW_SCHEME ? this.previews.get(uri.toString()) : undefined;
  }

  /**
   * 更新预演执行状态并通知只读编辑器。
   * @param uri 预演文档 URI。
   * @param state 新的执行状态。
   */
  public setState(uri: vscode.Uri, state: MergePreview['state']): void {
    const preview = this.get(uri);
    if (preview) {
      preview.state = state;
      this.changes.fire(uri);
    }
  }

  /**
   * 返回预演正文及明确的继续执行状态。
   * @param uri 预演文档 URI。
   * @returns 只读预演内容。
   */
  public provideTextDocumentContent(uri: vscode.Uri): string {
    const preview = this.get(uri);
    if (!preview) {
      return '此合并预演已失效，请重新运行“SVN: 合并”。';
    }
    const status = {
      ready: '可通过编辑器右上角或命令面板的“执行本次合并”继续；执行前仍需确认并重新校验工作副本。',
      running: '正在确认或执行本次合并，请勿重复操作。',
      applied: '本次预演已执行，不能重复执行。请检查本地修改及冲突后提交。',
      invalid: '本次预演已失效或执行未完成，请检查当前状态并重新预演。'
    }[preview.state];
    return `${status}\n\n${preview.content}`;
  }

  /** 释放本次扩展会话保留的预演及文档事件。 */
  public dispose(): void {
    this.previews.clear();
    this.changes.dispose();
  }
}

export const mergePreviews = new MergePreviewProvider();
