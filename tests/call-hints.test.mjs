// wb call answers with a short hint for untracked work or a supervisor delegating its own task.
// The hint never changes the call that was already sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Rooms } from '../src/rooms.mjs';
import { RoleCalls } from '../src/role-calls.mjs';
import { createAgentCalls } from '../src/agent-calls.mjs';
import { ConversationTasks } from '../src/conversation-tasks.mjs';
import { tr } from '../src/i18n.mjs';

const P = 'p1';
function env(callerId = 'b') {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'demo', supervisorRoleId: 'sup' });
  db.put('workspaces', { id: `${P}:w1`, projectId: P, nodeId: 'w1', localRoot: '/xxxxx' });
  for (const [id, name, extra] of [['sup', 'Supervisor', { systemSupervisor: true }], ['b', 'Builder', {}], ['c', 'Checker', {}]])
    db.put('roles', { id, projectId: P, name, nodeId: 'w1', runtime: 'claude', model: 'm', mode: 'workspace-write', enabled: true, ...extra });
  db.put('roomMessages', { id: 'm1', projectId: P, sender: 'human', text: 'work', taskIds: ['t1'] });
  db.put('tasks', { id: 't1', projectId: P, origin: 'chat', roleId: callerId, roleSnapshot: db.get('roles', callerId), prompt: 'work', sourceMessageId: 'm1', status: 'in_progress', currentRunId: 'r1' });
  db.put('runs', { id: 'r1', projectId: P, taskId: 't1', roleId: callerId, roleSnapshot: db.get('roles', callerId), nodeId: 'w1', sourceMessageId: 'm1', status: 'running', lastSeq: 0 });
  const calls = new RoleCalls(db), rooms = new Rooms(db); rooms.touch = () => {};
  calls.adoptTask('t1');
  const run = () => db.get('runs', 'r1');
  const call = input => createAgentCalls({ db, calls, rooms }, run(), { requestId: `c-${Math.random().toString(36).slice(2)}`, text: 'do it', ...input });
  const task = (owner = 'c') => new ConversationTasks(db).create({ projectId: P, conversationId: P }, { requestId: 'task-1', title: 'Implement', description: 'brief', ownerRoleId: owner }, { roleId: callerId, runId: 'r1' });
  return { db, run, call, task };
}

test('work sent without a task gets the task hint; consultations and linked work do not', () => {
  const e = env();
  assert.equal(e.call({ role: 'Checker', kind: 'direct' }).hint, tr('agentCalls.taskHint'));
  assert.equal(e.call({ role: 'Checker', kind: 'consult' }).hint, undefined, 'asking for a review is not tracked work');
  e.task();
  assert.equal(e.call({ role: 'Checker', kind: 'direct', task: 'T1' }).hint, undefined, 'the call is linked to a task');
});

test('a role already working on a linked task gets no task hint', () => {
  const e = env();
  const linkedRequest = e.db.get('coordinationRequests', 'task:t1');
  e.task('b');
  e.db.put('coordinationRequests', { ...linkedRequest, conversationTaskId: e.db.list('conversationTasks')[0].id });
  assert.equal(e.call({ role: 'Checker', kind: 'direct' }).hint, undefined);
});

test('transfer hint is actionable only for a task the supervisor still owns',()=>{
 const e=env('sup');e.task('sup');const direct=e.call({role:'Checker',kind:'direct',task:'T1'});assert.equal(direct.hint,tr('agentCalls.transferHint'));
 const next=env('sup');next.task('sup');assert.ok(next.call({role:'Checker',kind:'transfer',task:'T1'}).requestId);assert.equal(next.db.list('conversationTasks')[0].ownerRoleId,'c');
 const owned=env('sup');owned.task('c');assert.equal(owned.call({role:'Checker',kind:'direct',task:'T1'}).hint,undefined);
 const delegated=env('sup');delegated.task('sup');const r=delegated.db.get('coordinationRequests','task:t1');delegated.db.put('coordinationRequests',{...r,parentRequestId:'parent'});assert.equal(delegated.call({role:'Checker',kind:'direct',task:'T1'}).hint,undefined);
});
