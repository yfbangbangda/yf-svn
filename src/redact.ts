const SENSITIVE_OPTIONS = new Set(['--password', '--username']);

/**
 * 隐藏诊断文本中的 URL 用户信息和常见凭据字段。
 *
 * @param text 即将写入日志或显示为错误的文本。
 * @returns 已脱敏的文本，保留协议、主机与路径以便诊断。
 */
export function redactText(text: string): string {
  return text
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^/\s<>"']*@/gi, '$1***@')
    .replace(/((?:--)?(?:password|username|密码|用户名)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s<>&]+)/gi, '$1***')
    .replace(/(--(?:password|username)\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1***');
}

/**
 * 隐藏独立参数、等号参数以及 URL 中的凭据，不改变真实 SVN 参数。
 *
 * @param args 原始 SVN 参数数组。
 * @returns 仅供日志使用的脱敏参数副本。
 */
export function redactArguments(args: readonly string[]): readonly string[] {
  let hideNext = false;
  let targetsOnly = false;
  return args.map((argument) => {
    if (hideNext) {
      hideNext = false;
      return '***';
    }
    if (argument === '--') {
      targetsOnly = true;
    }
    if (!targetsOnly) {
      const separator = argument.indexOf('=');
      const option = separator < 0 ? argument : argument.slice(0, separator);
      if (SENSITIVE_OPTIONS.has(option)) {
        hideNext = separator < 0;
        return separator < 0 ? option : `${option}=***`;
      }
    }
    return redactText(argument);
  });
}
