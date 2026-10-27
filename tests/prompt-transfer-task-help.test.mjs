// The supervisor is told how to transfer, a task's owner is reminded to close it in turns linked to that task, and
// wb help matches the transfer rule and the per-turn invocation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runWithLanguage, tr } from '../src/i18n.mjs';
import { renderRunInputParts } from '../src/run-context.mjs';
import { normalizePlatformSettings, defaultSupervisorPrompt } from '../src/platform-prompts.mjs';
import { helpText } from '../src/wb-tools.mjs';

const task = (extra = {}) => ({ id: 'ct:1', number: 1, title: 'Implement', description: 'brief', plan: null, status: 'in_progress', ownerRoleId: 'exec', revision: 2, updated: false, ...extra });
const taskPart = packet => renderRunInputParts({ instruction: 'go', ...packet }).home.find(p => p.key === 'task')?.text || '';

test('only the owner of an open linked task is reminded to close it', () => runWithLanguage('zh', () => {
  const reminder = tr('conversationTasks.ownerReminder');
  assert.ok(taskPart({ roleId: 'exec', conversationTask: task() }).endsWith(reminder));
  assert.ok(!taskPart({ roleId: 'reviewer', conversationTask: task() }).includes(reminder), 'a reviewer linked to the task is not its owner');
  assert.ok(!taskPart({ roleId: 'exec', conversationTask: task({ status: 'done' }) }).includes(reminder), 'a closed task needs no reminder');
}));

test('the supervisor template names the transfer command, and the previous default upgrades to it', () => runWithLanguage('zh', () => {
  const current = defaultSupervisorPrompt();
  assert.match(current, /先用 wb task create 建任务.*再用 wb call --kind transfer --task T编号 交给它/);
  // The previous default differed only in this line.
  const line = current.split('\n').find(l => l.startsWith('- 派任务：'));
  const old = current.replace(line, '- 派任务：任务整件转交给一个角色，由它负责到底：自主推进、自己找人沟通和审核，做完直接回复用户结论；你不再跟进，除非收到停滞提醒。流程长的任务，先列好分步计划一起交给它。把一个目标拆给几个角色时，结果回到你汇总后再回复用户。');
  assert.notEqual(old, current);
  assert.equal(normalizePlatformSettings({ supervisorPrompt: old }).supervisorPrompt, current, 'a saved copy of the old default follows the new one');
  assert.equal(normalizePlatformSettings({ supervisorPrompt: 'my own words' }).supervisorPrompt, 'my own words');
}));

test('wb help states the same-turn transfer rule and to use this turn\'s invocation', () => runWithLanguage('zh', () => {
  const help = helpText();
  assert.match(help, /本轮新建的任务可直接转交，早先建的任务先用 wb task update 重写说明/);
  assert.doesNotMatch(help, /转交前先在本轮用 wb task update 重写说明/);
  assert.match(help, /每轮的调用方式都不同，用本轮【wb 命令】里给的，不要沿用上一轮的/);
}));
