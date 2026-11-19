// Steer on a Claude or Codex role in a group chat adds the queued message to the role's running turn instead of interrupting it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { RoleCalls } from '../src/role-calls.mjs';
import { RoleSteering } from '../src/role-steering.mjs';
import { Rooms } from '../src/rooms.mjs';

const P = 'p1', at = '2026-11-19T05:28:00Z';
function env({ runtime = 'claude', capable = true, runStatus = 'running', text = 'also check the logs' } = {}) {
  const db = new Store(':memory:'), calls = new RoleCalls(db);
  db.put('projects', { id: P, name: 'Chat', root: '/xxxxx' });
  db.put('workers', { id: 'w1', capabilities: capable ? { groupSupplement: 1 } : {} });
  db.put('roles', { id: 'sol', projectId: P, name: 'sol', enabled: true, nodeId: 'w1', runtime, model: 'm', mode: 'workspace-write' });
  const role = db.get('roles', 'sol');
  db.put('tasks', { id: 't1', projectId: P, origin: 'chat', roleId: 'sol', roleSnapshot: role, status: 'in_progress', currentRunId: 'run-1', createdAt: at });
  db.put('runs', { id: 'run-1', projectId: P, taskId: 't1', roleId: 'sol', roleSnapshot: role, nodeId: 'w1', status: runStatus, roleSessionId: 'rs1', seq: 0, createdAt: at });
  db.put('roomMessages', { id: 'm9', projectId: P, conversationId: P, sender: 'human', text, taskIds: ['t9'], createdAt: at });
  db.put('coordinationRequests', { id: 'r9', projectId: P, conversationId: P, kind: 'direct', targetRoleId: 'sol', taskId: 't9', status: 'queued', createdAt: at });
  db.put('tasks', { id: 't9', projectId: P, origin: 'chat', roleId: 'sol', roleSnapshot: role, status: 'ready', sourceMessageId: 'm9', requestId: 'r9', createdAt: at });
  db.put('tasks', { id: 't8', projectId: P, origin: 'chat', roleId: 'sol', roleSnapshot: role, status: 'ready', sourceMessageId: 'm8', createdAt: '2026-11-19T05:20:00Z' });
  return { db, steering: new RoleSteering(db, calls) };
}
let seq = 0;
const event = (db, type, payload) => db.event({ id: `e${++seq}`, runId: 'run-1', seq, type, payload });

for (const runtime of ['claude', 'codex']) test(`${runtime}: the message goes into the running turn; once taken it is completed by that run and joins the chat`, () => {
  const { db, steering } = env({ runtime });
  const receipt = steering.supplement(P, 't9', {}, { online: () => true });
  assert.equal(receipt.supplementing, true);
  const command = db.get('commands', 'supplement-t9-run-1');
  assert.equal(command.type, 'supplement'); assert.equal(command.runId, 'run-1'); assert.match(command.text, /also check the logs/);
  assert.ok(!db.get('runs', 'run-1').stopRequested, 'the running turn is not interrupted');
  assert.throws(() => new Rooms(db).cancel('t9'), /being added|补充/);
  assert.equal(steering.supplement(P, 't9', {}, { online: () => true }).supplementing, true, 'a second press changes nothing');
  event(db, 'supplement', { id: 't9' });
  const task = db.get('tasks', 't9');
  assert.equal(task.status, 'completed'); assert.equal(task.mergedIntoRunId, 'run-1'); assert.equal(task.supplementing, undefined);
  assert.equal(db.get('coordinationRequests', 'r9').status, 'succeeded');
  assert.ok(db.get('roomMessages', 'm9').orderAt, 'the message joins the chat now');
});

test('not taken: the message stays queued and starts after the turn; nothing is interrupted', () => {
  const { db, steering } = env();
  steering.supplement(P, 't9', {}, { online: () => true });
  event(db, 'supplement_failed', { id: 't9', error: 'Claude refused this message' });
  const task = db.get('tasks', 't9');
  assert.equal(task.status, 'ready'); assert.equal(task.supplementing, undefined);
  assert.ok(!db.get('runs', 'run-1').stopRequested);
});

test('a turn that cannot take it now (starting, slash command, old Worker) never interrupts: the message moves to the front', () => {
  for (const options of [{ runStatus: 'starting' }, { text: '/compact' }, { capable: false }]) {
    const { db, steering } = env(options);
    assert.deepEqual(steering.supplement(P, 't9', {}, { online: () => true }), { queuedFirst: true });
    assert.ok(!db.get('commands', 'supplement-t9-run-1'));
    assert.ok(!db.get('runs', 'run-1').stopRequested);
    assert.ok(db.get('tasks', 't9').queueOrder < Date.parse(db.get('tasks', 't8').createdAt), 'ahead of the older queued message');
  }
});

test('other CLIs and idle roles keep the ordinary steer', () => {
  assert.equal(env({ runtime: 'grok' }).steering.supplement(P, 't9', {}, { online: () => true }), null);
  const { db, steering } = env();
  db.put('runs', { ...db.get('runs', 'run-1'), status: 'succeeded' });
  assert.equal(steering.supplement(P, 't9', {}, { online: () => true }), null);
});

test('a late answer for a message that already started on its own changes nothing', () => {
  const { db, steering } = env();
  steering.supplement(P, 't9', {}, { online: () => true });
  db.put('runs', { ...db.get('runs', 'run-1'), status: 'failed' });
  db.put('tasks', { ...db.get('tasks', 't1'), status: 'blocked' });
  db.put('tasks', { ...db.get('tasks', 't9'), status: 'in_progress', currentRunId: 'run-2' });
  event(db, 'supplement', { id: 't9' });
  assert.notEqual(db.get('tasks', 't9').status, 'completed', 'a late answer does not complete a task that started on its own');
});

test('a merged message shares the outcome of its turn: the reply on success, blocked with the reason on failure', () => {
  let { db, steering } = env();
  steering.supplement(P, 't9', {}, { online: () => true });
  event(db, 'supplement', { id: 't9' });
  const { roleSessionId: _session, ...plain } = db.get('runs', 'run-1');
  db.put('runs', { ...plain, result: 'done, logs checked' });
  event(db, 'status', { status: 'succeeded' });
  assert.equal(db.get('coordinationRequests', 'r9').result, 'done, logs checked');
  assert.equal(db.get('tasks', 't9').status, 'completed');
  ({ db, steering } = env());
  steering.supplement(P, 't9', {}, { online: () => true });
  event(db, 'supplement', { id: 't9' });
  { const { roleSessionId: _session, ...plain } = db.get('runs', 'run-1'); db.put('runs', plain); }
  event(db, 'status', { status: 'failed', error: 'API error' });
  assert.equal(db.get('tasks', 't9').status, 'blocked');
  assert.equal(db.get('coordinationRequests', 'r9').status, 'failed');
});

test('a message the Worker could not add goes to the front; a flag left by a turn that ended does not lock it', () => {
  let { db, steering } = env();
  steering.supplement(P, 't9', {}, { online: () => true });
  event(db, 'supplement_failed', { id: 't9' });
  assert.ok(db.get('tasks', 't9').queueOrder < Date.parse(db.get('tasks', 't8').createdAt));
  ({ db, steering } = env());
  steering.supplement(P, 't9', {}, { online: () => true });
  db.put('runs', { ...db.get('runs', 'run-1'), status: 'failed' });
  assert.equal(new Rooms(db).cancel('t9').status, 'cancelled', 'cancel works again once the turn ended');
});

test('a turn whose reply is not posted to the chat does not take the message', () => {
  for (const extra of [{ explicitPublish: true }, { backgroundFollowup: true }, { handoffWait: { requestId: 'x' } }]) {
    const { db, steering } = env();
    db.put('runs', { ...db.get('runs', 'run-1'), ...extra });
    assert.deepEqual(steering.supplement(P, 't9', {}, { online: () => true }), { queuedFirst: true });
  }
});
