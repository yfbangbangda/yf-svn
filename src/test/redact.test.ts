import assert from 'node:assert/strict';
import test from 'node:test';
import { redactArguments, redactText } from '../redact';

test('脱敏独立参数、等号参数及 URL 凭据，保留原始参数', () => {
  const args = ['--username', 'tester', '--password=secret value', 'https://tester:secret@example.com/repo'];
  assert.deepEqual(redactArguments(args), [
    '--username', '***', '--password=***', 'https://***@example.com/repo'
  ]);
  assert.equal(args[1], 'tester');
  assert.equal(args[2], '--password=secret value');
  assert.deepEqual(redactArguments(['--password', 'secret value', '--username=tester']), [
    '--password', '***', '--username=***'
  ]);
});

test('脱敏支持 SVN、SSH、HTTP 和编码后的用户信息，不破坏含 @ 的本地路径', () => {
  for (const protocol of ['https', 'http', 'svn', 'svn+ssh']) {
    assert.equal(redactText(`${protocol}://user:p%40ss@host/repo`), `${protocol}://***@host/repo`);
    assert.equal(redactText(`${protocol}://user@host/repo`), `${protocol}://***@host/repo`);
  }
  const local = 'D:\\project@47.96.177.169\\file.txt@';
  assert.equal(redactText(local), local);
});

test('输出和错误摘要中的引号凭据、中文凭据和命令参数均脱敏', () => {
  const text = 'password="two words" username:tester 密码=秘密 --password \'two words\' --username=tester';
  const safe = redactText(text);
  for (const secret of ['two words', 'tester', '秘密']) {
    assert.equal(safe.includes(secret), false);
  }
  assert.equal(redactText('svn: E170001: https://user:secret@host/repo'), 'svn: E170001: https://***@host/repo');
});

test('参数终止符后的目标名称不会吞掉下一条日志参数', () => {
  assert.deepEqual(redactArguments(['--', '--password', 'ordinary.txt']), ['--', '--password', 'ordinary.txt']);
});
