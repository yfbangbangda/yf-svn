/**
 * 合并并串行执行刷新请求，确保执行期间到达的新请求会触发补偿刷新。
 */
export class RefreshQueue {
  private current: Promise<void> | undefined;
  private pending = false;

  /**
   * 请求执行刷新；已有刷新运行时，等待当前刷新结束后再补充执行一次。
   *
   * @param operation 单次实际刷新操作。
   * @returns 当前批次全部刷新完成后的 Promise。
   */
  public run(operation: () => Promise<void>): Promise<void> {
    if (this.current) {
      this.pending = true;
      return this.current;
    }

    const current = this.runPending(operation).finally(() => {
      this.current = undefined;
    });
    this.current = current;
    return current;
  }

  /**
   * 持续执行刷新，直到运行期间没有收到新请求。
   *
   * @param operation 单次实际刷新操作。
   */
  private async runPending(operation: () => Promise<void>): Promise<void> {
    do {
      // 关键逻辑：先消费待刷新标记，运行期间的新请求会重新设置该标记。
      this.pending = false;
      await operation();
    } while (this.pending);
  }
}
