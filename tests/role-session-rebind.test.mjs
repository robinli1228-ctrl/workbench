// A role moved to another device or CLI keeps working: its idle old session is retired and a new one starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { RoleSessions } from '../src/role-sessions.mjs';

test('a moved role gets a new session in place of its idle old one; a busy old session still refuses', () => {
  const db = new Store(':memory:'), sessions = new RoleSessions(db);
  const binding = { projectId: 'p1', conversationId: 'p1', roleId: 'agy', nodeId: 'server', runtime: 'agy' };
  const old = sessions.getOrCreate(binding);
  assert.equal(sessions.getOrCreate(binding).id, old.id);
  const moved = sessions.getOrCreate({ ...binding, nodeId: 'mac' });
  assert.notEqual(moved.id, old.id);
  assert.equal(moved.nodeId, 'mac');
  assert.equal(moved.predecessorSessionId, old.id);
  assert.equal(moved.generation, old.generation + 1);
  assert.equal(db.get('roleSessions', old.id).status, 'archived');
  assert.equal(db.get('roleSessions', old.id).archivedReason, 'binding_changed');
  sessions.claim(moved.id, 'run-1');
  assert.throws(() => sessions.getOrCreate({ ...binding, nodeId: 'server' }));
  assert.equal(db.get('roleSessions', moved.id).status, 'running');
});
