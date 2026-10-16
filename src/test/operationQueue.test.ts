import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationQueue } from '../operationQueue';

test('OperationQueue 按顺序完成操作及收尾，不合并写请求', async () => {
  const queue = new OperationQueue();
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = queue.run(async () => {
    events.push('first');
    await gate;
    events.push('refresh');
    return 1;
  });
  const second = queue.run(async () => { events.push('second'); return 2; });
  await Promise.resolve();
  assert.deepEqual(events, ['first']);
  release();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(events, ['first', 'refresh', 'second']);
});

test('OperationQueue 保留失败且不阻塞后续任务', async () => {
  const queue = new OperationQueue();
  const failure = new Error('模拟失败');
  const first = queue.run(async () => { throw failure; });
  const second = queue.run(async () => '恢复执行');
  await assert.rejects(first, (error) => error === failure);
  assert.equal(await second, '恢复执行');
});

test('不同工作副本的 OperationQueue 可以独立执行', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = new OperationQueue().run(async () => gate);
  try {
    assert.equal(await new OperationQueue().run(async () => '独立完成'), '独立完成');
  } finally {
    release();
    await first;
  }
});
