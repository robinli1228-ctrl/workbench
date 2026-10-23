// A role's large context is compacted only after the work it was part of has ended and the role stayed idle, in its retained process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { noteRoleCompaction, dueRoleCompactions, recordRoleCompaction, roleIdle, COMPACT_AT_TOKENS, COMPACT_IDLE_MS } from '../src/role-compaction.mjs';
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
