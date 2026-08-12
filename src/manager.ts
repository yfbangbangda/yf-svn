import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { findNestedWorkingCopyRoots } from './discovery';
import { SVN_MENU_CAPABILITIES, SvnMenuCapability } from './menuContext';
import { SvnRepository } from './repository';
import { SvnCli } from './svnCli';
import { SvnRepositoryOperations, SvnResourceState } from './types';
import { parseInfoXml } from './xml';

/**
 * 负责发现工作副本、路由命令并管理全部 SVN Repository 实例。
 */
export class SvnManager implements vscode.Disposable {
  private readonly repositories = new Map<string, SvnRepository>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly statusChangeEmitter = new vscode.EventEmitter<void>();
  private readonly pendingRefreshRepositories = new Set<SvnRepository>();
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshAllPending = false;

  /**
   * 创建 SVN 管理器并绑定编辑器事件。
   *
   * @param cli SVN CLI 适配器。
   * @param output 插件输出通道。
   */
  public constructor(
    private readonly cli: SvnCli,
    private readonly output: vscode.OutputChannel
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const workingCopyWatcher = vscode.workspace.createFileSystemWatcher('**/.svn/wc.db');
    this.disposables.push(
      watcher,
      workingCopyWatcher,
      watcher.onDidCreate((resource) => this.scheduleRefresh(resource)),
      watcher.onDidChange((resource) => this.scheduleRefresh(resource)),
      watcher.onDidDelete((resource) => this.scheduleRefresh(resource)),
      workingCopyWatcher.onDidCreate(() => void this.discover()),
      workingCopyWatcher.onDidDelete(() => void this.discover()),
      vscode.workspace.onDidSaveTextDocument((document) => this.scheduleRefresh(document.uri)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.discover()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => void this.discover()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('yfSvn.path')) {
          void this.discover();
        } else if (event.affectsConfiguration('yfSvn')) {
          this.scheduleRefresh();
        }
      }),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
          this.scheduleRefresh();
        }
      })
    );
  }

  /**
   * 返回当前已注册的全部 SVN 工作副本。
   *
   * @returns SVN Repository 只读列表。
   */
  public get all(): readonly SvnRepositoryOperations[] {
    return [...this.repositories.values()];
  }

  /**
   * SVN 状态刷新完成时触发。
   */
  public readonly onDidChangeStatus = this.statusChangeEmitter.event;

  /**
   * 汇总全部工作副本用于过滤右键菜单的资源集合。
   *
   * @returns 按菜单能力分组并序列化后的资源 URI。
   */
  public getMenuContextResources(): Readonly<Record<SvnMenuCapability, readonly string[]>> {
    const resources = Object.fromEntries(
      SVN_MENU_CAPABILITIES.map((capability) => [capability, new Set<string>()])
    ) as Record<SvnMenuCapability, Set<string>>;
    for (const repository of this.repositories.values()) {
      const repositoryResources = repository.getMenuContextResources();
      for (const capability of SVN_MENU_CAPABILITIES) {
        for (const uri of repositoryResources[capability]) {
          resources[capability].add(uri.toString());
        }
      }
    }
    return Object.fromEntries(
      SVN_MENU_CAPABILITIES.map((capability) => [capability, [...resources[capability]]])
    ) as unknown as Record<SvnMenuCapability, readonly string[]>;
  }

  /**
   * 检查运行环境并发现工作区中的顶层及嵌套 SVN 工作副本。
   */
  public async discover(): Promise<void> {
    if (process.platform !== 'win32') {
      void vscode.window.showErrorMessage('YF SVN 当前只支持 Windows 10 和 Windows 11。');
      this.clearRepositories();
      return;
    }
    if (!vscode.workspace.isTrusted) {
      this.clearRepositories();
      return;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      this.clearRepositories();
      return;
    }

    try {
      const version = await this.cli.ensureSupportedVersion();
      this.output.appendLine(`YF SVN：检测到 SVN CLI ${version}`);
      const candidates = new Set<string>();
      for (const folder of folders) {
        candidates.add(folder.uri.fsPath);
        const nestedRoots = await findNestedWorkingCopyRoots(folder.uri.fsPath);
        for (const nestedRoot of nestedRoots) {
          candidates.add(nestedRoot);
        }
      }

      const roots = new Map<string, vscode.Uri>();
      for (const candidate of candidates) {
        const root = await this.resolveWorkingCopyRoot(candidate);
        if (root) {
          roots.set(this.key(root.fsPath), root);
        }
      }
      this.syncRepositories(roots);
      await this.refreshAll();
    } catch (error) {
      this.clearRepositories();
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[初始化失败] ${message}`);
      const action = await vscode.window.showErrorMessage(message, '打开设置', '显示 SVN 输出');
      if (action === '打开设置') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'yfSvn.path');
      } else if (action === '显示 SVN 输出') {
        this.output.show();
      }
    }
  }

  /**
   * 刷新全部已发现的 SVN 工作副本。
   */
  public async refreshAll(): Promise<void> {
    await Promise.all(
      [...this.repositories.values()].map(async (repository) => {
        try {
          await repository.refresh();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.output.appendLine(`[刷新失败] ${repository.root.fsPath}: ${message}`);
        }
      })
    );
  }

  /**
   * 执行 SVN Checkout，并在完成后让用户选择是否打开目标目录。
   */
  public async checkout(): Promise<void> {
    const url = await vscode.window.showInputBox({
      title: 'SVN Checkout',
      prompt: '输入仓库 URL',
      placeHolder: 'https://example.com/svn/project/trunk',
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : '仓库 URL 不能为空。')
    });
    if (!url) {
      return;
    }
    const selectedFolder = await vscode.window.showOpenDialog({
      title: '选择 Checkout 目标目录',
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: '选择目录'
    });
    const destination = selectedFolder?.[0];
    if (!destination) {
      return;
    }
    const revision =
      (await vscode.window.showInputBox({
        title: 'SVN Checkout',
        prompt: '输入 revision，默认 HEAD',
        value: 'HEAD',
        validateInput: (value) =>
          value === 'HEAD' || /^\d+$/.test(value) ? undefined : '请输入 HEAD 或数字 revision。'
      })) ?? '';
    if (!revision) {
      return;
    }
    const depth = await vscode.window.showQuickPick(
      ['empty', 'files', 'immediates', 'infinity'],
      { title: 'SVN Checkout：选择检出深度' }
    );
    if (!depth) {
      return;
    }
    const args = [
      'checkout',
      '--revision',
      revision,
      '--depth',
      depth,
      url.trim(),
      destination.fsPath
    ];
    if (vscode.workspace.getConfiguration('yfSvn').get<boolean>('ignoreExternals', false)) {
      args.splice(args.length - 2, 0, '--ignore-externals');
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: '正在 Checkout SVN 工作副本',
        cancellable: true
      },
      async (_progress, token) => {
        await this.cli.run(args, { cwd: path.dirname(destination.fsPath), token });
      }
    );
    const action = await vscode.window.showInformationMessage(
      `Checkout 已完成：${destination.fsPath}`,
      '在当前窗口打开',
      '在新窗口打开'
    );
    if (action) {
      await vscode.commands.executeCommand(
        'vscode.openFolder',
        destination,
        action === '在新窗口打开'
      );
    }
  }

  /**
   * 输出当前插件、SVN CLI、配置和工作副本诊断信息。
   */
  public async diagnose(): Promise<void> {
    this.output.show();
    this.output.appendLine('===== YF SVN 诊断 =====');
    this.output.appendLine(`操作系统：${process.platform} ${process.arch} ${os.release()}`);
    this.output.appendLine(`VS Code：${vscode.version}`);
    this.output.appendLine(`工作区信任：${vscode.workspace.isTrusted}`);
    this.output.appendLine(`SVN 路径：${this.cli.executable}`);
    try {
      const version = await this.cli.ensureSupportedVersion();
      this.output.appendLine(`SVN 版本：${version}`);
    } catch (error) {
      this.output.appendLine(`SVN 检查失败：${error instanceof Error ? error.message : String(error)}`);
    }
    this.output.appendLine(`工作副本数量：${this.repositories.size}`);
    for (const repository of this.repositories.values()) {
      this.output.appendLine(`- ${repository.root.fsPath}`);
    }
    const config = vscode.workspace.getConfiguration('yfSvn');
    this.output.appendLine(`自动刷新：${config.get<boolean>('autoRefresh', true)}`);
    this.output.appendLine(`状态深度：${config.get<string>('statusDepth', 'infinity')}`);
    this.output.appendLine(`忽略 Externals：${config.get<boolean>('ignoreExternals', false)}`);
    this.output.appendLine('===== 诊断结束 =====');
  }

  /**
   * 根据资源路径找到所属最深层 SVN 工作副本。
   *
   * @param resource 文件、目录或工作副本 URI。
   * @returns 匹配的 Repository；没有匹配时返回 undefined。
   */
  public findRepository(resource: vscode.Uri): SvnRepository | undefined {
    const target = this.key(resource.fsPath);
    return [...this.repositories.values()]
      .filter((repository) => {
        const root = this.key(repository.root.fsPath);
        return target === root || target.startsWith(`${root}${path.sep}`);
      })
      .sort((left, right) => right.root.fsPath.length - left.root.fsPath.length)[0];
  }

  /**
   * 选择指定资源所属的工作副本；无资源且存在多个工作副本时让用户选择。
   *
   * @param resource 可选的目标资源。
   * @returns 用户选择或路径匹配的 Repository。
   */
  public async pickRepository(resource?: vscode.Uri): Promise<SvnRepository | undefined> {
    if (resource) {
      return this.findRepository(resource);
    }
    const repositories = [...this.repositories.values()];
    if (repositories.length <= 1) {
      return repositories[0];
    }
    const selected = await vscode.window.showQuickPick(
      repositories.map((repository) => ({
        label: path.basename(repository.root.fsPath),
        description: repository.root.fsPath,
        repository
      })),
      { title: '选择 SVN 工作副本' }
    );
    return selected?.repository;
  }

  /**
   * 释放事件监听器、计时器和全部 Repository。
   */
  public dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.clearRepositories();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.statusChangeEmitter.dispose();
  }

  /**
   * 查询候选目录所属的 SVN 工作副本根目录。
   *
   * @param candidate 候选文件夹路径。
   * @returns 工作副本根 URI；不是工作副本时返回 undefined。
   */
  private async resolveWorkingCopyRoot(candidate: string): Promise<vscode.Uri | undefined> {
    const result = await this.cli.run(['info', '--xml', '--', candidate], {
      cwd: candidate,
      allowNonWorkingCopy: true
    });
    if (result.exitCode !== 0) {
      return undefined;
    }
    const info = parseInfoXml(result.stdout);
    return info.workingCopyRoot ? vscode.Uri.file(info.workingCopyRoot) : undefined;
  }

  /**
   * 根据最新发现结果新增或删除 Repository。
   *
   * @param roots 当前有效的工作副本根目录集合。
   */
  private syncRepositories(roots: ReadonlyMap<string, vscode.Uri>): void {
    let changed = false;
    for (const [key, repository] of this.repositories) {
      if (!roots.has(key)) {
        repository.dispose();
        this.repositories.delete(key);
        changed = true;
      }
    }
    for (const [key, root] of roots) {
      if (!this.repositories.has(key)) {
        this.repositories.set(
          key,
          new SvnRepository(this.cli, root, this.output, () => this.statusChangeEmitter.fire())
        );
        changed = true;
      }
    }
    if (changed) {
      // 关键逻辑：工作副本新增或移除后立即清理旧菜单状态，后续刷新再写入最新资源。
      this.statusChangeEmitter.fire();
    }
  }

  /**
   * 清空并释放全部 Repository。
   */
  private clearRepositories(): void {
    const hadRepositories = this.repositories.size > 0;
    for (const repository of this.repositories.values()) {
      repository.dispose();
    }
    this.repositories.clear();
    this.pendingRefreshRepositories.clear();
    if (hadRepositories) {
      this.statusChangeEmitter.fire();
    }
  }

  /**
   * 以 Windows 不区分大小写的规则生成路径键。
   *
   * @param value Windows 文件系统路径。
   * @returns 规范化的小写路径键。
   */
  private key(value: string): string {
    return path.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
  }

  /**
   * 在文件事件频繁发生时合并自动刷新请求。
   */
  private scheduleRefresh(resource?: vscode.Uri): void {
    if (!vscode.workspace.getConfiguration('yfSvn').get<boolean>('autoRefresh', true)) {
      return;
    }
    const repository = resource ? this.findRepository(resource) : undefined;
    if (resource && repository) {
      this.pendingRefreshRepositories.add(repository);
    } else {
      this.refreshAllPending = true;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      const targets = this.refreshAllPending
        ? [...this.repositories.values()]
        : [...this.pendingRefreshRepositories];
      this.refreshAllPending = false;
      this.pendingRefreshRepositories.clear();
      // 关键逻辑：普通文件事件只刷新所属工作副本，避免多仓库工作区反复全量扫描。
      void Promise.all(targets.map((target) => target.refresh())).catch((error: unknown) => {
        this.output.appendLine(
          `[自动刷新失败] ${error instanceof Error ? error.message : String(error)}`
        );
      });
    }, 600);
  }
}

/**
 * 从 VS Code 命令参数中递归提取资源 URI。
 *
 * @param values 命令传入的 URI、SCM ResourceState 或其数组。
 * @returns 去重后的文件 URI。
 */
export function extractResourceUris(values: readonly unknown[]): readonly vscode.Uri[] {
  const result = new Map<string, vscode.Uri>();

  /**
   * 递归读取单个命令参数。
   *
   * @param value 当前待解析的命令参数。
   */
  function visit(value: unknown): void {
    if (value instanceof vscode.Uri) {
      result.set(value.toString(), value);
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        visit(child);
      }
      return;
    }
    if (value && typeof value === 'object' && 'resourceUri' in value) {
      const resourceUri = (value as SvnResourceState).resourceUri;
      if (resourceUri instanceof vscode.Uri) {
        result.set(resourceUri.toString(), resourceUri);
      }
    }
    if (value && typeof value === 'object' && 'resourceStates' in value) {
      // 关键逻辑：SCM 分组命令传入 ResourceGroup，需要展开其中资源以支持整组提交。
      visit((value as { readonly resourceStates?: unknown }).resourceStates);
    }
  }

  for (const value of values) {
    visit(value);
  }
  return [...result.values()];
}
