import assert from 'node:assert/strict';
import test from 'node:test';
import { RefreshQueue } from '../refreshQueue';

test('RefreshQueue 会在刷新期间收到新请求后补充执行一次', async () => {
  const queue = new RefreshQueue();
  let refreshCount = 0;
  let releaseFirstRefresh!: () => void;
  const firstRefreshStarted = new Promise<void>((resolve) => {
    releaseFirstRefresh = resolve;
  });

  /**
   * 模拟一次可控的状态刷新。
   */
  async function refresh(): Promise<void> {
    refreshCount += 1;
    if (refreshCount === 1) {
      await firstRefreshStarted;
    }
  }

  const first = queue.run(refresh);
  const second = queue.run(refresh);
  const third = queue.run(refresh);
  releaseFirstRefresh();
  await Promise.all([first, second, third]);

  assert.equal(refreshCount, 2);

  await queue.run(refresh);
  assert.equal(refreshCount, 3);
});
