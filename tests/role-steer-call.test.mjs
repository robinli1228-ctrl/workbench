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

// ---- Findings of the review of the first version.
test('review isolation: a run this role may not read shows no progress', () => {
  const e = env(); e.working('r-sup', 'Builder', 'r-b');
  event(e.db, 'r-b', 'tool', { text: 'Bash', item: { id: 'a', type: 'tool_use', name: 'Bash', input: { command: 'cat findings.md' } } });
  e.db.put('runs', { ...e.db.get('runs', 'r-b'), reviewRedacted: true, result: null });
  assert.equal(new History(e.db).read(P, { kind: 'result', id: 'r-b' }).content, '');
});

test('a run still going reads as progress even when a message already set its result', () => {
  const e = env(); e.working('r-sup', 'Builder', 'r-b');
  event(e.db, 'r-b', 'tool', { text: 'Bash', item: { id: 'a', type: 'tool_use', name: 'Bash', input: { command: 'npm test' } } });
  e.db.put('runs', { ...e.db.get('runs', 'r-b'), result: 'first note' });
  assert.match(new History(e.db).read(P, { kind: 'result', id: 'r-b' }).content, /npm test/);
});

test('steps survive a long stretch of streamed text, and the reply keeps its newest part', () => {
  const e = env(); e.working('r-sup', 'Builder', 'r-b');
  event(e.db, 'r-b', 'tool', { text: 'Bash', item: { id: 'a', type: 'tool_use', name: 'Bash', input: { command: 'npm test' } } });
  for (let i = 0; i < 260; i++) event(e.db, 'r-b', 'text', { text: `word${i} ` });
  const progress = runProgress(e.db, e.db.get('runs', 'r-b'), { replyChars: 40 });
  assert.deepEqual(progress.recentSteps, ['Bash: npm test']);
  assert.ok(progress.replySoFar.startsWith('…')); assert.ok(progress.replySoFar.endsWith('word259'));
});

test('a role\'s interrupt reaches the target as that role\'s correction, not as the user changing direction', async () => {
  const { turnOrigin, renderRunPrompt } = await import('../src/run-context.mjs');
  const e = env(); e.working('r-sup', 'Builder', 'r-b');
  const sent = e.call('r-sup', { role: 'Builder', kind: 'interrupt', text: 'stop: wrong branch' });
  const request = e.db.get('coordinationRequests', sent.requestId), task = e.db.get('tasks', request.taskId);
  assert.deepEqual(turnOrigin(e.db, task, request), { kind: 'role', name: 'Supervisor' });
  const prompt = renderRunPrompt({ instruction: 'stop: wrong branch', steering: task.steering, roleSteer: { byRole: 'Supervisor' }, context: {} }, { minimal: true });
  assert.match(prompt, new RegExp(tr('runContext.roleInterruptedTurn', { name: 'Supervisor' }).slice(0, 20)));
  assert.doesNotMatch(prompt, new RegExp(tr('runContext.userChangedDirectionTurnImmediate').slice(0, 12)));
});

test('a role\'s interrupt does not end the plans around the turn', () => {
  const e = env(); e.working('r-sup', 'Builder', 'r-b');
  const root = e.calls.forRun(e.db.get('runs', 'r-sup')).id;
  e.db.put('executionPlans', { id: 'plan-1', projectId: P, parentRequestId: root, status: 'running', stages: [] });
  e.call('r-sup', { role: 'Builder', kind: 'interrupt', text: 'stop' });
  assert.equal(e.db.get('executionPlans', 'plan-1').status, 'running');
});

test('interrupting a wake turn: the caller that waited for the original call is told which role stopped it', () => {
  const e = env(), { db, calls } = e;
  e.working('r-sup', 'Builder', 'r-b');
  const child = e.working('r-b', 'Checker', 'r-c');
  const builderRequest = db.get('runs', 'r-b').requestId;
  // Checker's first turn ended in a wait and it is now running its wake.
  db.put('runs', { ...db.get('runs', 'r-c'), status: 'succeeded' });
  const role = db.get('roles', 'c');
  db.put('coordinationRequests', { id: 'wake-c', projectId: P, conversationId: P, kind: 'continuation', continuationOf: child, targetRoleId: 'c', targetSnapshot: role, parentRequestId: null, rootRequestId: db.get('coordinationRequests', child).rootRequestId, status: 'running', taskId: 't-wake', currentRunId: 'r-c2', createdAt: at() });
  db.put('coordinationRequests', { ...db.get('coordinationRequests', child), status: 'waiting_call', continuationRequestId: 'wake-c' });
  db.put('tasks', { id: 't-wake', projectId: P, origin: 'chat', roleId: 'c', roleSnapshot: role, status: 'in_progress', currentRunId: 'r-c2', requestId: 'wake-c', createdAt: at() });
  db.put('runs', { id: 'r-c2', projectId: P, taskId: 't-wake', roleId: 'c', roleSnapshot: role, nodeId: 'w1', status: 'running', roleSessionId: 'rs-c', requestId: 'wake-c', lastSeq: 0, createdAt: at() });
  db.put('runs', { ...db.get('runs', 'r-b'), status: 'succeeded' });
  db.put('coordinationRequests', { ...db.get('coordinationRequests', builderRequest), status: 'waiting_call', waitRequestIds: [child], resumeSummary: 'waiting for the check' });
  e.call('r-sup', { role: 'Checker', kind: 'interrupt', text: 'wrong repository' });
  assert.equal(db.get('coordinationRequests', child).interruptedByRole, 'Supervisor'); assert.equal(db.get('coordinationRequests', 'wake-c').interruptedByRole, 'Supervisor');
  db.put('runs', { ...db.get('runs', 'r-c2'), status: 'interrupted' }); calls.finish('r-c2'); calls.resume(builderRequest);
  assert.equal(db.get('coordinationRequests', builderRequest).waitEvent.by, 'Supervisor');
});

test('a correction works inside a scheduled job\'s chain', () => {
  const e = env();
  const root = e.calls.forRun(e.db.get('runs', 'r-sup')).id;
  e.db.put('coordinationRequests', { ...e.db.get('coordinationRequests', root), scheduledJobId: 'job-1' });
  e.working('r-sup', 'Builder', 'r-b');
  assert.equal(e.call('r-sup', { role: 'Builder', kind: 'steer', text: 'skip the cache' }).steer, 'added');
});

test('a correction waiting first in the queue does not extend its sender\'s wait', () => {
  const e = env(), { db, calls } = e;
  e.working('r-sup', 'Grokker', 'r-g');
  const first = e.call('r-sup', { role: 'Grokker', kind: 'steer', text: 'use the staging API' });
  assert.equal(first.steer, 'queued_first');
  const root = calls.forRun(db.get('runs', 'r-sup')).id, now = Date.now();
  calls.wait(db.get('runs', 'r-sup'), 'Waiting for Grokker to finish the import.', { timeoutSeconds: 600 });
  db.put('runs', { ...db.get('runs', 'r-sup'), status: 'succeeded' });
  calls.resume(root, now + 15 * 60000);
  assert.equal(db.get('coordinationRequests', root).waitEvent?.reason, 'timeout', 'the queued correction does not add the two-hour queue grace');
});

test('an interrupt right after one\'s own queued correction takes its place', () => {
  const e = env(), { db } = e;
  e.working('r-sup', 'Grokker', 'r-g');
  const first = e.call('r-sup', { role: 'Grokker', kind: 'steer', text: 'use the staging API' });
  const second = e.call('r-sup', { role: 'Grokker', kind: 'interrupt', text: 'stop now: use the staging API' });
  assert.equal(second.steer, 'interrupting');
  assert.equal(db.get('tasks', db.get('coordinationRequests', first.requestId).taskId).status, 'cancelled');
  assert.equal(db.get('coordinationRequests', first.requestId).status, 'cancelled');
});

test('a correction the turn took is not a result to wait for; one it could not take says so on its card', () => {
  const e = env(), { db, calls } = e;
  e.working('r-sup', 'Builder', 'r-b');
  const sent = e.call('r-sup', { role: 'Builder', kind: 'steer', text: 'use the orders table' }), taskId = db.get('coordinationRequests', sent.requestId).taskId;
  const root = db.get('coordinationRequests', calls.forRun(db.get('runs', 'r-sup')).id);
  event(db, 'r-b', 'supplement', { id: taskId });
  assert.ok(!calls.dependencies(root).some(r => r.id === sent.requestId), 'only the handed-out work is waited for');
  const f = env(); f.working('r-sup', 'Builder', 'r-b');
  const other = f.call('r-sup', { role: 'Builder', kind: 'steer', text: 'use the orders table' });
  event(f.db, 'r-b', 'supplement_failed', { id: f.db.get('coordinationRequests', other.requestId).taskId, error: 'busy' });
  assert.equal(f.db.get('roomMessages', other.messageId).steer.state, 'queued_first');
});

// ---- wb call --kind withdraw: take back a call the target has not started; one already running answers with what to do next.
test('a call the target has not started is taken back, also from a later turn of the sender', () => {
  const e = env(), { db, calls } = e;
  e.working('r-sup', 'Builder', 'r-b');
  // Two more calls wait behind Builder's running turn; one already has its task in the queue.
  const plain = e.call('r-sup', { role: 'Builder', kind: 'direct', requestId: 'r-sup:next-1', text: 'then do Y' });
  const admitted = e.call('r-sup', { role: 'Builder', kind: 'direct', requestId: 'r-sup:next-2', text: 'then do Z' });
  const taskId = calls.reconcile(admitted.requestId).taskId;
  const first = e.call('r-sup', { kind: 'withdraw', requestId: 'next-1' });
  assert.deepEqual(first.withdrawn.map(item => item.name), ['Builder']); assert.equal(first.note, tr('agentCalls.withdrawDone', { names: 'Builder' }));
  assert.equal(db.get('coordinationRequests', plain.requestId).status, 'cancelled'); assert.equal(db.get('coordinationRequests', plain.requestId).cancelReason, 'withdrawn');
  assert.ok(db.get('roomMessages', plain.messageId).withdrawn.at);
  // The manager's next turn names the same short ID.
  db.put('runs', { ...db.get('runs', 'r-sup'), id: 'r-sup-2', status: 'running' });
  const later = createAgentCalls({ db, calls, rooms: new Rooms(db) }, db.get('runs', 'r-sup-2'), { kind: 'withdraw', requestId: 'next-2' });
  assert.equal(later.withdrawn.length, 1); assert.equal(db.get('tasks', taskId).status, 'cancelled'); assert.equal(db.get('coordinationRequests', admitted.requestId).status, 'cancelled');
  assert.equal(db.get('runs', 'r-b').status, 'running', 'the turn in progress is not touched');
});

test('a call already running is not taken back: the answer gives its run and the next step', () => {
  const e = env(), { db } = e;
  const work = e.working('r-sup', 'Builder', 'r-b');
  const answer = e.call('r-sup', { kind: 'withdraw', requestId: work });
  assert.deepEqual(answer.withdrawn, []);
  assert.match(answer.note, /r-b/); assert.match(answer.note, /--kind steer/); assert.match(answer.note, /--kind interrupt/);
  assert.equal(db.get('coordinationRequests', work).status, 'running'); assert.ok(!db.get('runs', 'r-b').stopRequested);
  db.put('runs', { ...db.get('runs', 'r-b'), status: 'succeeded', result: 'done' });
  db.put('coordinationRequests', { ...db.get('coordinationRequests', work), status: 'succeeded', result: 'done' });
  assert.equal(e.call('r-sup', { kind: 'withdraw', requestId: work }).note, tr('agentCalls.withdrawEnded', { name: 'Builder', status: 'succeeded', id: work }));
});

test('only the sender takes a call back', () => {
  const e = env();
  e.working('r-sup', 'Builder', 'r-b'); e.working('r-sup', 'Checker', 'r-c');
  const queued = e.call('r-sup', { role: 'Builder', kind: 'direct', requestId: 'r-sup:next-3', text: 'then do Y' });
  assert.throws(() => e.call('r-c', { kind: 'withdraw', requestId: 'next-3' }), new RegExp(tr('agentCalls.withdrawNotFound', { id: 'next-3' }).slice(0, 10)));
  assert.equal(e.db.get('coordinationRequests', queued.requestId).status, 'queued');
});

test('a transfer taken back before the new owner started gives the task back to its sender', async () => {
  const { ConversationTasks } = await import('../src/conversation-tasks.mjs');
  const e = env(), { db } = e;
  e.working('r-sup', 'Builder', 'r-b');
  const task = new ConversationTasks(db).create({ projectId: P, conversationId: P }, { requestId: 'task-1', title: 'Import', description: 'brief', ownerRoleId: 'sup' }, { roleId: 'sup', runId: 'r-sup' });
  const sent = e.call('r-sup', { role: 'Builder', kind: 'transfer', requestId: 'r-sup:hand-1', text: 'take over the import', task: 'T1' });
  assert.equal(db.get('conversationTasks', task.id).ownerRoleId, 'b');
  assert.equal(e.call('r-sup', { kind: 'withdraw', requestId: 'hand-1' }).withdrawn.length, 1);
  assert.equal(db.get('conversationTasks', task.id).ownerRoleId, 'sup'); assert.equal(db.get('coordinationRequests', sent.requestId).status, 'cancelled');
});
