import assert from 'node:assert/strict';
import test from 'node:test';
import { getSvnErrorAdvice } from '../errorAdvice';

test('工作副本锁与文件锁使用不同恢复建议，避免对文件锁误做 Cleanup', () => {
  assert.equal(getSvnErrorAdvice('svn: E155004: Working copy locked').action, 'cleanup');
  assert.equal(getSvnErrorAdvice('svn: E160035: Path is already locked').action, undefined);
  assert.match(getSvnErrorAdvice('svn: E160035: Path is already locked').summary, /锁拥有者/);
});

test('认证、冲突、混合 revision 和过期预演提供对应入口，未知错误保留日志入口', () => {
  assert.equal(getSvnErrorAdvice('svn: E170001: Authentication failed').action, 'settings');
  assert.equal(getSvnErrorAdvice('svn: E155015: Conflict').action, 'conflicts');
  assert.equal(getSvnErrorAdvice('svn: E195020: mixed revision').action, 'update');
  assert.equal(getSvnErrorAdvice('目标工作副本的 URL 或 revision 已变化，请重新选择来源并预演合并。').action, 'merge');
  assert.equal(getSvnErrorAdvice('找不到 SVN 可执行文件').action, 'settings');
  assert.equal(getSvnErrorAdvice('其他失败').action, undefined);
});
