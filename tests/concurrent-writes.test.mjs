// The project's manual switch lets roles on one device run at once: only the project lock is relaxed. A role still runs one
// thing at a time, the device capacity still queues the rest, a Worker that cannot honour the switch keeps the lock, and the
// run record carries the switch so the Worker's own start check agrees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Rooms } from '../src/rooms.mjs';
import { tr, runWithLanguage } from '../src/i18n.mjs';
import { executionConflict } from '../src/execution-workspace.mjs';
import { executionEnvironmentHint } from '../src/run-input.mjs';
import { sentText } from '../src/input-language.mjs';
import { continuationSource, workspaceTakenByLaterRun } from '../src/worker-coordinator.mjs';

const P = 'p1';
const chat = { projectId: P, nodeId: 'w1', execution: null };
const stage = (extra = {}) => ({ projectId: P, nodeId: 'w1', execution: { isolated: false, batchId: 'b1', exclusive: false, ...extra } });

test('conflict matrix: the switch relaxes any pair with an ordinary chat run, and nothing else', () => {
  assert.equal(executionConflict(chat, [chat]), true, 'off: chat runs on one device lock each other');
  assert.equal(executionConflict(chat, [chat], { concurrent: true }), false);
  assert.equal(executionConflict(chat, [stage({ exclusive: true })], { concurrent: true }), false, 'an exclusive stage no longer holds chat runs');
  assert.equal(executionConflict(stage({ exclusive: true }), [chat], { concurrent: true }), false, 'and does not wait for them');
  assert.equal(executionConflict(chat, [stage({ isolated: true })], { concurrent: true }), false);
  assert.equal(executionConflict(stage({ exclusive: true }), [stage()], { concurrent: true }), true, 'two plan stages keep their rules');
  assert.equal(executionConflict(stage(), [stage({ batchId: 'b2' })], { concurrent: true }), true);
  assert.equal(executionConflict(chat, [{ ...chat, projectId: 'other' }]), false, 'other projects never conflicted');
  assert.equal(executionConflict(chat, [{ ...chat, nodeId: 'w2' }]), false, 'other devices never conflicted');
});

function env({ project = { allowConcurrentWrites: true }, worker = {}, capacity = 4 } = {}) {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'demo', ...project });
  db.put('workers', { id: 'w1', name: 'server', platform: 'linux', capacity,
    runtimes: [{ type: 'claude', supported: true, installed: true, available: true, models: [{ id: 'm' }], checkedAt: new Date().toISOString() }],
    capabilities: { runtimeDiscovery: true, roomRoles: 1, projectSpace: 1, managedResume: 1, cliCapacity: 1, concurrentWrites: 1, ...worker } });
  db.put('workspaces', { id: `${P}:w1`, projectId: P, nodeId: 'w1', localRoot: '/xxxxx' });
  for (const [id, name] of [['a', 'Builder'], ['b', 'Checker'], ['c', 'Writer']])
    db.put('roles', { id, projectId: P, name, nodeId: 'w1', runtime: 'claude', model: 'm', mode: 'workspace-write', enabled: true });
  const rooms = new Rooms(db); rooms.touch = () => {};
  const ask = (roleId, n, conversationId) => {
    const chat = conversationId ? { conversationId } : {};
    db.put('roomMessages', { id: `m${n}`, projectId: P, ...chat, sender: 'human', text: `@${roleId} go`, taskIds: [`t${n}`] });
    db.put('tasks', { id: `t${n}`, projectId: P, ...chat, origin: 'chat', roleId, roleSnapshot: db.get('roles', roleId), prompt: 'go', sourceMessageId: `m${n}`, status: 'ready', contextPrepared: true, createdAt: new Date(2026, 9, 28, 0, 0, n).toISOString() });
    return `t${n}`;
  };
  const state = id => ({ run: db.list('runs').find(r => r.taskId === id), task: db.get('tasks', id) });
  return { db, rooms, ask, state };
}
const go = e => e.rooms.schedule(() => true);

test('off: the second role waits for the project; on: both start, and the run records the switch', () => {
  const off = env({ project: {} });
  const a = off.ask('a', 1), b = off.ask('b', 2);
  go(off);
  assert.ok(off.state(a).run, 'the first role starts');
  assert.equal(off.state(b).run, undefined);
  assert.equal(off.state(b).task.waitingReason, tr('rooms.waitingForProjectWorkspaceExclusive'));
  assert.equal(off.state(a).run.concurrentWrites, undefined);

  const on = env();
  const x = on.ask('a', 1), y = on.ask('b', 2);
  go(on);
  assert.ok(on.state(x).run && on.state(y).run, 'both roles run at once');
  assert.equal(on.state(x).run.concurrentWrites, true);
  assert.equal(on.state(y).run.concurrentWrites, true);
});

test('a Worker that cannot honour the switch keeps the lock', () => {
  const e = env({ worker: { concurrentWrites: 0 } });
  const a = e.ask('a', 1), b = e.ask('b', 2);
  go(e);
  assert.ok(e.state(a).run);
  assert.equal(e.state(b).run, undefined);
  assert.equal(e.state(a).run.concurrentWrites, undefined, 'the run must not claim a switch the Worker ignores');
});

test('device capacity and role occupancy still queue; only the project lock is relaxed', () => {
  const tight = env({ capacity: 1 });
  const a = tight.ask('a', 1), b = tight.ask('b', 2);
  go(tight);
  assert.ok(tight.state(a).run);
  assert.equal(tight.state(b).run, undefined);
  assert.equal(tight.state(b).task.waitingReason, tr('rooms.waitingForNodeBecomeIdle'), 'the device limit is the reason now');

  const same = env();
  const first = same.ask('a', 1);
  go(same);
  const second = same.ask('a', 2);
  go(same);
  assert.ok(same.state(first).run);
  assert.equal(same.state(second).run, undefined, 'one role never runs twice at once');
  assert.equal(same.state(second).task.waitingReason, tr('rooms.waitingForRoleFinishIts'));
});

test('turning the switch off again queues the next role', () => {
  const e = env();
  const a = e.ask('a', 1);
  go(e);
  e.db.put('projects', { ...e.db.get('projects', P), allowConcurrentWrites: false });
  const b = e.ask('b', 2);
  go(e);
  assert.ok(e.state(a).run);
  assert.equal(e.state(b).run, undefined);
});

test('the environment names the roles already running and the rules; without the switch it says nothing', () => {
  const base = { cwd: '/xxxxx', projectRoot: '/xxxxx' };
  for (const language of ['zh', 'en']) runWithLanguage(language, () => {
    const rules = sentText('turnInput.envConcurrent');
    const withOthers = executionEnvironmentHint({ ...base, concurrentRoles: ['Checker', 'Writer'] });
    assert.ok(withOthers.includes(rules), 'the rules are in the environment');
    assert.ok(withOthers.includes('Checker, Writer'), 'the running roles are listed');
    const alone = executionEnvironmentHint({ ...base, concurrentRoles: [] });
    assert.ok(alone.split('\n').length < withOthers.split('\n').length && !alone.includes('Checker'), 'nobody else running: rules only');
    assert.equal(executionEnvironmentHint(base).split('\n').length, alone.split('\n').length - 1, 'without the switch nothing is added');
  });
});

test('a starting run is told which roles were already admitted on its device', () => {
  const e = env();
  const a = e.ask('a', 1), b = e.ask('b', 2), c = e.ask('c', 3);
  go(e);
  assert.deepEqual(e.state(a).run.concurrentPeers, [], 'the first has nobody ahead of it');
  assert.deepEqual(e.state(b).run.concurrentPeers, ['Builder']);
  assert.deepEqual(e.state(c).run.concurrentPeers, ['Builder', 'Checker']);
  const off = env({ project: {} }), x = off.ask('a', 1);
  go(off);
  assert.equal(off.state(x).run.concurrentPeers, undefined, 'without the switch nothing is stamped');
});

test('worker: a continuation and a delivery publish are not blocked by other roles sharing the project directory', () => {
  const db = new Store(':memory:');
  db.put('runs', { id: 'src', projectId: P, roleId: 'a', status: 'succeeded', projectScope: true, workspace: '/xxxxx' });
  db.put('runs', { id: 'other', projectId: P, roleId: 'b', status: 'running', projectScope: true, workspace: '/xxxxx' });
  const next = { id: 'next', projectId: P, roleId: 'a', continuationRunId: 'src' };
  assert.throws(() => continuationSource(db, next), /./, 'off: another unfinished run in the directory still blocks');
  assert.equal(continuationSource(db, { ...next, concurrentWrites: true }).id, 'src', 'on: it continues');
  assert.equal(workspaceTakenByLaterRun({ runId: 'later' }, { concurrentWrites: false }, 'src'), true);
  assert.equal(workspaceTakenByLaterRun({ runId: 'later' }, { concurrentWrites: true }, 'src'), false, 'a stamped source keeps its delivery');
  assert.equal(workspaceTakenByLaterRun({ runId: 'src' }, { concurrentWrites: false }, 'src'), false);
});

test('one role in two group chats: each chat session runs at once; in one chat its turns stay in order', () => {
  const e = env({ worker: { groupConversations: 1 } });
  e.db.put('groupConversations', { id: 'chat2', projectId: P, title: 'second', createdAt: new Date().toISOString() });
  const here = e.ask('a', 1), there = e.ask('a', 2, 'chat2');
  go(e);
  assert.ok(e.state(here).run && e.state(there).run, 'the same role starts in both chats');
  assert.notEqual(e.state(here).run.roleSessionId, e.state(there).run.roleSessionId, 'each on its own session');
  const next = e.ask('a', 3, 'chat2');
  go(e);
  assert.equal(e.state(next).run, undefined, 'a second message in the same chat waits for that chat\'s turn');
  assert.equal(e.state(next).task.waitingReason, tr('rooms.waitingForRoleFinishIts'));
  const tight = env({ worker: { groupConversations: 1 }, capacity: 1 });
  tight.db.put('groupConversations', { id: 'chat2', projectId: P, title: 'second', createdAt: new Date().toISOString() });
  const one = tight.ask('a', 1), two = tight.ask('a', 2, 'chat2');
  go(tight);
  assert.ok(tight.state(one).run);assert.equal(tight.state(two).run, undefined, 'device capacity still applies');
});

test('the role\'s own session in another chat is named as such to a starting run, and steering or compaction there does not hold this chat', async () => {
  const { concurrentPeers } = await import('../src/concurrent-writes.mjs');
  const { steeringWaitReason } = await import('../src/role-steering.mjs');
  const { roleIdle } = await import('../src/role-compaction.mjs');
  const e = env({ worker: { groupConversations: 1 } });
  e.db.put('groupConversations', { id: 'chat2', projectId: P, title: 'second', createdAt: new Date().toISOString() });
  const there = e.ask('a', 1, 'chat2'), other = e.ask('b', 2);
  go(e);
  const peers = runWithLanguage('en', () => concurrentPeers(e.db, P, 'w1', { roleId: 'a', conversationId: P }));
  assert.ok(peers.includes('Checker'), 'another role by name');
  assert.ok(peers.some(name => /own other session.*second/.test(name)), `the twin is named: ${peers}`);
  assert.ok(!peers.includes('Builder'), 'not as if another role of the same name');
  // A steering message for the role in chat2 does not make the role wait here.
  e.db.put('tasks', { ...e.db.get('tasks', there), steering: { waitForRunIds: [] } });
  const here = e.ask('a', 3);
  assert.equal(steeringWaitReason(e.db, e.db.get('tasks', here)), null);
  assert.ok(steeringWaitReason(e.db, { ...e.db.get('tasks', here), id: 'x', conversationId: 'chat2' }), 'in chat2 itself it still waits');
  // The role's run in chat2 does not keep its default-chat session from compacting.
  const runThere = e.state(there).run;
  assert.equal(roleIdle(e.db, { id: 'done', roleId: 'a', projectId: P, roleSessionId: 'other-session' }), false, 'a ready task for the role in this chat still holds it');
  e.db.put('tasks', { ...e.db.get('tasks', here), status: 'cancelled' });
  assert.equal(roleIdle(e.db, { id: 'done', roleId: 'a', projectId: P, roleSessionId: 'other-session' }), true, `idle here while it runs in chat2 (${runThere.status})`);
  assert.equal(roleIdle(e.db, { id: 'done', roleId: 'a', projectId: P, conversationId: 'chat2', roleSessionId: 'other-session' }), false);
});
