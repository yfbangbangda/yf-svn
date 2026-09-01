/**
 * 生成可作为 SVN 命令目标参数使用的本地路径。
 *
 * 关键逻辑：SVN 把路径中最后一个 `@` 之后的内容解析为 peg revision，
 * 目录或文件名包含 `@`（例如 `project@47.96.177.169`）时会报
 * `E205000: Syntax error parsing peg revision`。SVN 官方约定在路径末尾
 * 追加一个 `@` 表示空 peg revision，使整个字符串按纯路径解析。
 *
 * @param fsPath Windows 文件系统路径。
 * @returns 追加尾部 `@` 转义后的 SVN 目标参数。
 */
export function escapeSvnTarget(fsPath: string): string {
  return `${fsPath}@`;
}

/**
 * 把一组本地路径统一转义为 SVN 命令目标参数。
 *
 * @param fsPaths 本地文件系统路径列表。
 * @returns 逐条追加尾部 `@` 的目标参数列表。
 */
export function escapeSvnTargets(fsPaths: readonly string[]): readonly string[] {
  return fsPaths.map((fsPath) => escapeSvnTarget(fsPath));
}
