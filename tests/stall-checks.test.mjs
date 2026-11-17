// A role's turn quiet for ten minutes gets one internal supervisor check: no chat message, no reply card, the facts and
// the wb run finish choice when only background commands keep its finished reply open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Rooms } from '../src/rooms.mjs';
import { inspectRunProgress } from '../src/run-monitor.mjs';
import { dispatchStallChecks } from '../src/stall-checks.mjs';
import { executionConflict } from '../src/execution-workspace.mjs';

function setup() {
  const db = new Store(':memory:'), rooms = new Rooms(db);rooms.touch = () => {};
  db.put('projects', { id: 'p', name: 'p', supervisorRoleId: 'sup' });
  for (const [id, name, extra] of [['sup', 'Supervisor', { systemSupervisor: true }], ['c', 'Claude', {}]])
    db.put('roles', { id, projectId: 'p', name, nodeId: 'w1', runtime: 'claude', model: 'm', mode: 'workspace-write', enabled: true, ...extra });
  return { db, rooms };
}
const old = new Date(Date.now() - 11 * 60000).toISOString();

test('a quiet turn whose reply finished but background commands stay open: one internal check for the supervisor', () => {
  const { db, rooms } = setup();
  db.put('runs', { id: 'r1', projectId: 'p', roleId: 'c', nodeId: 'w1', status: 'running', updatedAt: old, createdAt: old, lastSeq: 0,
    awaitingBackground: { since: old, tasks: [{ id: 'bk1', description: 'Write recheck file', type: 'local_bash' }] } });
  inspectRunProgress(db, () => true);
  assert.equal(db.get('runAlerts', 'r1').kind, 'silent');
  assert.equal(dispatchStallChecks(db, rooms), true);
  const [message] = db.list('roomMessages');
  assert.equal(message.visibility, 'internal', 'not shown in the chat');assert.equal(message.kind, 'stall_check');
  assert.match(message.text, /wb run finish r1/);assert.match(message.text, /Write recheck file/);
  const task = db.get('tasks', message.taskIds[0]);
  assert.equal(task.roleId, 'sup');assert.equal(task.backgroundFollowup, true, 'runs in the background, its result stays private');
  assert.equal(task.diagnosis, true, 'read-only: not held back by the quiet turn\'s workspace');
  assert.equal(dispatchStallChecks(db, rooms), false, 'once per alert');assert.equal(db.list('roomMessages').length, 1);
  // A new alert for the same turn (it spoke and went quiet again) is not checked a second time.
  db.put('runAlerts', { ...db.get('runAlerts', 'r1'), createdAt: new Date().toISOString(), checkMessageId: null });
  assert.equal(dispatchStallChecks(db, rooms), false, 'once per turn');assert.equal(db.list('roomMessages').length, 1);
});

test('no check for a turn still replying (no finish offered), an offline device, the supervisor itself, or without a supervisor', () => {
  const { db, rooms } = setup();
  db.put('runs', { id: 'r2', projectId: 'p', roleId: 'c', nodeId: 'w1', status: 'running', updatedAt: old, createdAt: old, lastSeq: 0 });
  db.put('runs', { id: 'r3', projectId: 'p', roleId: 'sup', nodeId: 'w1', status: 'running', updatedAt: old, createdAt: old, lastSeq: 0 });
  db.put('runs', { id: 'r4', projectId: 'p', roleId: 'c', nodeId: 'w2', status: 'running', updatedAt: old, createdAt: old, lastSeq: 0 });
  inspectRunProgress(db, id => id === 'w1');
  dispatchStallChecks(db, rooms);
  const texts = db.list('roomMessages').map(m => m.text);
  assert.equal(texts.length, 1, 'only r2: r3 is the supervisor, r4 is on an offline device');
  assert.doesNotMatch(texts[0], /wb run finish/);assert.match(texts[0], /r2/);
  db.put('projects', { id: 'p', name: 'p', supervisorRoleId: null });
  db.put('runs', { id: 'r5', projectId: 'p', roleId: 'c', nodeId: 'w1', status: 'running', updatedAt: old, createdAt: old, lastSeq: 0 });
  inspectRunProgress(db, () => true);dispatchStallChecks(db, rooms);
  assert.equal(db.list('roomMessages').length, 1);
});

test('a diagnosis run neither waits for nor holds the project workspace', () => {
  const busy = [{ projectId: 'p', nodeId: 'w1' }];
  assert.equal(executionConflict({ projectId: 'p', nodeId: 'w1' }, busy), true);
  assert.equal(executionConflict({ projectId: 'p', nodeId: 'w1', diagnosis: true }, busy), false);
  assert.equal(executionConflict({ projectId: 'p', nodeId: 'w1' }, [{ projectId: 'p', nodeId: 'w1', diagnosis: true }]), false);
});
