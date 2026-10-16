/** 将常见 SVN 错误关联到需要用户明确选择的恢复入口。 */
export interface SvnErrorAdvice {
  readonly summary: string;
  readonly action?: 'settings' | 'cleanup' | 'conflicts' | 'update' | 'merge';
}

/**
 * 根据错误码给出恢复建议，不执行或重试任何 SVN 写操作。
 * @param message 已脱敏的 SVN 或插件错误说明。
 * @returns 中文原因和可选择的恢复入口。
 */
export function getSvnErrorAdvice(message: string): SvnErrorAdvice {
  if (/E155004|E155037/.test(message)) {
    return { summary: '工作副本被未完成的操作锁定，请确认其他 SVN 操作已结束，再清理工作副本。', action: 'cleanup' };
  }
  if (/E170001|E215004/.test(message)) {
    return { summary: 'SVN 认证失败，请通过本机 SVN 客户端完成认证后，再重新执行本次操作。', action: 'settings' };
  }
  if (/E155015/.test(message)) {
    return { summary: '工作副本存在未解决冲突，请先查看冲突并完成处理。', action: 'conflicts' };
  }
  if (/E155011|E160028|E195020/.test(message)) {
    return { summary: '工作副本版本过旧或包含混合 revision，请先检查并更新工作副本。', action: 'update' };
  }
  if (/目标工作副本的 URL 或 revision 已变化/.test(message)) {
    return { summary: '目标工作副本已变化，旧的合并预演不能继续，请重新预演。', action: 'merge' };
  }
  if (/找不到 SVN 可执行文件|需要 SVN CLI/.test(message)) {
    return { summary: 'SVN CLI 不可用，请检查安装位置及版本设置。', action: 'settings' };
  }
  if (/E160035|E195013/.test(message)) {
    return { summary: '文件锁操作未完成，请查看输出确认锁拥有者及锁令牌，避免直接强制覆盖他人的锁。' };
  }
  return { summary: 'SVN 操作未完成，请查看下方原因及输出日志。' };
}
