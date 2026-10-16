import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SvnFileDecorationProvider } from '../../fileDecorationProvider';
import { SvnManager } from '../../manager';
import { SvnRepository } from '../../repository';
import { SvnCli } from '../../svnCli';

/**
 * 等待原生编辑器和配置事件完成，避免把异步事件误判为失败。
 * @param condition 表示事件已处理的判断函数。
 */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) { throw new Error('原生 UI 事件等待超时。'); }
    await delay(20);
  }
}

/**
 * 在真实宿主中验证状态摘要、中文装饰、Blame 固定宽度、分栏同步和编辑后撤下旧追溯。
 * @param workspace 隔离的真实 SVN 工作副本。
 * @param output SVN 输出通道。
 */
export async function testNativeUi(workspace: vscode.Uri, output: vscode.OutputChannel): Promise<void> {
  const cli = new SvnCli(output);
  const manager = new SvnManager(cli, output);
  const repository = new SvnRepository(cli, workspace, output, () => {});
  manager['repositories'].set(workspace.fsPath, repository);
  const provider = new SvnFileDecorationProvider(manager);
  const token = new vscode.CancellationTokenSource();
  const configuration = vscode.workspace.getConfiguration('yfSvn', workspace);
  const oldStyle = configuration.inspect<string>('blameStyle')?.globalValue;
  const oldDepth = configuration.inspect<string>('statusDepth')?.globalValue;
  const tracked = vscode.Uri.joinPath(workspace, 'tracked.txt');
  const restores: Array<() => void> = [];
  let originalText: string | undefined;
  try {
    await configuration.update('blameStyle', 'compact', vscode.ConfigurationTarget.Global);
    await repository.refresh();
    const summary = repository.sourceControl.statusBarCommands![0]!;
    assert.equal(summary.command, 'yfSvn.refresh');
    assert.deepEqual(summary.arguments, [workspace]);
    assert.ok(summary.title.includes(path.basename(workspace.fsPath)));
    assert.ok(summary.title.includes(`${repository.sourceControl.count} 项`));
    assert.ok(summary.tooltip?.includes('未版本控制：'));
    assert.ok(summary.tooltip?.includes('上次成功刷新：'));
    assert.ok(repository['unversioned'].hideWhenEmpty);
    assert.ok(repository['conflicts'].hideWhenEmpty);
    const state = repository['changes'].resourceStates.find((item) => item.resourceUri.toString() === tracked.toString())!;
    assert.ok(state.decorations?.iconPath instanceof vscode.ThemeIcon);
    assert.equal((state.decorations?.iconPath as vscode.ThemeIcon).id, 'diff-modified');
    const decoration = provider.provideFileDecoration(tracked, token.token)!;
    assert.equal(decoration.badge, 'M');
    assert.equal(decoration.tooltip, 'SVN：已修改');

    const conflict = await repository['createResourceState']({ ...repository.getStatus(tracked)!, treeConflicted: true });
    assert.ok(conflict);
    assert.equal((conflict.decorations?.iconPath as vscode.ThemeIcon).id, 'warning');
    repository['conflicts'].resourceStates = [conflict];
    repository['updateStatusBar']();
    assert.ok(repository.sourceControl.statusBarCommands![0]!.title.includes('1 冲突'));
    await configuration.update('statusDepth', 'empty', vscode.ConfigurationTarget.Global);
    await repository.refresh();
    assert.ok(repository.sourceControl.statusBarCommands![0]!.title.includes('无可见更改'));
    assert.ok(repository.sourceControl.statusBarCommands![0]!.tooltip?.includes('empty（仅统计已扫描范围）'));
    await configuration.update('statusDepth', oldDepth, vscode.ConfigurationTarget.Global);
    await repository.refresh();
    console.log('通过：工作副本状态摘要、浅层范围说明、冲突优先级及中文状态标记和图标');

    const document = await vscode.workspace.openTextDocument(tracked);
    originalText = document.getText();
    const first = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
    const observed = new Map<vscode.TextEditor, readonly vscode.DecorationOptions[]>();
    const editorWrappers = new Map<vscode.TextEditor, vscode.TextEditor>();
    const visibleDescriptor = Object.getOwnPropertyDescriptor(vscode.window, 'visibleTextEditors')!;
    assert.ok(visibleDescriptor.configurable);
    // 关键逻辑：原生编辑器对象不可改写，只包装可见编辑器入口，并继续把装饰交给真实编辑器。
    Object.defineProperty(vscode.window, 'visibleTextEditors', { configurable: true, get: () => {
      const editors = (visibleDescriptor.get ? visibleDescriptor.get.call(vscode.window) : visibleDescriptor.value) as readonly vscode.TextEditor[];
      return editors.map((editor) => {
        if (!editorWrappers.has(editor)) {
          editorWrappers.set(editor, { ...editor,
            /** 观察装饰数据并调用原生渲染。@param type 装饰类型。@param ranges 装饰范围和内容。 */
            setDecorations: (type, ranges) => {
              if (type === repository['blameDecoration']) { observed.set(editor, ranges as readonly vscode.DecorationOptions[]); }
              editor.setDecorations(type, ranges);
            }
          });
        }
        return editorWrappers.get(editor)!;
      });
    } });
    restores.push(() => { Object.defineProperty(vscode.window, 'visibleTextEditors', visibleDescriptor); });
    const originalRun = cli.run.bind(cli);
    let blameCalls = 0;
    /** 统计真实追溯查询，确保格式切换复用缓存。@param args SVN 参数。@param options 执行选项。 */
    cli.run = async (args, options) => {
      if (args[0] === 'blame') { blameCalls++; }
      return originalRun(args, options);
    };
    await repository.showBlame(tracked);
    assert.equal(blameCalls, 1);
    const compact = observed.get(first)![0]!;
    assert.equal(compact.renderOptions?.before?.width, '24ch');
    assert.ok((compact.hoverMessage as vscode.MarkdownString).value.includes('Revision：'));
    assert.ok((compact.hoverMessage as vscode.MarkdownString).value.includes('作者：'));
    assert.ok((compact.hoverMessage as vscode.MarkdownString).value.includes('时间：'));
    await configuration.update('blameStyle', 'full', vscode.ConfigurationTarget.Global);
    await until(() => observed.get(first)?.[0]?.renderOptions?.before?.width === '46ch');
    assert.equal(blameCalls, 1, '修改显示格式不能重新执行 SVN 查询');
    const second = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Two, preview: false });
    assert.notEqual(first, second);
    await until(() => observed.get(second) !== undefined);
    assert.ok(observed.get(first)!.length > 0);
    assert.deepEqual(observed.get(second), observed.get(first));
    await repository.showBlame(tracked);
    assert.deepEqual(observed.get(first), []);
    assert.deepEqual(observed.get(second), []);
    assert.equal(blameCalls, 1, '再次执行只关闭追溯，不应重新查询');
    await repository.showBlame(tracked);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(tracked, new vscode.Position(0, 0), '测试编辑后撤下旧追溯\n');
    assert.ok(await vscode.workspace.applyEdit(edit));
    await until(() => repository['blameResource'] === undefined);
    assert.deepEqual(observed.get(first), []);
    assert.deepEqual(observed.get(second), []);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queryStarted = new Promise<void>((resolve) => { started = resolve; });
    /** 延迟真实查询的返回以覆盖查询期间编辑。@param args SVN 参数。@param options 执行选项。 */
    cli.run = async (args, options) => {
      const result = await originalRun(args, options);
      if (args[0] === 'blame') { started(); await gate; }
      return result;
    };
    const pending = repository.showBlame(tracked);
    try {
      await queryStarted;
      const duringQuery = new vscode.WorkspaceEdit();
      duringQuery.insert(tracked, new vscode.Position(0, 0), '查询期间的新内容\n');
      assert.ok(await vscode.workspace.applyEdit(duringQuery));
    } finally {
      release();
      await pending;
      cli.run = originalRun;
    }
    assert.equal(repository['blameResource'], undefined, '查询期间编辑后不能重新贴回旧追溯');
    assert.deepEqual(observed.get(first), []);
    assert.deepEqual(observed.get(second), []);
    console.log('通过：真实 Blame 紧凑与完整固定宽度、完整悬浮信息、配置即时生效、分栏同步、关闭及编辑后清除');
  } finally {
    restores.forEach((restore) => restore());
    if (originalText !== undefined) {
      const document = await vscode.workspace.openTextDocument(tracked);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(tracked, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), originalText);
      await vscode.workspace.applyEdit(edit);
      await document.save();
    }
    await configuration.update('blameStyle', oldStyle, vscode.ConfigurationTarget.Global);
    await configuration.update('statusDepth', oldDepth, vscode.ConfigurationTarget.Global);
    token.dispose();
    provider.dispose();
    manager.dispose();
  }
}
