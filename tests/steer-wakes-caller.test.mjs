// Steering a role that is doing work another role waits for: the caller's wait shows as cancelled (no longer "waiting for
// other roles") and the caller is woken to look at the interrupted run and decide; the steered role's own chain still
// follows the user's new direction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { RoleCalls } from '../src/role-calls.mjs';
import { RoleSteering } from '../src/role-steering.mjs';
import { roleActivity } from '../public/role-icons.js';
import { executionProgress } from '../public/execution-progress.js';

const P = 'p1', at = '2026-11-09T05:28:00Z';
function env() {
  const db = new Store(':memory:'), calls = new RoleCalls(db);
  db.put('projects', { id: P, name: 'Chat', root: '/xxxxx' });
  db.put('workspaces', { id: `${P}:w1`, projectId: P, nodeId: 'w1', localRoot: '/xxxxx' });
  for (const [id, name] of [['claude', 'Claude'], ['sol', 'sol']]) db.put('roles', { id, projectId: P, name, enabled: true, nodeId: 'w1', runtime: 'claude', model: 'm', mode: 'workspace-write' });
  // Claude handed work to sol and waits for it; sol is running it.
  db.put('tasks', { id: 't0', projectId: P, origin: 'chat', roleId: 'claude', status: 'in_progress', currentRunId: 'run-c', createdAt: at });
  db.put('runs', { id: 'run-c', projectId: P, taskId: 't0', roleId: 'claude', status: 'succeeded', createdAt: at });
  db.put('coordinationRequests', { id: 'root', projectId: P, conversationId: P, kind: 'direct', targetRoleId: 'claude', taskId: 't0', status: 'waiting_call', currentRunId: 'run-c', waitRequestIds: ['child'], resumeSummary: 'check the screenshots', createdAt: at });
  db.put('tasks', { id: 'ts', projectId: P, origin: 'chat', roleId: 'sol', roleSnapshot: db.get('roles', 'sol'), status: 'in_progress', currentRunId: 'run-s', requestId: 'child', createdAt: at });
  db.put('runs', { id: 'run-s', projectId: P, taskId: 'ts', roleId: 'sol', roleSnapshot: db.get('roles', 'sol'), nodeId: 'w1', status: 'running', requestId: 'child', createdAt: at });
  db.put('coordinationRequests', { id: 'child', projectId: P, conversationId: P, kind: 'direct', targetRoleId: 'sol', targetSnapshot: db.get('roles', 'sol'), parentRequestId: 'root', status: 'running', taskId: 'ts', currentRunId: 'run-s', createdAt: at });
  // The user sends sol a new message and steers it.
  db.put('roomMessages', { id: 'm9', projectId: P, conversationId: P, sender: 'human', text: 'stop, do X instead', taskIds: ['t9'] });
  db.put('tasks', { id: 't9', projectId: P, origin: 'chat', roleId: 'sol', roleSnapshot: db.get('roles', 'sol'), status: 'ready', sourceMessageId: 'm9', createdAt: at });
  return { db, calls };
}
const card = db => roleActivity(db.get('roles', 'claude'), db.list('tasks'), db.list('runs'), { requests: db.list('coordinationRequests'), worker: { online: true } });

test('the caller is not frozen: its wait shows cancelled and it is woken to look at the interrupted run', () => {
  const { db, calls } = env();
  new RoleSteering(db, calls).request(P, 't9', 'steer-1', {});
  const child = db.get('coordinationRequests', 'child');
  assert.equal(child.status, 'cancelled');assert.equal(child.cancelReason, 'user_interrupted');
  assert.equal(child.steeringTaskId, 't9', 'sol\'s own work follows the new direction');
  assert.equal(db.get('coordinationRequests', 'root').steeringTaskId, undefined, 'Claude\'s wait is not frozen');
  db.put('runs', { ...db.get('runs', 'run-s'), status: 'interrupted' });calls.finish('run-s');
  calls.resume('root');
  const root = db.get('coordinationRequests', 'root'), wake = db.get('coordinationRequests', root.continuationRequestId);
  assert.equal(root.waitEvent.reason, 'interrupted');
  assert.equal(wake.kind, 'continuation');assert.equal(wake.targetRoleId, 'claude');assert.equal(wake.wakeReason, 'interrupted');
  assert.match(wake.summary, /interrupted/);assert.match(wake.summary, /sol/);assert.match(wake.summary, /child/);assert.match(wake.summary, /check the screenshots/);
  const progress = executionProgress({ task: db.get('tasks', 't0'), run: db.get('runs', 'run-c'), request: root });
  assert.equal(progress.state, 'stopped');assert.equal(progress.detail, 'The work it handed out was interrupted by the user');
  assert.notEqual(card(db).detail, 'Waiting for other roles to reply', 'the role card no longer waits for other roles');
});

test('without the change the caller stayed waiting for good (the reported symptom), now a later finish of the chain settles it', () => {
  const { db, calls } = env();
  new RoleSteering(db, calls).request(P, 't9', 'steer-1', {});
  db.put('runs', { ...db.get('runs', 'run-s'), status: 'interrupted' });calls.finish('run-s');
  calls.resume('root');
  const wakeId = db.get('coordinationRequests', 'root').continuationRequestId;
  calls.reconcile(wakeId);
  const task = db.get('tasks', db.get('coordinationRequests', wakeId).taskId);
  db.put('runs', { id: 'run-w', projectId: P, taskId: task.id, roleId: 'claude', requestId: wakeId, status: 'succeeded', result: 'Looked at sol\'s run; continuing myself.', createdAt: '2026-11-09T05:44:00Z' });
  db.put('coordinationRequests', { ...db.get('coordinationRequests', wakeId), status: 'running', currentRunId: 'run-w' });
  calls.finish('run-w');
  assert.equal(db.get('coordinationRequests', 'root').status, 'succeeded', 'the woken turn settles the whole chain');
});

test('a wait an earlier steer froze is closed once at Home start, shown cancelled, and nobody is woken', () => {
  const { db, calls } = env();
  // What a steer left before the fix: every request up the chain carried the steering mark, the caller's wait included.
  db.put('roles', { id: 'sup', projectId: P, name: 'Supervisor', enabled: true, nodeId: 'w1', runtime: 'claude', model: 'm' });
  db.put('coordinationRequests', { id: 'top', projectId: P, conversationId: P, kind: 'direct', targetRoleId: 'sup', status: 'waiting_call', currentRunId: 'run-top', steeringTaskId: 't9', createdAt: at });
  db.put('coordinationRequests', { ...db.get('coordinationRequests', 'root'), parentRequestId: 'top', steeringTaskId: 't9' });
  db.put('coordinationRequests', { ...db.get('coordinationRequests', 'child'), status: 'cancelled', steeringTaskId: 't9' });
  db.put('coordinationRequests', { id: 'own', projectId: P, conversationId: P, kind: 'direct', targetRoleId: 'sol', status: 'waiting_call', currentRunId: 'run-o', steeringTaskId: 't9', createdAt: at });
  db.put('runs', { ...db.get('runs', 'run-s'), status: 'interrupted' });
  const before = db.list('coordinationRequests').length;
  assert.deepEqual(calls.closeSteeredWaits().sort(), ['root', 'top']);
  for (const id of ['root', 'top']) {
    const r = db.get('coordinationRequests', id);
    assert.equal(r.status, 'cancelled');assert.equal(r.cancelReason, 'user_interrupted');assert.equal(r.continuationRequestId, undefined);
  }
  assert.equal(db.list('coordinationRequests').length, before, 'no wake turn is created');
  assert.equal(db.get('coordinationRequests', 'own').status, 'waiting_call', 'the steered role\'s own chain is left to the new direction');
  assert.equal(executionProgress({ task: db.get('tasks', 't0'), run: db.get('runs', 'run-c'), request: db.get('coordinationRequests', 'root') }).state, 'stopped');
  assert.notEqual(card(db).detail, 'Waiting for other roles to reply');
  assert.deepEqual(calls.closeSteeredWaits(), [], 'once');
});
