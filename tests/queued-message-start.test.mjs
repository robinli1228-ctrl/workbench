// A message that waited in the group queue joins the chat when its reply starts: Home records that time as its chat order,
// so it never lands above messages sent while it waited. A message that started at once, or whose other recipient already
// started, keeps its own time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Rooms } from '../src/rooms.mjs';

const P = 'p1';
function env() {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'demo' });
  db.put('workers', { id: 'w1', name: 'server', platform: 'linux', capacity: 4,
    runtimes: [{ type: 'claude', supported: true, installed: true, available: true, models: [{ id: 'm' }], checkedAt: new Date().toISOString() }],
    capabilities: { runtimeDiscovery: true, roomRoles: 1, projectSpace: 1, managedResume: 1, cliCapacity: 1, concurrentWrites: 1 } });
  db.put('workspaces', { id: `${P}:w1`, projectId: P, nodeId: 'w1', localRoot: '/xxxxx' });
  for (const id of ['a', 'b']) db.put('roles', { id, projectId: P, name: id, nodeId: 'w1', runtime: 'claude', model: 'm', mode: 'workspace-write', enabled: true });
  db.put('projects', { ...db.get('projects', P), allowConcurrentWrites: true });
  const rooms = new Rooms(db); rooms.touch = () => {};
  const ask = (n, roleIds) => {
    const taskIds = roleIds.map((roleId, i) => {
      const id = `t${n}${roleId}`;
      db.put('tasks', { id, projectId: P, origin: 'chat', roleId, roleSnapshot: db.get('roles', roleId), prompt: 'go', sourceMessageId: `m${n}`, status: 'ready', contextPrepared: true, createdAt: new Date(Date.now() - (10 - n) * 1000 + i).toISOString() });
      return id;
    });
    db.put('roomMessages', { id: `m${n}`, projectId: P, sender: 'human', text: 'go', taskIds, createdAt: new Date(Date.now() - (10 - n) * 1000).toISOString() });
    return taskIds;
  };
  // The run ends and gives back its role's session, as the Worker's final report does.
  const finish = taskId => {
    const task = db.get('tasks', taskId), run = db.get('runs', task.currentRunId);
    db.put('runs', { ...run, status: 'succeeded' }); db.put('tasks', { ...task, status: 'done' });
    for (const session of db.list('roleSessions').filter(s => s.activeRunId === run.id)) db.put('roleSessions', { ...session, status: 'idle', activeRunId: null, lastRunId: run.id });
  };
  return { db, rooms, go: () => rooms.schedule(() => true), ask, finish };
}

test('a message that waited takes its start time; one that started at once keeps its own', () => {
  const { db, rooms, go, ask, finish } = env();
  const [first] = ask(1, ['a']); go();
  assert.ok(db.get('tasks', first).currentRunId, 'the first message starts at once');
  assert.equal(db.get('roomMessages', 'm1').orderAt, undefined);
  const [second] = ask(2, ['a']); go();
  assert.ok(db.get('tasks', second).waitingReason, 'the second waits for the busy role');
  assert.equal(db.get('roomMessages', 'm2').orderAt, undefined);
  ask(3, ['b']); go();
  finish(first); const before = new Date().toISOString(); go();
  assert.ok(db.get('tasks', second).currentRunId, 'it starts once the role is free');
  assert.ok(db.get('roomMessages', 'm2').orderAt >= before, 'and joins the chat at that moment');
  assert.equal(db.get('roomMessages', 'm2').orderAt, db.get('runs', db.get('tasks', second).currentRunId).createdAt, 'at its run\'s start');
  db.put('roomMessages', { id: `result-${db.get('tasks', second).currentRunId}`, projectId: P, sender: 'agent', runId: db.get('tasks', second).currentRunId, text: 'done' });
  const order = rooms.messages(P).messages.map(m => m.id);
  assert.ok(order.indexOf('m3') < order.indexOf('m2') && order.indexOf('m2') < order.indexOf(`result-${db.get('tasks', second).currentRunId}`), 'below what was sent while it waited, above its own reply');
});

test('a message whose other recipient already started stays at its own time', () => {
  const { db, go, ask, finish } = env();
  const [busy] = ask(1, ['a']); go();
  const [toB, toA] = ask(2, ['b', 'a']); go();
  assert.ok(db.get('tasks', toB).currentRunId, 'b starts at once, so the message is in the chat');
  assert.ok(db.get('tasks', toA).waitingReason);
  finish(busy); go();
  assert.ok(db.get('tasks', toA).currentRunId);
  assert.equal(db.get('roomMessages', 'm2').orderAt, undefined);
});
