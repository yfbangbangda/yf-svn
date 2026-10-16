/**
 * 构造检出参数，目标目录是实际文件系统路径，不使用 peg revision 转义。
 *
 * @param url SVN 仓库来源 URL。
 * @param destination 用户选择的实际目标目录。
 * @param revision 要检出的 revision。
 * @param depth 检出深度。
 * @param ignoreExternals 是否忽略外部定义。
 * @returns 交给 SvnCli 执行的参数数组。
 */
export function buildCheckoutArguments(
  url: string,
  destination: string,
  revision: string,
  depth: string,
  ignoreExternals: boolean
): readonly string[] {
  const args = ['checkout', '--revision', revision, '--depth', depth];
  if (ignoreExternals) {
    args.push('--ignore-externals');
  }
  // 关键逻辑：checkout 的目标不解析 peg revision，追加 @ 会创建名称不同的目录。
  args.push('--', url.trim(), destination);
  return args;
}
