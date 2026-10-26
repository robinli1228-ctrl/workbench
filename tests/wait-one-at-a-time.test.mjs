// Waiting for one call at a time: a call that finished while the owner was busy with an earlier result can still be
// waited for, wakes the owner at once, and is carried only once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Rooms } from '../src/rooms.mjs';
import { RoleCalls } from '../src/role-calls.mjs';
import { createAgentCalls } from '../src/agent-calls.mjs';
import { dependencySnapshot } from '../src/coordination-wait.mjs';

const P = 'p1';
function env() {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'demo', supervisorRoleId: 'sup' });
  db.put('workspaces', { id: `${P}:w1`, projectId: P, nodeId: 'w1', localRoot: '/xxxxx' });
  for (const [id, name] of [['sup', 'Supervisor'], ['c', 'Reviewer'], ['x', 'Builder']])
    db.put('roles', { id, projectId: P, name, nodeId: 'w1', runtime: 'claude', model: 'm', mode: 'workspace-write', enabled: true });
  db.put('roomMessages', { id: 'm1', projectId: P, sender: 'human', text: 'do both', taskIds: ['t1'] });
  db.put('tasks', { id: 't1', projectId: P, origin: 'chat', roleId: 'c', roleSnapshot: db.get('roles', 'c'), prompt: 'do both', sourceMessageId: 'm1', status: 'in_progress', currentRunId: 'r1', createdAt: new Date().toISOString() });
  db.put('runs', { id: 'r1', projectId: P, taskId: 't1', roleId: 'c', roleSnapshot: db.get('roles', 'c'), nodeId: 'w1', sourceMessageId: 'm1', status: 'running', lastSeq: 0 });
  const calls = new RoleCalls(db), rooms = new Rooms(db); rooms.touch = () => {};
  calls.adoptTask('t1');
  return { db, calls, rooms };
}
const finish = (e, id) => {
  e.db.put('coordinationRequests', { ...e.db.get('coordinationRequests', id), status: 'succeeded', result: `done ${id}`, updatedAt: new Date().toISOString() });
  e.calls.settleResult(e.db.get('coordinationRequests', id));
};
/** The continuation the wait created, now running as the owner's next turn. */
const startContinuation = (e, ownerId, runId) => {
  const next = e.db.get('coordinationRequests', e.db.get('coordinationRequests', ownerId).continuationRequestId);
  const taskId = `task-${runId}`;
  e.db.put('tasks', { id: taskId, projectId: P, origin: 'chat', roleId: 'c', roleSnapshot: e.db.get('roles', 'c'), prompt: next.summary, requestId: next.id, status: 'in_progress', currentRunId: runId, createdAt: new Date().toISOString() });
  e.db.put('runs', { id: runId, projectId: P, taskId, requestId: next.id, roleId: 'c', roleSnapshot: e.db.get('roles', 'c'), nodeId: 'w1', status: 'running', lastSeq: 0 });
  e.db.put('coordinationRequests', { ...next, taskId, status: 'running', currentRunId: runId });
  return next;
};

test('a call that finished during an earlier review can still be waited for and wakes the owner once', () => {
  const e = env(), run = () => e.db.get('runs', 'r1');
  const a = createAgentCalls(e, run(), { role: 'Builder', kind: 'direct', requestId: 'A', text: 'build A' }).requestId;
  const b = createAgentCalls(e, run(), { role: 'Builder', kind: 'direct', requestId: 'B', text: 'build B' }).requestId;
  e.calls.wait(run(), 'review A first', { requestIds: [a] });
  e.db.put('runs', { ...run(), status: 'succeeded' });
  finish(e, a);
  const first = startContinuation(e, 'task:t1', 'r2');
  assert.match(first.summary, /done .*A/, 'the first wake carries A');
  assert.doesNotMatch(first.summary, /done .*B/);

  finish(e, b); // B finishes while the owner is still reviewing A
  assert.deepEqual(dependencySnapshot(e.db, first.id).map(d => d.requestId), [b], 'the turn sees that B is back');
  const waiting = e.calls.wait(e.db.get('runs', 'r2'), 'now B', { requestIds: ['B'] });
  assert.equal(waiting.status, 'waiting_call', 'waiting for a call that already finished is accepted');
  e.db.put('runs', { ...e.db.get('runs', 'r2'), status: 'succeeded' });
  e.calls.resume(first.id);
  const second = startContinuation(e, first.id, 'r3');
  assert.match(second.summary, /done .*B/, 'the owner is woken at once with B');
  assert.doesNotMatch(second.summary, /done .*A/, 'A is not carried again');
  assert.throws(() => e.calls.wait(e.db.get('runs', 'r3'), 'again', { requestIds: [a] }), /requestIds/, 'a call already carried cannot be waited for again');
  assert.deepEqual(dependencySnapshot(e.db, second.id), [], 'nothing is left to report');
});
