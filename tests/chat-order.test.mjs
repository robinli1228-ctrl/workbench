// Group chat order is trigger time: a run's reply sits where the run was triggered, and a message's createdAt never changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = name => import(pathToFileURL(join(root, 'src', name)).href);
const { Store } = await load('store.mjs');
const { Rooms } = await load('rooms.mjs');
const P = 'p1', at = minute => `2026-10-20T10:${String(minute).padStart(2, '0')}:00.000Z`;

function env() {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'Chat', root: '/tmp/chat', createdAt: at(0) });
  db.put('roles', { id: 'a', projectId: P, name: 'A', enabled: true });
  const rooms = new Rooms(db); rooms.touch = () => {};
  return { db, rooms };
}

test('a reply is placed at its run trigger time even though it is written later than newer messages', () => {
  const { db, rooms } = env();
  db.put('roomMessages', { id: 'u1', projectId: P, sender: 'human', text: '@A go', taskIds: ['t1'], createdAt: at(0) });
  db.put('runs', { id: 'r1', projectId: P, taskId: 't1', roleId: 'a', roleSnapshot: { name: 'A' }, status: 'running', lastSeq: 0, createdAt: at(1) });
  db.put('roomMessages', { id: 'u2', projectId: P, sender: 'human', text: 'meanwhile', taskIds: [], createdAt: at(5) });
  db.put('roomMessages', { id: 'u3', projectId: P, sender: 'human', text: 'later', taskIds: [], createdAt: at(6) });
  db.put('roomMessages', { id: 'result-r1', projectId: P, sender: 'agent', senderName: 'A', roleId: 'a', runId: 'r1', text: 'done', taskIds: [], createdAt: at(10) });
  const page = rooms.messages(P);
  assert.deepEqual(page.messages.map(m => m.id), ['u1', 'result-r1', 'u2', 'u3']);
  assert.equal(page.messages[1].orderAt, at(1));
  assert.equal(page.messages[1].createdAt, at(10));
  // Paging keeps the same order: the cursor walks the sorted list.
  const older = rooms.messages(P, 'u3');
  assert.deepEqual(older.messages.map(m => m.id), ['u1', 'result-r1', 'u2']);
});

test('messages created in the same millisecond keep Home receipt order, and a rewrite cannot change createdAt', () => {
  const { db, rooms } = env();
  db.put('roomMessages', { id: 'b', projectId: P, sender: 'human', text: 'b', taskIds: [], createdAt: at(2) });
  db.put('roomMessages', { id: 'a', projectId: P, sender: 'human', text: 'a', taskIds: [], createdAt: at(2) });
  db.put('roomMessages', { id: 'setup', projectId: P, sender: 'system', text: 'setup', taskIds: [], createdAt: at(1) });
  db.put('roomMessages', { ...db.get('roomMessages', 'setup'), text: 'setup again', createdAt: at(9) });
  assert.equal(db.get('roomMessages', 'setup').createdAt, at(1));
  assert.equal(db.get('roomMessages', 'setup').text, 'setup again');
  assert.deepEqual(rooms.messages(P).messages.map(m => m.id), ['setup', 'b', 'a']);
});
