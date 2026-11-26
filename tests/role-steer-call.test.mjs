// Roles follow and correct a teammate's long turn with the tools they already have: wb discuss peers (detail) and
// wb history read show what a running turn is doing; wb call --kind steer adds a correction to it, --kind interrupt stops it.
// Only the manager or the role that handed the work out may correct, and not twice within a few minutes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Rooms } from '../src/rooms.mjs';
import { RoleCalls } from '../src/role-calls.mjs';
import { RoleSteering } from '../src/role-steering.mjs';
import { createAgentCalls } from '../src/agent-calls.mjs';
import { History } from '../src/history.mjs';
import { runProgress } from '../src/run-progress.mjs';
import { tr } from '../src/i18n.mjs';

const P = 'p1', at = () => new Date().toISOString();
function env() {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'demo', supervisorRoleId: 'sup' });
  db.put('workspaces', { id: `${P}:w1`, projectId: P, nodeId: 'w1', localRoot: '/xxxxx' });
  db.put('workers', { id: 'w1', name: 'dev', capabilities: { groupSupplement: 1 } });
  for (const [id, name, runtime, extra] of [['sup', 'Supervisor', 'claude', { systemSupervisor: true }], ['b', 'Builder', 'claude', {}], ['c', 'Checker', 'codex', {}], ['g', 'Grokker', 'grok', {}]])
    db.put('roles', { id, projectId: P, name, nodeId: 'w1', runtime, model: 'm', mode: 'workspace-write', enabled: true, ...extra });
  const calls = new RoleCalls(db), rooms = new Rooms(db), steering = new RoleSteering(db, calls); rooms.touch = () => {};
  // The user's message runs the manager.
  db.put('roomMessages', { id: 'm1', projectId: P, sender: 'human', text: 'build it', taskIds: ['t-sup'] });
  db.put('tasks', { id: 't-sup', projectId: P, origin: 'chat', roleId: 'sup', roleSnapshot: db.get('roles', 'sup'), prompt: 'build it', sourceMessageId: 'm1', status: 'in_progress', currentRunId: 'r-sup' });
  db.put('runs', { id: 'r-sup', projectId: P, taskId: 't-sup', roleId: 'sup', roleSnapshot: db.get('roles', 'sup'), nodeId: 'w1', sourceMessageId: 'm1', status: 'running', lastSeq: 0, createdAt: at() });
  calls.adoptTask('t-sup');
  let n = 0;
  const call = (runId, input) => createAgentCalls({ db, calls, rooms, steering, online: () => true }, db.get('runs', runId), { requestId: `c${++n}`, text: 'do it', ...input });
  /** `from` hands work to `role` and that role's turn is now running it. */
  const working = (from, role, runId, kind = 'direct') => {
    const sent = call(from, { role, kind }), request = calls.reconcile(sent.requestId), task = db.get('tasks', request.taskId), target = db.get('roles', request.targetRoleId);
    db.put('runs', { id: runId, projectId: P, taskId: task.id, roleId: target.id, roleSnapshot: target, nodeId: 'w1', sourceMessageId: 'm1', status: 'running', roleSessionId: `rs-${target.id}`, requestId: request.id, lastSeq: 0, createdAt: at(), startedAt: at() });
    db.put('tasks', { ...task, status: 'in_progress', currentRunId: runId });
    db.put('coordinationRequests', { ...db.get('coordinationRequests', request.id), status: 'running', currentRunId: runId });
    return request.id;
  };
  return { db, calls, call, working };
}
let seq = 0;
const event = (db, runId, type, payload) => db.event({ id: `e${++seq}`, runId, seq, type, payload, createdAt: at() });

test('the manager corrects a running teammate: the text goes into that turn, nothing is stopped', () => {
  const e = env(); e.working('r-sup', 'Builder', 'r-b');
  const sent = e.call('r-sup', { role: 'Builder', kind: 'steer', text: 'use the orders table, not order_items' });
  assert.equal(sent.steer, 'added'); assert.equal(sent.note, tr('agentCalls.steerAdded', { name: 'Builder' }));
  assert.deepEqual(sent.dispatchNodeIds, ['w1']); assert.ok(!Object.keys(sent).includes('dispatchNodeIds'), 'not part of the answer the role reads');
  const request = e.db.get('coordinationRequests', sent.requestId), task = e.db.get('tasks', request.taskId);
  assert.equal(request.kind, 'consult'); assert.equal(task.roleSteer.byRole, 'Supervisor');
  const command = e.db.get('commands', `supplement-${task.id}-r-b`);
  assert.equal(command.type, 'supplement'); assert.equal(command.runId, 'r-b');
  assert.match(command.text, /Supervisor/); assert.match(command.text, /orders table/);
  assert.ok(!e.db.get('runs', 'r-b').stopRequested, 'the running turn goes on');
  assert.equal(e.db.get('roomMessages', sent.messageId).handoff.kind, 'steer', 'the chat shows it as a correction');
  event(e.db, 'r-b', 'supplement', { id: task.id });
  assert.equal(e.db.get('tasks', task.id).mergedIntoRunId, 'r-b'); assert.equal(e.db.get('coordinationRequests', sent.requestId).status, 'succeeded');
});

test('only the manager or the role that handed the work out may correct', () => {
  const e = env(); e.working('r-sup', 'Builder', 'r-b'); e.working('r-sup', 'Checker', 'r-c');
  assert.throws(() => e.call('r-c', { role: 'Builder', kind: 'steer' }), new RegExp(tr('agentCalls.steerNotAllowed', { name: 'Builder' }).slice(0, 12)));
  assert.throws(() => e.call('r-b', { role: 'Checker', kind: 'interrupt' }), new RegExp(tr('agentCalls.steerNotAllowed', { name: 'Checker' }).slice(0, 12)));
  assert.equal(e.db.list('coordinationRequests').filter(r => r.summary === 'do it' && r.sourceRunId !== 'r-sup').length, 0, 'a refused correction leaves nothing behind');
  // Builder asks Grokker for help; Builder handed that out, so Builder may correct it.
  e.working('r-b', 'Grokker', 'r-g', 'consult');
  assert.equal(e.call('r-b', { role: 'Grokker', kind: 'steer' }).steer, 'queued_first', 'a CLI that cannot take a message mid-turn gets it first in its queue');
});

test('a teammate that is not running, oneself, or one corrected a moment ago is refused; a retry repeats the first answer', () => {
  const e = env();
  assert.throws(() => e.call('r-sup', { role: 'Builder', kind: 'steer' }), new RegExp(tr('agentCalls.steerNotRunning', { name: 'Builder' }).slice(0, 12)));
  assert.throws(() => e.call('r-sup', { role: 'Supervisor', kind: 'steer' }));
  e.working('r-sup', 'Builder', 'r-b');
  const first = createAgentCalls({ db: e.db, calls: e.calls, rooms: Object.assign(new Rooms(e.db), { touch() {} }), steering: new RoleSteering(e.db, e.calls), online: () => true }, e.db.get('runs', 'r-sup'), { requestId: 'fix-1', role: 'Builder', kind: 'steer', text: 'stop using mocks' });
  const again = createAgentCalls({ db: e.db, calls: e.calls, rooms: Object.assign(new Rooms(e.db), { touch() {} }), steering: new RoleSteering(e.db, e.calls), online: () => true }, e.db.get('runs', 'r-sup'), { requestId: 'fix-1', role: 'Builder', kind: 'steer', text: 'stop using mocks' });
  assert.equal(again.requestId, first.requestId); assert.equal(again.steer, 'added'); assert.equal(again.note, first.note);
  assert.throws(() => e.call('r-sup', { role: 'Builder', kind: 'steer', text: 'and another thing' }), new RegExp(tr('agentCalls.steerTooSoon', { name: 'Builder' }).slice(0, 10)));
});

test('interrupt stops the turn; the role continues from the correction and whoever waited is told who stopped it', () => {
  const e = env(), { db, calls } = e;
  // Builder handed work to Checker and waits for it; the manager sees Checker going wrong and interrupts it.
  e.working('r-sup', 'Builder', 'r-b');
  const child = e.working('r-b', 'Checker', 'r-c');
  const builderRequest = db.get('runs', 'r-b').requestId;
  db.put('runs', { ...db.get('runs', 'r-b'), status: 'succeeded' });
  db.put('coordinationRequests', { ...db.get('coordinationRequests', builderRequest), status: 'waiting_call', waitRequestIds: [child], resumeSummary: 'waiting for the check' });
  const sent = e.call('r-sup', { role: 'Checker', kind: 'interrupt', text: 'wrong repository; check ltl-service instead' });
  assert.equal(sent.steer, 'interrupting'); assert.deepEqual(sent.dispatchNodeIds, ['w1']);
  const cancelled = db.get('coordinationRequests', child);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.interruptedByRole, 'Supervisor');
  assert.ok(db.get('commands', `steer:${db.get('coordinationRequests', sent.requestId).taskId}:r-c`) || db.get('runs', 'r-c').stopRequested, 'the running turn is asked to stop');
  assert.ok(db.get('tasks', db.get('coordinationRequests', sent.requestId).taskId).steering, 'the correction runs first once the turn has stopped');
  db.put('runs', { ...db.get('runs', 'r-c'), status: 'interrupted' }); calls.finish('r-c'); calls.resume(builderRequest);
  const waiting = db.get('coordinationRequests', builderRequest), wake = db.get('coordinationRequests', waiting.continuationRequestId);
  assert.equal(waiting.waitEvent.reason, 'interrupted'); assert.equal(waiting.waitEvent.by, 'Supervisor');
  assert.match(wake.summary, /Supervisor/); assert.match(wake.summary, /Checker/);
});

test('a running turn can be followed: recent steps and the reply so far, without tool output', () => {
  const e = env(); e.working('r-sup', 'Builder', 'r-b');
  event(e.db, 'r-b', 'tool', { text: 'Read', item: { id: 'a', type: 'tool_use', name: 'Read', input: { file_path: 'src/orders.mjs' } } });
  event(e.db, 'r-b', 'tool', { text: 'Bash', item: { id: 'b', type: 'tool_use', name: 'Bash', input: { command: 'npm test' } } });
  event(e.db, 'r-b', 'tool', { text: 'tool result', item: { id: 'b', type: 'tool_result', output: 'SECRET OUTPUT' } });
  event(e.db, 'r-b', 'text', { text: 'Tests pass; ' }); event(e.db, 'r-b', 'text', { text: 'now editing the migration.' });
  const progress = runProgress(e.db, e.db.get('runs', 'r-b'));
  assert.deepEqual(progress.recentSteps, ['Read: src/orders.mjs', 'Bash: npm test']);
  assert.equal(progress.replySoFar, 'Tests pass; now editing the migration.'); assert.equal(typeof progress.runningMinutes, 'number');
  const read = new History(e.db).read(P, { kind: 'result', id: 'r-b' });
  assert.match(read.content, /npm test/); assert.match(read.content, /now editing the migration/); assert.doesNotMatch(read.content, /SECRET OUTPUT/);
  e.db.put('runs', { ...e.db.get('runs', 'r-b'), status: 'succeeded', result: 'done' });
  assert.equal(new History(e.db).read(P, { kind: 'result', id: 'r-b' }).content, 'done', 'a finished run reads as before');
});

test('wb discuss peers (detail) shows what each running teammate is doing', async () => {
  const { RoleDiscussions } = await import('../src/role-discussions.mjs');
  const e = env(); e.working('r-sup', 'Builder', 'r-b');
  event(e.db, 'r-b', 'tool', { text: 'Edit', item: { id: 'x', type: 'tool_use', name: 'Edit', input: { file_path: 'src/orders.mjs' } } });
  e.db.put('roleSessions', { id: 'rs-sup', projectId: P, roleId: 'sup', nodeId: 'w1', runtime: 'claude', status: 'idle' });
  e.db.put('runs', { ...e.db.get('runs', 'r-sup'), roleSessionId: 'rs-sup' });
  const team = new RoleDiscussions(e.db, { online: () => true }).peers(e.db.get('runs', 'r-sup'), { view: 'detail' });
  const builder = team.items.find(item => item.name === 'Builder'), active = builder.activeRuns[0];
  assert.equal(active.id, 'r-b'); assert.deepEqual(active.recentSteps, ['Edit: src/orders.mjs']);
  assert.equal(typeof active.runningMinutes, 'number'); assert.ok(active.startedAt); assert.equal(active.replySoFar, undefined, 'the team list stays short');
});
