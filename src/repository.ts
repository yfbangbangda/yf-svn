import * as path from 'node:path';
import * as vscode from 'vscode';
import { containsConflictMarkers, extractConflictVersions, findCommitConflicts } from './conflict';
import { createSvnContentUri } from './contentProvider';
import { RefreshQueue } from './refreshQueue';
import { OperationQueue } from './operationQueue';
import { redactText } from './redact';
import { nextLogRange, SvnLogRange } from './logPagination';
import { runInputSteps, SVN_DEPTH_CHOICES, validateRevision } from './inputSteps';
import { mergePreviews } from './mergePreview';
import { showSvnError } from './errorFeedback';
import { formatBlameAnnotation } from './blamePresentation';
import {
  buildMergeArguments,
  getMergeBlockReason,
  isMergeConflict,
  SvnMergePlan,
  validateMergeRange,
  validateMergeSource
} from './merge';
import { escapeSvnTarget, escapeSvnTargets } from './svnTarget';
import {
  getSvnMenuCapabilities,
  SVN_MENU_CAPABILITIES,
  SvnMenuCapability
} from './menuContext';
import { SvnCli, SvnCommandError } from './svnCli';
import { getStatusColorId, getStatusIconId, getStatusTooltip, isDecoratedStatus } from './statusDecoration';
import {
  SvnBlameLine,
  SvnCommandResult,
  SvnLogEntry,
  SvnRepositoryOperations,
  SvnResourceState,
  SvnStatusEntry
} from './types';
import {
  parseBlameXml,
  parseInfoXml,
  parseLogXml,
  parsePropertyNamesXml,
  parseStatusXml
} from './xml';

/**
 * 管理一个 SVN 工作副本与 VS Code Source Control Provider 之间的映射。
 */
export class SvnRepository implements SvnRepositoryOperations {
  public readonly sourceControl: vscode.SourceControl;
  private readonly changes: vscode.SourceControlResourceGroup;
  private readonly unversioned: vscode.SourceControlResourceGroup;
  private readonly conflicts: vscode.SourceControlResourceGroup;
  private readonly ignored: vscode.SourceControlResourceGroup;
  private readonly externals: vscode.SourceControlResourceGroup;
  private readonly changelistGroups = new Map<string, vscode.SourceControlResourceGroup>();
  private readonly statusByPath = new Map<string, SvnStatusEntry>();
  private readonly refreshQueue = new RefreshQueue();
  private readonly operationQueue = new OperationQueue();
  private readonly blameDecoration = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    before: {
      margin: '0 1em 0 0',
      color: new vscode.ThemeColor('descriptionForeground')
    }
  });
  private blameResource: string | undefined;
  private blameRequest = 0;
  private blameLines: readonly SvnBlameLine[] = [];
  private readonly uiSubscriptions: vscode.Disposable[];
  private lastRefresh: Date | undefined;
  private scannedDepth = 'infinity';
  private refreshFailed = false;
  private disposed = false;

  /**
   * 创建一个 SVN 工作副本实例。
   *
   * @param cli SVN CLI 适配器。
   * @param root 工作副本根目录。
   * @param output 插件输出通道。
   * @param onDidRefresh 状态刷新完成后的通知回调。
   */
  public constructor(
    private readonly cli: SvnCli,
    public readonly root: vscode.Uri,
    private readonly output: vscode.OutputChannel,
    private readonly onDidRefresh: () => void
  ) {
    this.sourceControl = vscode.scm.createSourceControl('yfSvn', 'SVN', root);
    this.sourceControl.inputBox.placeholder = '提交说明（Ctrl+Enter 提交）';
    this.sourceControl.acceptInputCommand = {
      command: 'yfSvn.commitAll',
      title: '全部提交',
      arguments: [root]
    };
    this.sourceControl.quickDiffProvider = {
      provideOriginalResource: (resource) => this.provideOriginalResource(resource)
    };
    this.changes = this.sourceControl.createResourceGroup('changes', '更改');
    this.unversioned = this.sourceControl.createResourceGroup('unversioned', '未版本控制');
    this.conflicts = this.sourceControl.createResourceGroup('conflicts', '冲突');
    this.ignored = this.sourceControl.createResourceGroup('ignored', '已忽略');
    this.externals = this.sourceControl.createResourceGroup('externals', 'Externals');
    this.ignored.hideWhenEmpty = true;
    this.externals.hideWhenEmpty = true;
    this.unversioned.hideWhenEmpty = true;
    this.conflicts.hideWhenEmpty = true;
    this.uiSubscriptions = [
      vscode.window.onDidChangeVisibleTextEditors(() => this.renderBlame()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        // 关键逻辑：文件内容变化后撤下旧追溯，避免把原 revision 错配到新内容。
        if (event.contentChanges.length > 0 && event.document.uri.toString() === this.blameResource) {
          this.blameResource = undefined;
          this.blameLines = [];
          this.renderBlame();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('yfSvn.blameStyle', this.root)) { this.renderBlame(); }
      })
    ];
    this.updateStatusBar();
  }

  /**
   * 刷新当前工作副本状态并更新 Source Control 分组。
   */
  public async refresh(): Promise<void> {
    return this.refreshQueue.run(async () => {
      try {
        await this.refreshCore();
        this.refreshFailed = false;
        this.lastRefresh = new Date();
        this.updateStatusBar();
        this.onDidRefresh();
      } catch (error) {
        const message = redactText(error instanceof Error ? error.message : String(error));
        this.output.appendLine(`[刷新失败] ${this.root.fsPath}: ${message}`);
        this.updateStatusBar(message);
        // 关键逻辑：一次连续失败只提示一次，保留上次状态，恢复成功后允许再次提示。
        if (!this.refreshFailed) {
          this.refreshFailed = true;
          void vscode.window.showWarningMessage(
            `SVN 状态刷新失败，当前显示的状态可能已过期：${this.root.fsPath}\n${message}`,
            '重试刷新',
            '显示 SVN 输出'
          ).then((action) => {
            if (this.disposed) {
              return;
            }
            if (action === '重试刷新') {
              this.refreshFailed = false;
              void this.refresh().catch(() => {});
            } else if (action === '显示 SVN 输出') {
              this.output.show();
            }
          });
        }
        throw error;
      }
    });
  }

  /**
   * 查询资源当前的 SVN 状态。
   *
   * @param resource 文件或目录 URI。
   * @returns 已扫描到的 SVN 状态；正常或不属于工作副本时返回 undefined。
   */
  public getStatus(resource: vscode.Uri): SvnStatusEntry | undefined {
    const status = this.statusByPath.get(path.normalize(resource.fsPath).toLowerCase());
    return status && isDecoratedStatus(status) ? status : undefined;
  }

  /**
   * 返回当前工作副本用于过滤右键菜单的资源集合。
   *
   * @returns 按菜单能力分组的资源 URI。
   */
  public getMenuContextResources(): Readonly<Record<SvnMenuCapability, readonly vscode.Uri[]>> {
    const resources = Object.fromEntries(
      SVN_MENU_CAPABILITIES.map((capability) => [capability, new Map<string, vscode.Uri>()])
    ) as Record<SvnMenuCapability, Map<string, vscode.Uri>>;

    for (const entry of this.statusByPath.values()) {
      const uri = vscode.Uri.file(entry.absolutePath);
      for (const capability of getSvnMenuCapabilities(entry)) {
        resources[capability].set(uri.toString(), uri);
      }
    }

    // 关键逻辑：目录提交和还原取决于其后代状态，因此把后代能力向已版本控制的父目录传播。
    for (const capability of ['committable', 'revertible'] as const) {
      for (const uri of [...resources[capability].values()]) {
        let parent = path.dirname(uri.fsPath);
        while (this.statusByPath.has(path.normalize(parent).toLowerCase())) {
          const parentUri = vscode.Uri.file(parent);
          resources[capability].set(parentUri.toString(), parentUri);
          if (
            path.normalize(parent).toLowerCase() ===
            path.normalize(this.root.fsPath).toLowerCase()
          ) {
            break;
          }
          parent = path.dirname(parent);
        }
      }
    }

    return Object.fromEntries(
      SVN_MENU_CAPABILITIES.map((capability) => [capability, [...resources[capability].values()]])
    ) as unknown as Record<SvnMenuCapability, readonly vscode.Uri[]>;
  }

  /**
   * 提交选中资源；未传资源时提交当前 Source Control 中的全部可提交更改。
   *
  * @param resources 要提交的文件或目录。
  */
  public async commit(resources?: readonly vscode.Uri[]): Promise<void> {
    let targets = resources?.length
      ? resources
      : [
          ...this.changes.resourceStates,
          ...this.conflicts.resourceStates,
          ...[...this.changelistGroups.values()].flatMap((group) => group.resourceStates)
        ].map((state) => state.resourceUri);
    if (targets.length === 0) {
      void vscode.window.showInformationMessage('当前没有可提交的 SVN 更改。');
      return;
    }

    if (targets.length > 1) {
      // 关键逻辑：多目标提交必须由用户勾选本次范围，避免误提交无关文件。
      const selected = await vscode.window.showQuickPick(
        targets.map((resource) => {
          const relative = path.relative(this.root.fsPath, resource.fsPath) || '.';
          const status = this.statusByPath.get(path.normalize(resource.fsPath).toLowerCase());
          return {
            label: relative,
            description: status ? getStatusTooltip(status) : '状态未知',
            picked: Boolean(resources?.length),
            resource
          };
        }),
        {
          title: '选择要提交的 SVN 文件',
          placeHolder: '勾选本次需要提交的文件',
          canPickMany: true,
          matchOnDescription: true
        }
      );
      if (!selected) {
        return;
      }
      targets = selected.map((item) => item.resource);
      if (targets.length === 0) {
        void vscode.window.showWarningMessage('请至少选择一个需要提交的文件。');
        return;
      }
    }

    const conflicts = findCommitConflicts([...this.statusByPath.values()], targets.map((target) => target.fsPath));
    if (conflicts.length > 0) {
      const action = await vscode.window.showWarningMessage(
        `所选提交范围包含未解决冲突：\n${conflicts.slice(0, 10).map((entry) => path.relative(this.root.fsPath, entry.absolutePath)).join('\n')}`,
        '查看冲突'
      );
      if (action === '查看冲突') {
        await this.openConflict(vscode.Uri.file(conflicts[0]!.absolutePath));
      }
      return;
    }
    let message = this.sourceControl.inputBox.value.trim();
    if (!message) {
      message =
        (
          await vscode.window.showInputBox({
            title: 'SVN 提交',
            prompt: '请输入提交说明',
            ignoreFocusOut: true,
            validateInput: (value) => (value.trim() ? undefined : '提交说明不能为空。')
          })
        )?.trim() ?? '';
    }
    if (!message) {
      return;
    }
    this.sourceControl.inputBox.value = message;

    const confirmation = await vscode.window.showInformationMessage(
      `确认向 ${this.root.fsPath} 提交 ${targets.length} 个目标？`,
      {
        modal: true,
        detail: [
          `提交说明：${message}`,
          '',
          ...targets.map((resource) => {
            const relative = path.relative(this.root.fsPath, resource.fsPath) || '.';
            const status = this.statusByPath.get(path.normalize(resource.fsPath).toLowerCase());
            return `${status ? getStatusTooltip(status) : '状态未知'}  ${relative}`;
          })
        ].join('\n')
      },
      '提交'
    );
    if (confirmation !== '提交') {
      return;
    }
    await this.runOperation('正在提交 SVN 更改', async (token) => {
      // 关键逻辑：排队期间可能新增冲突，真正执行提交前完整检查所选范围。
      if (findCommitConflicts(await this.readMergeStatus(token), targets.map((target) => target.fsPath)).length > 0) {
        throw new Error('svn: E155015: 所选提交范围存在未解决冲突，请先处理后提交。');
      }
      await this.cli.run(
        [
          'commit',
          '--message',
          message,
          // 关键逻辑：允许提交说明与现有文件路径同名，避免 SVN 误判为应使用 -F。
          '--force-log',
          '--',
          ...escapeSvnTargets(targets.map((resource) => resource.fsPath))
        ],
        { cwd: this.root.fsPath, token }
      );
      if (this.sourceControl.inputBox.value.trim() === message) {
        this.sourceControl.inputBox.value = '';
      }
    });
  }

  /**
   * 将当前工作副本或指定资源更新到 HEAD 或指定 revision。
   *
   * @param resource 可选的文件或目录目标；省略时更新整个工作副本。
   * @param advanced 是否使用多步输入选择 revision 和深度。
   */
  public async update(resource?: vscode.Uri, advanced = false): Promise<void> {
    const target = resource ?? this.root;
    let revision = 'HEAD';
    let depth = 'working';
    if (advanced) {
      const values = await runInputSteps('SVN 高级更新', [
        { key: 'revision', prompt: '选择目标 revision', placeholder: 'HEAD 或数字 revision', value: revision, validate: validateRevision },
        { key: 'depth', prompt: '选择更新深度', placeholder: '选择更新范围，默认保持当前深度', value: depth, items: SVN_DEPTH_CHOICES }
      ]);
      if (!values) {
        return;
      }
      revision = values.revision!.trim();
      depth = values.depth!;
    }
    const args = ['update', '--revision', revision];
    // 关键逻辑：working 仅为界面内部选项；SVN CLI 必须省略 --depth 才会沿用各目录已有的深度。
    if (depth !== 'working') {
      args.push('--depth', depth);
    }
    if (vscode.workspace.getConfiguration('yfSvn').get<boolean>('ignoreExternals', false)) {
      args.push('--ignore-externals');
    }
    args.push('--', escapeSvnTarget(target.fsPath));
    const relativeTarget = path.relative(this.root.fsPath, target.fsPath) || '整个工作副本';
    const confirmation = await vscode.window.showInformationMessage(
      `确认将 ${relativeTarget} 更新到 ${revision}？`,
      {
        modal: true,
        detail: [
          `工作副本：${this.root.fsPath}`,
          `更新目标：${target.fsPath}`,
          `深度：${SVN_DEPTH_CHOICES.find((item) => item.value === depth)?.label ?? depth}${depth === 'working' ? '' : `（${depth}）`}`,
          `忽略 Externals：${args.includes('--ignore-externals') ? '是' : '否'}`
        ].join('\n')
      },
      '更新'
    );
    if (confirmation !== '更新') {
      return;
    }
    const succeeded = await this.runOperation('正在更新 SVN 工作副本', async (token) => {
      await this.cli.run(args, { cwd: this.root.fsPath, token });
      return true;
    });
    if (succeeded) {
      void vscode.window.showInformationMessage(`SVN 更新成功：${relativeTarget}`);
    }
  }

  /**
   * 从当前工作副本 URL 创建远程分支或标签。
   */
  public async branchOrTag(): Promise<void> {
    const infoResult = await this.cli.run(
      ['info', '--xml', '--', escapeSvnTarget(this.root.fsPath)],
      {
      cwd: this.root.fsPath,
      logStdout: false
    });
    const info = parseInfoXml(infoResult.stdout);
    const values = await runInputSteps('SVN 创建分支或标签', [
      { key: 'kind', prompt: '选择创建类型', placeholder: '选择分支或标签', value: 'branches', items: [
        { label: '分支', value: 'branches' }, { label: '标签', value: 'tags' }
      ] },
      {
        key: 'destination', prompt: '输入包含分支或标签名称的完整目标 URL', placeholder: 'https://example.com/svn/project/branches/feature',
        value: (draft) => /\/trunk(?:\/.*)?$/.test(info.url)
          ? info.url.replace(/\/trunk(?:\/.*)?$/, `/${draft.kind}/`)
          : `${info.repositoryRoot.replace(/\/$/, '')}/${draft.kind}/`,
        validate: (value) => validateMergeSource(value) ?? (value.trim().endsWith('/') ? '请输入包含名称的完整目标 URL。' : value.trim() === info.url ? '目标 URL 不能与当前 URL 相同。' : undefined)
      },
      { key: 'revision', prompt: '输入来源 revision', placeholder: 'HEAD 或数字 revision', value: 'HEAD', validate: validateRevision },
      { key: 'message', prompt: '输入提交说明', placeholder: '说明本次创建用途',
        value: (draft) => `创建${draft.kind === 'tags' ? '标签' : '分支'}：${draft.destination?.trim().split('/').at(-1) ?? ''}`,
        validate: (value) => value.trim() ? undefined : '提交说明不能为空。' }
    ]);
    if (!values) {
      return;
    }
    const kind = { label: values.kind === 'tags' ? '标签' : '分支' };
    const destinationUrl = values.destination!.trim();
    const revision = values.revision!.trim();
    const message = values.message!.trim();
    const confirmation = await vscode.window.showInformationMessage(
      `确认创建 SVN ${kind.label}？`,
      {
        modal: true,
        detail: [
          `来源：${info.url}@${revision}`,
          `目标：${destinationUrl.trim()}`,
          `提交说明：${message.trim()}`
        ].join('\n')
      },
      '创建'
    );
    if (confirmation !== '创建') {
      return;
    }
    const succeeded = await this.runOperation(`正在创建 SVN ${kind.label}`, async (token) => {
      await this.cli.run(
        [
          'copy',
          '--revision',
          revision,
          '--parents',
          '--message',
          message.trim(),
          '--force-log',
          '--',
          `${info.url}@${revision}`,
          destinationUrl.trim()
        ],
        { cwd: this.root.fsPath, token }
      );
      return true;
    });
    if (succeeded) {
      void vscode.window.showInformationMessage(`SVN ${kind.label}创建成功。`);
    }
  }

  /**
   * 将当前工作副本切换到同一仓库中的其他 URL。
   */
  public async switchBranch(): Promise<void> {
    const infoResult = await this.cli.run(
      ['info', '--xml', '--', escapeSvnTarget(this.root.fsPath)],
      {
      cwd: this.root.fsPath,
      logStdout: false
    });
    const info = parseInfoXml(infoResult.stdout);
    const values = await runInputSteps('SVN 切换分支或标签', [
      { key: 'destination', prompt: '输入同一仓库中的目标 URL', placeholder: '完整的分支或标签 URL', value: info.url,
        validate: (value) => validateMergeSource(value) ?? (value.trim() === info.url ? '请选择其他目标 URL。' : undefined) },
      { key: 'revision', prompt: '输入目标 revision', placeholder: 'HEAD 或数字 revision', value: 'HEAD', validate: validateRevision },
      { key: 'depth', prompt: '选择切换深度', placeholder: '选择需要切换的目录范围', value: 'infinity', items: SVN_DEPTH_CHOICES.filter((item) => item.value !== 'working') }
    ]);
    if (!values) {
      return;
    }
    const destinationUrl = values.destination!.trim();
    const revision = values.revision!.trim();
    const depth = values.depth!;
    const args = ['switch', '--revision', revision, '--depth', depth];
    if (vscode.workspace.getConfiguration('yfSvn').get<boolean>('ignoreExternals', false)) {
      args.push('--ignore-externals');
    }
    args.push('--', destinationUrl.trim(), escapeSvnTarget(this.root.fsPath));
    const confirmation = await vscode.window.showWarningMessage(
      '确认切换当前 SVN 工作副本？',
      {
        modal: true,
        detail: [
          `当前 URL：${info.url}`,
          `目标 URL：${destinationUrl.trim()}`,
          `Revision：${revision}`,
          `深度：${depth}`
        ].join('\n')
      },
      '切换'
    );
    if (confirmation !== '切换') {
      return;
    }
    const succeeded = await this.runOperation('正在切换 SVN 工作副本', async (token) => {
      await this.cli.run(args, { cwd: this.root.fsPath, token });
      return true;
    });
    if (succeeded) {
      void vscode.window.showInformationMessage(`SVN Switch 成功：${destinationUrl.trim()}`);
    }
  }

  /** 先预演，再由用户确认将来源分支的变更合并到当前工作副本。 */
  public async merge(): Promise<void> {
    const source = await this.selectMergeSource();
    if (!source) {
      return;
    }
    const range = await vscode.window.showInputBox({
      title: 'SVN 合并：选择 revision 范围',
      prompt: `留空合并全部可合并变更；N:M 表示合并 r(N+1) 至 rM，来源快照为 r${source.sourceRevision}`,
      placeHolder: '例如 10:15；留空表示全部可合并变更',
      ignoreFocusOut: true,
      validateInput: (value) => validateMergeRange(value, source.sourceRevision)
    });
    if (range === undefined) {
      return;
    }
    const plan: SvnMergePlan = { ...source, revisionRange: range.trim() || undefined };
    const preview = await this.performMerge(plan, true);
    if (!preview) {
      return;
    }
    const uri = mergePreviews.create(this.root, plan, [
      'SVN 合并预演（未修改工作文件）',
      this.mergePlanDetail(plan),
      '',
      '以下为 SVN 预演输出；实际合并前会再次检查工作副本。',
      preview.stdout || 'SVN 未报告待合并的文件变更。',
      preview.stderr
    ].join('\n'));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    const next = await vscode.window.showInformationMessage(
      'SVN 合并预演已完成，请检查预演结果。',
      '执行合并'
    );
    if (next === '执行合并') {
      await this.continueMerge(uri);
    }
  }

  /**
   * 从只读预演继续合并；确认前占用预演，避免重复点击同时执行。
   * @param uri 已完成预演的文档 URI。
   */
  public async continueMerge(uri: vscode.Uri): Promise<void> {
    const preview = mergePreviews.get(uri);
    if (this.disposed || !preview || preview.root.toString() !== this.root.toString() || preview.state !== 'ready') {
      void vscode.window.showWarningMessage('此合并预演不可继续，请查看执行状态或重新运行“SVN: 合并”。');
      return;
    }
    mergePreviews.setState(uri, 'running');
    const plan = preview.plan;
    try {
      const confirmation = await vscode.window.showWarningMessage(
        '确认将以下来源的变更合并到当前 SVN 工作副本？',
        {
          modal: true,
          detail: `${this.mergePlanDetail(plan)}\n\n合并结果保留为本地修改，请检查后自行提交。`
        },
        '合并'
      );
      if (confirmation !== '合并') {
        mergePreviews.setState(uri, 'ready');
        return;
      }
      const result = await this.performMerge(plan, false);
      // 关键逻辑：失败或取消也可能已修改部分文件，此预演必须失效，不能重复使用。
      mergePreviews.setState(uri, result ? 'applied' : 'invalid');
      if (result?.conflicts) {
        const depth = vscode.workspace.getConfiguration('yfSvn').get<string>('statusDepth', 'infinity');
        void vscode.window.showWarningMessage(depth === 'infinity'
          ? 'SVN 合并产生冲突，请在源代码管理的“冲突”分组中处理，解决后再提交。'
          : 'SVN 合并产生冲突，请将 yfSvn.statusDepth 设置为 infinity 并刷新，以查看完整冲突列表，解决后再提交。');
      } else if (result) {
        void vscode.window.showInformationMessage('SVN 合并完成，结果尚未提交。请检查差异后提交。');
      }
    } finally {
      if (mergePreviews.get(uri)?.state === 'running') {
        mergePreviews.setState(uri, 'invalid');
      }
    }
  }

  /** 查看所选来源相对当前工作副本已合并及尚未合并的 revision。 */
  public async showMergeinfo(): Promise<void> {
    const plan = await this.selectMergeSource();
    if (!plan) {
      return;
    }
    const content = await this.runOperation('正在读取 SVN Mergeinfo', (token) => this.operationQueue.run(async () => {
      await this.verifyMergeTarget(plan, token);
      const sections = ['SVN Mergeinfo', this.mergePlanDetail(plan)];
      for (const [mode, title] of [['merged', '已合并 revision'], ['eligible', '尚未合并 revision']] as const) {
        const result = await this.cli.run(
          ['mergeinfo', '--show-revs', mode, '--depth', 'infinity', '--',
            `${plan.sourceUrl}@${plan.sourceRevision}`, escapeSvnTarget(this.root.fsPath)],
          { cwd: this.root.fsPath, token, logStdout: false }
        );
        sections.push('', title, result.stdout.trim() || '（无）');
      }
      sections.push('', '带 * 的 revision 表示仅在部分子路径上合并。');
      return redactText(sections.join('\n'));
    }), false);
    if (content !== undefined) {
      const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content });
      await vscode.window.showTextDocument(document, { preview: false });
    }
  }

  /**
   * 选择同一仓库中的来源分支，并固定来源 HEAD，供预演和实际合并共用。
   *
   * @returns 合并来源及目标快照；取消或读取失败时返回 undefined。
   */
  private async selectMergeSource(): Promise<SvnMergePlan | undefined> {
    const target = await this.runOperation('正在读取 SVN 合并目标', async (token) => {
      const result = await this.cli.run(
        ['info', '--xml', '--', escapeSvnTarget(this.root.fsPath)],
        { cwd: this.root.fsPath, token, logStdout: false }
      );
      return parseInfoXml(result.stdout);
    }, false);
    if (!target) {
      return undefined;
    }
    const sourceUrl = await vscode.window.showInputBox({
      title: 'SVN 合并：选择来源 URL',
      prompt: '输入同一仓库中的完整来源分支 URL（不附加 @REV）',
      value: target.url,
      ignoreFocusOut: true,
      validateInput: validateMergeSource
    });
    if (!sourceUrl) {
      return undefined;
    }
    return this.runOperation('正在读取 SVN 合并来源', async (token) => {
      const result = await this.cli.run(
        ['info', '--xml', '--revision', 'HEAD', '--', `${sourceUrl.trim()}@HEAD`],
        { cwd: this.root.fsPath, token, logStdout: false }
      );
      const source = parseInfoXml(result.stdout);
      if (!source.repositoryUuid || source.repositoryUuid !== target.repositoryUuid) {
        throw new Error('合并来源与目标必须属于同一个 SVN 仓库。');
      }
      if (source.url === target.url) {
        throw new Error('来源分支与目标分支相同，请选择其他来源 URL。');
      }
      return {
        sourceUrl: source.url,
        sourceRevision: source.revision,
        targetUrl: target.url,
        targetRevision: target.revision,
        repositoryUuid: target.repositoryUuid
      };
    }, false);
  }

  /**
   * 格式化来源、目标和范围，保证预演与确认界面展示相同的合并方向。
   *
   * @param plan 本次合并的来源及目标快照。
   * @returns 已脱敏的合并说明。
   */
  private mergePlanDetail(plan: SvnMergePlan): string {
    return redactText([
      `来源：${plan.sourceUrl}@${plan.sourceRevision}`,
      `目标 URL：${plan.targetUrl}`,
      `目标工作副本：${this.root.fsPath}（r${plan.targetRevision}）`,
      `范围：${plan.revisionRange ?? '全部可合并变更'}`
    ].join('\n'));
  }

  /**
   * 读取完整目标状态，避免较浅的界面扫描深度遗漏修改和冲突。
   *
   * @param token 当前合并操作的取消令牌。
   * @returns 排除外部工作副本的递归 SVN 状态。
   */
  private async readMergeStatus(token: vscode.CancellationToken): Promise<readonly SvnStatusEntry[]> {
    const result = await this.cli.run(
      ['status', '--xml', '--ignore-externals', '--depth', 'infinity', '--', escapeSvnTarget(this.root.fsPath)],
      { cwd: this.root.fsPath, token, logStdout: false }
    );
    return parseStatusXml(result.stdout, this.root.fsPath);
  }

  /**
   * 校验排队后的目标仍与用户选择时一致，防止切换或更新后使用旧的合并说明。
   *
   * @param plan 用户选择时固定的目标信息。
   * @param token 当前查询或合并的取消令牌。
   */
  private async verifyMergeTarget(plan: SvnMergePlan, token: vscode.CancellationToken): Promise<void> {
    const target = parseInfoXml((await this.cli.run(
      ['info', '--xml', '--', escapeSvnTarget(this.root.fsPath)],
      { cwd: this.root.fsPath, token, logStdout: false }
    )).stdout);
    if (target.url !== plan.targetUrl || target.repositoryUuid !== plan.repositoryUuid || target.revision !== plan.targetRevision) {
      throw new Error('目标工作副本的 URL 或 revision 已变化，请重新选择来源并预演合并。');
    }
  }

  /**
   * 在工作副本操作队列中重新校验目标后执行预演或实际合并。
   *
   * @param plan 已固定的合并来源、目标及 revision 范围。
   * @param dryRun 是否仅执行预演。
   * @returns SVN 输出和冲突状态（读取失败时未知）；合并命令失败或取消时返回 undefined。
   */
  private async performMerge(
    plan: SvnMergePlan,
    dryRun: boolean
  ): Promise<(SvnCommandResult & { readonly conflicts: boolean | undefined }) | undefined> {
    return this.runOperation(dryRun ? '正在预演 SVN 合并' : '正在合并 SVN 变更', async (token) => {
      // 关键逻辑：检查必须在队列出队后执行，避免先前排队的写操作使确认信息失效。
      await this.verifyMergeTarget(plan, token);
      const dirty = vscode.workspace.textDocuments.some((document) => {
        const relative = path.relative(this.root.fsPath, document.uri.fsPath);
        return document.uri.scheme === 'file' && document.isDirty &&
          !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
      });
      if (dirty) {
        throw new Error('工作副本存在尚未保存的编辑器内容，请先处理后重新合并。');
      }
      const reason = getMergeBlockReason(await this.readMergeStatus(token));
      if (reason) {
        throw new Error(reason);
      }
      // 关键逻辑：预演也占用同一队列；保留冲突供现有合并编辑器处理，不自动接受某一侧。
      const result = await this.cli.run(buildMergeArguments(plan, dryRun), { cwd: this.root.fsPath, token });
      let conflicts: boolean | undefined = false;
      if (!dryRun) {
        try {
          conflicts = (await this.readMergeStatus(token)).some(isMergeConflict);
        } catch (error) {
          // 关键逻辑：合并已完成，后续状态读取失败不能把实际合并结果误报为失败。
          conflicts = undefined;
          const message = redactText(error instanceof Error ? error.message : String(error));
          this.output.appendLine(`[合并状态检查失败] ${message}`);
          void vscode.window.showWarningMessage('SVN 合并命令已完成，但冲突状态读取失败，请手动刷新并检查冲突后提交。');
        }
      }
      return { ...result, conflicts };
    });
  }

  /**
   * 将未版本控制的资源加入 SVN。
   *
   * @param resources 要加入版本控制的文件或目录。
   */
  public async add(resources: readonly vscode.Uri[]): Promise<void> {
    if (resources.length === 0) {
      return;
    }
    await this.runOperation('正在添加 SVN 资源', (token) =>
      this.cli.run(
        ['add', '--parents', '--', ...escapeSvnTargets(resources.map((resource) => resource.fsPath))],
        {
        cwd: this.root.fsPath,
        token
      })
    );
  }

  /**
   * 将资源标记为 SVN 删除。
   *
   * @param resources 要删除的文件或目录。
   */
  public async remove(resources: readonly vscode.Uri[]): Promise<void> {
    if (resources.length === 0) {
      return;
    }
    const confirmation = await vscode.window.showWarningMessage(
      `将删除 ${resources.length} 个目标，并把删除操作加入 SVN，是否继续？`,
      { modal: true, detail: resources.map((resource) => resource.fsPath).join('\n') },
      '删除'
    );
    if (confirmation !== '删除') {
      return;
    }
    await this.runOperation('正在删除 SVN 资源', async (token) => {
      // 关键逻辑：排队结束后再读取状态，避免使用前一项操作执行前的资源分类。
      const unversioned = resources.filter((resource) => this.isUnversioned(resource));
      const versioned = resources.filter((resource) => !this.isUnversioned(resource));
      if (versioned.length > 0) {
        await this.cli.run(
          ['delete', '--force', '--', ...escapeSvnTargets(versioned.map((resource) => resource.fsPath))],
          {
            cwd: this.root.fsPath,
            token
          }
        );
      }
      // 关键逻辑：未版本控制文件不属于 SVN，使用系统回收站保证仍可恢复。
      for (const resource of unversioned) {
        if (token.isCancellationRequested) {
          throw new vscode.CancellationError();
        }
        await vscode.workspace.fs.delete(resource, {
          recursive: true,
          useTrash: true
        });
      }
    });
  }

  /**
   * 放弃资源的本地 SVN 更改。
   *
   * @param resources 要还原的文件或目录。
   */
  public async revert(resources: readonly vscode.Uri[]): Promise<void> {
    if (resources.length === 0) {
      return;
    }
    const confirmation = await vscode.window.showWarningMessage(
      `还原会丢弃 ${resources.length} 个目标的本地更改，是否继续？`,
      { modal: true, detail: resources.map((resource) => resource.fsPath).join('\n') },
      '还原'
    );
    if (confirmation !== '还原') {
      return;
    }
    await this.runOperation('正在还原 SVN 更改', (token) =>
      this.cli.run(
        ['revert', '--depth', 'infinity', '--', ...escapeSvnTargets(resources.map((resource) => resource.fsPath))],
        { cwd: this.root.fsPath, token }
      )
    );
  }

  /**
   * 使用 SVN Move 移动或重命名单个资源。
   *
   * @param resource 要移动的文件或目录。
   */
  public async rename(resource: vscode.Uri): Promise<void> {
    const relative = path.relative(this.root.fsPath, resource.fsPath);
    const destination = await vscode.window.showInputBox({
      title: 'SVN 移动/重命名',
      prompt: '输入相对于工作副本根目录的新路径',
      value: relative,
      ignoreFocusOut: true,
      validateInput: (value) => {
        const resolved = path.resolve(this.root.fsPath, value);
        return resolved.startsWith(`${this.root.fsPath}${path.sep}`)
          ? undefined
          : '目标必须位于当前工作副本内。';
      }
    });
    if (!destination || destination === relative) {
      return;
    }
    const destinationPath = path.resolve(this.root.fsPath, destination);
    await this.runOperation('正在移动 SVN 资源', async (token) => {
      if (this.isUnversioned(resource)) {
        await vscode.workspace.fs.rename(resource, vscode.Uri.file(destinationPath));
        return;
      }
      await this.cli.run(
        ['move', '--parents', '--', escapeSvnTarget(resource.fsPath), escapeSvnTarget(destinationPath)],
        {
        cwd: this.root.fsPath,
        token
      });
    });
  }

  /**
   * 把资源名称追加到父目录的 svn:ignore 属性。
   *
   * @param resources 要忽略的未版本控制资源。
   */
  public async ignore(resources: readonly vscode.Uri[]): Promise<void> {
    const property = await vscode.window.showQuickPick(
      [
        {
          label: '仅当前目录',
          description: '写入 svn:ignore',
          property: 'svn:ignore'
        },
        {
          label: '当前目录及子目录',
          description: '写入 SVN 1.8+ 支持的 svn:global-ignores',
          property: 'svn:global-ignores'
        }
      ],
      { title: 'SVN 忽略范围', placeHolder: '选择忽略规则的作用范围' }
    );
    if (!property) {
      return;
    }
    const grouped = new Map<string, Set<string>>();
    for (const resource of resources) {
      const parent = path.dirname(resource.fsPath);
      const names = grouped.get(parent) ?? new Set<string>();
      names.add(path.basename(resource.fsPath));
      grouped.set(parent, names);
    }
    await this.runOperation(`正在更新 ${property.property}`, async (token) => {
      for (const [parent, names] of grouped) {
        let currentValue = '';
        try {
          const existing = await this.cli.run(
            ['propget', property.property, '--', escapeSvnTarget(parent)],
            {
            cwd: this.root.fsPath,
            token
          });
          currentValue = existing.stdout;
        } catch (error) {
          // 关键逻辑：父目录尚未设置目标忽略属性时，propget 返回错误但这是正常初始化场景。
          if (
            !(error instanceof SvnCommandError) ||
            !/W200017|E200000|property .* not found|属性.*不存在/i.test(error.result.stderr)
          ) {
            throw error;
          }
        }
        const lines = new Set(
          currentValue
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
        );
        for (const name of names) {
          lines.add(name);
        }
        await this.cli.run(
          [
            'propset',
            property.property,
            [...lines].join('\n'),
            '--',
            escapeSvnTarget(parent)
          ],
          {
          cwd: this.root.fsPath,
          token
        });
      }
    });
  }

  /**
   * 锁定选中的 SVN 文件。
   *
   * @param resources 要锁定的文件。
   * @param force 是否直接使用强制锁定；省略时保留方式选择。
   */
  public async lock(resources: readonly vscode.Uri[], force = false): Promise<void> {
    if (resources.length === 0) {
      return;
    }
    const mode = force ? { force: true } : await vscode.window.showQuickPick(
      [
        { label: '普通锁定', description: '已有锁时停止操作', force: false },
        { label: '强制锁定', description: '夺取其他工作副本持有的锁', force: true }
      ],
      { title: 'SVN Lock：选择锁定方式' }
    );
    if (!mode) {
      return;
    }
    const comment = await vscode.window.showInputBox({
      title: 'SVN Lock',
      prompt: '输入锁定说明；可以留空',
      ignoreFocusOut: true
    });
    if (comment === undefined) {
      return;
    }
    const confirmation = await vscode.window.showWarningMessage(
      `确认${mode.force ? '强制' : ''}锁定 ${resources.length} 个 SVN 文件？`,
      { modal: true, detail: resources.map((resource) => resource.fsPath).join('\n') },
      '锁定'
    );
    if (confirmation !== '锁定') {
      return;
    }
    const args = ['lock'];
    if (mode.force) {
      args.push('--force');
    }
    if (comment.trim()) {
      args.push('--message', comment.trim(), '--force-log');
    }
    args.push('--', ...escapeSvnTargets(resources.map((resource) => resource.fsPath)));
    await this.runOperation('正在锁定 SVN 文件', (token) =>
      this.cli.run(args, { cwd: this.root.fsPath, token })
    );
  }

  /**
   * 解锁选中的 SVN 文件。
   *
   * @param resources 要解锁的文件。
   * @param force 是否直接使用强制解锁；省略时保留方式选择。
   */
  public async unlock(resources: readonly vscode.Uri[], force = false): Promise<void> {
    if (resources.length === 0) {
      return;
    }
    const mode = force ? { force: true } : await vscode.window.showQuickPick(
      [
        { label: '普通解锁', description: '仅释放当前工作副本持有的锁', force: false },
        { label: '强制解锁', description: '释放其他用户或工作副本持有的锁', force: true }
      ],
      { title: 'SVN Unlock：选择解锁方式' }
    );
    if (!mode) {
      return;
    }
    const confirmation = await vscode.window.showWarningMessage(
      `确认${mode.force ? '强制' : ''}解锁 ${resources.length} 个 SVN 文件？`,
      { modal: true, detail: resources.map((resource) => resource.fsPath).join('\n') },
      '解锁'
    );
    if (confirmation !== '解锁') {
      return;
    }
    const args = ['unlock'];
    if (mode.force) {
      args.push('--force');
    }
    args.push('--', ...escapeSvnTargets(resources.map((resource) => resource.fsPath)));
    await this.runOperation('正在解锁 SVN 文件', (token) =>
      this.cli.run(args, { cwd: this.root.fsPath, token })
    );
  }

  /**
   * 查看、新建、编辑或删除单个资源的 SVN 属性。
   *
   * @param resource 要管理属性的文件或目录。
   */
  public async manageProperty(resource: vscode.Uri): Promise<void> {
    const propertyResult = await this.cli.run(
      ['proplist', '--xml', '--', escapeSvnTarget(resource.fsPath)],
      {
      cwd: this.root.fsPath,
      logStdout: false
    });
    const propertyNames = parsePropertyNamesXml(propertyResult.stdout);
    const selected = await vscode.window.showQuickPick(
      [
        ...propertyNames.map((name) => ({ label: name, name, create: false })),
        { label: '$(add) 新建属性…', name: '', create: true }
      ],
      { title: `SVN 属性：${path.basename(resource.fsPath)}` }
    );
    if (!selected) {
      return;
    }
    const propertyName = selected.create
      ? await vscode.window.showInputBox({
          title: '新建 SVN 属性',
          prompt: '输入属性名称，例如 svn:keywords',
          validateInput: (value) =>
            value.trim() && !/\s/.test(value) ? undefined : '属性名称不能为空且不能包含空白。'
        })
      : selected.name;
    if (!propertyName) {
      return;
    }

    let currentValue = '';
    if (!selected.create) {
      const action = await vscode.window.showQuickPick(
        [
          { label: '编辑属性', action: 'set' as const },
          { label: '删除属性', action: 'delete' as const }
        ],
        { title: `SVN 属性：${propertyName}` }
      );
      if (!action) {
        return;
      }
      if (action.action === 'delete') {
        const confirmation = await vscode.window.showWarningMessage(
          `确认删除属性 ${propertyName}？`,
          { modal: true, detail: resource.fsPath },
          '删除'
        );
        if (confirmation !== '删除') {
          return;
        }
        await this.runOperation('正在删除 SVN 属性', (token) =>
          this.cli.run(['propdel', propertyName, '--', escapeSvnTarget(resource.fsPath)], {
            cwd: this.root.fsPath,
            token
          })
        );
        return;
      }
      const valueResult = await this.cli.run(
        ['propget', '--strict', propertyName, '--', escapeSvnTarget(resource.fsPath)],
        { cwd: this.root.fsPath, logStdout: false }
      );
      currentValue = valueResult.stdout;
    }

    const encodedValue = await vscode.window.showInputBox({
      title: `设置 SVN 属性：${propertyName}`,
      prompt: '输入属性值；使用 \\n 表示换行',
      value: currentValue.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n'),
      ignoreFocusOut: true
    });
    if (encodedValue === undefined) {
      return;
    }
    // 关键逻辑：InputBox 仅支持单行输入，将 \n 和 \\ 转回换行与反斜杠。
    const propertyValue = encodedValue.replace(/\\(n|\\)/g, (_match, escaped: string) =>
      escaped === 'n' ? '\n' : '\\'
    );
    await this.runOperation('正在设置 SVN 属性', (token) =>
      this.cli.run(['propset', propertyName.trim(), propertyValue, '--', escapeSvnTarget(resource.fsPath)], {
        cwd: this.root.fsPath,
        token
      })
    );
  }

  /**
   * 将选中资源加入、移动到或移出 SVN Changelist。
   *
   * @param resources 要调整 Changelist 的文件。
   */
  public async assignChangelist(resources: readonly vscode.Uri[]): Promise<void> {
    if (resources.length === 0) {
      return;
    }
    const selected = await vscode.window.showQuickPick(
      [
        ...[...this.changelistGroups.keys()].map((name) => ({
          label: name,
          name,
          remove: false,
          create: false
        })),
        { label: '$(add) 新建 Changelist…', name: '', remove: false, create: true },
        { label: '$(remove-close) 移出 Changelist', name: '', remove: true, create: false }
      ],
      { title: 'SVN Changelist：选择目标分组' }
    );
    if (!selected) {
      return;
    }
    const changelistName = selected.create
      ? await vscode.window.showInputBox({
          title: '新建 SVN Changelist',
          prompt: '输入 Changelist 名称',
          validateInput: (value) => (value.trim() ? undefined : 'Changelist 名称不能为空。')
        })
      : selected.name;
    if (!selected.remove && !changelistName) {
      return;
    }
    const args = selected.remove
      ? ['changelist', '--remove']
      : ['changelist', changelistName!.trim()];
    args.push('--', ...escapeSvnTargets(resources.map((resource) => resource.fsPath)));
    await this.runOperation('正在更新 SVN Changelist', (token) =>
      this.cli.run(args, { cwd: this.root.fsPath, token })
    );
  }

  /**
   * 清理当前 SVN 工作副本。
   */
  public async cleanup(): Promise<void> {
    await this.runOperation('正在清理 SVN 工作副本', (token) =>
      this.cli.run(['cleanup', '--', escapeSvnTarget(this.root.fsPath)], {
        cwd: this.root.fsPath,
        token
      })
    );
  }

  /**
   * 在 VS Code Diff Editor 中比较本地文件与指定 SVN revision。
   *
   * @param resource 要比较的文件。
   */
  public async compare(resource: vscode.Uri): Promise<void> {
    const selection = await vscode.window.showQuickPick(
      [
        { label: 'BASE', description: '本地工作副本基准版本', revision: 'BASE' },
        { label: 'HEAD', description: '仓库最新版本', revision: 'HEAD' },
        { label: '指定 revision…', description: '输入数字 revision', revision: '' }
      ],
      { title: 'SVN 比较版本' }
    );
    if (!selection) {
      return;
    }
    const revision =
      selection.revision ||
      (await vscode.window.showInputBox({
        title: 'SVN 比较版本',
        prompt: '输入 revision',
        validateInput: (value) => (/^\d+$/.test(value) ? undefined : '请输入数字 revision。')
      }));
    if (!revision) {
      return;
    }
    await vscode.commands.executeCommand(
      'vscode.diff',
      createSvnContentUri(resource, revision),
      resource,
      `${path.basename(resource.fsPath)}（${revision} ↔ 工作副本）`
    );
  }

  /**
   * 打开冲突资源的三方合并编辑器或类型专用详情。
   *
   * @param resource 要处理的单个冲突文件或目录。
   */
  public async openConflict(resource: vscode.Uri): Promise<void> {
    const status = this.statusByPath.get(path.normalize(resource.fsPath).toLowerCase());
    const isConflict =
      status?.item === 'conflicted' ||
      status?.propertyStatus === 'conflicted' ||
      status?.treeConflicted === true;
    if (!isConflict) {
      void vscode.window.showWarningMessage('所选资源当前没有 SVN 冲突。');
      return;
    }

    await this.runOperation('正在读取 SVN 冲突信息', async (token) => {
      const result = await this.cli.run(['info', '--xml', '--', escapeSvnTarget(resource.fsPath)], {
        cwd: this.root.fsPath,
        token,
        logStdout: false
      });
      const conflict = parseInfoXml(result.stdout).conflict;
      const localConflictFile = conflict?.previousWorkingFile ?? `${resource.fsPath}.mine`;
      let localConflictUri: vscode.Uri | undefined;
      try {
        const candidate = vscode.Uri.file(localConflictFile);
        await vscode.workspace.fs.stat(candidate);
        localConflictUri = candidate;
      } catch {
        if (conflict?.type === 'text') {
          try {
            const workingDocument = await vscode.workspace.openTextDocument(resource);
            const versions = extractConflictVersions(workingDocument.getText());
            // 关键逻辑：没有 .mine 时，工作文件可能已是纯本地版本，也可能包含冲突标记；两种情况统一复制为只读合并输入。
            const localDocument = await vscode.workspace.openTextDocument({
              language: workingDocument.languageId,
              content: versions?.mine ?? workingDocument.getText()
            });
            localConflictUri = localDocument.uri;
          } catch {
            localConflictUri = undefined;
          }
        }
      }
      let hasTextConflictFiles = false;
      if (conflict?.previousBaseFile && conflict.currentBaseFile) {
        try {
          await Promise.all(
            [conflict.previousBaseFile, conflict.currentBaseFile].map((file) =>
              vscode.workspace.fs.stat(vscode.Uri.file(file))
            )
          );
          hasTextConflictFiles = localConflictUri !== undefined;
        } catch {
          hasTextConflictFiles = false;
        }
      }

      if (
        conflict?.type === 'text' &&
        conflict.previousBaseFile &&
        conflict.currentBaseFile &&
        localConflictUri &&
        hasTextConflictFiles
      ) {
        const base = vscode.Uri.file(conflict.previousBaseFile);
        const local = localConflictUri;
        const incoming = vscode.Uri.file(conflict.currentBaseFile);
        try {
          // 关键逻辑：SVN 的旧基准、本地副本和新基准分别映射为三方合并输入，输出直接写回工作文件。
          await vscode.commands.executeCommand('_open.mergeEditor', {
            base,
            input1: { uri: local, title: '本地更改' },
            input2: { uri: incoming, title: '传入更改' },
            output: resource
          });
        } catch (error) {
          const message = redactText(error instanceof Error ? error.message : String(error));
          this.output.appendLine(`[警告] 无法打开三方合并编辑器：${message}`);
          await vscode.commands.executeCommand(
            'vscode.diff',
            local,
            incoming,
            `${path.basename(resource.fsPath)}（本地更改 ↔ 传入更改）`
          );
          void vscode.window.showWarningMessage(
            '当前 VS Code 无法打开三方合并编辑器，已降级为双向差异视图。'
          );
        }
        return;
      }

      if (conflict?.type === 'text') {
        await vscode.commands.executeCommand(
          'vscode.diff',
          createSvnContentUri(resource, 'BASE'),
          resource,
          `${path.basename(resource.fsPath)}（BASE ↔ 冲突工作文件）`
        );
        void vscode.window.showWarningMessage(
          'SVN 未提供完整的三方冲突文件，已降级为 BASE 与工作文件的差异视图。'
        );
        return;
      }

      if (conflict?.type === 'property' || status.propertyStatus === 'conflicted') {
        const propertyDiff = await this.cli.run(
          ['diff', '--properties-only', '--', escapeSvnTarget(resource.fsPath)],
          { cwd: this.root.fsPath, token, logStdout: false }
        );
        const document = await vscode.workspace.openTextDocument({
          language: 'diff',
          content: propertyDiff.stdout || '该资源存在属性冲突，但 SVN 未返回可显示的属性差异。'
        });
        await vscode.window.showTextDocument(document, { preview: true });
        return;
      }

      const conflictType = conflict?.type === 'tree' || status.treeConflicted ? '树冲突' : '未知冲突';
      const document = await vscode.workspace.openTextDocument({
        language: 'markdown',
        content: [
          `# SVN ${conflictType}`,
          '',
          `- 路径：${resource.fsPath}`,
          `- 操作：${conflict?.operation || '未知'}`,
          `- 状态：${getStatusTooltip(status)}`,
          '',
          '树冲突通常涉及文件或目录被移动、删除或替换。确认工作副本结构正确后，再从 Source Control 视图选择“标记冲突已解决”。'
        ].join('\n')
      });
      await vscode.window.showTextDocument(document, { preview: true });
    }, false);
  }

  /**
   * 使用用户选择的 SVN 冲突接受策略标记资源已解决。
   *
   * @param resources 要处理的冲突资源。
   */
  public async resolve(resources: readonly vscode.Uri[]): Promise<void> {
    const invalidResources = resources.filter((resource) => {
      const status = this.statusByPath.get(path.normalize(resource.fsPath).toLowerCase());
      return !(
        status?.item === 'conflicted' ||
        status?.propertyStatus === 'conflicted' ||
        status?.treeConflicted === true
      );
    });
    if (resources.length === 0 || invalidResources.length > 0) {
      void vscode.window.showWarningMessage(
        invalidResources.length > 0
          ? `以下资源当前没有 SVN 冲突：\n${invalidResources.map((item) => item.fsPath).join('\n')}`
          : '请先选择一个 SVN 冲突资源。'
      );
      return;
    }
    const strategy = await vscode.window.showQuickPick(
      [
        { label: 'working', description: '保留当前手工合并后的文件' },
        { label: 'mine-full', description: '完整接受本地版本' },
        { label: 'theirs-full', description: '完整接受仓库版本' },
        { label: 'base', description: '恢复冲突前的基准版本' }
      ],
      { title: 'SVN 标记冲突已解决', placeHolder: '选择冲突处理策略' }
    );
    if (!strategy) {
      return;
    }
    if (strategy.label === 'working') {
      const unresolved: string[] = [];
      for (const resource of resources) {
        try {
          const bytes = await vscode.workspace.fs.readFile(resource);
          const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if (containsConflictMarkers(content)) {
            unresolved.push(path.relative(this.root.fsPath, resource.fsPath));
          }
        } catch {
          // 关键逻辑：目录、二进制文件和树冲突无法通过文本标记判断，继续依赖下方人工确认。
        }
      }
      if (unresolved.length > 0) {
        void vscode.window.showWarningMessage(
          `以下文件仍包含冲突标记，不能标记为已解决：\n${unresolved.join('\n')}`
        );
        return;
      }
    }
    const confirmation = await vscode.window.showWarningMessage(
      `将以 ${strategy.label} 策略处理 ${resources.length} 个冲突，是否继续？`,
      {
        modal: true,
        detail: resources
          .map((resource) => {
            const status = this.statusByPath.get(path.normalize(resource.fsPath).toLowerCase());
            return `${status ? getStatusTooltip(status) : '冲突类型未知'}  ${path.relative(this.root.fsPath, resource.fsPath)}`;
          })
          .join('\n')
      },
      '继续'
    );
    if (confirmation !== '继续') {
      return;
    }
    await this.runOperation('正在处理 SVN 冲突', (token) =>
      this.cli.run(
        [
          'resolve',
          '--accept',
          strategy.label,
          '--',
          ...escapeSvnTargets(resources.map((resource) => resource.fsPath))
        ],
        { cwd: this.root.fsPath, token }
      )
    );
  }

  /**
   * 显示文件、目录或工作副本的 SVN 历史记录。
   *
   * @param resource 可选的历史目标；省略时使用工作副本根目录。
   */
  public async showLog(resource?: vscode.Uri): Promise<void> {
    const target = resource ?? this.root;
    const limit = vscode.workspace.getConfiguration('yfSvn').get<number>('logLimit', 50);
    await this.runOperation('正在读取 SVN 历史', async (token) => {
      // 关键逻辑：本地目录 revision 可能停留在旧值，改用 URL@HEAD 避免历史被 peg revision 截断。
      const infoResult = await this.cli.run(['info', '--xml', '--', escapeSvnTarget(target.fsPath)], {
        cwd: this.root.fsPath,
        token
      });
      const targetInfo = parseInfoXml(infoResult.stdout);
      const filterMode = await vscode.window.showQuickPick(
        [
          { label: '最近历史', description: `每页 ${limit} 条，可继续加载` },
          { label: '筛选历史', description: '按作者、revision 或日期范围筛选' }
        ],
        { title: `SVN 历史：${path.basename(target.fsPath)}` }
      );
      if (!filterMode) {
        return;
      }

      let revisionRange = 'HEAD:1';
      let author = '';
      const filtered = filterMode.label === '筛选历史';
      if (filtered) {
        revisionRange =
          (await vscode.window.showInputBox({
            title: 'SVN 历史筛选',
            prompt: '输入 revision 或日期范围',
            value: 'HEAD:1',
            placeHolder: '例如 HEAD:1、100:50、{2026-01-01}:{2026-07-31}',
            validateInput: (value) =>
              /^(?:HEAD|\d+|\{[^}]+\}):(?:\d+|\{[^}]+\})$/.test(value)
                ? undefined
                : '请输入有效范围，例如 HEAD:1、100:50 或 {日期}:{日期}。'
          })) ?? '';
        if (!revisionRange) {
          return;
        }
        const input = await vscode.window.showInputBox({
          title: 'SVN 历史筛选',
          prompt: '输入作者关键字；留空表示全部作者'
        });
        if (input === undefined) {
          return;
        }
        author = input.trim();
      }

      const resolved = await this.resolveLogRange(revisionRange, targetInfo.repositoryRoot, token);
      const targetUrl = `${targetInfo.url}@${resolved.headRevision}`;
      let range: SvnLogRange | undefined = resolved.range;
      while (range) {
        const page = await this.readLogPage(targetUrl, range, author, limit, token);
        const action = await this.pickLogEntry(target, page.entries, page.nextRange !== undefined);
        if (action !== 'more' || !page.nextRange) {
          break;
        }
        range = page.nextRange;
      }
    }, false);
  }

  /**
   * 将 HEAD 和日期边界解析为数字，保证翻页期间的方向、终点与来源路径不漂移。
   *
   * @param value 用户输入的 revision 或日期范围。
   * @param repositoryRoot 仓库根 URL，用于解析早于目标路径创建时间的日期。
   * @param token 历史查询的取消令牌。
   * @returns 数字查询范围及固定的仓库 HEAD。
   */
  private async resolveLogRange(
    value: string,
    repositoryRoot: string,
    token: vscode.CancellationToken
  ): Promise<{ readonly range: SvnLogRange; readonly headRevision: string }> {
    const match = /^(HEAD|\d+|\{[^}]+\}):(\d+|\{[^}]+\})$/.exec(value);
    if (!match) {
      throw new Error('请输入有效的 SVN 历史 revision 或日期范围。');
    }
    const head = parseInfoXml((await this.cli.run(
      ['info', '--xml', '--revision', 'HEAD', '--', `${repositoryRoot}@HEAD`],
      { cwd: this.root.fsPath, token, logStdout: false }
    )).stdout).revision;
    const bounds: bigint[] = [];
    for (const boundary of [match[1]!, match[2]!]) {
      if (boundary === 'HEAD') {
        bounds.push(BigInt(head));
      } else if (/^\d+$/.test(boundary)) {
        bounds.push(BigInt(boundary));
      } else {
        const result = await this.cli.run(
          ['info', '--xml', '--revision', boundary, '--', `${repositoryRoot}@${head}`],
          { cwd: this.root.fsPath, token, logStdout: false }
        );
        bounds.push(BigInt(parseInfoXml(result.stdout).revision));
      }
    }
    return { range: { start: bounds[0]!, end: bounds[1]! }, headRevision: head };
  }

  /**
   * 读取一页作者匹配的历史，空匹配页自动向后搜索但始终保留原始范围边界。
   *
   * @param targetUrl 已固定 peg revision 的历史目标 URL。
   * @param range 当前数字 revision 范围。
   * @param author 作者关键字，按不区分大小写的字面包含规则筛选。
   * @param limit 每次 SVN 查询的最大记录数。
   * @param token 历史查询的取消令牌。
   * @returns 当前匹配页及下一页范围。
   */
  private async readLogPage(
    targetUrl: string,
    range: SvnLogRange,
    author: string,
    limit: number,
    token: vscode.CancellationToken
  ): Promise<{ readonly entries: readonly SvnLogEntry[]; readonly nextRange?: SvnLogRange }> {
    let current: SvnLogRange | undefined = range;
    while (current) {
      const result = await this.cli.run(
        ['log', '--xml', '--verbose', '--revision', `${current.start}:${current.end}`, '--limit', String(limit), '--', targetUrl],
        { cwd: this.root.fsPath, token, logStdout: false }
      );
      const rawEntries = parseLogXml(result.stdout);
      const nextRange = nextLogRange(current, rawEntries, limit);
      // 关键逻辑：--search 会先受 --limit 限制且搜索提交说明等字段，不能作为作者分页游标。
      const entries = rawEntries.filter((entry) => !author || entry.author.toLowerCase().includes(author.toLowerCase()));
      if (entries.length > 0 || !nextRange) {
        return { entries, nextRange };
      }
      current = nextRange;
    }
    return { entries: [] };
  }

  /**
   * 在代码左侧显示或关闭有固定占宽的 SVN Blame，完整信息保留在悬浮提示中。
   *
   * @param resource 要追溯的文件。
   */
  public async showBlame(resource: vscode.Uri): Promise<void> {
    const request = ++this.blameRequest;
    const resourceKey = resource.toString();
    if (this.blameResource === resourceKey) {
      this.blameResource = undefined;
      this.blameLines = [];
      this.renderBlame();
      return;
    }

    await this.runOperation('正在读取 SVN Blame', async (token) => {
      const document = await vscode.workspace.openTextDocument(resource);
      const version = document.version;
      const result = await this.cli.run(['blame', '--xml', '--', escapeSvnTarget(resource.fsPath)], {
        cwd: this.root.fsPath,
        token,
        logStdout: false
      });
      // 关键逻辑：慢查询不能把旧追溯重新贴到已编辑的内容，也不能覆盖用户后发的显示或关闭操作。
      if (this.disposed || request !== this.blameRequest || document.version !== version) { return; }
      await vscode.window.showTextDocument(document, { preview: false });
      if (this.disposed || request !== this.blameRequest || document.version !== version) { return; }
      this.blameLines = parseBlameXml(result.stdout);
      this.blameResource = resourceKey;
      this.renderBlame();
    }, false);
  }

  /**
   * 把缓存追溯应用到当前文件的所有可见编辑器，切换格式时无需再次查询 SVN。
   */
  private renderBlame(): void {
    if (this.disposed) { return; }
    const style = vscode.workspace.getConfiguration('yfSvn', this.root).get<string>('blameStyle', 'compact') === 'full' ? 'full' : 'compact';
    for (const editor of vscode.window.visibleTextEditors) {
      const document = editor.document;
      const decorations = document.uri.toString() === this.blameResource ? this.blameLines
        .filter((line) => line.lineNumber > 0 && line.lineNumber <= document.lineCount)
        .map((line): vscode.DecorationOptions => {
          const parsedDate = new Date(line.date);
          const date = Number.isNaN(parsedDate.getTime()) ? '时间未知' : parsedDate.toLocaleString();
          const annotation = formatBlameAnnotation(line.revision, line.author, line.date, style);
          const hover = new vscode.MarkdownString();
          hover.appendText(`Revision：r${line.revision}\n\n作者：${line.author}\n\n时间：${date}`);
          return {
            range: new vscode.Range(
              document.lineAt(line.lineNumber - 1).range.start,
              document.lineAt(line.lineNumber - 1).range.start
            ),
            hoverMessage: hover,
            renderOptions: {
              before: { contentText: annotation.text, width: annotation.width }
            }
          };
        }) : [];
      editor.setDecorations(this.blameDecoration, decorations);
    }
  }

  /**
   * 释放 Source Control Provider 及资源分组。
   */
  public dispose(): void {
    this.disposed = true;
    this.uiSubscriptions.forEach((subscription) => subscription.dispose());
    this.blameDecoration.dispose();
    for (const group of this.changelistGroups.values()) {
      group.dispose();
    }
    this.changelistGroups.clear();
    this.changes.dispose();
    this.unversioned.dispose();
    this.conflicts.dispose();
    this.ignored.dispose();
    this.externals.dispose();
    this.sourceControl.dispose();
  }

  /**
   * 执行状态扫描并把结果映射到基础 SCM 分组和动态 Changelist 分组。
   */
  private async refreshCore(): Promise<void> {
    const startedAt = Date.now();
    const depth = vscode.workspace
      .getConfiguration('yfSvn')
      .get<string>('statusDepth', 'infinity');
    const result = await this.cli.run(
      [
        'status',
        '--xml',
        '--verbose',
        '--no-ignore',
        '--depth',
        depth,
        '--',
        escapeSvnTarget(this.root.fsPath)
      ],
      {
        cwd: this.root.fsPath,
        // 关键逻辑：状态 XML 只用于内部解析，避免大型工作副本把数 MB 内容写入输出日志。
        logStdout: false
      }
    );
    const entries = parseStatusXml(result.stdout, this.root.fsPath);
    const statuses = new Map<string, SvnStatusEntry>();
    const groups = {
      changes: [] as SvnResourceState[],
      unversioned: [] as SvnResourceState[],
      conflicts: [] as SvnResourceState[],
      ignored: [] as SvnResourceState[],
      externals: [] as SvnResourceState[]
    };
    const changelists = new Map<string, SvnResourceState[]>();
    for (const entry of entries) {
      const state = await this.createResourceState(entry);
      statuses.set(path.normalize(entry.absolutePath).toLowerCase(), state?.status ?? entry);
      if (!state) {
        continue;
      }
      if (
        entry.treeConflicted ||
        entry.item === 'conflicted' ||
        entry.propertyStatus === 'conflicted'
      ) {
        groups.conflicts.push(state);
      } else if (entry.item === 'unversioned') {
        groups.unversioned.push(state);
      } else if (entry.item === 'ignored') {
        groups.ignored.push(state);
      } else if (entry.item === 'external') {
        groups.externals.push(state);
      } else if (entry.changelist) {
        const states = changelists.get(entry.changelist) ?? [];
        states.push(state);
        changelists.set(entry.changelist, states);
      } else {
        groups.changes.push(state);
      }
    }
    // 关键逻辑：异步读取节点类型期间保留旧快照，全部准备完毕后再统一替换菜单和 SCM 状态。
    this.statusByPath.clear();
    for (const [key, entry] of statuses) {
      this.statusByPath.set(key, entry);
    }
    this.changes.resourceStates = groups.changes;
    this.unversioned.resourceStates = groups.unversioned;
    this.conflicts.resourceStates = groups.conflicts;
    this.ignored.resourceStates = groups.ignored;
    this.externals.resourceStates = groups.externals;
    this.updateChangelistGroups(changelists);
    this.scannedDepth = depth;
    const changelistCount = [...changelists.values()].reduce(
      (total, states) => total + states.length,
      0
    );
    this.sourceControl.count =
      groups.changes.length + groups.unversioned.length + groups.conflicts.length + changelistCount;
    this.output.appendLine(
      `[状态扫描] ${this.root.fsPath}：${entries.length} 项，耗时 ${Date.now() - startedAt} 毫秒`
    );
  }

  /**
   * 同步动态 Changelist SCM 分组并释放已经不存在的分组。
   *
   * @param changelists 当前状态扫描得到的 Changelist 及资源。
   */
  private updateChangelistGroups(
    changelists: ReadonlyMap<string, readonly SvnResourceState[]>
  ): void {
    for (const [name, group] of this.changelistGroups) {
      if (!changelists.has(name)) {
        group.dispose();
        this.changelistGroups.delete(name);
      }
    }
    for (const [name, states] of changelists) {
      let group = this.changelistGroups.get(name);
      if (!group) {
        group = this.sourceControl.createResourceGroup(
          `changelist:${encodeURIComponent(name)}`,
          `Changelist：${name}`
        );
        this.changelistGroups.set(name, group);
      }
      group.resourceStates = [...states];
    }
  }

  /**
   * 把 SVN 状态条目转换为 VS Code SCM 资源。
   *
   * @param entry SVN 状态条目。
   * @returns 需要展示的 SCM 资源；正常且属性未修改时返回 undefined。
   */
  private async createResourceState(entry: SvnStatusEntry): Promise<SvnResourceState | undefined> {
    if (!isDecoratedStatus(entry)) {
      return undefined;
    }
    const resourceUri = vscode.Uri.file(entry.absolutePath);
    if (!['unversioned', 'ignored', 'external'].includes(entry.item)) {
      // 关键逻辑：只为可见的版本化资源读取类型，目录不能执行文件锁、逐行追溯或 Changelist 操作。
      const stat = await vscode.workspace.fs.stat(resourceUri).then((value) => value, () => undefined);
      if (stat) {
        entry = { ...entry, kind: (stat.type & vscode.FileType.Directory) !== 0 ? 'dir' : 'file' };
      }
    }
    const diffable =
      !['added', 'unversioned', 'ignored', 'external'].includes(entry.item) &&
      entry.item !== 'missing';
    return {
      resourceUri,
      status: entry,
      // 关键逻辑：SCM 菜单直接复用资源管理器与编辑器的能力规则，避免仅按分组粗略判断。
      contextValue: [...getSvnMenuCapabilities(entry)].join(' '),
      command: diffable
        ? {
            command: 'vscode.diff',
            title: '查看 SVN 更改',
            arguments: [
              createSvnContentUri(resourceUri, 'BASE'),
              resourceUri,
              `${path.basename(entry.absolutePath)}（BASE ↔ 工作副本）`
            ]
          }
        : undefined,
      decorations: {
        iconPath: new vscode.ThemeIcon(getStatusIconId(entry), new vscode.ThemeColor(getStatusColorId(entry))),
        tooltip: getStatusTooltip(entry),
        strikeThrough: entry.item === 'deleted' || entry.item === 'missing',
        faded: entry.item === 'ignored'
      }
    };
  }

  /**
   * 为编辑器 Quick Diff 返回工作文件对应的 BASE 内容。
   *
   * @param resource 当前编辑器中的文件 URI。
   * @returns 可比较的 BASE 虚拟 URI；当前资源不可比较时返回 undefined。
   */
  private provideOriginalResource(resource: vscode.Uri): vscode.Uri | undefined {
    const entry = this.statusByPath.get(path.normalize(resource.fsPath).toLowerCase());
    if (
      !entry ||
      ['added', 'unversioned', 'ignored', 'external', 'missing'].includes(entry.item)
    ) {
      return undefined;
    }
    return createSvnContentUri(resource, 'BASE');
  }

  /**
   * 汇总已扫描范围的更改与冲突，失败时保留旧计数并提供明确的重试入口。
   * @param error 本次刷新失败的脱敏说明；省略表示正常或尚未完成首次扫描。
   */
  private updateStatusBar(error?: string): void {
    const changes = this.changes.resourceStates.length + [...this.changelistGroups.values()].reduce((total, group) => total + group.resourceStates.length, 0);
    const unversioned = this.unversioned.resourceStates.length;
    const conflicts = this.conflicts.resourceStates.length;
    const count = changes + unversioned + conflicts;
    const state = error ? '状态已过期' : !this.lastRefresh ? '尚未扫描' : count === 0 ? '无可见更改' : `${count} 项${conflicts ? ` · ${conflicts} 冲突` : ''}`;
    this.sourceControl.statusBarCommands = [{
      command: 'yfSvn.refresh',
      title: `${error || conflicts ? '$(warning)' : '$(source-control)'} SVN · ${path.basename(this.root.fsPath)} · ${state}`,
      tooltip: [
        `工作副本：${this.root.fsPath}`,
        `版本化更改：${changes}；未版本控制：${unversioned}；冲突：${conflicts}`,
        `扫描深度：${this.scannedDepth}（仅统计已扫描范围）`,
        `上次成功刷新：${this.lastRefresh?.toLocaleString() ?? '尚未成功扫描'}`,
        ...(error ? [`状态已过期：${error}`] : []),
        '单击刷新此工作副本。'
      ].join('\n'),
      arguments: [this.root]
    }];
  }

  /**
   * 显示历史 Quick Pick，并打开所选 revision 的内容或改动摘要。
   *
   * @param target 历史查询目标。
   * @param entries SVN 历史记录。
   * @param canLoadMore 是否显示“加载更早记录”入口。
   * @returns 用户要求继续翻页时返回 more，否则返回 done。
   */
  private async pickLogEntry(
    target: vscode.Uri,
    entries: readonly SvnLogEntry[],
    canLoadMore: boolean
  ): Promise<'done' | 'more'> {
    if (entries.length === 0) {
      void vscode.window.showInformationMessage('没有找到 SVN 历史记录。');
      return 'done';
    }
    const items: Array<{
      label: string;
      description?: string;
      detail?: string;
      entry?: SvnLogEntry;
      loadMore?: boolean;
    }> = entries.map((entry) => ({
      label: `r${entry.revision}  ${entry.author}`,
      description: new Date(entry.date).toLocaleString(),
      detail: entry.message || '（无提交说明）',
      entry
    }));
    if (canLoadMore) {
      items.push({
        label: '$(history) 加载更早记录…',
        description: '读取下一页 SVN 历史',
        loadMore: true
      });
    }
    const selected = await vscode.window.showQuickPick(
      items,
      {
        title: `SVN 历史：${path.basename(target.fsPath)}`,
        matchOnDescription: true,
        matchOnDetail: true
      }
    );
    if (!selected) {
      return 'done';
    }
    if (selected.loadMore) {
      return 'more';
    }
    if (!selected.entry) {
      return 'done';
    }
    const stat = await vscode.workspace.fs.stat(target).then(
      (value) => value,
      () => undefined
    );
    if (stat?.type === vscode.FileType.File) {
      const revision = Number(selected.entry.revision);
      if (revision <= 1) {
        await vscode.commands.executeCommand(
          'vscode.open',
          createSvnContentUri(target, selected.entry.revision)
        );
        return 'done';
      }
      await vscode.commands.executeCommand(
        'vscode.diff',
        createSvnContentUri(target, String(revision - 1)),
        createSvnContentUri(target, selected.entry.revision),
        `${path.basename(target.fsPath)}（r${selected.entry.revision}）`
      );
      return 'done';
    }
    const content = this.logEntryMarkdown(selected.entry);
    const document = await vscode.workspace.openTextDocument({
      content,
      language: 'markdown'
    });
    await vscode.window.showTextDocument(document, { preview: true });
    return 'done';
  }

  /**
   * 把一个 SVN 历史条目格式化为 Markdown。
   *
   * @param entry SVN 历史条目。
   * @returns 可在编辑器中展示的 Markdown。
   */
  private logEntryMarkdown(entry: SvnLogEntry): string {
    const changedPaths = entry.paths.length
      ? entry.paths.map((item) => `- \`${item.action}\` ${item.path}`).join('\n')
      : '- 无路径信息';
    return [
      `# SVN r${entry.revision}`,
      '',
      `- 作者：${entry.author}`,
      `- 时间：${entry.date}`,
      '',
      '## 提交说明',
      '',
      entry.message || '（无提交说明）',
      '',
      '## 改动路径',
      '',
      changedPaths
    ].join('\n');
  }

  /**
   * 判断资源当前是否属于未版本控制分组。
   *
   * @param resource 待检查的文件或目录。
   * @returns 当前状态为 unversioned 时返回 true。
   */
  private isUnversioned(resource: vscode.Uri): boolean {
    return (
      this.statusByPath.get(path.normalize(resource.fsPath).toLowerCase())?.item === 'unversioned'
    );
  }

  /**
   * 在可取消进度框中执行操作；写操作按工作副本排队并在结束后刷新状态。
   *
   * @param title 进度框标题。
   * @param operation 接收取消令牌的实际操作。
   * @param write 是否为需要排队和刷新状态的写操作。
   * @returns 成功时返回操作结果，失败或取消时返回 undefined。
   */
  private async runOperation<T>(
    title: string,
    operation: (token: vscode.CancellationToken) => Promise<T>,
    write = true
  ): Promise<T | undefined> {
    try {
      return await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `${title.replace(/^正在/, '')} · ${path.basename(this.root.fsPath)}`,
          cancellable: true
        },
        async (progress, token) => {
          if (!write) {
            progress.report({ message: '正在执行' });
            return operation(token);
          }
          progress.report({ message: '等待前一项操作完成' });
          return this.operationQueue.run(async () => {
            // 关键逻辑：排队期间取消的任务不再执行，也不产生额外刷新。
            if (token.isCancellationRequested) {
              throw new vscode.CancellationError();
            }
            progress.report({ message: '正在执行' });
            try {
              return await operation(token);
            } finally {
              // 关键逻辑：失败或取消也可能已修改部分文件，使用独立于操作取消令牌的刷新。
              progress.report({ message: '正在刷新状态' });
              try {
                await this.refresh();
              } catch {
                // refresh 已单独提示并标记过期；刷新错误不得覆盖原操作结果。
              }
            }
          });
        }
      );
    } catch (error) {
      if (error instanceof vscode.CancellationError) {
        return undefined;
      }
      showSvnError(error, this.output, this.root);
      return undefined;
    }
  }
}
