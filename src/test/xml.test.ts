import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBlameXml, parseInfoXml, parseLogXml, parseStatusXml } from '../xml';

test('parseStatusXml 能解析中文路径和冲突状态', () => {
  const xml =
    '<?xml version="1.0"?><status><target path="."><entry path="目录/a.php"><wc-status item="modified" props="none" revision="8" tree-conflicted="true"/></entry></target></status>';
  const entries = parseStatusXml(xml, 'D:\\工作副本');
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.item, 'modified');
  assert.equal(entries[0]?.treeConflicted, true);
  assert.equal(entries[0]?.absolutePath, 'D:\\工作副本\\目录\\a.php');
});

test('parseInfoXml 能解析工作副本信息', () => {
  const xml =
    '<?xml version="1.0"?><info><entry path="." revision="12"><url>file:///repo/trunk</url><repository><root>file:///repo</root><uuid>abc</uuid></repository><wc-info><wcroot-abspath>D:\\wc</wcroot-abspath></wc-info></entry></info>';
  const info = parseInfoXml(xml);
  assert.equal(info.workingCopyRoot, 'D:\\wc');
  assert.equal(info.revision, '12');
  assert.equal(info.repositoryUuid, 'abc');
});

test('parseInfoXml 能解析文本冲突的三方文件', () => {
  const xml =
    '<?xml version="1.0"?><info><entry path="a.txt" revision="2"><url>file:///repo/a.txt</url><repository><root>file:///repo</root><uuid>abc</uuid></repository><wc-info><wcroot-abspath>D:\\wc</wcroot-abspath></wc-info><conflict operation="update" type="text"><prev-base-file>D:\\wc\\a.txt.r1</prev-base-file><prev-wc-file>D:\\wc\\a.txt.mine</prev-wc-file><cur-base-file>D:\\wc\\a.txt.r2</cur-base-file></conflict></entry></info>';
  const info = parseInfoXml(xml);
  assert.deepEqual(info.conflict, {
    type: 'text',
    operation: 'update',
    previousBaseFile: 'D:\\wc\\a.txt.r1',
    previousWorkingFile: 'D:\\wc\\a.txt.mine',
    currentBaseFile: 'D:\\wc\\a.txt.r2'
  });
});

test('parseLogXml 能解析改动路径', () => {
  const xml =
    '<?xml version="1.0"?><log><logentry revision="7"><author>tester</author><date>2026-07-31T00:00:00Z</date><paths><path action="M">/trunk/a.php</path></paths><msg>修改</msg></logentry></log>';
  const entries = parseLogXml(xml);
  assert.equal(entries[0]?.revision, '7');
  assert.equal(entries[0]?.paths[0]?.action, 'M');
  assert.equal(entries[0]?.paths[0]?.path, '/trunk/a.php');
});

test('parseBlameXml 能解析作者、日期和 revision', () => {
  const xml =
    '<?xml version="1.0"?><blame><target path="a.php"><entry line-number="2"><commit revision="9"><author>张三</author><date>2026-08-06T01:02:03Z</date></commit></entry><entry line-number="1"><commit revision="8"><author>李四</author><date>2026-08-05T01:02:03Z</date></commit></entry></target></blame>';
  const lines = parseBlameXml(xml);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], {
    lineNumber: 1,
    revision: '8',
    author: '李四',
    date: '2026-08-05T01:02:03Z'
  });
});
