import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as vscode from 'vscode';
import { runInputSteps, StepChoice } from '../../inputSteps';
import { SvnRepository } from '../../repository';
import { SvnManager } from '../../manager';
import { SvnCli } from '../../svnCli';
import { parseInfoXml } from '../../xml';
import { escapeSvnTarget } from '../../svnTarget';
import { mergePreviews, MERGE_PREVIEW_SCHEME } from '../../mergePreview';
import { showSvnError } from '../../errorFeedback';
import { SvnMergePlan } from '../../merge';

/** 用受控事件驱动生产多步输入逻辑，验证返回和取消，无需依赖界面点击时序。 */
class ControlledInput {
  public value = '';
  public items: readonly StepChoice[] = [];
  public activeItems: readonly StepChoice[] = [];
  public selectedItems: readonly StepChoice[] = [];
  public buttons: readonly vscode.QuickInputButton[] = [];
  public step = 0;
  public totalSteps = 0;
  public disposed = false;
  public validationMessage: string | undefined;
  public readonly acceptEvent = new vscode.EventEmitter<void>();
  public readonly hideEvent = new vscode.EventEmitter<void>();
  public readonly buttonEvent = new vscode.EventEmitter<vscode.QuickInputButton>();
  public readonly valueEvent = new vscode.EventEmitter<string>();
  public readonly onDidAccept = this.acceptEvent.event;
  public readonly onDidHide = this.hideEvent.event;
  public readonly onDidTriggerButton = this.buttonEvent.event;
  public readonly onDidChangeValue = this.valueEvent.event;

  /** 受控控件无需显示真实弹窗。 */
  public show(): void {}

  /** 释放当前步骤的全部事件。 */
  public dispose(): void {
    this.disposed = true;
    this.acceptEvent.dispose();
    this.hideEvent.dispose();
    this.buttonEvent.dispose();
    this.valueEvent.dispose();
  }
}

/**
 * 等待受控交互完成，失败时给出有限超时。
 * @param condition 判断异步步骤是否已完成。
 */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('交互测试未在期限内完成。');
    }
    await delay(10);
  }
}

/**
 * 创建可注入原生输入入口的受控控件。
 * @param folder 浏览目录按钮返回的隔离测试目录。
 * @returns 受控输入入口及创建顺序中的控件。
 */
function controlledUi(folder: vscode.Uri): {
  controls: ControlledInput[];
  ui: Pick<typeof vscode.window, 'createInputBox' | 'createQuickPick' | 'showOpenDialog'>;
} {
  const controls: ControlledInput[] = [];
  return { controls, ui: {
    /** 创建受控文本输入。 */
    createInputBox: () => {
      const control = new ControlledInput();
      controls.push(control);
      return control as unknown as vscode.InputBox;
    },
    /** 创建受控单选输入。 */
    createQuickPick: <T extends vscode.QuickPickItem>() => {
      const control = new ControlledInput();
      controls.push(control);
      return control as unknown as vscode.QuickPick<T>;
    },
    /** 返回测试目录，不访问用户其他目录。 */
    showOpenDialog: async () => [folder]
  } };
}

/**
 * 临时替换隔离扩展宿主的原生窗口入口，恢复函数必须在 finally 中调用。
 * @param replacements 本次测试需要的受控窗口方法。
 * @returns 恢复全部原方法的函数。
 */
function replaceWindow(replacements: Partial<typeof vscode.window>): () => void {
  const descriptors = new Map<string, PropertyDescriptor>();
  for (const [key, value] of Object.entries(replacements)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(vscode.window, key)!);
    Object.defineProperty(vscode.window, key, { configurable: true, writable: true, value });
  }
  return () => {
    for (const [key, descriptor] of descriptors) {
      Object.defineProperty(vscode.window, key, descriptor);
    }
  };
}

/**
 * 验证多步输入在返回、校验、浏览目录及取消时保留参数。
 * @param folder 隔离测试目录。
 */
async function testInputSteps(folder: vscode.Uri): Promise<void> {
  const { controls, ui } = controlledUi(folder);
  const task = runInputSteps('多步回归', [
    { key: 'name', prompt: '名称', placeholder: '输入名称', validate: (value) => value ? undefined : '名称不能为空' },
    { key: 'folder', prompt: '目录', placeholder: '输入或浏览目录', browseFolder: true },
    { key: 'depth', prompt: '深度', placeholder: '选择深度', value: 'working', items: [
      { label: '保持当前深度', value: 'working' }, { label: '完整目录树', value: 'infinity' }
    ] }
  ], ui);
  assert.equal(controls[0]!.step, 1);
  assert.equal(controls[0]!.totalSteps, 3);
  assert.equal(controls[0]!.buttons.includes(vscode.QuickInputButtons.Back), false);
  controls[0]!.acceptEvent.fire();
  await until(() => Boolean(controls[0]!.validationMessage));
  assert.equal(controls.length, 1);
  controls[0]!.value = '首次输入';
  controls[0]!.acceptEvent.fire();
  await until(() => controls.length === 2);
  controls[1]!.value = '目录草稿';
  controls[1]!.buttonEvent.fire(vscode.QuickInputButtons.Back);
  await until(() => controls.length === 3);
  assert.equal(controls[2]!.value, '首次输入');
  controls[2]!.value = '修改后输入';
  controls[2]!.acceptEvent.fire();
  await until(() => controls.length === 4);
  assert.equal(controls[3]!.value, '目录草稿');
  controls[3]!.buttonEvent.fire(controls[3]!.buttons.find((button) => button.tooltip === '浏览目标目录')!);
  await until(() => controls[3]!.value === folder.fsPath);
  controls[3]!.acceptEvent.fire();
  await until(() => controls.length === 5);
  controls[4]!.activeItems = [controls[4]!.items[1]!];
  controls[4]!.buttonEvent.fire(vscode.QuickInputButtons.Back);
  await until(() => controls.length === 6);
  assert.equal(controls[5]!.value, folder.fsPath);
  controls[5]!.acceptEvent.fire();
  await until(() => controls.length === 7);
  assert.equal(controls[6]!.activeItems[0]!.value, 'infinity');
  controls[6]!.acceptEvent.fire();
  assert.deepEqual(await task, { name: '修改后输入', folder: folder.fsPath, depth: 'infinity' });

  const canceled = controlledUi(folder);
  const cancelTask = runInputSteps('取消回归', [{ key: 'name', prompt: '输入', placeholder: '输入名称' }], canceled.ui);
  canceled.controls[0]!.hideEvent.fire();
  assert.equal(await cancelTask, undefined);
  console.log('通过：多步输入的步骤提示、校验、返回保留内容、目录浏览和取消');
}

/**
 * 验证第二批交互入口及执行保护，全部数据位于隔离测试仓库。
 * @param root 宿主测试临时目录。
 * @param workspace 原有测试工作副本。
 * @param output SVN 输出通道。
 */
export async function testInteractions(root: string, workspace: vscode.Uri, output: vscode.OutputChannel): Promise<void> {
  await testInputSteps(vscode.Uri.file(root));
  const cli = new SvnCli(output);
  const repository = new SvnRepository(cli, workspace, output, () => {});
  let picked: Array<{ picked?: boolean }> = [];
  let warnings: string[] = [];
  let confirmation: { message: string; detail: string } | undefined;
  let acceptUpdate = false;
  const restore = replaceWindow({
    showQuickPick: (async (items: readonly unknown[]) => { picked = items as Array<{ picked?: boolean }>; return undefined; }) as typeof vscode.window.showQuickPick,
    showWarningMessage: (async (message: string) => { warnings.push(message); return undefined; }) as typeof vscode.window.showWarningMessage,
    showInformationMessage: (async (message: string, options?: vscode.MessageOptions) => {
      if (options?.modal) {
        confirmation = { message, detail: options.detail ?? '' };
        return acceptUpdate ? '更新' : undefined;
      }
      return undefined;
    }) as typeof vscode.window.showInformationMessage
  });
  try {
    await repository.refresh();
    const tracked = vscode.Uri.joinPath(workspace, 'tracked.txt');
    const other = vscode.Uri.joinPath(workspace, 'queued one.txt');
    await repository.commit([tracked, other]);
    assert.equal(picked.length, 2);
    assert.ok(picked.every((item) => item.picked === true));
    await repository.commit();
    assert.ok(picked.every((item) => item.picked === false));
    const key = path.normalize(tracked.fsPath).toLowerCase();
    const oldStatus = repository['statusByPath'].get(key)!;
    repository['statusByPath'].set(key, { ...oldStatus, item: 'conflicted' });
    await repository.commit([tracked]);
    assert.ok(warnings.some((message) => message.includes('所选提交范围包含未解决冲突')));
    repository['statusByPath'].set(key, oldStatus);

    picked = [];
    await repository.update();
    assert.equal(picked.length, 0, '普通更新不再要求选择参数');
    assert.ok(confirmation?.message.includes('HEAD'));
    assert.ok(confirmation?.detail.includes('保持当前深度'));
    const originalRun = cli.run.bind(cli);
    const updates: string[][] = [];
    let successfulUpdates = 0;
    /** 捕获真实更新参数。@param args SVN 参数。@param options 执行选项。 */
    cli.run = async (args, options) => {
      if (args[0] === 'update') { updates.push([...args]); }
      const result = await originalRun(args, options);
      if (args[0] === 'update' && result.exitCode === 0) { successfulUpdates++; }
      return result;
    };
    acceptUpdate = true;
    await repository.update();
    cli.run = originalRun;
    assert.equal(updates.length, 1);
    assert.equal(successfulUpdates, 1, '必须确认真实 SVN 更新成功，不能只检查是否发起命令');
    assert.deepEqual(updates[0]!.slice(0, 3), ['update', '--revision', 'HEAD']);
    assert.equal(updates[0]!.includes('--depth'), false, '保持当前深度时应省略 --depth');
    console.log('通过：已选提交文件默认勾选、冲突提前阻止、普通更新默认值及最终确认');
  } finally {
    restore();
    repository.dispose();
  }
  await testSparseUpdate(root, output);
  await testPreviewContinuation(root, output);
  await testQueueProgress(workspace, output);
  await testQueuedCommit(workspace, output);
  await testProductionForms(root, workspace, output);
  await testErrorRecovery(workspace, output);
}

/**
 * 验证普通及高级更新真实推进 revision，并保持稀疏工作副本的检出范围。
 * @param root 宿主测试临时目录，由测试入口统一清理。
 * @param output SVN 输出通道。
 */
async function testSparseUpdate(root: string, output: vscode.OutputChannel): Promise<void> {
  const cli = new SvnCli(output);
  const target = vscode.Uri.file(path.join(root, '稀疏 update@depth test'));
  const fullTarget = path.join(root, 'interaction fixture', '合并 target@team');
  const info = parseInfoXml((await cli.run(['info', '--xml', '--', escapeSvnTarget(fullTarget)])).stdout);
  await cli.run(['checkout', '--revision', '2', '--depth', 'files', '--', info.url, target.fsPath]);
  const repository = new SvnRepository(cli, target, output, () => {});
  const errors: string[] = [];
  const originalRun = cli.run.bind(cli);
  let updateArgs: readonly string[] = [];
  /** 记录传给真实 SVN 的更新深度。@param args SVN 参数。@param options 执行选项。 */
  cli.run = async (args, options) => {
    if (args[0] === 'update') { updateArgs = [...args]; }
    return originalRun(args, options);
  };
  try {
    for (const depth of [undefined, 'working', 'files', 'infinity']) {
      // 关键逻辑：每次先回到旧 revision，避免失败后仍停留在 HEAD 导致测试误通过。
      await cli.run(['update', '--revision', '2', '--', escapeSvnTarget(target.fsPath)]);
      const input = controlledUi(target);
      const restore = replaceWindow({ ...input.ui,
        showInformationMessage: (async (_message: string, options?: vscode.MessageOptions) => options?.modal ? '更新' : undefined) as typeof vscode.window.showInformationMessage,
        showErrorMessage: (async (message: string) => { errors.push(message); return undefined; }) as typeof vscode.window.showErrorMessage
      });
      try {
        const task = repository.update(undefined, depth !== undefined);
        if (depth !== undefined) {
          input.controls[0]!.acceptEvent.fire();
          await until(() => input.controls.length === 2);
          input.controls[1]!.activeItems = [input.controls[1]!.items.find((item) => item.value === depth)!];
          input.controls[1]!.acceptEvent.fire();
        }
        await task;
        assert.deepEqual(errors, [], '真实更新不应被 runOperation 捕获为错误后仍通过测试');
        const depthIndex = updateArgs.indexOf('--depth');
        if (depth === undefined || depth === 'working') {
          assert.equal(depthIndex, -1);
        } else {
          assert.notEqual(depthIndex, -1);
          assert.equal(updateArgs[depthIndex + 1], depth);
        }
        const xml = (await cli.run(['info', '--xml', '--', escapeSvnTarget(target.fsPath)])).stdout;
        assert.equal(parseInfoXml(xml).revision, info.revision, '更新必须实际推进到 HEAD');
        assert.ok(xml.includes('<depth>files</depth>'), '更新不能修改工作副本的持久深度');
        assert.equal(existsSync(path.join(target.fsPath, '子目录', 'guard.txt')), false, '操作深度不能擅自扩大稀疏检出范围');
      } finally {
        restore();
      }
    }
    console.log('通过：普通及高级更新真实成功，保持当前稀疏深度，显式深度仍生效');
  } finally {
    repository.dispose();
  }
}

/**
 * 验证预演文档可独立继续，取消不消费预演，重复点击和过期目标不会重复执行。
 * @param root 隔离测试目录。
 * @param output SVN 输出通道。
 */
async function testPreviewContinuation(root: string, output: vscode.OutputChannel): Promise<void> {
  const targetPath = path.join(root, 'interaction fixture', '合并 target@team');
  const sourcePath = path.join(root, 'interaction fixture', '合并 source@team');
  const cli = new SvnCli(output);
  const target = parseInfoXml((await cli.run(['info', '--xml', '--', escapeSvnTarget(targetPath)], { logStdout: false })).stdout);
  const source = parseInfoXml((await cli.run(['info', '--xml', '--', escapeSvnTarget(sourcePath)], { logStdout: false })).stdout);
  const head = parseInfoXml((await cli.run(['info', '--xml', '-r', 'HEAD', '--', `${source.url}@HEAD`], { logStdout: false })).stdout);
  const plan: SvnMergePlan = { sourceUrl: source.url, sourceRevision: head.revision, targetUrl: target.url, targetRevision: target.revision, repositoryUuid: target.repositoryUuid };
  const repository = new SvnRepository(cli, vscode.Uri.file(targetPath), output, () => {});
  let confirmation: () => Promise<string | undefined> = async () => undefined;
  let modalVisits = 0;
  const originalSelection = repository['selectMergeSource'].bind(repository);
  repository['selectMergeSource'] = async () => plan;
  const restore = replaceWindow({
    showInputBox: (async () => '') as typeof vscode.window.showInputBox,
    showWarningMessage: (async (_message: string, options?: vscode.MessageOptions) => {
      if (options?.modal) {
        modalVisits += 1;
        return confirmation();
      }
      return undefined;
    }) as typeof vscode.window.showWarningMessage,
    showInformationMessage: (async () => undefined) as typeof vscode.window.showInformationMessage,
    showErrorMessage: (async () => undefined) as typeof vscode.window.showErrorMessage
  });
  try {
    await repository.merge();
    const document = vscode.window.activeTextEditor!.document;
    const uri = document.uri;
    assert.equal(document.uri.scheme, MERGE_PREVIEW_SCHEME);
    assert.ok(document.uri.query, '预演 URI 必须包含会话标识以隔离重新加载前的缓存');
    assert.equal(document.isUntitled, false);
    assert.equal(document.isDirty, false);
    assert.ok(document.getText().includes('以下为 SVN 预演输出'), '文档必须读取到同一预演上下文');
    assert.equal(mergePreviews.get(uri)!.state, 'ready', '关闭通知后预演必须仍可继续');
    await repository.continueMerge(uri);
    assert.equal(mergePreviews.get(uri)!.state, 'ready');
    writeFileSync(path.join(sourcePath, '文件 with spaces.txt'), '预演之后的新修改\n');
    await cli.run(['commit', '-m', '预演之后继续提交', '--', escapeSvnTarget(sourcePath)]);
    let release!: (value: string | undefined) => void;
    confirmation = () => new Promise((resolve) => { release = resolve; });
    const first = repository.continueMerge(uri);
    assert.equal(mergePreviews.get(uri)!.state, 'running');
    await repository.continueMerge(uri);
    release('合并');
    await first;
    assert.equal(mergePreviews.get(uri)!.state, 'applied');
    assert.equal(readFileSync(path.join(targetPath, '文件 with spaces.txt'), 'utf8'), '分支修改一\n');
    await repository.continueMerge(uri);
    assert.equal(mergePreviews.get(uri)!.state, 'applied');
    confirmation = async () => '合并';
    const stale = mergePreviews.create(repository.root, { ...plan, targetUrl: `${plan.targetUrl}/changed` }, '旧目标');
    await repository.continueMerge(stale);
    assert.equal(mergePreviews.get(stale)!.state, 'invalid');
    const old = mergePreviews.create(repository.root, plan, '旧预演');
    mergePreviews.create(repository.root, plan, '新预演');
    assert.equal(mergePreviews.get(old)!.state, 'invalid');
    // 只验证正式命令入口路由并取消确认，不在原有测试工作副本执行合并。
    const routed = mergePreviews.create(vscode.workspace.workspaceFolders![0]!.uri, plan, '正式命令入口测试');
    confirmation = async () => undefined;
    const beforeRouting = modalVisits;
    await vscode.commands.executeCommand('yfSvn.continueMerge', routed);
    assert.equal(modalVisits, beforeRouting + 1);
    assert.equal(mergePreviews.get(routed)!.state, 'ready');
    console.log('通过：预演只读文档独立继续、取消保留、重复点击保护、来源快照及目标重检');
  } finally {
    repository['selectMergeSource'] = originalSelection;
    restore();
    repository.dispose();
  }
}

/**
 * 验证等待期间新增的冲突在提交真正出队后再次检查，并保留提交草稿。
 * @param workspace 隔离测试工作副本。
 * @param output SVN 输出通道。
 */
async function testQueuedCommit(workspace: vscode.Uri, output: vscode.OutputChannel): Promise<void> {
  const cli = new SvnCli(output);
  const repository = new SvnRepository(cli, workspace, output, () => {});
  const tracked = vscode.Uri.joinPath(workspace, 'tracked.txt');
  const originalRun = cli.run.bind(cli);
  const originalStatus = repository['readMergeStatus'].bind(repository);
  const mutations: string[] = [];
  let conflictAdded = false;
  /** 捕获是否真正执行了提交。@param args SVN 参数。@param options 执行选项。 */
  cli.run = async (args, options) => { if (args[0] === 'commit') { mutations.push(args[0]); } return originalRun(args, options); };
  const restore = replaceWindow({
    showInformationMessage: (async () => '提交') as typeof vscode.window.showInformationMessage,
    showErrorMessage: (async () => undefined) as typeof vscode.window.showErrorMessage
  });
  try {
    await repository.refresh();
    /** 模拟排队之前没有、出队时才出现的文本冲突。@param token 当前取消令牌。 */
    repository['readMergeStatus'] = async (token) => {
      const entries = await originalStatus(token);
      return conflictAdded ? entries.map((entry) => entry.absolutePath.toLowerCase() === tracked.fsPath.toLowerCase() ? { ...entry, item: 'conflicted' as const } : entry) : entries;
    };
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const began = new Promise<void>((resolve) => { started = resolve; });
    const preceding = repository['runOperation']('正在模拟前置操作', async () => { started(); await gate; conflictAdded = true; });
    await began;
    repository.sourceControl.inputBox.value = '需要保留的提交草稿';
    const committing = repository.commit([tracked]);
    await delay(20);
    release();
    await Promise.all([preceding, committing]);
    assert.deepEqual(mutations, []);
    assert.equal(repository.sourceControl.inputBox.value, '需要保留的提交草稿');
    console.log('通过：提交出队后重检新增冲突，阻止写入并保留提交草稿');
  } finally {
    restore();
    repository['readMergeStatus'] = originalStatus;
    cli.run = originalRun;
    repository.dispose();
  }
}

/**
 * 驱动真实命令使用的多步输入，确认返回内容保留且取消不执行写命令。
 * @param root 隔离测试目录。
 * @param workspace 测试工作副本。
 * @param output SVN 输出通道。
 */
async function testProductionForms(root: string, workspace: vscode.Uri, output: vscode.OutputChannel): Promise<void> {
  const cli = new SvnCli(output);
  const manager = new SvnManager(cli, output);
  const repository = new SvnRepository(cli, workspace, output, () => {});
  const mutations: string[] = [];
  const originalRun = cli.run.bind(cli);
  /** 观察取消之前是否发起写命令。@param args SVN 参数。@param options 执行选项。 */
  cli.run = async (args, options) => {
    if (['checkout', 'copy', 'switch', 'update'].includes(args[0]!)) {
      mutations.push(args[0]!);
    }
    return originalRun(args, options);
  };
  try {
    const checkoutUi = controlledUi(vscode.Uri.file(root));
    let restore = replaceWindow(checkoutUi.ui);
    try {
      const task = manager.checkout();
      checkoutUi.controls[0]!.value = 'https://example.com/svn/trunk';
      checkoutUi.controls[0]!.acceptEvent.fire();
      await until(() => checkoutUi.controls.length === 2);
      checkoutUi.controls[1]!.value = root;
      checkoutUi.controls[1]!.acceptEvent.fire();
      await until(() => checkoutUi.controls.length === 3);
      checkoutUi.controls[2]!.buttonEvent.fire(vscode.QuickInputButtons.Back);
      await until(() => checkoutUi.controls.length === 4);
      assert.equal(checkoutUi.controls[3]!.value, root);
      checkoutUi.controls[3]!.hideEvent.fire();
      await task;
    } finally { restore(); }

    const branchUi = controlledUi(workspace);
    restore = replaceWindow(branchUi.ui);
    try {
      const task = repository.branchOrTag();
      await until(() => branchUi.controls.length === 1);
      branchUi.controls[0]!.activeItems = [branchUi.controls[0]!.items.find((item) => item.value === 'tags')!];
      branchUi.controls[0]!.acceptEvent.fire();
      await until(() => branchUi.controls.length === 2);
      assert.ok(branchUi.controls[1]!.value.endsWith('/tags/'));
      branchUi.controls[1]!.value = 'https://example.com/svn/tags/draft';
      branchUi.controls[1]!.buttonEvent.fire(vscode.QuickInputButtons.Back);
      await until(() => branchUi.controls.length === 3);
      assert.equal(branchUi.controls[2]!.activeItems[0]!.value, 'tags');
      branchUi.controls[2]!.acceptEvent.fire();
      await until(() => branchUi.controls.length === 4);
      assert.equal(branchUi.controls[3]!.value, 'https://example.com/svn/tags/draft');
      branchUi.controls[3]!.hideEvent.fire();
      await task;
    } finally { restore(); }

    const switchUi = controlledUi(workspace);
    restore = replaceWindow(switchUi.ui);
    try {
      const task = repository.switchBranch();
      await until(() => switchUi.controls.length === 1);
      switchUi.controls[0]!.value = 'https://example.com/svn/branches/other';
      switchUi.controls[0]!.acceptEvent.fire();
      await until(() => switchUi.controls.length === 2);
      switchUi.controls[1]!.value = '3';
      switchUi.controls[1]!.buttonEvent.fire(vscode.QuickInputButtons.Back);
      await until(() => switchUi.controls.length === 3);
      assert.equal(switchUi.controls[2]!.value, 'https://example.com/svn/branches/other');
      switchUi.controls[2]!.hideEvent.fire();
      await task;
    } finally { restore(); }

    const advancedUi = controlledUi(workspace);
    let detail = '';
    restore = replaceWindow({ ...advancedUi.ui,
      showInformationMessage: (async (_message: string, options?: vscode.MessageOptions) => { detail = options?.detail ?? ''; return undefined; }) as typeof vscode.window.showInformationMessage
    });
    try {
      const task = repository.update(undefined, true);
      advancedUi.controls[0]!.value = '3';
      advancedUi.controls[0]!.acceptEvent.fire();
      await until(() => advancedUi.controls.length === 2);
      advancedUi.controls[1]!.activeItems = [advancedUi.controls[1]!.items.find((item) => item.value === 'files')!];
      advancedUi.controls[1]!.buttonEvent.fire(vscode.QuickInputButtons.Back);
      await until(() => advancedUi.controls.length === 3);
      assert.equal(advancedUi.controls[2]!.value, '3');
      advancedUi.controls[2]!.acceptEvent.fire();
      await until(() => advancedUi.controls.length === 4);
      assert.equal(advancedUi.controls[3]!.activeItems[0]!.value, 'files');
      advancedUi.controls[3]!.acceptEvent.fire();
      await task;
      assert.ok(detail.includes('files'));
    } finally { restore(); }
    assert.deepEqual(mutations, []);
    console.log('通过：检出、分支、切换和高级更新的真实输入流程可返回，取消不执行写命令');
  } finally {
    manager.dispose();
    repository.dispose();
  }
}

/**
 * 验证错误恢复按钮由用户明确选择，清理再次确认，关闭提示不会执行任何命令。
 * @param workspace 测试工作副本。
 * @param output SVN 输出通道。
 */
async function testErrorRecovery(workspace: vscode.Uri, output: vscode.OutputChannel): Promise<void> {
  let choice: string | undefined;
  let confirmed: string | undefined;
  let actions: string[] = [];
  const calls: string[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(vscode.commands, 'executeCommand')!;
  const restore = replaceWindow({
    showErrorMessage: (async (_message: string, ...items: unknown[]) => { actions = items.filter((item): item is string => typeof item === 'string'); return choice; }) as typeof vscode.window.showErrorMessage,
    showWarningMessage: (async () => confirmed) as typeof vscode.window.showWarningMessage
  });
  Object.defineProperty(vscode.commands, 'executeCommand', { configurable: true, writable: true,
    value: async (command: string) => { calls.push(command); }
  });
  try {
    showSvnError(new Error('svn: E155004: Working copy locked'), output, workspace);
    await delay(20);
    assert.ok(actions.includes('清理工作副本…'));
    assert.deepEqual(calls, []);
    choice = '清理工作副本…';
    showSvnError(new Error('svn: E155004: Working copy locked'), output, workspace);
    await delay(20);
    assert.deepEqual(calls, [], '取消清理确认时不能执行清理');
    confirmed = '清理';
    showSvnError(new Error('svn: E155004: Working copy locked'), output, workspace);
    await until(() => calls.length === 1);
    assert.deepEqual(calls, ['yfSvn.cleanup']);
    choice = undefined;
    showSvnError(new Error('svn: E170001: Authentication failed'), output, workspace);
    await delay(20);
    assert.ok(actions.includes('打开 SVN 设置'));
    assert.equal(calls.length, 1);
    showSvnError(new Error('svn: E155004: Working copy locked'), output);
    await delay(20);
    assert.equal(actions.includes('清理工作副本…'), false, '未知工作副本时不提供写操作入口');
    console.log('通过：错误恢复提供对应入口，关闭不重试写操作，清理需明确选择及确认');
  } finally {
    Object.defineProperty(vscode.commands, 'executeCommand', descriptor);
    restore();
  }
}

/**
 * 捕获真实队列进度并验证取消仍在等待的操作不会进入执行阶段。
 * @param workspace 隔离测试工作副本。
 * @param output SVN 输出通道。
 */
async function testQueueProgress(workspace: vscode.Uri, output: vscode.OutputChannel): Promise<void> {
  const repository = new SvnRepository(new SvnCli(output), workspace, output, () => {});
  const reports: string[][] = [];
  const tokens: vscode.CancellationTokenSource[] = [];
  const restore = replaceWindow({
    withProgress: (async (options: vscode.ProgressOptions, task: (progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) => Thenable<unknown>) => {
      assert.ok(options.title?.includes(path.basename(workspace.fsPath)));
      const messages: string[] = [];
      reports.push(messages);
      const token = new vscode.CancellationTokenSource();
      tokens.push(token);
      return task({ report: (value) => { messages.push(value.message ?? ''); } }, token.token);
    }) as typeof vscode.window.withProgress
  });
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = repository['runOperation']('正在测试第一项', async () => { await gate; return true; });
    await until(() => reports[0]!.includes('正在执行'));
    let executed = false;
    const second = repository['runOperation']('正在测试第二项', async () => { executed = true; });
    assert.deepEqual(reports[1], ['等待前一项操作完成']);
    tokens[1]!.cancel();
    release();
    await Promise.all([first, second]);
    assert.equal(executed, false);
    assert.deepEqual(reports[0], ['等待前一项操作完成', '正在执行', '正在刷新状态']);
    assert.deepEqual(reports[1], ['等待前一项操作完成']);
    console.log('通过：工作副本进度区分等待、执行、刷新，排队取消不进入执行');
  } finally {
    restore();
    tokens.forEach((token) => token.dispose());
    repository.dispose();
  }
}
