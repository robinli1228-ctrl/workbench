// A role reads task text and history in Traditional (wb). Sending a task's text back unchanged is no change, a history page
// that begins inside a code block keeps that code, and search still finds a literal match.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { ConversationTasks } from '../src/conversation-tasks.mjs';
import { History } from '../src/history.mjs';
import { traditionalInput, traditionalRecord } from '../src/input-language.mjs';

function setup() {
  const db = new Store(':memory:');
  db.put('projects', { id: 'p', name: 'Example', supervisorRoleId: 's' });
  for (const id of ['a', 'b', 's']) db.put('roles', { id, projectId: 'p', name: id, nodeId: 'w', runtime: 'claude', model: 'm', enabled: true });
  db.put('runs', { id: 'run', projectId: 'p', roleId: 'a', nodeId: 'w', status: 'running' });
  return { db, tasks: new ConversationTasks(db), scope: { projectId: 'p', conversationId: 'p' } };
}

test('a handover that only echoes the Traditional copy of the description is refused, as with the Simplified one', () => {
  const { db, tasks, scope } = setup();
  const created = tasks.create(scope, { requestId: 'c1', title: '检查订单设置', description: '把订单页面的设置检查一遍', ownerRoleId: 'a', plan: { steps: [{ title: '读取设置', status: 'todo' }], currentStep: 0 } }, { roleId: 'a', runId: 'run' });
  const seen = traditionalRecord(tasks.agent(db.get('runs', 'run'), 'show', { id: created.id }));
  assert.notEqual(seen.description, created.description, 'the role reads Traditional');
  assert.throws(() => tasks.agent(db.get('runs', 'run'), 'update', { id: created.id, revision: 1, ownerRoleId: 'b', description: seen.description }), /changed description|handover/i);
  // Re-sending the plan to mark one step done changes only that status; the description and its revision stay.
  const updated = tasks.agent(db.get('runs', 'run'), 'update', { id: created.id, revision: 1, description: seen.description, plan: { ...seen.plan, steps: seen.plan.steps.map(step => ({ ...step, status: 'done' })) } });
  assert.equal(updated.description, '把订单页面的设置检查一遍'); assert.equal(db.get('conversationTasks', created.id).descriptionRevision, 1);
  assert.equal(db.get('conversationTasks', created.id).plan.steps[0].description, '读取设置', 'the step text stays as stored');
});

test('a history page that begins inside a fenced code block says which fence is open there', () => {
  const { db } = setup();
  const body = ['说明文字', '```yaml', '# 设置默认用户', 'DEFAULT_NAME: 测试账号', ...Array.from({ length: 400 }, (_, i) => `key_${i}: 值${i}`), '```', '后面的说明'].join('\n');
  db.put('roomMessages', { id: 'm1', projectId: 'p', sender: 'agent', text: body, createdAt: '2026-11-28T00:00:00Z' });
  const history = new History(db), first = history.read('p', { kind: 'message', id: 'm1' });
  assert.equal(first.codeFence, undefined);
  const second = history.read('p', { kind: 'message', id: 'm1', offset: 20, version: first.version });
  assert.equal(second.codeFence, '```');
  // What wb gives the CLI for that page: the code keeps its Simplified text.
  const converted = traditionalInput(`${second.codeFence}\n${second.content}`).slice(second.codeFence.length + 1);
  assert.match(converted, /DEFAULT_NAME: 测试账号/);
});

test('search finds a literal match as well as the folded one', () => {
  const { db } = setup();
  db.put('roomMessages', { id: 'm2', projectId: 'p', sender: 'human', text: '乾隆年间的记录', createdAt: '2026-11-28T00:00:00Z' });
  db.put('roomMessages', { id: 'm3', projectId: 'p', sender: 'human', text: '设置页面', createdAt: '2026-11-28T00:00:01Z' });
  const history = new History(db), ids = query => history.search('p', { query }).items.map(item => item.id).filter(id => /m[23]/.test(id));
  assert.ok(ids('乾').some(id => id.includes('m2')), '乾 finds 乾隆');
  assert.ok(ids('設置').some(id => id.includes('m3')), 'Traditional finds Simplified');
});
