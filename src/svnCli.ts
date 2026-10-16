import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import { SvnCommandResult } from './types';
import { redactArguments, redactText } from './redact';

/**
 * 表示一次 SVN 命令执行失败。
 */
export class SvnCommandError extends Error {
  /**
   * 创建 SVN 命令错误。
   *
   * @param message 面向用户的错误说明。
   * @param result 命令返回的标准输出、错误输出和退出码。
   */
  public constructor(
    message: string,
    public readonly result: SvnCommandResult
  ) {
    super(message);
    this.name = 'SvnCommandError';
  }
}

/**
 * 以参数数组安全执行本机 svn.exe，并统一处理超时、取消和日志脱敏。
 */
export class SvnCli {
  /**
   * 创建 SVN CLI 适配器。
   *
   * @param output 用于记录脱敏命令和诊断信息的输出通道。
   */
  public constructor(private readonly output: vscode.OutputChannel) {}

  /**
   * 获取设置中的 SVN 可执行文件路径。
   *
   * @returns svn.exe 完整路径或命令名。
   */
  public get executable(): string {
    return vscode.workspace.getConfiguration('yfSvn').get<string>('path', 'svn');
  }

  /**
   * 检查 SVN CLI 是否可执行且版本不低于 1.10。
   *
   * @param token 可选的 VS Code 取消令牌。
   * @returns SVN 版本字符串。
   */
  public async ensureSupportedVersion(token?: vscode.CancellationToken): Promise<string> {
    const result = await this.run(['--version', '--quiet'], {
      allowNonWorkingCopy: true,
      token
    });
    const version = result.stdout.trim();
    const match = /^(\d+)\.(\d+)/.exec(version);
    if (!match || Number(match[1]) < 1 || (Number(match[1]) === 1 && Number(match[2]) < 10)) {
      throw new Error(`需要 SVN CLI 1.10 或更高版本，当前版本：${version || '无法识别'}`);
    }
    return version;
  }

  /**
   * 执行 SVN 命令。
   *
   * @param args 不含 svn.exe 的命令参数数组。
   * @param options 工作目录、取消令牌、日志和错误处理选项。
   * @returns 命令执行结果。
   */
  public async run(
    args: readonly string[],
    options: {
      readonly cwd?: string;
      readonly token?: vscode.CancellationToken;
      readonly allowNonWorkingCopy?: boolean;
      readonly timeout?: number;
      readonly logStdout?: boolean;
    } = {}
  ): Promise<SvnCommandResult> {
    if (!vscode.workspace.isTrusted) {
      throw new Error('当前工作区尚未受信任，YF SVN 不会执行外部命令。');
    }
    if (options.token?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    const timeout =
      options.timeout ??
      vscode.workspace.getConfiguration('yfSvn').get<number>('timeout', 120_000);
    const commandArgs = args.includes('--non-interactive') ? [...args] : ['--non-interactive', ...args];
    const safeArgs = redactArguments(commandArgs);
    this.output.appendLine(`> ${redactText(this.executable)} ${safeArgs.join(' ')}`);

    return new Promise<SvnCommandResult>((resolve, reject) => {
      const child = spawn(this.executable, commandArgs, {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        env: {
          ...process.env,
          LANG: 'C',
          LC_ALL: 'C'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let finished = false;
      let interruption: Error | undefined;
      let cancellation: vscode.Disposable | undefined;

      // 关键逻辑：先终止进程，再由 close 事件结束 Promise，防止下一写操作抢先启动。
      const timeoutHandle = setTimeout(() => {
        if (!finished && !interruption) {
          interruption = new Error(`SVN 命令执行超过 ${timeout} 毫秒，已终止。`);
          child.kill();
        }
      }, timeout);
      /** 收到取消请求时终止进程，并等待 close 释放工作副本写入占用。 */
      const cancel = (): void => {
        if (!finished && !interruption) {
          interruption = new vscode.CancellationError();
          clearTimeout(timeoutHandle);
          child.kill();
        }
      };
      cancellation = options.token?.onCancellationRequested(cancel);
      // 关键逻辑：补查启动与监听注册之间的取消，已取消令牌不会再启动后续命令。
      if (options.token?.isCancellationRequested) {
        cancel();
      }

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.once('error', (error) => {
        finished = true;
        clearTimeout(timeoutHandle);
        cancellation?.dispose();
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(
            new Error(
              `找不到 SVN 可执行文件“${redactText(this.executable)}”，请安装 SVN CLI 或配置 yfSvn.path。`
            )
          );
          return;
        }
        reject(new Error(redactText(error.message)));
      });
      child.once('close', (code) => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timeoutHandle);
        cancellation?.dispose();
        const result: SvnCommandResult = {
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode: code ?? -1
        };
        this.appendResult(result, options.logStdout !== false);
        if (interruption) {
          reject(interruption);
          return;
        }
        if (result.exitCode === 0) {
          resolve(result);
          return;
        }
        if (
          options.allowNonWorkingCopy &&
          /E155007|is not a working copy|不是工作副本/i.test(result.stderr)
        ) {
          resolve(result);
          return;
        }
        reject(
          new SvnCommandError(
            this.userFacingError(result.stderr || result.stdout, result.exitCode),
            result
          )
        );
      });
    });
  }

  /**
   * 把命令输出脱敏后写入输出通道。
   *
   * @param result SVN 命令执行结果。
   * @param includeStdout 是否记录标准输出。
   */
  private appendResult(result: SvnCommandResult, includeStdout: boolean): void {
    // 关键逻辑：状态扫描等大 XML 结果可跳过 stdout，但 stderr 必须保留用于诊断。
    const text = [includeStdout ? result.stdout : '', result.stderr]
      .filter(Boolean)
      .join('\n')
      .trim();
    if (text) {
      this.output.appendLine(redactText(text));
    }
    this.output.appendLine(`[退出码 ${result.exitCode}]`);
  }

  /**
   * 提取适合展示给用户的 SVN 错误摘要。
   *
   * @param output SVN 标准错误或标准输出。
   * @param exitCode SVN 进程退出码。
   * @returns 单行错误说明。
   */
  private userFacingError(output: string, exitCode: number): string {
    const lines = redactText(output)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const important = lines.find((line) => /^svn: E\d+:/i.test(line)) ?? lines.at(-1);
    return important || `SVN 命令执行失败，退出码 ${exitCode}。`;
  }
}
