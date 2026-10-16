import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as vscode from 'vscode';
import { testNativeUi } from './nativeUi';
import { createSvnContentUri } from '../../contentProvider';
import { SvnRepository } from '../../repository';
import { SvnCli, SvnCommandError } from '../../svnCli';
import { escapeSvnTarget } from '../../svnTarget';
import { SvnMergePlan } from '../../merge';
import { parseInfoXml } from '../../xml';
import { SvnManager } from '../../manager';
import { SvnLogRange } from '../../logPagination';
import { testInteractions } from './interactions';

/**
 * 为进程取消及日志测试复用真实 CLI 执行器，仅替换为可控的 Node 可执行程序。
 */
class NodeTestCli extends SvnCli {
  /** 获取宿主启动脚本传入的 Node.exe，所有进程仍由 SvnCli 启动。 */
  public override get executable(): string {
    return process.env.YF_SVN_TEST_NODE!;
  }
}

/**
 * 等待测试子进程写出 PID，保证取消发生在进程启动之后。
 *
 * @param file 子进程写入 PID 的文件。
 * @returns 已启动子进程的 PID。
 */
async function waitForPid(file: string): Promise<number> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      return Number(readFileSync(file, 'utf8'));
    }
    await delay(20);
  }
  throw new Error('测试子进程未在期限内启动。');
}

/**
 * 在真实 VS Code 扩展宿主中验证激活、SCM、菜单数据、操作收尾和进程生命周期。
 */
export async function run(): Promise<void> {
  const root = process.env.YF_SVN_TEST_ROOT!;
  const workspace = vscode.workspace.workspaceFolders![0]!.uri;
  const extension = vscode.extensions.getExtension('yf.yf-svn');
  assert.ok(extension, '开发扩展应当可见');
  await extension.activate();
  assert.equal(extension.isActive, true);
  const commands = new Set(await vscode.commands.getCommands(true));
  const manifest = extension.packageJSON;
  for (const entry of manifest.contributes.commands) {
    assert.ok(commands.has(entry.command), `未注册命令：${entry.command}`);
  }
  for (const menu of Object.values(manifest.contributes.menus) as Array<Array<{ command?: string }>>) {
    for (const entry of menu) {
      if (entry.command) {
        assert.ok(commands.has(entry.command), `菜单引用了未注册命令：${entry.command}`);
      }
    }
  }
  console.log('通过：真实扩展激活、命令与菜单注册');

  const channel = vscode.window.createOutputChannel('YF SVN 宿主测试');
  const messages: string[] = [];
  const output: vscode.OutputChannel = {
    ...channel,
    /** 记录测试日志并写入真实输出通道。@param value 待记录的诊断文本。 */
    appendLine: (value: string): void => { messages.push(value); channel.appendLine(value); },
    show: channel.show.bind(channel)
  };
  const cli = new SvnCli(output);
  let refreshCount = 0;
  const repository = new SvnRepository(cli, workspace, output, () => { refreshCount += 1; });
  try {
    await repository.refresh();
    const tracked = vscode.Uri.joinPath(workspace, 'tracked.txt');
    const untracked = vscode.Uri.joinPath(workspace, '新增 file.txt');
    assert.equal(repository.sourceControl.count, 2);
    assert.equal(repository.getStatus(tracked)?.item, 'modified');
    assert.deepEqual(repository['changes'].resourceStates.map((state) => state.resourceUri.fsPath), [tracked.fsPath]);
    assert.deepEqual(repository['unversioned'].resourceStates.map((state) => state.resourceUri.fsPath), [untracked.fsPath]);
    const context = repository.getMenuContextResources();
    assert.ok(context.committable.some((uri) => uri.toString() === tracked.toString()));
    assert.ok(context.addable.some((uri) => uri.toString() === untracked.toString()));
    const base = await vscode.workspace.openTextDocument(createSvnContentUri(tracked, 'BASE'));
    assert.equal(base.getText(), '初始内容\n');
    console.log('通过：真实 SCM 状态、菜单能力与 BASE 虚拟文档');

    // 关键逻辑：给第一条 add 设置闸门，确定第二条写命令在第一条及刷新之前不会启动。
    const originalRun = cli.run.bind(cli);
    const events: string[] = [];
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const firstFile = vscode.Uri.joinPath(workspace, 'queued one.txt');
    const secondFile = vscode.Uri.joinPath(workspace, 'queued two.txt');
    writeFileSync(firstFile.fsPath, '第一项');
    writeFileSync(secondFile.fsPath, '第二项');
    /** 拦截写命令以验证顺序，实际仍执行 SVN。@param args SVN 参数。@param options 执行选项。 */
    cli.run = async (args, options) => {
      events.push(args[0]!);
      if (args[0] === 'add' && args.includes(escapeSvnTarget(firstFile.fsPath))) {
        started();
        await gate;
      }
      return originalRun(args, options);
    };
    const first = repository.add([firstFile]);
    await firstStarted;
    const second = repository.add([secondFile]);
    try {
      await delay(30);
      assert.deepEqual(events, ['add']);
    } finally {
      release();
      await Promise.all([first, second]);
      cli.run = originalRun;
    }
    assert.deepEqual(events, ['add', 'status', 'add', 'status']);
    assert.equal(repository.getStatus(secondFile)?.item, 'added');
    console.log('通过：同一工作副本写操作及刷新串行执行');

    const partial = vscode.Uri.joinPath(workspace, 'partial.txt');
    writeFileSync(partial.fsPath, '部分成功');
    const beforeFailure = refreshCount;
    await repository.add([partial, vscode.Uri.joinPath(workspace, 'missing.txt')]);
    assert.equal(repository.getStatus(partial)?.item, 'added');
    assert.ok(refreshCount > beforeFailure, '写操作失败后必须刷新');
    assert.ok(messages.some((message) => message.startsWith('[错误]')));

    // 仅测试共用收尾入口，不为测试增加生产公开 API。
    const runOperation = repository['runOperation'].bind(repository);
    const canceled = vscode.Uri.joinPath(workspace, 'canceled.txt');
    writeFileSync(canceled.fsPath, '取消前的部分修改');
    const beforeCancel = refreshCount;
    const errorCount = messages.filter((message) => message.startsWith('[错误]')).length;
    await runOperation('测试取消后的刷新', async (token) => {
      await cli.run(['add', '--', escapeSvnTarget(canceled.fsPath)], { token });
      throw new vscode.CancellationError();
    });
    assert.equal(repository.getStatus(canceled)?.item, 'added');
    assert.ok(refreshCount > beforeCancel);
    assert.equal(messages.filter((message) => message.startsWith('[错误]')).length, errorCount);
    console.log('通过：部分失败及取消后刷新状态');

    const originalRefreshCore = repository['refreshCore'].bind(repository);
    /** 模拟实际状态扫描失败，验证公共刷新处理不会覆盖写操作结果。 */
    repository['refreshCore'] = async () => { throw new Error('测试刷新失败'); };
    try {
      assert.equal(await runOperation('测试成功与刷新失败', async () => true), true);
      await runOperation('测试原始错误保留', async () => { throw new Error('原始写操作错误'); });
      assert.ok(messages.includes('[错误] 原始写操作错误'));
      assert.ok(messages.some((message) => message.startsWith('[刷新失败]') && message.endsWith('测试刷新失败')));
      assert.ok(repository.sourceControl.statusBarCommands?.[0]?.title.includes('状态已过期'));
      assert.ok(repository.sourceControl.statusBarCommands?.[0]?.title.includes(path.basename(workspace.fsPath)));
      assert.deepEqual(repository.sourceControl.statusBarCommands?.[0]?.arguments, [workspace]);
    } finally {
      repository['refreshCore'] = originalRefreshCore;
    }
    await repository.add([untracked]);
    assert.equal(repository.getStatus(untracked)?.item, 'added');
    assert.ok(repository.sourceControl.statusBarCommands?.[0]?.title.includes('项'));
    assert.equal(repository.sourceControl.statusBarCommands?.[0]?.title.includes('状态已过期'), false);
    console.log('通过：刷新失败保留原结果，队列在失败后继续工作');

    await testProcessLifecycle(root, output, messages);
    await testMergeWorkflow(root, output, messages);
    await testFilteredLog(root, output);
    await testRefreshRecovery(workspace, output);
    await testInteractions(root, workspace, output);
    await testNativeUi(workspace, output);
    writeFileSync(path.join(root, 'host-passed'), 'passed');
    console.log(`扩展宿主冒烟测试全部通过（VS Code ${vscode.version}）`);
  } finally {
    repository.dispose();
    channel.dispose();
  }
}

/**
 * 验证作者筛选在连续空匹配页、升降序范围、日期范围及取消时保持正确游标。
 *
 * @param root 当前宿主测试的隔离目录。
 * @param output SVN 命令输出通道。
 */
async function testFilteredLog(root: string, output: vscode.OutputChannel): Promise<void> {
  const sourcePath = path.join(root, '合并 source@team');
  const cli = new SvnCli(output);
  const info = parseInfoXml((await cli.run(['info', '--xml', '--', escapeSvnTarget(sourcePath)], { logStdout: false })).stdout);
  const head = parseInfoXml((await cli.run(['info', '--xml', '-r', 'HEAD', '--', `${info.url}@HEAD`], { logStdout: false })).stdout);
  const expected: bigint[] = [];
  for (let index = 1; index <= 24; index += 1) {
    const author = [2, 14, 24].includes(index) ? 'alice' : 'bob';
    writeFileSync(path.join(sourcePath, '文件 with spaces.txt'), `历史分页内容 ${index}\n`);
    await cli.run(['commit', '--username', author, '-m', '提交说明也提及 alice，但只按真实作者筛选', '--', escapeSvnTarget(sourcePath)]);
    if (author === 'alice') {
      expected.push(BigInt(head.revision) + BigInt(index));
    }
  }
  const repository = new SvnRepository(cli, vscode.Uri.file(sourcePath), output, () => {});
  const token = new vscode.CancellationTokenSource();
  try {
    const resolved = await repository['resolveLogRange'](`HEAD:${BigInt(head.revision) + 12n}`, info.repositoryRoot, token.token);
    const expectedSubset = expected.filter((revision) => revision >= resolved.range.end);
    const targetUrl = `${info.url}@${resolved.headRevision}`;
    for (const range of [resolved.range, { start: resolved.range.end, end: resolved.range.start }]) {
      let current: SvnLogRange | undefined = range;
      const revisions: bigint[] = [];
      let pages = 0;
      while (current) {
        assert.ok(pages++ < 30, '分页必须终止');
        const page = await repository['readLogPage'](targetUrl, current, 'ALICE', 3, token.token);
        assert.ok(page.entries.every((entry) => entry.author === 'alice'));
        revisions.push(...page.entries.map((entry) => BigInt(entry.revision)));
        current = page.nextRange;
      }
      assert.deepEqual(revisions, range.start > range.end ? [...expectedSubset].reverse() : expectedSubset);
      assert.equal(new Set(revisions).size, revisions.length, '跨页不能出现重复 revision');
    }
    const dates = await repository['resolveLogRange']('{2000-01-01}:{2099-01-01}', info.repositoryRoot, token.token);
    assert.equal(dates.range.start, 0n);
    assert.equal(dates.range.end, BigInt(resolved.headRevision));
    const dated: bigint[] = [];
    let dateRange: SvnLogRange | undefined = dates.range;
    while (dateRange) {
      const page = await repository['readLogPage'](targetUrl, dateRange, 'alice', 3, token.token);
      dated.push(...page.entries.map((entry) => BigInt(entry.revision)));
      dateRange = page.nextRange;
    }
    assert.deepEqual(dated, expected);
    token.cancel();
    await assert.rejects(repository['readLogPage'](targetUrl, resolved.range, 'alice', 3, token.token), (error) => error instanceof vscode.CancellationError);
    console.log('通过：真实 SVN 作者筛选跨空页、升降序及日期边界分页，无重复遗漏且支持取消');
  } finally {
    token.dispose();
    repository.dispose();
  }
}

/**
 * 验证手动及自动刷新失败保留旧状态、提示重试，并在成功后清除过期标记。
 *
 * @param workspace 当前测试工作副本。
 * @param output SVN 命令输出通道。
 */
async function testRefreshRecovery(workspace: vscode.Uri, output: vscode.OutputChannel): Promise<void> {
  const cli = new SvnCli(output);
  const manager = new SvnManager(cli, output);
  const repository = new SvnRepository(cli, workspace, output, () => {});
  manager['repositories'].set(workspace.fsPath, repository);
  const configuration = vscode.workspace.getConfiguration('yfSvn');
  const oldAutoRefresh = configuration.inspect<boolean>('autoRefresh')?.globalValue;
  const originalCore = repository['refreshCore'].bind(repository);
  let attempts = 0;
  try {
    await repository.refresh();
    const before = repository.sourceControl.count;
    /** 模拟连续扫描失败以覆盖手动刷新与文件事件刷新。 */
    repository['refreshCore'] = async () => { attempts += 1; throw new Error('模拟自动及手动刷新失败'); };
    await manager.refreshAll();
    assert.equal(repository.sourceControl.count, before, '失败时保留上次状态');
    assert.equal(repository['refreshFailed'], true);
    assert.equal(repository.sourceControl.statusBarCommands?.[0]?.command, 'yfSvn.refresh');
    await configuration.update('autoRefresh', true, vscode.ConfigurationTarget.Global);
    manager['scheduleRefresh'](workspace);
    const deadline = Date.now() + 5000;
    while (attempts < 2 && Date.now() < deadline) {
      await delay(20);
    }
    assert.ok(attempts >= 2, '自动刷新必须触发同一失败处理');
    assert.equal(repository['refreshFailed'], true);
    repository['refreshCore'] = originalCore;
    await manager.refreshAll();
    assert.equal(repository['refreshFailed'], false);
    assert.equal(repository.sourceControl.statusBarCommands?.[0]?.title.includes('状态已过期'), false);
    assert.ok(repository.sourceControl.statusBarCommands?.[0]?.tooltip?.includes(`工作副本：${workspace.fsPath}`));
    console.log('通过：手动与自动刷新失败保留状态、显示过期及重试入口，恢复后清除标记');
  } finally {
    repository['refreshCore'] = originalCore;
    await configuration.update('autoRefresh', oldAutoRefresh, vscode.ConfigurationTarget.Global);
    manager.dispose();
  }
}

/**
 * 在真实扩展宿主中验证合并保护、来源固定、队列重检及冲突分组。
 *
 * @param root 宿主启动器准备的隔离测试目录。
 * @param output 记录真实 SVN 命令的输出通道。
 * @param messages 已捕获的日志列表。
 */
async function testMergeWorkflow(root: string, output: vscode.OutputChannel, messages: string[]): Promise<void> {
  const targetPath = path.join(root, '合并 target@team');
  const sourcePath = path.join(root, '合并 source@team');
  const targetUri = vscode.Uri.file(targetPath);
  const file = vscode.Uri.joinPath(targetUri, '文件 with spaces.txt');
  const guard = vscode.Uri.joinPath(targetUri, '子目录', 'guard.txt');
  const cli = new SvnCli(output);
  const repository = new SvnRepository(cli, targetUri, output, () => {});
  const configuration = vscode.workspace.getConfiguration('yfSvn');
  const oldDepth = configuration.inspect<string>('statusDepth')?.globalValue;
  try {
    const target = parseInfoXml((await cli.run(['info', '--xml', '--', escapeSvnTarget(targetPath)], { logStdout: false })).stdout);
    const source = parseInfoXml((await cli.run(['info', '--xml', '--', escapeSvnTarget(sourcePath)], { logStdout: false })).stdout);
    const head = parseInfoXml((await cli.run(['info', '--xml', '-r', 'HEAD', '--', `${source.url}@HEAD`], { logStdout: false })).stdout);
    const plan: SvnMergePlan = {
      sourceUrl: source.url, sourceRevision: head.revision,
      targetUrl: target.url, targetRevision: target.revision,
      repositoryUuid: target.repositoryUuid
    };
    const preview = await repository['performMerge'](plan, true);
    assert.ok(preview, '预演必须成功');
    assert.equal(readFileSync(file.fsPath, 'utf8'), '初始内容\n');
    assert.equal(repository.sourceControl.count, 0, '预演不能产生本地修改');

    await configuration.update('statusDepth', 'empty', vscode.ConfigurationTarget.Global);
    writeFileSync(guard.fsPath, '深层未提交修改\n');
    assert.equal(await repository['performMerge'](plan, false), undefined);
    assert.ok(messages.some((message) => message.includes('[错误] 工作副本存在未提交')));
    assert.equal(readFileSync(file.fsPath, 'utf8'), '初始内容\n');
    writeFileSync(guard.fsPath, '深层文件\n');

    const document = await vscode.workspace.openTextDocument(guard);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(guard, new vscode.Position(0, 0), '尚未保存的编辑');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(document.isDirty, true);
    assert.equal(await repository['performMerge'](plan, false), undefined);
    assert.ok(messages.some((message) => message.includes('[错误] 工作副本存在尚未保存')));
    const reset = new vscode.WorkspaceEdit();
    reset.replace(guard, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), '深层文件\n');
    await vscode.workspace.applyEdit(reset);
    assert.equal(await document.save(), true);

    // 关键逻辑：在合并前排入一个写操作，验证保护检查发生在真正出队之后。
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const start = new Promise<void>((resolve) => { started = resolve; });
    const preceding = repository['runOperation']('测试合并前的排队修改', async (token) => {
      started();
      await gate;
      await cli.run(['propset', 'test:queued', 'changed', '--', escapeSvnTarget(targetPath)], { token });
    });
    await start;
    const waitingMerge = repository['performMerge'](plan, false);
    release();
    await preceding;
    assert.equal(await waitingMerge, undefined);
    assert.equal(readFileSync(file.fsPath, 'utf8'), '初始内容\n');
    await cli.run(['revert', '--depth', 'infinity', '--', escapeSvnTarget(targetPath)]);
    await configuration.update('statusDepth', 'infinity', vscode.ConfigurationTarget.Global);
    assert.equal(await repository['performMerge']({ ...plan, targetUrl: `${plan.targetUrl}/changed` }, false), undefined);
    assert.ok(messages.some((message) => message.includes('[错误] 目标工作副本的 URL 或 revision 已变化')));
    console.log('通过：浅层配置下的深层修改、未保存内容、出队重检和目标切换保护');

    // 预演之后来源继续提交，实际执行必须保持先前的来源快照。
    writeFileSync(path.join(sourcePath, '文件 with spaces.txt'), '分支修改二\n');
    await cli.run(['commit', '-m', '预演之后继续修改来源', '--', escapeSvnTarget(sourcePath)]);
    const actual = await repository['performMerge'](plan, false);
    assert.ok(actual);
    assert.equal(actual.conflicts, false);
    assert.equal(readFileSync(file.fsPath, 'utf8'), '分支修改一\n');
    assert.equal(repository.getStatus(file)?.item, 'modified');
    const directoryState = repository['changes'].resourceStates.find((state) => state.resourceUri.toString() === targetUri.toString())!;
    assert.equal(repository.getStatus(targetUri)?.kind, 'dir');
    assert.equal(/\b(lockable|unlockable|blamable|changelistable)\b/.test(directoryState.contextValue!), false);
    const merged = await cli.run(['mergeinfo', '--show-revs', 'merged', '--', `${plan.sourceUrl}@HEAD`, escapeSvnTarget(targetPath)]);
    assert.ok(merged.stdout.split(/\r?\n/).includes(`r${plan.sourceRevision}`));
    const currentSource = parseInfoXml((await cli.run(['info', '--xml', '-r', 'HEAD', '--', `${plan.sourceUrl}@HEAD`], { logStdout: false })).stdout);
    const originalSelection = repository['selectMergeSource'].bind(repository);
    /** 复用已固定的来源，跳过手工输入框以测试真实 Mergeinfo 命令和编辑器文档。 */
    repository['selectMergeSource'] = async () => ({ ...plan, sourceRevision: currentSource.revision });
    try {
      await repository.showMergeinfo();
      const text = vscode.window.activeTextEditor!.document.getText();
      assert.ok(text.startsWith('SVN Mergeinfo\n'));
      // SVN 也可能列出分支创建 revision，因此检查列表成员，不假定首项就是修改 revision。
      const normalized = text.replace(/\r\n/g, '\n');
      const mergedLines = normalized.split('\n\n已合并 revision\n')[1]!.split('\n\n')[0]!.split('\n');
      const eligibleLines = normalized.split('\n\n尚未合并 revision\n')[1]!.split('\n\n')[0]!.split('\n');
      assert.ok(mergedLines.includes(`r${plan.sourceRevision}`), text);
      assert.ok(eligibleLines.includes(`r${currentSource.revision}`), text);
    } finally {
      repository['selectMergeSource'] = originalSelection;
    }
    await cli.run(['commit', '-m', '提交宿主测试合并', '--', escapeSvnTarget(targetPath)]);
    await cli.run(['update', '--', escapeSvnTarget(targetPath)]);

    writeFileSync(file.fsPath, '主干修改\n');
    await cli.run(['commit', '-m', '准备合并冲突', '--', escapeSvnTarget(targetPath)]);
    await cli.run(['update', '--', escapeSvnTarget(targetPath)]);
    const latestTarget = parseInfoXml((await cli.run(['info', '--xml', '--', escapeSvnTarget(targetPath)], { logStdout: false })).stdout);
    const latestSource = parseInfoXml((await cli.run(['info', '--xml', '-r', 'HEAD', '--', `${plan.sourceUrl}@HEAD`], { logStdout: false })).stdout);
    const conflict = await repository['performMerge']({ ...plan, sourceRevision: latestSource.revision, targetRevision: latestTarget.revision }, false);
    assert.equal(conflict?.conflicts, true);
    assert.equal(repository.getStatus(file)?.item, 'conflicted');
    assert.equal(repository['conflicts'].resourceStates.length, 1);
    assert.equal(await repository['performMerge']({ ...plan, sourceRevision: latestSource.revision, targetRevision: latestTarget.revision }, false), undefined);
    assert.ok(messages.some((message) => message.includes('[错误] 工作副本存在未解决冲突')));
    writeFileSync(file.fsPath, '人工合并完成\n');
    await cli.run(['resolve', '--accept', 'working', '--', escapeSvnTarget(file.fsPath)]);
    await cli.run(['commit', '-m', '提交解决后的合并', '--', escapeSvnTarget(targetPath)]);
    await repository.refresh();
    assert.equal(repository['conflicts'].resourceStates.length, 0);
    assert.equal(repository.sourceControl.count, 0);
    console.log('通过：真实合并预演、来源固定、Mergeinfo、冲突分组、解决及提交');

    await cli.run(['update', '--', escapeSvnTarget(targetPath)]);
    const finalTarget = parseInfoXml((await cli.run(['info', '--xml', '--', escapeSvnTarget(targetPath)], { logStdout: false })).stdout);
    const finalSource = parseInfoXml((await cli.run(['info', '--xml', '-r', 'HEAD', '--', `${plan.sourceUrl}@HEAD`], { logStdout: false })).stdout);
    const originalRun = cli.run.bind(cli);
    let mergeFinished = false;
    let statusFailed = false;
    /** 模拟合并成功后的状态读取失败。@param args SVN 参数。@param options 执行选项。 */
    cli.run = async (args, options) => {
      if (args[0] === 'status' && mergeFinished && !statusFailed) {
        statusFailed = true;
        throw new Error('模拟合并后状态读取失败');
      }
      const result = await originalRun(args, options);
      if (args[0] === 'merge') {
        mergeFinished = true;
      }
      return result;
    };
    try {
      const result = await repository['performMerge']({ ...plan, sourceRevision: finalSource.revision, targetRevision: finalTarget.revision }, false);
      assert.ok(result, '合并后的状态读取失败不能覆盖已完成的合并结果');
      assert.equal(result.conflicts, undefined);
      assert.ok(messages.includes('[合并状态检查失败] 模拟合并后状态读取失败'));
    } finally {
      cli.run = originalRun;
    }
    console.log('通过：合并完成后状态读取失败仍保留实际合并结果');
  } finally {
    await configuration.update('statusDepth', oldDepth, vscode.ConfigurationTarget.Global);
    repository.dispose();
  }
}

/**
 * 使用真实子进程验证提前取消、运行中取消、超时和错误脱敏。
 *
 * @param root 本轮测试的隔离临时目录。
 * @param output 测试使用的输出通道。
 * @param messages 已捕获的日志列表。
 */
async function testProcessLifecycle(root: string, output: vscode.OutputChannel, messages: string[]): Promise<void> {
  const cli = new NodeTestCli(output);
  const source = new vscode.CancellationTokenSource();
  const pidFile = path.join(root, 'canceled.pid');
  const script = `require('node:fs').writeFileSync(process.argv.at(-1), String(process.pid)); setInterval(() => {}, 1000);`;
  const args = ['-e', script, '--', '--non-interactive', pidFile];
  const result = cli.run(args, { token: source.token, timeout: 10_000 });
  // 提前安装拒绝处理器，避免取消与断言之间出现未处理的拒绝。
  const rejected = assert.rejects(result, (error) => error instanceof vscode.CancellationError);
  try {
    const pid = await waitForPid(pidFile);
    source.cancel();
    await rejected;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    const logCount = messages.length;
    await assert.rejects(cli.run(args, { token: source.token }), (error) => error instanceof vscode.CancellationError);
    assert.equal(messages.length, logCount, '已取消令牌不得再启动进程或记录新命令');
  } finally {
    source.cancel();
    source.dispose();
    await rejected;
  }

  const timeoutFile = path.join(root, 'timeout.pid');
  await assert.rejects(cli.run(['-e', script, '--', '--non-interactive', timeoutFile], { timeout: 1500 }), /执行超过/);
  const timeoutPid = Number(readFileSync(timeoutFile, 'utf8'));
  assert.throws(() => process.kill(timeoutPid, 0), { code: 'ESRCH' });
  console.log('通过：取消与超时等待子进程退出，已取消令牌不启动进程');

  const secret = 'host-test-secret';
  await assert.rejects(cli.run([
    '-e', 'process.stderr.write("svn: E170001: " + process.argv.at(-1)); process.exit(1);',
    '--', '--non-interactive', `svn+ssh://tester:${secret}@example.com/repo`
  ]), (error) => error instanceof SvnCommandError && !error.message.includes(secret));
  assert.equal(messages.join('\n').includes(secret), false);
  console.log('通过：真实命令日志、错误输出与错误摘要脱敏');
}
