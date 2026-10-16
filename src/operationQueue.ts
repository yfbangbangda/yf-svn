/**
 * 按提交顺序串行执行同一工作副本的写操作，失败不会阻塞后续任务。
 */
export class OperationQueue {
  private tail: Promise<void> = Promise.resolve();

  /**
   * 等待前一项写操作及其收尾结束后执行任务。
   *
   * @param operation 实际写操作，包含状态刷新等收尾工作。
   * @returns 当前任务的结果；保留当前任务的错误。
   */
  public run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    // 关键逻辑：队列只消化尾部错误，调用方仍能收到当前操作的失败。
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
