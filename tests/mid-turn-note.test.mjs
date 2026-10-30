// Notes a role posts during its turn read as sent; only the turn's final reply follows the run, so one role never shows
// several "running" replies at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Rooms } from '../src/rooms.mjs';
import { midTurnNote } from '../public/room.js';

test('wb notes are mid-turn notes; the final result and other messages are not', () => {
  const db = new Store(':memory:');
  db.put('projects', { id: 'p', name: 'demo' });
  const run = { id: 'r1', projectId: 'p', roleId: 'a', roleSnapshot: { name: 'Executor' }, status: 'running' };
  const rooms = new Rooms(db); rooms.touch = () => {};
  const first = rooms.agentNote(run, 'part 1'), second = rooms.agentNote(run, 'part 2');
  assert.equal(midTurnNote(first), true);
  assert.equal(midTurnNote(second), true);
  assert.equal(midTurnNote({ id: 'result-r1', sender: 'agent', runId: 'r1' }), false, 'the final reply follows its run');
  assert.equal(midTurnNote({ id: 'm1', sender: 'human', runId: 'r1' }), false);
  assert.equal(midTurnNote({ id: 'h1', sender: 'agent', kind: 'handoff' }), false, 'no run, not a note');
  db.close();
});
