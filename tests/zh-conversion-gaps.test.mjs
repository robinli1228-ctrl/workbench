// Model input in Traditional, page display in Simplified: places that were missed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {traditionalRecord,traditionalAnswers} from '../src/input-language.mjs';
import {simplifiedCliOutput} from '../public/output-language.js';

test('records read through wb tools give people-written prose in Traditional and keep ids and paths', () => {
  const task={id:'t1',number:7,title:'修复登录页面',description:'检查 /srv/xxxxx/app.js 后再改',plan:{steps:[{description:'先写测试',status:'todo'}]},history:[{reason:'用户调整',revision:2}],version:'abc'};
  const out=traditionalRecord(task);
  assert.equal(out.title,'修復登錄頁面');assert.match(out.description,/檢查 \/srv\/xxxxx\/app\.js 後再改/);
  assert.equal(out.plan.steps[0].description,'先寫測試');assert.equal(out.history[0].reason,'用戶調整');
  assert.equal(out.id,'t1');assert.equal(out.version,'abc');assert.equal(out.plan.steps[0].status,'todo');
});

test('typed answers to a CLI question go in Traditional; picked Traditional labels stay as they are', () => {
  assert.deepEqual(traditionalAnswers({q1:['只查用戶文檔'],q2:'先发布测试环境'}),{q1:['只查用戶文檔'],q2:'先發布測試環境'});
});

test('the page shows Traditional task text in Simplified', () => {
  assert.equal(simplifiedCliOutput('GPT逐例真實執行並留證，Opus獨立裁定'),'GPT逐例真实执行并留证，Opus独立裁定');
});
