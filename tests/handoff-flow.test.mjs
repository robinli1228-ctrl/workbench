// Smoother handoffs: work goes straight to a role on another device, a wait does not time out while its calls are queued,
// a return whose task was closed meanwhile is withdrawn, and a message without @ answers the reply it follows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Rooms } from '../src/rooms.mjs';
import { RoleCalls } from '../src/role-calls.mjs';
import { createAgentCalls } from '../src/agent-calls.mjs';
import { wakeTaskReturns } from '../src/task-return.mjs';

const P = 'p1', at = '2026-11-05T03:00:00Z';
function env() {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'demo', root: '/xxxxx', supervisorRoleId: 'sup' });
  for (const node of ['w1', 'w2']) db.put('workspaces', { id: `${P}:${node}`, projectId: P, nodeId: node, localRoot: '/xxxxx' });
  for (const [id, name, nodeId, extra] of [['sup', 'Supervisor', 'w1', { systemSupervisor: true }], ['b', 'Builder', 'w1', {}], ['far', 'Remote', 'w2', {}]])
    db.put('roles', { id, projectId: P, name, nodeId, runtime: 'claude', model: 'm', mode: 'workspace-write', enabled: true, ...extra });
  db.put('roomMessages', { id: 'm1', projectId: P, sender: 'human', text: 'work', taskIds: ['t1'] });
  db.put('tasks', { id: 't1', projectId: P, origin: 'chat', roleId: 'b', roleSnapshot: db.get('roles', 'b'), prompt: 'work', sourceMessageId: 'm1', status: 'in_progress', currentRunId: 'r1' });
  db.put('runs', { id: 'r1', projectId: P, taskId: 't1', roleId: 'b', roleSnapshot: db.get('roles', 'b'), nodeId: 'w1', sourceMessageId: 'm1', status: 'running', lastSeq: 0 });
  const calls = new RoleCalls(db), rooms = new Rooms(db); rooms.touch = () => {};
  calls.adoptTask('t1');
  return { db, calls, rooms };
}

test('direct work for a role on another device goes to that role, not through the supervisor', () => {
  const { db, calls, rooms } = env();
  const sent = createAgentCalls({ db, calls, rooms }, db.get('runs', 'r1'), { requestId: 'x1', role: 'Remote', kind: 'direct', text: 'run the Java tests' });
  const request = db.get('coordinationRequests', sent.requestId);
  assert.equal(request.targetRoleId, 'far');
  assert.equal(request.summary, 'run the Java tests', 'the brief arrives as written');
  db.put('runs', { ...db.get('runs', 'r1'), execution: { baselines: [{ commit: 'abc' }] } });
  const pinned = createAgentCalls({ db, calls, rooms }, db.get('runs', 'r1'), { requestId: 'x0', role: 'Remote', kind: 'direct', text: 'check it' });
  assert.equal(db.get('coordinationRequests', pinned.requestId).execution, null, 'the caller\'s own device versions do not travel to another device');
  db.put('runs', { ...db.get('runs', 'r1'), planId: 'plan-1' });
  assert.throws(() => createAgentCalls({ db, calls, rooms }, db.get('runs', 'r1'), { requestId: 'x2', role: 'Remote', kind: 'direct', text: 'more' }), /./, 'a plan stage still may not add cross-device work');
});

test('a wait does not time out while a call is queued; its length counts from the last one to start', () => {
  const { db, calls } = env(), t0 = Date.parse(at), min = 60000;
  db.put('runs', { id: 'run-p', projectId: P, roleId: 'b', status: 'succeeded', createdAt: at });
  db.put('coordinationRequests', { id: 'parent', projectId: P, conversationId: P, kind: 'direct', targetRoleId: 'b', taskId: 'tp', status: 'waiting_call', currentRunId: 'run-p',
    waitRequestIds: ['child'], resumeSummary: 'continue', waitStartedAt: at, waitDeadlineAt: new Date(t0 + 30 * min).toISOString(), createdAt: at });
  db.put('coordinationRequests', { id: 'child', projectId: P, conversationId: P, kind: 'direct', targetRoleId: 'far', parentRequestId: 'parent', status: 'queued', createdAt: at });
  calls.resume('parent', t0 + 50 * min);
  assert.equal(db.get('coordinationRequests', 'parent').continuationRequestId, undefined, 'queued behind other work: no timeout');
  const capped = env(), cap = capped.calls;
  for (const [k, v] of [['runs', db.get('runs', 'run-p')], ['coordinationRequests', db.get('coordinationRequests', 'parent')], ['coordinationRequests', db.get('coordinationRequests', 'child')]]) capped.db.put(k, v);
  cap.resume('parent', t0 + 151 * min);
  assert.equal(capped.db.get('coordinationRequests', 'parent').waitEvent?.reason, 'timeout', 'still queued two hours past the deadline: the wait ends');
  db.put('runs', { id: 'run-c', projectId: P, roleId: 'far', status: 'running', createdAt: new Date(t0 + 45 * min).toISOString() });
  db.put('coordinationRequests', { ...db.get('coordinationRequests', 'child'), status: 'running', currentRunId: 'run-c' });
  calls.resume('parent', t0 + 70 * min);
  assert.equal(db.get('coordinationRequests', 'parent').continuationRequestId, undefined, '25 minutes after it started');
  calls.resume('parent', t0 + 76 * min);
  assert.equal(db.get('coordinationRequests', 'parent').waitEvent.reason, 'timeout', '30 minutes after it started');
});

test('a return still queued when its task was closed meanwhile is withdrawn; one for an open task stays', () => {
  const { db } = env();
  for (const [n, status] of [[1, 'done'], [2, 'in_progress']]) {
    db.put('conversationTasks', { id: `ct:${n}`, projectId: P, conversationId: P, number: n, title: 'T', status, ownerRoleId: 'b' });
    db.put('tasks', { id: `tr${n}`, projectId: P, origin: 'chat', roleId: 'b', status: 'ready', requestId: `ret${n}` });
    db.put('coordinationRequests', { id: `ret${n}`, projectId: P, conversationId: P, kind: 'direct', targetRoleId: 'b', taskId: `tr${n}`, status: 'queued', taskReturn: true, conversationTaskId: `ct:${n}`, createdAt: at });
  }
  assert.equal(wakeTaskReturns(db, () => { throw new Error('nothing to post'); }), true);
  assert.equal(db.get('tasks', 'tr1').status, 'cancelled');assert.equal(db.get('coordinationRequests', 'ret1').status, 'cancelled');
  assert.equal(db.get('tasks', 'tr2').status, 'ready');assert.equal(db.get('coordinationRequests', 'ret2').status, 'queued');
});

test('a message without @ right after a role\'s reply answers that reply; otherwise the default intake decides', () => {
  const { db, rooms } = env();
  let n = 0;
  const reply = (minutesAgo, { role = 'far', status = 'succeeded', id } = {}) => {
    const runId = `run-${++n}`;
    db.put('runs', { id: runId, projectId: P, roleId: role, roleSnapshot: db.get('roles', role), nodeId: db.get('roles', role).nodeId, status, workspace: '/xxxxx', lastSeq: 0 });
    return db.put('roomMessages', { id: id || `result-${runId}`, projectId: P, conversationId: P, sender: 'agent', roleId: role, runId, text: 'done', taskIds: [], createdAt: new Date(Date.now() - minutesAgo * 60000).toISOString() }).id;
  };
  const send = text => { const m = rooms.post(P, { clientMessageId: `u${++n}`, text }); return { replyToId: m.replyToId ?? null, roleId: m.taskIds?.[0] ? db.get('tasks', m.taskIds[0])?.roleId ?? null : null }; };
  let id = reply(3);
  assert.deepEqual(send('also check the totals'), { replyToId: id, roleId: 'far' });
  id = reply(3);db.put('roomMessages', { id: 'internal', projectId: P, conversationId: P, sender: 'system', kind: 'task_return', visibility: 'internal', text: 'x', taskIds: [], createdAt: new Date().toISOString() });
  assert.deepEqual(send('and the dates'), { replyToId: id, roleId: 'far' }, 'an internal platform message does not count');
  reply(11);
  assert.deepEqual(send('new topic'), { replyToId: null, roleId: 'sup' }, 'after 10 minutes it is a new message');
  reply(1, { status: 'failed' });
  assert.deepEqual(send('give this to someone else'), { replyToId: null, roleId: 'sup' }, 'a failed turn does not keep the follow-up');
  reply(1, { id: 'note-1' });
  assert.deepEqual(send('ok'), { replyToId: null, roleId: 'sup' }, 'a note or other message is not a final reply');
  reply(1, { role: 'sup' });
  assert.deepEqual(send('have all roles review this'), { replyToId: null, roleId: 'sup' }, 'the supervisor gets it through the default intake');
  reply(1);
  assert.equal(send('@Builder take this').roleId, 'b', 'an @ still decides');
  reply(1);
  db.put('projects', { ...db.get('projects', P), supervisorRoleId: null });
  assert.deepEqual(send('just a thought'), { replyToId: null, roleId: null }, 'without a supervisor an unaddressed message stays discussion');
});
