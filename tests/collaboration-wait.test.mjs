// While a role waits for its own collaboration, unrelated same-role messages queue; a human can let one go first
// without cancelling anything, and a chain with no progress for the release window frees the queue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Rooms } from '../src/rooms.mjs';
import { RoleCalls } from '../src/role-calls.mjs';
import { RoleSteering } from '../src/role-steering.mjs';
import { collaborationQueueView, releaseMinutes } from '../src/coordination-wait.mjs';

const P = 'p1';
function env() {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'demo' });
  db.put('workspaces', { id: `${P}:w1`, projectId: P, nodeId: 'w1', localRoot: '/xxxxx' });
  for (const [id, name] of [['a', 'Supervisor'], ['b', 'Executor']]) db.put('roles', { id, projectId: P, name, nodeId: 'w1', runtime: 'claude', model: 'm', mode: 'workspace-write', enabled: true });
  db.put('roomMessages', { id: 'm1', projectId: P, sender: 'human', text: '@Supervisor plan and delegate', taskIds: ['t1'] });
  db.put('tasks', { id: 't1', projectId: P, origin: 'chat', roleId: 'a', roleSnapshot: db.get('roles', 'a'), prompt: 'plan', sourceMessageId: 'm1', status: 'in_progress', currentRunId: 'r1', contextPrepared: true });
  db.put('runs', { id: 'r1', projectId: P, taskId: 't1', roleId: 'a', roleSnapshot: db.get('roles', 'a'), nodeId: 'w1', sourceMessageId: 'm1', status: 'running', lastSeq: 0 });
  const calls = new RoleCalls(db), parent = calls.adoptTask('t1');
  db.put('coordinationRequests', { id: 'c1', projectId: P, parentRequestId: parent.id, targetRoleId: 'b', kind: 'direct', status: 'queued', summary: 'implement', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  calls.wait(db.get('runs', 'r1'), 'resume after Executor replies');
  db.put('runs', { ...db.get('runs', 'r1'), status: 'succeeded' });
  db.put('tasks', { ...db.get('tasks', 't1'), status: 'completed', currentRunId: null });
  const human = (id, roleId = 'a', conversationId) => {
    db.put('roomMessages', { id: `m-${id}`, projectId: P, sender: 'human', text: id, taskIds: [id], ...(conversationId ? { conversationId } : {}) });
    db.put('tasks', { id, projectId: P, origin: 'chat', roleId, roleSnapshot: db.get('roles', roleId), prompt: id, sourceMessageId: `m-${id}`, status: 'ready', contextPrepared: true, createdAt: new Date().toISOString(), ...(conversationId ? { conversationId } : {}) });
    calls.adoptTask(id);
    return db.get('tasks', id);
  };
  const rooms = new Rooms(db); rooms.touch = () => {};
  return { db, calls, parent, rooms, human, steering: new RoleSteering(db, calls) };
}

test('an unrelated message for the waiting role queues; other roles are not affected', () => {
  const e = env(), t2 = e.human('t2'), other = e.human('t3', 'b');
  const view = collaborationQueueView(e.db);
  assert.equal(view.states.length, 1);
  assert.equal(view.states[0].phase, 'waiting_reply');
  assert.deepEqual(view.states[0].waitingRequestIds, ['c1']);
  const check = view.forTask(t2);
  assert.equal(check.allowed, false);
  assert.ok(check.minutesLeft >= 39 && check.minutesLeft <= 40);
  assert.equal(view.forTask(other).allowed, true);
  e.rooms.schedule(() => false);
  assert.match(e.db.get('tasks', 't2').waitingReason, /waiting for collaboration results/);
});

test('no progress for the window marks the wait stalled but never releases it by itself', () => {
  const e = env(), t2 = e.human('t2');
  const later = collaborationQueueView(e.db, Date.now() + 41 * 60000);
  assert.equal(later.states[0].stalled, true);
  assert.equal(later.states[0].released, false);
  const check = later.forTask(t2);
  assert.equal(check.allowed, false, 'nothing runs automatically after the window');
  assert.equal(check.stalled, true);
  assert.equal(e.db.get('coordinationRequests', e.parent.id).status, 'waiting_call');
});

test('progress from a teammate restarts the window', () => {
  const e = env(), t2 = e.human('t2'), soon = Date.now() + 30 * 60000;
  e.db.put('coordinationRequests', { ...e.db.get('coordinationRequests', 'c1'), status: 'running', updatedAt: new Date(soon).toISOString() });
  assert.equal(collaborationQueueView(e.db, soon + 20 * 60000).forTask(t2).stalled, false);
  assert.equal(collaborationQueueView(e.db, soon + 41 * 60000).forTask(t2).stalled, true);
});

test('the release window follows the project setting', () => {
  const e = env(), t2 = e.human('t2');
  e.db.updateProject(P, { name: 'demo', collaborationWaitReleaseMinutes: 10 });
  assert.equal(releaseMinutes(e.db.get('projects', P)), 10);
  assert.equal(collaborationQueueView(e.db, Date.now() + 11 * 60000).forTask(t2).stalled, true);
  assert.throws(() => e.db.updateProject(P, { name: 'demo', collaborationWaitReleaseMinutes: 2 }));
  e.db.updateProject(P, { name: 'demo' });
  assert.equal(e.db.get('projects', P).collaborationWaitReleaseMinutes, 10, 'older clients keep the saved value');
});

test('handle this first keeps every collaboration record and allows one message only', () => {
  const e = env(), t2 = e.human('t2'), t3 = e.human('t3');
  const before = JSON.stringify(e.db.list('coordinationRequests'));
  const result = e.steering.request(P, 't2', 'cmd-1', { mode: 'yield_wait' });
  assert.equal(result.actor, 'human');
  assert.equal(JSON.stringify(e.db.list('coordinationRequests')), before, 'no request is cancelled or redirected');
  assert.equal(e.db.list('commands').length, 0, 'nothing is stopped');
  assert.equal(collaborationQueueView(e.db).forTask(e.db.get('tasks', 't2')).allowed, true);
  assert.deepEqual(e.steering.request(P, 't2', 'cmd-1', { mode: 'yield_wait' }), result, 'replay returns the same decision');
  assert.throws(() => e.steering.request(P, 't3', 'cmd-2', { mode: 'yield_wait' }), /already been set to go first/);
  assert.equal(collaborationQueueView(e.db).forTask(t3).allowed, false);
});

test('a steer without an explicit cancel confirmation cannot cancel a waiting collaboration', () => {
  const e = env(); e.human('t2');
  assert.throws(() => e.steering.request(P, 't2', 'cmd-x', {}), /waiting for collaboration results/);
  assert.throws(() => e.steering.request(P, 't2', 'cmd-y', { mode: 'replace' }), /waiting for collaboration results/, 'the queue button sends replace; it must not cancel a protected wait');
  assert.equal(e.db.get('coordinationRequests', e.parent.id).status, 'waiting_call');
});

test('the waiting role\'s own continuation is allowed and goes ahead of ordinary messages', () => {
  const e = env(); e.human('t2');
  e.db.put('coordinationRequests', { ...e.db.get('coordinationRequests', 'c1'), status: 'succeeded', result: 'done', updatedAt: new Date().toISOString() });
  e.calls.resume(e.parent.id);
  const nextId = e.db.get('coordinationRequests', e.parent.id).continuationRequestId;
  assert.ok(nextId, 'continuation created');
  e.calls.reconcile(nextId);
  const next = e.db.get('coordinationRequests', nextId);
  const view = collaborationQueueView(e.db);
  assert.equal(view.states[0].phase, 'resume_queued');
  assert.equal(view.forTask(e.db.get('tasks', next.taskId)).allowed, true);
  assert.equal(view.forTask(e.db.get('tasks', 't2')).allowed, false, 'ordinary messages still wait for the continuation');
});

test('another group chat of the same project is not blocked', () => {
  const e = env();
  e.db.put('conversations', { id: 'chat-2', projectId: P, title: 'second' });
  const t = { ...e.human('t2'), conversationId: 'chat-2' };
  assert.equal(collaborationQueueView(e.db).forTask(t).allowed, true);
});

test('the yield result needs no runs to wait for', () => {
  const e = env(); e.human('t2');
  const result = e.steering.request(P, 't2', 'cmd-1', { mode: 'yield_wait' });
  assert.equal(result.waitForRunIds, undefined);
  for (const id of result.waitForRunIds || []) assert.fail(id);
});

test('while a yielded message and its own collaboration run, the original owner does not take the role back', () => {
  const e = env(); e.human('t2');
  e.steering.request(P, 't2', 'cmd-1', { mode: 'yield_wait' });
  // B (t2) started and is now waiting on a teammate of its own.
  const b = e.db.get('tasks', 't2');
  e.db.put('tasks', { ...b, status: 'completed', currentRunId: null });
  const bRequest = e.db.get('coordinationRequests', b.requestId);
  e.db.put('coordinationRequests', { ...bRequest, status: 'waiting_call', waitRequestIds: ['c2'], waitDeadlineAt: new Date(Date.now() + 1800000).toISOString(), updatedAt: new Date().toISOString() });
  e.db.put('coordinationRequests', { id: 'c2', projectId: P, parentRequestId: bRequest.id, targetRoleId: 'b', kind: 'direct', status: 'queued', summary: 'help B', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  // A's teammate replies and A's continuation becomes ready.
  e.db.put('coordinationRequests', { ...e.db.get('coordinationRequests', 'c1'), status: 'succeeded', result: 'done', updatedAt: new Date().toISOString() });
  e.calls.resume(e.parent.id);
  const nextId = e.db.get('coordinationRequests', e.parent.id).continuationRequestId; e.calls.reconcile(nextId);
  const aContinuation = e.db.get('tasks', e.db.get('coordinationRequests', nextId).taskId);
  const view = collaborationQueueView(e.db);
  assert.equal(view.forTask(aContinuation).allowed, false, 'A waits until B\'s chain settles');
  assert.equal(view.forTask(aContinuation).yieldActive, true);
  // A third message cannot be pushed ahead while B's chain is active.
  const c = e.human('t4');
  assert.throws(() => e.steering.request(P, 't4', 'cmd-2', { mode: 'yield_wait' }), /already been set to go first/);
  assert.equal(view.forTask(c).allowed, false);
});

test('a yielded message that is already running still blocks a second yield', () => {
  const e = env(); e.human('t2'); e.human('t3');
  e.steering.request(P, 't2', 'cmd-1', { mode: 'yield_wait' });
  e.db.put('tasks', { ...e.db.get('tasks', 't2'), status: 'in_progress', currentRunId: 'rb' });
  assert.throws(() => e.steering.request(P, 't3', 'cmd-2', { mode: 'yield_wait' }), /already been set to go first/);
});

test('before the wait is stalled only human messages can go first; afterwards any queued item can', () => {
  const e = env();
  e.db.put('tasks', { id: 'agent-task', projectId: P, origin: 'chat', roleId: 'a', roleSnapshot: e.db.get('roles', 'a'), prompt: 'from a peer', status: 'ready', contextPrepared: true, createdAt: new Date().toISOString() });
  e.calls.adoptTask('agent-task');
  assert.throws(() => e.steering.request(P, 'agent-task', 'cmd-1', { mode: 'yield_wait' }), /Only human messages/);
  const old = new Date(Date.now() - 41 * 60000).toISOString();
  e.db.put('coordinationRequests', { ...e.db.get('coordinationRequests', e.parent.id), updatedAt: old, createdAt: old });
  e.db.put('coordinationRequests', { ...e.db.get('coordinationRequests', 'c1'), updatedAt: old, createdAt: old });
  assert.equal(e.steering.request(P, 'agent-task', 'cmd-1', { mode: 'yield_wait' }).actor, 'human');
});

test('a formal discussion wait protects the asking role too', () => {
  const e = env();
  e.db.put('coordinationRequests', { ...e.db.get('coordinationRequests', e.parent.id), status: 'succeeded' });
  e.db.put('tasks', { ...e.db.get('tasks', 't1'), status: 'waiting_discussion', discussionWait: { threadId: 'th1', questionId: 'q1' } });
  const t2 = e.human('t2');
  const view = collaborationQueueView(e.db);
  assert.equal(view.states.some(s => s.phase === 'waiting_discussion' && s.roleId === 'a'), true);
  assert.equal(view.forTask(t2).allowed, false);
});
