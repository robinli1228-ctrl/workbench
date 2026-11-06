// A role's new model applies to its work that has not started; a turn already running finishes on the model it began with.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Rooms } from '../src/rooms.mjs';
import { Coordinator } from '../src/coordinator.mjs';

test('changing the model updates queued work of that role only', () => {
  const db = new Store(':memory:'), P = 'p1';
  db.put('projects', { id: P, name: 'demo' });
  db.put('workspaces', { id: `${P}:w1`, projectId: P, nodeId: 'w1', localRoot: '/xxxxx' });
  db.put('workers', { id: 'w1', name: 'w1', online: true, capabilities: { runtimeDiscovery: true, permissionScopes: { codex: ['project'] } },
    runtimes: [{ type: 'codex', supported: true, available: true, authReady: true, checkedAt: new Date().toISOString(), models: [{ id: 'old', efforts: [] }, { id: 'new', efforts: [] }] }] });
  const rooms = new Rooms(db);
  const input = { name: 'dev', nodeId: 'w1', runtime: 'codex', model: 'old', instructions: '', enabled: true };
  const role = rooms.saveRole(P, input), other = rooms.saveRole(P, { ...input, name: 'qa' });
  const task = (id, r, extra = {}) => db.put('tasks', { id, projectId: P, origin: 'chat', roleId: r.id, roleSnapshot: r, model: r.model, status: 'ready', ...extra });
  task('queued', role);task('running', role, { status: 'in_progress', currentRunId: 'run-1' });task('peer', other);
  db.put('coordinationRequests', { id: 'call', projectId: P, conversationId: P, kind: 'consult', targetRoleId: role.id, targetSnapshot: role, status: 'queued' });
  rooms.saveRole(P, { ...input, id: role.id, revision: role.revision, model: 'new' });
  assert.equal(db.get('tasks', 'queued').model, 'new');
  assert.equal(db.get('tasks', 'queued').roleSnapshot.model, 'new');
  assert.equal(db.get('coordinationRequests', 'call').targetSnapshot.model, 'new', 'a call not yet started uses the new model');
  assert.equal(db.get('tasks', 'running').model, 'old', 'the running turn is left alone');
  assert.equal(db.get('tasks', 'peer').model, 'old', 'other roles are untouched');
  db.put('roles', { id: 'sup', projectId: P, name: 'Supervisor', systemSupervisor: true, nodeId: 'w1', runtime: 'codex', model: 'old', enabled: true });
  db.put('projects', { ...db.get('projects', P), supervisorRoleId: 'sup' });
  task('intake', db.get('roles', 'sup'));
  new Coordinator(db).saveSupervisor(P, 'w1', { runtime: 'codex', model: 'new', enabled: true });
  assert.equal(db.get('tasks', 'intake').model, 'new', 'the supervisor settings apply the same way');
});
