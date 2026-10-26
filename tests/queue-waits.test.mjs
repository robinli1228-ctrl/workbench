// An open wait sits in its chat's queue: it holds nothing back, its wake runs in the wait's slot, the user can drag it,
// and steering a waiting role puts the message first without cancelling the wait.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Rooms, orderRoleQueue, queueKey } from '../src/rooms.mjs';
import { RoleCalls } from '../src/role-calls.mjs';
import { RoleSteering } from '../src/role-steering.mjs';
import { queuedWaits, stampWaitSlots } from '../src/coordination-wait.mjs';
import { renderRunInputParts } from '../src/run-context.mjs';
import { tr } from '../src/i18n.mjs';

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
  db.put('coordinationRequests', { id: 'c1', projectId: P, parentRequestId: parent.id, targetRoleId: 'b', targetSnapshot: db.get('roles', 'b'), kind: 'direct', status: 'queued', summary: 'implement', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  calls.wait(db.get('runs', 'r1'), 'resume after Executor replies');
  db.put('runs', { ...db.get('runs', 'r1'), status: 'succeeded' });
  db.put('tasks', { ...db.get('tasks', 't1'), status: 'completed', currentRunId: null });
  let clock = Date.now();
  const human = (id, roleId = 'a') => {
    db.put('roomMessages', { id: `m-${id}`, projectId: P, sender: 'human', text: id, taskIds: [id] });
    db.put('tasks', { id, projectId: P, origin: 'chat', roleId, roleSnapshot: db.get('roles', roleId), prompt: id, sourceMessageId: `m-${id}`, status: 'ready', contextPrepared: true, createdAt: new Date(clock += 1000).toISOString() });
    calls.adoptTask(id);
    return db.get('tasks', id);
  };
  const rooms = new Rooms(db); rooms.touch = () => {};
  /** The executor's result comes back and the wake is materialised as the waiting role's next queued task. */
  const wake = () => {
    db.put('coordinationRequests', { ...db.get('coordinationRequests', 'c1'), status: 'succeeded', result: 'done', updatedAt: new Date().toISOString() });
    calls.resume(parent.id);
    const id = db.get('coordinationRequests', parent.id).continuationRequestId;
    calls.reconcile(id);
    return db.get('tasks', db.get('coordinationRequests', id).taskId);
  };
  return { db, calls, parent, rooms, human, wake, steering: new RoleSteering(db, calls) };
}

test('a message for a waiting role is not held back by the wait', () => {
  const e = env(), t2 = e.human('t2');
  e.rooms.schedule(() => false);
  assert.equal(e.db.get('tasks', t2.id).waitingReason, tr('rooms.waitingForNodeComeOnline'), 'it only waits for the device, not for the collaboration');
});

test('the open wait is listed in its chat with what it waits for, at the slot where it began', () => {
  const e = env(), t2 = e.human('t2');
  const [wait] = queuedWaits(e.db);
  assert.equal(wait.id, `wait:${e.parent.id}`);
  assert.equal(wait.roleId, 'a');
  assert.equal(wait.conversationId, P);
  assert.deepEqual(wait.waitingFor.map(w => w.roleName), ['Executor']);
  assert.ok(wait.queueOrder < queueKey(t2), 'the wait began before the later message');
});

test('the wake takes the wait\'s slot, ahead of messages that arrived meanwhile', () => {
  const e = env(), t2 = e.human('t2'), [wait] = queuedWaits(e.db), next = e.wake();
  assert.equal(next.queueOrder, wait.queueOrder);
  assert.deepEqual(orderRoleQueue([e.db.get('tasks', t2.id), next]).map(t => t.id), [next.id, t2.id]);
  assert.deepEqual(queuedWaits(e.db), [], 'once woken, the wait leaves the queue and its wake stands in for it');
});

test('dragging the wait behind a message makes its wake run after that message', () => {
  const e = env(), t2 = e.human('t2'), t3 = e.human('t3');
  e.rooms.reorderQueue(P, { taskIds: [t2.id, `wait:${e.parent.id}`, t3.id] });
  const next = e.wake(), order = orderRoleQueue([e.db.get('tasks', t2.id), e.db.get('tasks', t3.id), next]).map(t => t.id);
  assert.deepEqual(order, [t2.id, next.id, t3.id]);
  assert.deepEqual(e.rooms.reorderQueue(P, { taskIds: [t3.id, `wait:${e.parent.id}`] }), { taskIds: [t3.id, next.id] }, 'a wait that woke during the drag moves its wake instead');
  assert.deepEqual(orderRoleQueue([e.db.get('tasks', t3.id), e.db.get('tasks', next.id)]).map(t => t.id), [t3.id, next.id]);
  assert.throws(() => e.rooms.reorderQueue(P, { taskIds: [t2.id, 'missing-task'] }), /order/i, 'unknown messages are still rejected');
});

test('steering a waiting role puts the message first, keeps the wait and claims no change of direction', () => {
  const e = env(); e.human('t2');
  const steering = e.steering.request(P, 't2', 'cmd-1', { mode: 'replace' });
  assert.deepEqual(steering.waitForRunIds, [], 'nothing was running, so nothing is stopped');
  const parent = e.db.get('coordinationRequests', e.parent.id);
  assert.equal(parent.status, 'waiting_call', 'the wait is not cancelled');
  assert.equal(parent.steeringTaskId, undefined);
  assert.equal(queuedWaits(e.db).length, 1, 'the wait keeps its place in the queue');
  assert.deepEqual(renderRunInputParts({ instruction: 'question', steering }).home.map(p => p.key), [], 'no "old arrangement is void" notice');
  assert.deepEqual(renderRunInputParts({ instruction: 'change course', steering: { waitForRunIds: ['run-x'] } }).home.map(p => p.key), ['steering'], 'interrupting a running turn still says so');
});


test('a wait recorded before queue slots existed keeps the slot it began in', () => {
  const e = env(), began = '2026-10-26T01:00:00.000Z';
  const { queueOrder, waitStartedAt, ...legacy } = e.db.get('coordinationRequests', e.parent.id);
  e.db.put('coordinationRequests', { ...legacy, updatedAt: began });
  assert.equal(stampWaitSlots(e.db), 1);
  assert.equal(stampWaitSlots(e.db), 0, 'stamped once');
  assert.equal(e.wake().queueOrder, Date.parse(began), 'the wake lands where the wait began, not at wake time');
});

test('a wait whose caller was cancelled is not listed, and reordering stays within one chat', () => {
  const e = env(), t2 = e.human('t2');
  e.db.put('coordinationRequests', { id: 'other-chat-wait', projectId: P, conversationId: 'chat-2', targetRoleId: 'b', kind: 'direct', status: 'waiting_call', summary: 'x', createdAt: new Date().toISOString() });
  assert.throws(() => e.rooms.reorderQueue(P, { taskIds: [t2.id, 'wait:other-chat-wait'] }), /order/i, 'a wait from another chat is rejected');
  e.db.put('coordinationRequests', { id: 'source', projectId: P, targetRoleId: 'b', kind: 'direct', status: 'cancelled', summary: 'x' });
  e.db.put('coordinationRequests', { ...e.db.get('coordinationRequests', e.parent.id), parentRequestId: 'source' });
  assert.deepEqual(queuedWaits(e.db).filter(w => w.requestId === e.parent.id), [], 'it would close without a wake');
});

test('steering a running turn still stops it and cancels its own chain, leaving the role\'s open wait alone', () => {
  const e = env(), t2 = e.human('t2');
  e.db.put('roomMessages', { id: 'm-busy', projectId: P, sender: 'human', text: 'long job', taskIds: ['busy'] });
  e.db.put('tasks', { id: 'busy', projectId: P, origin: 'chat', roleId: 'a', roleSnapshot: e.db.get('roles', 'a'), prompt: 'long job', sourceMessageId: 'm-busy', status: 'in_progress', currentRunId: 'r-busy', contextPrepared: true });
  const busy = e.calls.adoptTask('busy');
  e.db.put('coordinationRequests', { ...busy, status: 'running', currentRunId: 'r-busy' });
  e.db.put('runs', { id: 'r-busy', projectId: P, taskId: 'busy', requestId: busy.id, roleId: 'a', roleSnapshot: e.db.get('roles', 'a'), nodeId: 'w1', status: 'running', lastSeq: 0 });
  const steering = e.steering.request(P, t2.id, 'cmd-run', { mode: 'replace' });
  assert.deepEqual(steering.waitForRunIds, ['r-busy'], 'the running turn is stopped');
  assert.equal(e.db.get('coordinationRequests', busy.id).status, 'cancelled', 'and its own request is cancelled');
  assert.equal(e.db.get('coordinationRequests', e.parent.id).status, 'waiting_call', 'the separate open wait is kept');
  assert.deepEqual(renderRunInputParts({ instruction: 'change course', steering }).home.map(p => p.key), ['steering']);
});
