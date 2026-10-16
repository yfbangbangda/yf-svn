import * as vscode from 'vscode';

/** 原生多步选择器中的一个选项。 */
export interface StepChoice extends vscode.QuickPickItem {
  readonly value: string;
}

/** 一个文本输入或单选步骤，内容只保留在当前流程内。 */
export interface InputStep {
  readonly key: string;
  readonly prompt: string;
  readonly placeholder: string;
  readonly value?: string | ((values: Readonly<Record<string, string>>) => string);
  readonly items?: readonly StepChoice[];
  readonly browseFolder?: boolean;
  readonly validate?: (value: string) => string | undefined | Promise<string | undefined>;
}

export const SVN_DEPTH_CHOICES: readonly StepChoice[] = [
  { label: '保持当前深度', description: '沿用工作副本各目录已有的检出深度', value: 'working' },
  { label: '完整目录树', description: 'infinity：包含全部子目录和文件', value: 'infinity' },
  { label: '仅当前节点', description: 'empty：不包含子项', value: 'empty' },
  { label: '当前目录的文件', description: 'files：不进入子目录', value: 'files' },
  { label: '当前目录的直接子项', description: 'immediates：不继续深入子目录', value: 'immediates' }
];

/**
 * 校验输入的数字 revision 或 HEAD。
 *
 * @param value revision 输入文本。
 * @returns 输入错误说明；合法时返回 undefined。
 */
export function validateRevision(value: string): string | undefined {
  return /^(HEAD|\d+)$/.test(value.trim()) ? undefined : '请输入 HEAD 或数字 revision。';
}

/**
 * 使用 VS Code 原生输入控件收集参数，返回上一步时保留编辑内容，取消时不返回部分参数。
 *
 * @param title 本次流程的标题。
 * @param steps 按顺序展示的输入或选择步骤。
 * @param ui 原生输入控件入口，测试时可提供受控控件。
 * @returns 全部确认后的参数；取消时返回 undefined。
 */
export async function runInputSteps(
  title: string,
  steps: readonly InputStep[],
  ui: Pick<typeof vscode.window, 'createInputBox' | 'createQuickPick' | 'showOpenDialog'> = vscode.window
): Promise<Readonly<Record<string, string>> | undefined> {
  const values: Record<string, string> = {};
  for (let index = 0; index < steps.length;) {
    const step = steps[index]!;
    const initial = values[step.key] ?? (typeof step.value === 'function' ? step.value(values) : step.value ?? '');
    const action = await new Promise<'next' | 'back' | 'cancel'>((resolve) => {
      const pick = step.items ? ui.createQuickPick<StepChoice>() : undefined;
      const input = pick ? undefined : ui.createInputBox();
      const control = pick ?? input!;
      const browse: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('folder-opened'), tooltip: '浏览目标目录' };
      const subscriptions: vscode.Disposable[] = [];
      let finished = false;
      let browsing = false;
      control.title = title;
      control.step = index + 1;
      control.totalSteps = steps.length;
      control.placeholder = step.placeholder;
      control.ignoreFocusOut = true;
      control.buttons = [...(index > 0 ? [vscode.QuickInputButtons.Back] : []), ...(step.browseFolder ? [browse] : [])];
      if (pick) {
        pick.items = [...step.items!];
        pick.activeItems = pick.items.filter((item) => item.value === initial);
      } else {
        input!.value = initial;
        input!.prompt = step.prompt;
        subscriptions.push(input!.onDidChangeValue(() => { input!.validationMessage = undefined; }));
      }

      /** 读取当前编辑或选中的值，返回上一步也保存尚未确认的内容。 */
      function readValue(): string {
        return input ? input.value : (pick!.selectedItems[0] ?? pick!.activeItems[0])?.value ?? initial;
      }

      /**
       * 结束当前步骤并释放监听，防止 dispose 触发的 hide 事件重复结束流程。
       * @param result 用户选择的前进、返回或取消动作。
       */
      function finish(result: 'next' | 'back' | 'cancel'): void {
        if (finished) {
          return;
        }
        finished = true;
        values[step.key] = readValue();
        subscriptions.forEach((subscription) => subscription.dispose());
        control.dispose();
        resolve(result);
      }

      subscriptions.push(
        control.onDidHide(() => { if (!browsing) { finish('cancel'); } }),
        control.onDidAccept(async () => {
          control.enabled = false;
          control.busy = true;
          try {
            const error = await step.validate?.(readValue());
            if (finished) {
              return;
            }
            if (error) {
              if (input) {
                input.validationMessage = error;
              }
            } else {
              finish('next');
            }
          } catch {
            if (!finished && input) {
              input.validationMessage = '暂时无法校验输入，请检查内容后重试。';
            }
          } finally {
            if (!finished) {
              control.enabled = true;
              control.busy = false;
            }
          }
        }),
        control.onDidTriggerButton(async (button) => {
          if (button === vscode.QuickInputButtons.Back) {
            finish('back');
          } else if (button === browse && input) {
            browsing = true;
            try {
              const selected = await ui.showOpenDialog({
                title: step.prompt, canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
                openLabel: '选择目录',
                defaultUri: input.value ? vscode.Uri.file(input.value) : undefined
              });
              if (!finished && selected?.[0]) {
                input.value = selected[0].fsPath;
              }
            } catch {
              if (!finished) {
                input.validationMessage = '无法打开目录选择器，请手工输入目标目录。';
              }
            } finally {
              browsing = false;
              if (!finished) {
                control.show();
              }
            }
          }
        })
      );
      control.show();
    });
    if (action === 'cancel') {
      return undefined;
    }
    index += action === 'back' ? -1 : 1;
  }
  return values;
}
