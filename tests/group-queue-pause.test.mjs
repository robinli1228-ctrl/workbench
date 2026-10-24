// A group conversation's queue can be paused like a Sessions queue: queued messages wait, Steer now still goes, an emptied queue un-pauses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = name => import(pathToFileURL(join(root, 'src', name)).href);
const { Store } = await load('store.mjs');
const { Rooms } = await load('rooms.mjs');
const { workspaceState } = await load('workspace-state.mjs');
const { tr } = await load('i18n.mjs');
const P = 'p1';

function env() {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'Chat', root: '/tmp/chat', createdAt: new Date().toISOString() });
  db.put('roles', { id: 'a', projectId: P, name: 'A', enabled: true, nodeId: 'w1' });
  const rooms = new Rooms(db); rooms.touch = () => {};
  const task = (id, extra = {}) => db.put('tasks', { id, projectId: P, origin: 'chat', roleId: 'a', roleSnapshot: db.get('roles', 'a'), prompt: id, status: 'ready', contextPrepared: true, createdAt: new Date().toISOString(), ...extra });
  return { db, rooms, task };
}

test('a paused group queue holds its messages; Steer now and other conversations are not held', () => {
  const { db, rooms, task } = env();
  task('t1');
  db.put('groupConversations', { id: 'c2', projectId: P, title: 'Other' });
  task('t2', { conversationId: 'c2' });
  task('t3', { steering: { mode: 'replace', waitForRunIds: [] } });
  assert.deepEqual(rooms.setQueuePaused(P, { paused: true }), { paused: true });
  rooms.schedule(() => false);
  assert.equal(db.get('tasks', 't1').waitingReason, tr('rooms.queuePaused'));
  assert.notEqual(db.get('tasks', 't2').waitingReason, tr('rooms.queuePaused'));
  assert.notEqual(db.get('tasks', 't3').waitingReason, tr('rooms.queuePaused'));
  const state = id => workspaceState({ projects: db.list('projects'), conversations: db.list('groupConversations'), runs: [], tasks: [], chatQueuePauses: db.list('chatQueuePauses') }, P, id).state.chatQueuePaused;
  assert.equal(state(P), true);
  assert.equal(state('c2'), false);
  assert.deepEqual(rooms.setQueuePaused(P, { paused: false }), { paused: false });
  rooms.schedule(() => false);
  assert.notEqual(db.get('tasks', 't1').waitingReason, tr('rooms.queuePaused'));
});

test('pausing an empty queue does nothing, and a queue that empties un-pauses itself', () => {
  const { db, rooms, task } = env();
  assert.deepEqual(rooms.setQueuePaused(P, { paused: true }), { paused: false });
  task('t1');
  rooms.setQueuePaused(P, { paused: true });
  db.put('tasks', { ...db.get('tasks', 't1'), status: 'cancelled' });
  rooms.schedule(() => false);
  assert.equal(db.get('chatQueuePauses', P), null);
  assert.throws(() => rooms.setQueuePaused(P, { paused: 'yes' }));
  assert.throws(() => rooms.setQueuePaused(P, { paused: true, conversationId: 'missing' }));
});
