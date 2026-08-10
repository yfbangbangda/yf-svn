import * as path from 'node:path';
import * as vscode from 'vscode';
import { containsConflictMarkers, extractConflictVersions } from './conflict';
import { createSvnContentUri } from './contentProvider';
import { SvnCli, SvnCommandError } from './svnCli';
import { isDecoratedStatus } from './statusDecoration';
import {
  SvnItemStatus,
  SvnLogEntry,
  SvnRepositoryOperations,
  SvnResourceState,
  SvnStatusEntry
} from './types';
import { parseBlameXml, parseInfoXml, parseLogXml, parseStatusXml } from './xml';

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
  private readonly statusByPath = new Map<string, SvnStatusEntry>();
  private refreshPromise: Promise<void> | undefined;
  private readonly blameDecoration = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    before: {
      margin: '0 2em 0 0',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic'
    }
  });
  private blameResource: string | undefined;

  /**
   * 创建一个 SVN 工作副本实例。
   *
   * @param cli SVN CLI 适配器。
   * @param root 工作副本根目录。
   * @param output 插件输出通道。
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
      command: 'yfSvn.commit',
      title: '提交',
      arguments: [root]
    };
    this.changes = this.sourceControl.createResourceGroup('changes', '更改');
    this.unversioned = this.sourceControl.createResourceGroup('unversioned', '未版本控制');
    this.conflicts = this.sourceControl.createResourceGroup('conflicts', '冲突');
    this.ignored = this.sourceControl.createResourceGroup('ignored', '已忽略');
    this.externals = this.sourceControl.createResourceGroup('externals', 'Externals');
    this.ignored.hideWhenEmpty = true;
    this.externals.hideWhenEmpty = true;
  }

  /**
   * 刷新当前工作副本状态并更新 Source Control 分组。
   */
  public async refresh(): Promise<void> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshPromise = this.refreshCore()
      .then(() => this.onDidRefresh())
      .finally(() => {
        this.refreshPromise = undefined;
      });
    return this.refreshPromise;
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
   * 提交选中资源；未传资源时提交当前 Source Control 中的全部可提交更改。
   *
   * @param resources 要提交的文件或目录。
   */
  public async commit(resources?: readonly vscode.Uri[]): Promise<void> {
    const targets = resources?.length
      ? resources
      : [...this.changes.resourceStates, ...this.conflicts.resourceStates].map(
          (state) => state.resourceUri
        );
    if (targets.length === 0) {
      void vscode.window.showInformationMessage('当前没有可提交的 SVN 更改。');
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
            return `${status ? this.statusTooltip(status) : '状态未知'}  ${relative}`;
          })
        ].join('\n')
      },
      '提交'
    );
    if (confirmation !== '提交') {
      return;
    }
    await this.runOperation('正在提交 SVN 更改', async (token) => {
      await this.cli.run(
        [
          'commit',
          '--message',
          message,
          // 关键逻辑：允许提交说明与现有文件路径同名，避免 SVN 误判为应使用 -F。
          '--force-log',
          '--',
          ...targets.map((resource) => resource.fsPath)
        ],
        { cwd: this.root.fsPath, token }
      );
      this.sourceControl.inputBox.value = '';
    });
  }

  /**
   * 将当前工作副本或指定资源更新到 HEAD 或指定 revision。
   *
   * @param resource 可选的文件或目录目标；省略时更新整个工作副本。
   */
  public async update(resource?: vscode.Uri): Promise<void> {
    const target = resource ?? this.root;
    const revisionMode = await vscode.window.showQuickPick(
      [
        { label: 'HEAD', description: '更新到仓库最新版本', revision: 'HEAD' },
        { label: '指定 revision…', description: '输入数字 revision', revision: '' }
      ],
      { title: 'SVN Update：选择目标 revision', ignoreFocusOut: true }
    );
    if (!revisionMode) {
      return;
    }
    const revision =
      revisionMode.revision ||
      (await vscode.window.showInputBox({
        title: 'SVN Update',
        prompt: '输入目标 revision',
        validateInput: (value) => (/^\d+$/.test(value) ? undefined : '请输入数字 revision。')
      }));
    if (!revision) {
      return;
    }
    const depth = await vscode.window.showQuickPick(
      ['working', 'empty', 'files', 'immediates', 'infinity'],
      { title: 'SVN Update：选择更新深度' }
    );
    if (!depth) {
      return;
    }
    const args = ['update', '--revision', revision, '--depth', depth];
    if (vscode.workspace.getConfiguration('yfSvn').get<boolean>('ignoreExternals', false)) {
      args.push('--ignore-externals');
    }
    args.push('--', target.fsPath);
    const relativeTarget = path.relative(this.root.fsPath, target.fsPath) || '整个工作副本';
    const confirmation = await vscode.window.showInformationMessage(
      `确认将 ${relativeTarget} 更新到 ${revision}？`,
      {
        modal: true,
        detail: [
          `工作副本：${this.root.fsPath}`,
          `更新目标：${target.fsPath}`,
          `深度：${depth}`,
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
   * 将未版本控制的资源加入 SVN。
   *
   * @param resources 要加入版本控制的文件或目录。
   */
  public async add(resources: readonly vscode.Uri[]): Promise<void> {
    if (resources.length === 0) {
      return;
    }
    await this.runOperation('正在添加 SVN 资源', (token) =>
      this.cli.run(['add', '--parents', '--', ...resources.map((resource) => resource.fsPath)], {
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
    const unversioned = resources.filter((resource) => this.isUnversioned(resource));
    const versioned = resources.filter((resource) => !this.isUnversioned(resource));
    await this.runOperation('正在删除 SVN 资源', async (token) => {
      if (versioned.length > 0) {
        await this.cli.run(
          ['delete', '--force', '--', ...versioned.map((resource) => resource.fsPath)],
          {
            cwd: this.root.fsPath,
            token
          }
        );
      }
      // 关键逻辑：未版本控制文件不属于 SVN，使用系统回收站保证仍可恢复。
      for (const resource of unversioned) {
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
        ['revert', '--depth', 'infinity', '--', ...resources.map((resource) => resource.fsPath)],
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
      await this.cli.run(['move', '--parents', '--', resource.fsPath, destinationPath], {
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
          const existing = await this.cli.run(['propget', property.property, '--', parent], {
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
        await this.cli.run(['propset', property.property, [...lines].join('\n'), '--', parent], {
          cwd: this.root.fsPath,
          token
        });
      }
    });
  }

  /**
   * 清理当前 SVN 工作副本。
   */
  public async cleanup(): Promise<void> {
    await this.runOperation('正在清理 SVN 工作副本', (token) =>
      this.cli.run(['cleanup', '--', this.root.fsPath], {
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
      const result = await this.cli.run(['info', '--xml', '--', resource.fsPath], {
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
          const message = error instanceof Error ? error.message : String(error);
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
          ['diff', '--properties-only', '--', resource.fsPath],
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
          `- 状态：${this.statusTooltip(status)}`,
          '',
          '树冲突通常涉及文件或目录被移动、删除或替换。确认工作副本结构正确后，再从 Source Control 视图选择“标记冲突已解决”。'
        ].join('\n')
      });
      await vscode.window.showTextDocument(document, { preview: true });
    });
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
            return `${status ? this.statusTooltip(status) : '冲突类型未知'}  ${path.relative(this.root.fsPath, resource.fsPath)}`;
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
          ...resources.map((resource) => resource.fsPath)
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
      const infoResult = await this.cli.run(['info', '--xml', '--', target.fsPath], {
        cwd: this.root.fsPath,
        token
      });
      const targetUrl = `${parseInfoXml(infoResult.stdout).url}@HEAD`;
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
        author =
          (
            await vscode.window.showInputBox({
              title: 'SVN 历史筛选',
              prompt: '输入作者关键字；留空表示全部作者'
            })
          )?.trim() ?? '';
      }

      // 关键逻辑：普通历史按最旧 revision 向后翻页；自定义范围保持用户给定边界。
      while (true) {
        const args = [
          'log',
          '--xml',
          '--verbose',
          '--revision',
          revisionRange,
          '--limit',
          String(limit)
        ];
        if (author) {
          args.push('--search', author);
        }
        args.push('--', targetUrl);
        const result = await this.cli.run(args, {
          cwd: this.root.fsPath,
          token
        });
        const entries = parseLogXml(result.stdout).filter(
          (entry) => !author || entry.author.toLowerCase().includes(author.toLowerCase())
        );
        const oldestRevision = Math.min(
          ...entries.map((entry) => Number(entry.revision)).filter(Number.isFinite)
        );
        const canLoadMore =
          !filtered && entries.length >= limit && Number.isFinite(oldestRevision) && oldestRevision > 1;
        const action = await this.pickLogEntry(target, entries, canLoadMore);
        if (action !== 'more') {
          break;
        }
        revisionRange = `${oldestRevision - 1}:1`;
      }
    });
  }

  /**
   * 在编辑器行尾显示或关闭文件的 SVN Blame 逐行追溯结果。
   *
   * @param resource 要追溯的文件。
   */
  public async showBlame(resource: vscode.Uri): Promise<void> {
    const resourceKey = resource.toString();
    const visibleEditor = vscode.window.visibleTextEditors.find(
      (editor) => editor.document.uri.toString() === resourceKey
    );
    if (this.blameResource === resourceKey && visibleEditor) {
      visibleEditor.setDecorations(this.blameDecoration, []);
      this.blameResource = undefined;
      return;
    }

    await this.runOperation('正在读取 SVN Blame', async (token) => {
      const result = await this.cli.run(['blame', '--xml', '--', resource.fsPath], {
        cwd: this.root.fsPath,
        token,
        logStdout: false
      });
      const document = await vscode.workspace.openTextDocument(resource);
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      const decorations = parseBlameXml(result.stdout)
        .filter((line) => line.lineNumber > 0 && line.lineNumber <= document.lineCount)
        .map((line): vscode.DecorationOptions => {
          const date = line.date ? new Date(line.date).toLocaleString() : '时间未知';
          const shortDate = line.date ? line.date.slice(0, 10) : '未知日期';
          const hover = new vscode.MarkdownString();
          hover.appendText(`Revision：r${line.revision}\n\n作者：${line.author}\n\n时间：${date}`);
          return {
            range: new vscode.Range(
              document.lineAt(line.lineNumber - 1).range.start,
              document.lineAt(line.lineNumber - 1).range.start
            ),
            hoverMessage: hover,
            renderOptions: {
              before: { contentText: `r${line.revision} · ${line.author} · ${shortDate}` }
            }
          };
        });

      // 关键逻辑：同一仓库仅保留当前文件的追溯装饰，避免旧文件注释长期占用编辑器空间。
      for (const openEditor of vscode.window.visibleTextEditors) {
        openEditor.setDecorations(this.blameDecoration, []);
      }
      editor.setDecorations(this.blameDecoration, decorations);
      this.blameResource = resourceKey;
      void vscode.window.showInformationMessage(
        `已在 ${path.basename(resource.fsPath)} 左侧显示 SVN 逐行追溯；再次执行可关闭。`
      );
    });
  }

  /**
   * 释放 Source Control Provider 及资源分组。
   */
  public dispose(): void {
    this.blameDecoration.dispose();
    this.changes.dispose();
    this.unversioned.dispose();
    this.conflicts.dispose();
    this.ignored.dispose();
    this.externals.dispose();
    this.sourceControl.dispose();
  }

  /**
   * 执行状态扫描并把结果映射到五个 SCM 分组。
   */
  private async refreshCore(): Promise<void> {
    const startedAt = Date.now();
    const depth = vscode.workspace
      .getConfiguration('yfSvn')
      .get<string>('statusDepth', 'infinity');
    const result = await this.cli.run(
      ['status', '--xml', '--no-ignore', '--depth', depth, '--', this.root.fsPath],
      {
        cwd: this.root.fsPath,
        // 关键逻辑：状态 XML 只用于内部解析，避免大型工作副本把数 MB 内容写入输出日志。
        logStdout: false
      }
    );
    const entries = parseStatusXml(result.stdout, this.root.fsPath);
    this.statusByPath.clear();
    const groups = {
      changes: [] as SvnResourceState[],
      unversioned: [] as SvnResourceState[],
      conflicts: [] as SvnResourceState[],
      ignored: [] as SvnResourceState[],
      externals: [] as SvnResourceState[]
    };
    for (const entry of entries) {
      this.statusByPath.set(path.normalize(entry.absolutePath).toLowerCase(), entry);
      const state = this.createResourceState(entry);
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
      } else {
        groups.changes.push(state);
      }
    }
    this.changes.resourceStates = groups.changes;
    this.unversioned.resourceStates = groups.unversioned;
    this.conflicts.resourceStates = groups.conflicts;
    this.ignored.resourceStates = groups.ignored;
    this.externals.resourceStates = groups.externals;
    this.sourceControl.count =
      groups.changes.length + groups.unversioned.length + groups.conflicts.length;
    this.output.appendLine(
      `[状态扫描] ${this.root.fsPath}：${entries.length} 项，耗时 ${Date.now() - startedAt} 毫秒`
    );
  }

  /**
   * 把 SVN 状态条目转换为 VS Code SCM 资源。
   *
   * @param entry SVN 状态条目。
   * @returns 需要展示的 SCM 资源；正常且属性未修改时返回 undefined。
   */
  private createResourceState(entry: SvnStatusEntry): SvnResourceState | undefined {
    if (!isDecoratedStatus(entry)) {
      return undefined;
    }
    const resourceUri = vscode.Uri.file(entry.absolutePath);
    const diffable =
      !['added', 'unversioned', 'ignored', 'external'].includes(entry.item) &&
      entry.item !== 'missing';
    return {
      resourceUri,
      status: entry,
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
        tooltip: this.statusTooltip(entry),
        strikeThrough: entry.item === 'deleted' || entry.item === 'missing',
        faded: entry.item === 'ignored'
      }
    };
  }

  /**
   * 生成状态条目的中文悬浮说明。
   *
   * @param entry SVN 状态条目。
   * @returns 中文状态说明。
   */
  private statusTooltip(entry: SvnStatusEntry): string {
    const names: Record<SvnItemStatus, string> = {
      added: '已添加',
      conflicted: '有冲突',
      deleted: '已删除',
      external: '外部定义',
      ignored: '已忽略',
      incomplete: '不完整',
      missing: '本地缺失',
      modified: '已修改',
      none: '无状态',
      normal: '正常',
      obstructed: '路径被阻塞',
      replaced: '已替换',
      unversioned: '未版本控制'
    };
    const details = [names[entry.item]];
    if (entry.propertyStatus !== 'none' && entry.propertyStatus !== 'normal') {
      details.push(`属性：${names[entry.propertyStatus]}`);
    }
    if (entry.treeConflicted) {
      details.push('树冲突');
    }
    if (entry.switched) {
      details.push('已 Switch');
    }
    return details.join('；');
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
   * 在可取消进度框中执行写操作，并在结束后刷新状态。
   *
   * @param title 进度框标题。
   * @param operation 接收取消令牌的实际操作。
   */
  private async runOperation<T>(
    title: string,
    operation: (token: vscode.CancellationToken) => Promise<T>
  ): Promise<T | undefined> {
    try {
      return await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title,
          cancellable: true
        },
        async (_progress, token) => {
          const value = await operation(token);
          await this.refresh();
          return value;
        }
      );
    } catch (error) {
      if (error instanceof vscode.CancellationError) {
        return undefined;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[错误] ${message}`);
      const action = await vscode.window.showErrorMessage(message, '显示 SVN 输出');
      if (action === '显示 SVN 输出') {
        this.output.show();
      }
      return undefined;
    }
  }
}
