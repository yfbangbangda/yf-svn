import * as vscode from 'vscode';
import { SVN_CONTENT_SCHEME, SvnContentProvider } from './contentProvider';
import { SvnFileDecorationProvider } from './fileDecorationProvider';
import { extractResourceUris, SvnManager } from './manager';
import { SVN_MENU_CAPABILITIES } from './menuContext';
import { SvnCli } from './svnCli';

/**
 * 激活 YF SVN 扩展并注册核心命令。
 *
 * @param context VS Code 扩展上下文。
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('YF SVN');
  const cli = new SvnCli(output);
  const manager = new SvnManager(cli, output);
  const fileDecorationProvider = new SvnFileDecorationProvider(manager);
  const contentProvider = new SvnContentProvider(cli);

  context.subscriptions.push(
    output,
    manager,
    fileDecorationProvider,
    vscode.window.registerFileDecorationProvider(fileDecorationProvider),
    vscode.workspace.registerTextDocumentContentProvider(SVN_CONTENT_SCHEME, contentProvider),
    manager.onDidChangeStatus(() => void updateMenuContexts(manager)),
    vscode.commands.registerCommand('yfSvn.showOutput', () => output.show()),
    vscode.commands.registerCommand('yfSvn.diagnose', () => manager.diagnose()),
    vscode.commands.registerCommand('yfSvn.checkout', () => manager.checkout()),
    vscode.commands.registerCommand('yfSvn.refresh', () => manager.refreshAll()),
    vscode.commands.registerCommand('yfSvn.commit', (...args: unknown[]) =>
      withRepository(manager, args, (repository, resources) => repository.commit(resources))
    ),
    vscode.commands.registerCommand('yfSvn.commitAll', (...args: unknown[]) =>
      // 关键逻辑：参数仅用于定位当前工作副本，提交范围由 Repository 收集并交给用户勾选。
      withRepository(manager, args, (repository) => repository.commit())
    ),
    vscode.commands.registerCommand('yfSvn.update', (...args: unknown[]) =>
      withRepository(manager, args, (repository) => repository.update())
    ),
    vscode.commands.registerCommand('yfSvn.branchTag', (...args: unknown[]) =>
      withRepository(manager, args, (repository) => repository.branchOrTag())
    ),
    vscode.commands.registerCommand('yfSvn.switch', (...args: unknown[]) =>
      withRepository(manager, args, (repository) => repository.switchBranch())
    ),
    vscode.commands.registerCommand('yfSvn.updateFile', (...args: unknown[]) =>
      withRepository(
        manager,
        args,
        (repository, resources) => repository.update(resources[0]!),
        true
      )
    ),
    vscode.commands.registerCommand('yfSvn.updateDirectory', (...args: unknown[]) =>
      withRepository(
        manager,
        args,
        (repository, resources) => repository.update(resources[0]!),
        true
      )
    ),
    vscode.commands.registerCommand('yfSvn.add', (...args: unknown[]) =>
      withRepository(manager, args, (repository, resources) => repository.add(resources), true)
    ),
    vscode.commands.registerCommand('yfSvn.delete', (...args: unknown[]) =>
      withRepository(manager, args, (repository, resources) => repository.remove(resources), true)
    ),
    vscode.commands.registerCommand('yfSvn.revert', (...args: unknown[]) =>
      withRepository(manager, args, (repository, resources) => repository.revert(resources), true)
    ),
    vscode.commands.registerCommand('yfSvn.rename', (...args: unknown[]) =>
      withRepository(
        manager,
        args,
        (repository, resources) => repository.rename(resources[0]!),
        true
      )
    ),
    vscode.commands.registerCommand('yfSvn.ignore', (...args: unknown[]) =>
      withRepository(manager, args, (repository, resources) => repository.ignore(resources), true)
    ),
    vscode.commands.registerCommand('yfSvn.lock', (...args: unknown[]) =>
      withRepository(manager, args, (repository, resources) => repository.lock(resources), true)
    ),
    vscode.commands.registerCommand('yfSvn.unlock', (...args: unknown[]) =>
      withRepository(manager, args, (repository, resources) => repository.unlock(resources), true)
    ),
    vscode.commands.registerCommand('yfSvn.property', (...args: unknown[]) =>
      withRepository(
        manager,
        args,
        (repository, resources) => repository.manageProperty(resources[0]!),
        true
      )
    ),
    vscode.commands.registerCommand('yfSvn.changelist', (...args: unknown[]) =>
      withRepository(
        manager,
        args,
        (repository, resources) => repository.assignChangelist(resources),
        true
      )
    ),
    vscode.commands.registerCommand('yfSvn.cleanup', (...args: unknown[]) =>
      withRepository(manager, args, (repository) => repository.cleanup())
    ),
    vscode.commands.registerCommand('yfSvn.compare', (...args: unknown[]) =>
      withRepository(
        manager,
        args,
        (repository, resources) => repository.compare(resources[0]!),
        true
      )
    ),
    vscode.commands.registerCommand('yfSvn.openConflict', (...args: unknown[]) =>
      withRepository(
        manager,
        args,
        (repository, resources) => repository.openConflict(resources[0]!),
        true
      )
    ),
    vscode.commands.registerCommand('yfSvn.resolve', (...args: unknown[]) =>
      withRepository(manager, args, (repository, resources) => repository.resolve(resources), true)
    ),
    vscode.commands.registerCommand('yfSvn.log', (...args: unknown[]) =>
      withRepository(manager, args, (repository, resources) => repository.showLog(resources[0]))
    ),
    vscode.commands.registerCommand('yfSvn.blame', (...args: unknown[]) =>
      withRepository(
        manager,
        args,
        (repository, resources) => repository.showBlame(resources[0]!),
        true
      )
    )
  );

  await manager.discover();
  await updateMenuContexts(manager);
}

/**
 * 释放扩展资源。
 */
export function deactivate(): void {
  // VS Code 会自动释放 context.subscriptions 中注册的全部资源。
}

/**
 * 把最新 SVN 状态写入 VS Code context key，供资源管理器和编辑器菜单过滤。
 *
 * @param manager SVN 工作副本管理器。
 */
async function updateMenuContexts(manager: SvnManager): Promise<void> {
  const resources = manager.getMenuContextResources();
  await Promise.all(
    SVN_MENU_CAPABILITIES.map((capability) =>
      vscode.commands.executeCommand(
        'setContext',
        `yfSvn.${capability}Resources`,
        resources[capability]
      )
    )
  );
}

/**
 * 为命令选择所属工作副本、校验资源并统一展示错误。
 *
 * @param manager SVN 工作副本管理器。
 * @param args VS Code 传入的命令参数。
 * @param action 找到工作副本后执行的实际操作。
 * @param resourcesRequired 是否必须至少传入一个资源。
 */
async function withRepository(
  manager: SvnManager,
  args: readonly unknown[],
  action: (
    repository: Awaited<ReturnType<SvnManager['pickRepository']>> extends infer T
      ? Exclude<T, undefined>
      : never,
    resources: readonly vscode.Uri[]
  ) => Promise<void>,
  resourcesRequired = false
): Promise<void> {
  const resources = extractResourceUris(args);
  if (resourcesRequired && resources.length === 0) {
    void vscode.window.showWarningMessage('请先选择一个 SVN 文件或目录。');
    return;
  }
  const repository = await manager.pickRepository(resources[0]);
  if (!repository) {
    void vscode.window.showWarningMessage('没有找到对应的 SVN 工作副本。');
    return;
  }
  try {
    await action(repository, resources);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(message);
  }
}
