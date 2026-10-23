// A role's large context is compacted only after the work it was part of has ended, in its retained process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { roleCompactionDue, requestRoleCompaction, recordRoleCompaction, COMPACT_AT_TOKENS } from '../src/role-compaction.mjs';
import { WarmSessions } from '../src/warm-sessions.mjs';

const P = 'p1', N = 'w1';
function env() {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'Chat', root: '/tmp/chat' });
  db.put('workers', { id: N, capabilities: { roleCompaction: 1 } });
  db.put('roleSessions', { id: 's1', projectId: P, roleId: 'a', nodeId: N, runtime: 'claude' });
  const run = db.put('runs', { id: 'r1', projectId: P, roleId: 'a', roleSessionId: 's1', nodeId: N, status: 'succeeded', runtimeRetained: true, contextUsage: { usedTokens: COMPACT_AT_TOKENS + 1 } });
  return { db, run };
}

test('compaction is due only for a large, retained, finished role with nothing left on the same matter', () => {
  const { db, run } = env();
  assert.equal(roleCompactionDue(db, run), true);
  assert.equal(roleCompactionDue(db, { ...run, contextUsage: { usedTokens: COMPACT_AT_TOKENS - 1 } }), false);
  assert.equal(roleCompactionDue(db, { ...run, runtimeRetained: false }), false);
  assert.equal(roleCompactionDue(db, { ...run, status: 'failed' }), false);
  assert.equal(roleCompactionDue(db, run, { online: () => false }), false);
  // Still on the same matter: a queued message, an open call to it, or a call it made that is still open.
  db.put('tasks', { id: 't2', projectId: P, origin: 'chat', roleId: 'a', status: 'ready' });
  assert.equal(roleCompactionDue(db, run), false);
  db.put('tasks', { ...db.get('tasks', 't2'), status: 'succeeded' });
  db.put('coordinationRequests', { id: 'c1', projectId: P, targetRoleId: 'b', sourceRunId: 'r1', status: 'running' });
  assert.equal(roleCompactionDue(db, run), false);
  db.put('coordinationRequests', { ...db.get('coordinationRequests', 'c1'), status: 'succeeded' });
  assert.equal(roleCompactionDue(db, run), true);
  // Asked once per Run; the device's answer is recorded on the session.
  const sent = [];
  requestRoleCompaction(db, run, m => sent.push(m));
  assert.deepEqual(sent, [{ type: 'compact_role_session', roleSessionId: 's1', afterRunId: 'r1' }]);
  assert.equal(roleCompactionDue(db, run), false);
  assert.equal(recordRoleCompaction(db, 'other-node', { roleSessionId: 's1', afterRunId: 'r1', ok: true }), false);
  assert.equal(recordRoleCompaction(db, N, { roleSessionId: 's1', afterRunId: 'r1', ok: true, usedTokens: 30000 }), true);
  assert.equal(db.get('roleSessions', 's1').compaction.status, 'compacted');
  assert.equal(db.get('roleSessions', 's1').compaction.usedTokensAfter, 30000);
});

test('a retained process can be borrowed for maintenance and kept again without being retired', () => {
  const retired = [];
  const proc = { exitCode: null, signalCode: null, killed: false, once() {}, removeListener() {}, pid: 7 };
  const warm = new WarmSessions({ idleMs: 60000, max: 2, retired: (meta, pid) => retired.push(pid) });
  warm.alive = s => s.proc === proc;
  const session = { done: true, proc, shutdown() {} };
  assert.equal(warm.keep('s1', 'fp', session, { runId: 'r1' }), true);
  const lent = warm.borrow('s1');
  assert.equal(lent.session, session);
  assert.equal(lent.fingerprint, 'fp');
  assert.equal(warm.borrow('s1'), null);
  assert.equal(warm.keep('s1', lent.fingerprint, lent.session, lent.metadata), true);
  assert.deepEqual(retired, []);
  for (const entry of warm.entries.values()) clearTimeout(entry.timer);
});
