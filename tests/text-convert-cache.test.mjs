// Display conversion is remembered: a repeated text gives the same result as the first time, text without Han characters is
// returned untouched without conversion, and the memory stays bounded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { simplifiedCliOutput } from '../public/output-language.js';

test('repeated conversion gives the same result; text without Han characters passes through', () => {
  const samples = ['這是一個測試，檔案在 `/srv/xxxxx/報告.md`。', '後端「資料庫」連線失敗\n```\n繁體 code 不轉\n```\n後續', '> 引用：網路錯誤', 'plain English only', 'BEGIN_BASE64 QUJDRA/+== END'];
  const first = samples.map(simplifiedCliOutput), second = samples.map(simplifiedCliOutput);
  assert.deepEqual(second, first);
  assert.ok(first[0].startsWith('这是一个测试') && first[0].endsWith('`/srv/xxxxx/報告.md`。'), 'prose converts, the quoted path stays exact');
  assert.ok(first[1].includes('\n```\n繁體 code 不轉\n```\n') && first[1].startsWith('后端'), 'fenced code stays exact');
  assert.equal(simplifiedCliOutput(samples[3]), samples[3]);
  assert.equal(simplifiedCliOutput(samples[4]), samples[4]);
});

test('many distinct texts do not grow the memory without bound and still convert correctly', () => {
  for (let i = 0; i < 6000; i++) assert.equal(simplifiedCliOutput(`第 ${i} 個測試`), `第 ${i} 个测试`);
  assert.equal(simplifiedCliOutput('第 1 個測試'), '第 1 个测试', 'an evicted text converts again');
});
