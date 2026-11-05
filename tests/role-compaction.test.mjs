// A role's large context is compacted only after the work it was part of has ended and the role stayed idle, in its retained process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { noteRoleCompaction, dueRoleCompactions, recordRoleCompaction, roleIdle, compactThreshold, COMPACT_AT_TOKENS, COMPACT_IDLE_MS } from '../src/role-compaction.mjs';
import { RoleCalls } from '../src/role-calls.mjs';
import { WarmSessions } from '../src/warm-sessions.mjs';

const P = 'p1', N = 'w1';
function env() {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'Chat', root: '/tmp/chat' });
  db.put('workers', { id: N, capabilities: { roleCompaction: 1 } });
  db.put('roleSessions', { id: 's1', projectId: P, roleId: 'a', nodeId: N, runtime: 'claude', lastRunId: 'r1' });
  const run = db.put('runs', { id: 'r1', projectId: P, roleId: 'a', roleSessionId: 's1', nodeId: N, status: 'succeeded', runtimeRetained: true, createdAt: '2026-10-23T10:00:00Z', contextUsage: { usedTokens: COMPACT_AT_TOKENS + 1 } });
  const sent = [], tick = now => dueRoleCompactions(db, { send: (nodeId, m) => sent.push({ nodeId, ...m }), now });
  return { db, run, sent, tick };
}

test('a large retained session is compacted only after the role stays idle, and once per Run', () => {
  const { db, run, sent, tick } = env(), t0 = Date.now();
  assert.equal(noteRoleCompaction(db, { ...run, contextUsage: { usedTokens: 1000 } }, { now: t0 }), false);
  assert.equal(noteRoleCompaction(db, { ...run, runtimeRetained: false }, { now: t0 }), false);
  assert.equal(noteRoleCompaction(db, run, { online: () => false, now: t0 }), false);
  assert.equal(noteRoleCompaction(db, run, { now: t0 }), true);
  assert.equal(noteRoleCompaction(db, run, { now: t0 }), false);
  tick(t0 + COMPACT_IDLE_MS - 1);
  assert.deepEqual(sent, []);
  // Still on the same matter when due: a queued message for the role keeps it pending.
  db.put('tasks', { id: 't2', projectId: P, origin: 'chat', roleId: 'a', status: 'ready' });
  tick(t0 + COMPACT_IDLE_MS + 1);
  assert.deepEqual(sent, []);
  assert.equal(db.get('roleSessions', 's1').compaction.status, 'pending');
  db.put('tasks', { ...db.get('tasks', 't2'), status: 'succeeded' });
  tick(t0 + COMPACT_IDLE_MS + 2);
  assert.deepEqual(sent, [{ nodeId: N, type: 'compact_role_session', roleSessionId: 's1', afterRunId: 'r1' }]);
  assert.equal(recordRoleCompaction(db, 'other-node', { roleSessionId: 's1', afterRunId: 'r1', ok: true }), false);
  assert.equal(recordRoleCompaction(db, N, { roleSessionId: 's1', afterRunId: 'r1', ok: true, usedTokens: 30000 }), true);
  assert.equal(db.get('roleSessions', 's1').compaction.status, 'compacted');
  assert.equal(db.get('roleSessions', 's1').compaction.usedTokensAfter, 30000);
});

test('a newer Run of the session supersedes a pending compaction; a short context window lowers the threshold', () => {
  const { db, run, sent, tick } = env(), t0 = Date.now();
  noteRoleCompaction(db, run, { now: t0 });
  db.put('runs', { id: 'r2', projectId: P, roleId: 'a', roleSessionId: 's1', nodeId: N, status: 'running', createdAt: '2026-10-23T10:05:00Z' });
  db.put('roleSessions', { ...db.get('roleSessions', 's1'), activeRunId: 'r2' });
  tick(t0 + COMPACT_IDLE_MS + 1);
  assert.deepEqual(sent, []);
  assert.equal(db.get('roleSessions', 's1').compaction.status, 'superseded');
  assert.equal(roleIdle(db, run), false);
  const small = { ...run, id: 'r3', contextUsage: { usedTokens: 130000, limitTokens: 200000 } };
  db.put('runs', small);
  assert.equal(noteRoleCompaction(db, small, { now: t0 }), true);
});

test('a borrowed process still belongs to the cache and is kept again or retired when given back', async () => {
  const retired = [];
  const proc = { exitCode: null, signalCode: null, killed: false, once(event, fn) { if (event === 'exit') this.exit = fn; }, removeListener() {}, pid: 7 };
  const warm = new WarmSessions({ idleMs: 60000, max: 2, retired: (meta, pid) => retired.push(pid) });
  warm.alive = s => s.proc === proc && proc.exitCode === null;
  const session = { done: true, proc, shutdown() { proc.exitCode = 0; proc.exit?.(); } };
  assert.equal(warm.keep('s1', 'fp', session, { runId: 'r1' }), true);
  const lent = warm.borrow('s1');
  assert.equal(lent.session, session);
  assert.equal(warm.owns(7), true);
  assert.equal(warm.borrow('s1'), null);
  assert.equal(await warm.giveBack('s1', { keep: true }), true);
  assert.deepEqual(retired, []);
  warm.borrow('s1');
  assert.equal(await warm.giveBack('s1'), false);
  assert.deepEqual(retired, [7]);
  assert.equal(warm.owns(7), false);
  for (const entry of warm.entries.values()) clearTimeout(entry.timer);
});

test('the threshold is half of the model window; a fixed size applies only when the CLI reports none', () => {
  assert.equal(compactThreshold({ usedTokens: 1, limitTokens: 1000000 }), 500000);
  assert.equal(compactThreshold({ usedTokens: 1, limitTokens: 272000 }), 136000);
  assert.equal(compactThreshold({ usedTokens: 1 }), COMPACT_AT_TOKENS);
  const { db, run } = env(), t0 = Date.now();
  assert.equal(noteRoleCompaction(db, { ...run, contextUsage: { usedTokens: 450000, limitTokens: 1000000 } }, { now: t0 }), false);
  assert.equal(noteRoleCompaction(db, { ...run, contextUsage: { usedTokens: 520000, limitTokens: 1000000 } }, { now: t0 }), true);
});

test('a call still waiting for its delivery does not hold the role; an open call does, and a dropped compaction keeps why', () => {
  const { db, run, sent, tick } = env(), t0 = Date.now();
  noteRoleCompaction(db, run, { now: t0 });
  // A handoff to the role whose commit never arrived: it may wait for ever and must not keep the context from compacting.
  db.put('coordinationRequests', { id: 'stale', projectId: P, conversationId: P, targetRoleId: 'a', status: 'waiting_delivery', createdAt: '2026-10-22T10:00:00Z' });
  assert.equal(roleIdle(db, run), true);
  db.put('coordinationRequests', { id: 'open-call-1234', projectId: P, conversationId: P, targetRoleId: 'a', status: 'queued', createdAt: '2026-10-23T10:01:00Z' });
  tick(t0 + COMPACT_IDLE_MS + 1);
  assert.deepEqual(sent, []);
  assert.equal(db.get('roleSessions', 's1').compaction.blockedBy, 'call:open-call-1234', 'the page can say what it waits for');
  tick(t0 + COMPACT_IDLE_MS + 3600001);
  const dropped = db.get('roleSessions', 's1').compaction;
  assert.equal(dropped.status, 'expired');
  assert.equal(dropped.blockedBy, 'call:open-call-1234', 'and why it was dropped');
});

test('a role found idle after the hour is still compacted: nothing newer ran, so the large context is still there', () => {
  const { db, run, sent, tick } = env(), t0 = Date.now();
  noteRoleCompaction(db, run, { now: t0 });
  tick(t0 + COMPACT_IDLE_MS + 2 * 3600000);
  assert.deepEqual(sent.map(m => m.type), ['compact_role_session']);
  assert.equal(db.get('roleSessions', 's1').compaction.status, 'requested');
});

test('a handoff whose delivery never came is cancelled a day after it was sent, saying why', () => {
  const db = new Store(':memory:'), calls = new RoleCalls(db), sent = Date.parse('2026-11-03T03:00:00Z');
  db.put('projects', { id: P, name: 'Chat', root: '/tmp/chat' });
  db.put('coordinationRequests', { id: 'old', projectId: P, conversationId: P, kind: 'handoff', targetRoleId: 'a', status: 'waiting_delivery', createdAt: new Date(sent).toISOString(), updatedAt: new Date(sent).toISOString() });
  db.put('coordinationRequests', { id: 'fresh', projectId: P, conversationId: P, kind: 'handoff', targetRoleId: 'a', status: 'waiting_delivery', createdAt: new Date(sent + 23 * 3600000).toISOString() });
  // Waits that can still end stay: a delivery not yet ready, a sync batch, review isolation. A blocked delivery cannot.
  const at = new Date(sent).toISOString();
  db.put('deliveries', { id: 'd-ready', projectId: P, status: 'ready' });db.put('deliveries', { id: 'd-blocked', projectId: P, status: 'blocked' });
  db.put('coordinationRequests', { id: 'ready', projectId: P, conversationId: P, kind: 'handoff', targetRoleId: 'a', status: 'waiting_delivery', deliveryId: 'd-ready', createdAt: at });
  db.put('coordinationRequests', { id: 'blocked', projectId: P, conversationId: P, kind: 'handoff', targetRoleId: 'a', status: 'waiting_delivery', deliveryId: 'd-blocked', createdAt: at });
  db.put('coordinationRequests', { id: 'sync', projectId: P, conversationId: P, kind: 'handoff', targetRoleId: 'a', status: 'waiting_delivery', sourceSyncBatchId: 'b1', createdAt: at });
  db.put('coordinationRequests', { id: 'isolated', projectId: P, conversationId: P, kind: 'handoff', targetRoleId: 'a', status: 'waiting_delivery', deliveryId: 'd-ready', waitingReason: 'review_isolation', createdAt: at });
  assert.equal(calls.expireWaits(sent + 23 * 3600000), false, 'not before a day');
  assert.equal(calls.expireWaits(sent + 24 * 3600000 + 1), true);
  const old = db.get('coordinationRequests', 'old');
  assert.equal(old.status, 'cancelled');assert.equal(old.cancelReason, 'delivery_expired');assert.match(old.result, /delivery it waited for|交付/);
  assert.equal(db.get('coordinationRequests', 'blocked').status, 'cancelled');
  for (const id of ['fresh', 'ready', 'sync', 'isolated']) assert.equal(db.get('coordinationRequests', id).status, 'waiting_delivery', id);
});

test('the user closing a task cancels the calls still linked to it and returns the runs to stop', () => {
  const db = new Store(':memory:'), calls = new RoleCalls(db), at = '2026-11-05T03:00:00Z';
  db.put('projects', { id: P, name: 'Chat', root: '/tmp/chat' });
  const call = (id, extra) => db.put('coordinationRequests', { id, projectId: P, conversationId: P, kind: 'direct', targetRoleId: 'a', createdAt: at, ...extra });
  db.put('runs', { id: 'run-1', projectId: P, roleId: 'a', status: 'running', createdAt: at });
  call('running', { conversationTaskId: 'ct:1', status: 'running', currentRunId: 'run-1' });
  call('queued', { conversationTaskId: 'ct:1', status: 'queued' });
  call('handoff', { conversationTaskId: 'ct:1', kind: 'handoff', status: 'waiting_delivery' });
  call('done', { conversationTaskId: 'ct:1', status: 'succeeded' });
  call('other', { conversationTaskId: 'ct:2', status: 'queued' });
  const stop = calls.cancelForTask(P, 'ct:1');
  assert.deepEqual(stop, ['run-1'], 'the running role is stopped');
  for (const id of ['running', 'queued', 'handoff']) {
    const r = db.get('coordinationRequests', id);
    assert.equal(r.status, 'cancelled', id);assert.equal(r.cancelReason, 'task_closed');assert.match(r.result, /closed this task|关闭/);
  }
  assert.equal(db.get('coordinationRequests', 'done').status, 'succeeded', 'finished work keeps its result');
  assert.equal(db.get('coordinationRequests', 'other').status, 'queued', 'another task is untouched');
  assert.deepEqual(calls.cancelForTask(P, 'ct:1'), [], 'closing again changes nothing');
});
