// Group-chat simplification: short default prompts, no wb report, whole-task transfer, reminders for every role.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../src/store.mjs';
import { Rooms } from '../src/rooms.mjs';
import { RoleCalls, transferDepth } from '../src/role-calls.mjs';
import { createAgentCalls } from '../src/agent-calls.mjs';
import { TimerAgentActions } from '../src/timer-agent.mjs';
import { History } from '../src/history.mjs';
import { runWithLanguage } from '../src/i18n.mjs';
import { normalizePlatformSettings, executionRules, defaultPlatformPrompt, defaultSupervisorPrompt } from '../src/platform-prompts.mjs';
import { helpText } from '../src/wb-tools.mjs';

const P = 'p1';
function env() {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'demo', supervisorRoleId: 'sup' });
  db.put('workspaces', { id: `${P}:w1`, projectId: P, nodeId: 'w1', localRoot: '/xxxxx' });
  for (const [id, name, extra] of [['sup', 'Supervisor', { systemSupervisor: true }], ['b', 'Builder', {}], ['c', 'Checker', {}]])
    db.put('roles', { id, projectId: P, name, nodeId: 'w1', runtime: 'claude', model: 'm', mode: 'workspace-write', enabled: true, ...extra });
  db.put('roomMessages', { id: 'm1', projectId: P, sender: 'human', text: 'build the feature', taskIds: ['t1'] });
  db.put('tasks', { id: 't1', projectId: P, origin: 'chat', roleId: 'sup', roleSnapshot: db.get('roles', 'sup'), prompt: 'build the feature', sourceMessageId: 'm1', status: 'in_progress', currentRunId: 'r1', createdAt: new Date().toISOString() });
  db.put('runs', { id: 'r1', projectId: P, taskId: 't1', roleId: 'sup', roleSnapshot: db.get('roles', 'sup'), nodeId: 'w1', sourceMessageId: 'm1', status: 'running', lastSeq: 0 });
  const calls = new RoleCalls(db), rooms = new Rooms(db); rooms.touch = () => {};
  return { db, calls, rooms };
}
/** Materialise a queued request into the target role's running turn, as the scheduler would. */
function start(e, requestId, runId) {
  const request = e.calls.reconcile(requestId), task = e.db.get('tasks', request.taskId);
  e.db.put('tasks', { ...task, status: 'in_progress', currentRunId: runId });
  e.db.put('runs', { id: runId, projectId: P, taskId: task.id, requestId, roleId: task.roleId, roleSnapshot: task.roleSnapshot, nodeId: 'w1', sourceMessageId: task.sourceMessageId, status: 'running', lastSeq: 0 });
  e.db.put('coordinationRequests', { ...e.db.get('coordinationRequests', requestId), status: 'running', currentRunId: runId });
  return e.db.get('runs', runId);
}

test('a transfer outlives the supervisor turn: the owner keeps calling reviewers and replies to the user', () => {
  const e = env();
  const sent = createAgentCalls(e, e.db.get('runs', 'r1'), { role: 'Builder', kind: 'transfer', requestId: 'own-1', text: 'build it, get two reviews, reply to the user' });
  assert.match(sent.note, /Builder/);
  const owned = e.db.get('coordinationRequests', sent.requestId), parent = e.calls.forRun(e.db.get('runs', 'r1'));
  assert.equal(owned.parentRequestId, null, 'not a child of the supervisor call');
  assert.equal(owned.transferredFrom, parent.id);
  assert.equal(owned.kind, 'direct');
  assert.equal(e.db.get('roomMessages', sent.messageId).handoff.kind, 'transfer');
  assert.deepEqual(e.calls.dependencies(parent).map(r => r.id), [], 'nothing for the supervisor to wait on');
  // The supervisor ends its turn without waiting; its call settles.
  e.db.put('runs', { ...e.db.get('runs', 'r1'), status: 'succeeded', result: 'Transferred to @Builder.' });
  e.calls.finish('r1');
  assert.equal(e.db.get('coordinationRequests', parent.id).status, 'succeeded');
  const builder = start(e, owned.id, 'r2');
  const review = createAgentCalls(e, builder, { role: 'Checker', kind: 'consult', requestId: 'rev-1', text: 'review commit xxxxx' });
  assert.equal(e.db.get('coordinationRequests', review.requestId).parentRequestId, owned.id, 'the owner can still call reviewers');
  e.db.put('runs', { ...builder, status: 'succeeded', result: 'Done: reviewed twice, all checks pass.' });
  e.rooms.complete(e.db.get('runs', 'r2'));
  const reply = e.db.get('roomMessages', 'result-r2');
  assert.equal(reply.text, 'Done: reviewed twice, all checks pass.');
  assert.equal(reply.replyToId, sent.messageId, 'the reply threads under the transfer card');
  assert.equal(e.db.list('resultReceipts').filter(r => r.ownerRoleId === 'sup').length, 0, 'no result is handed back to the supervisor');
});

test('a transfer goes to one role and a long transfer chain stops', () => {
  const e = env();
  assert.throws(() => createAgentCalls(e, e.db.get('runs', 'r1'), { roles: ['Builder', 'Checker'], kind: 'transfer', requestId: 'two', text: 'x' }));
  const parent = e.calls.forRun(e.db.get('runs', 'r1'));
  let from = parent.id;
  for (let i = 0; i < 8; i++) {
    const r = e.calls.create({ id: `hop-${i}`, projectId: P, targetRoleId: i % 2 ? 'b' : 'c', kind: 'direct', transferredFrom: from, summary: 'again', sourceMessageId: 'm1' });
    from = r.id;
  }
  assert.equal(transferDepth(e.db, from), 8);
  assert.throws(() => e.calls.create({ id: 'hop-9', projectId: P, targetRoleId: 'b', kind: 'direct', transferredFrom: from, summary: 'again', sourceMessageId: 'm1' }), /transferChainTooLong|transferred too many/);
});

test('the default prompts carry no removed commands; custom text stays', () => {
  for (const language of ['en', 'zh']) runWithLanguage(language, () => {
    const current = normalizePlatformSettings({});
    assert.equal(current.platformPrompt, defaultPlatformPrompt());
    assert.equal(current.supervisorPrompt, defaultSupervisorPrompt());
    assert.doesNotMatch(current.platformPrompt, /wb report|wb ask|wb progress/);
    assert.doesNotMatch(current.supervisorPrompt, /wb schedule|wb progress|setup propose/);
    assert.equal(normalizePlatformSettings({ platformPrompt: 'my own rules', supervisorPrompt: 'mine' }).platformPrompt, 'my own rules');
  });
});

test('execution rules no longer ask for wb report, and help lists only the kept commands', () => {
  const rules = runWithLanguage('en', () => executionRules({ reportRequired: true, roleSnapshot: {} }, { minimal: true }));
  assert.doesNotMatch(rules, /wb report/);
  const help = runWithLanguage('en', () => helpText());
  for (const gone of ['wb report', 'wb progress', 'wb ask', 'wb docs', 'wb git', 'wb handoff', 'wb boot', 'wb read ', 'wb role prompt', 'wb session list', 'wb result read', 'wb discuss ask', 'wb setup'])
    assert.equal(help.includes(gone), false, gone);
  for (const kept of ['wb discuss peers', 'transfer', 'wb wait', 'wb note', 'wb history read', 'wb history summary', 'wb timer', 'wb deliver', 'wb session current'])
    assert.ok(help.includes(kept), kept);
});

test('removed wb commands are refused before any request is sent', async () => {
  const run = promisify(execFile);
  for (const argv of [['report', '{}'], ['ask', 'Builder', 'hi'], ['read', 'file', '{}'], ['docs'], ['handoff', 'last']]) {
    const error = await run(process.execPath, ['src/wb-cli.mjs', ...argv], { env: { PATH: process.env.PATH, WB_LANGUAGE: 'en' } }).then(() => null, e => e);
    assert.ok(error, argv.join(' '));
    assert.match(error.stderr, /Unknown command/, argv.join(' '));
  }
});

test('any role keeps its own reminders; only the supervisor sets them for others', () => {
  const e = env(), saved = [];
  const jobs = {
    list: () => ({ jobs: [{ id: 'j1', roleId: 'b' }, { id: 'j2', roleId: 'c' }], occurrences: [{ jobId: 'j1' }, { jobId: 'j2' }] }),
    save: (projectId, values) => { saved.push(values); return { id: 'new', ...values }; }
  };
  const timers = new TimerAgentActions(e.db, jobs);
  const builderRun = { id: 'rb', projectId: P, roleId: 'b', roleSnapshot: e.db.get('roles', 'b') };
  const schedule = { type: 'once', onceAt: '2026-10-25T09:00:00+08:00' };
  timers.execute(builderRun, 'create', { requestId: 'self-1', name: 'recheck', description: 'recheck the deploy', schedule });
  assert.equal(saved.at(-1).roleId, 'b', 'a reminder without roleId is for the caller');
  assert.throws(() => timers.execute(builderRun, 'create', { requestId: 'other-1', name: 'x', description: 'x', roleId: 'c', schedule }), /ownRemindersOnly|own reminders/);
  assert.deepEqual(timers.execute(builderRun, 'list').jobs.map(j => j.id), ['j1']);
  const supRun = e.db.get('runs', 'r1');
  timers.execute(supRun, 'create', { requestId: 'for-c', name: 'x', description: 'x', roleId: 'c', schedule });
  assert.equal(saved.at(-1).roleId, 'c');
  assert.equal(timers.execute(supRun, 'list').jobs.length, 2);
});

test('wb history read takes a message ID or a run / call ID', () => {
  const e = env();
  e.db.put('runs', { ...e.db.get('runs', 'r1'), status: 'succeeded', result: 'final answer' });
  const history = new History(e.db);
  assert.equal(history.read(P, { kind: 'auto', id: 'm1' }).kind, 'message');
  const result = history.read(P, { kind: 'auto', id: 'r1' });
  assert.equal(result.kind, 'result');
  assert.equal(result.content, 'final answer');
});
