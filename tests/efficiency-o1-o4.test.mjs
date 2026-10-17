// O1: a single process-level CLI probe failure keeps the last good report; O2: a dependency that cannot start wakes
// its waiter once, like an early timeout; O4: wb call --file also finds project-root relative paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeRuntimeReports, runtimeIssue, inspectCodex } from '../src/runtime-probe.mjs';
import { Store } from '../src/store.mjs';
import { Rooms } from '../src/rooms.mjs';
import { RoleCalls, BLOCKED_WAKE_MS } from '../src/role-calls.mjs';
import { callDocument } from '../src/wb-tools.mjs';

const good = (at = new Date().toISOString()) => ({ type: 'codex', supported: true, installed: true, available: true, version: 'codex 1.0', models: [{ id: 'm' }], checkedAt: at });
const flaky = (extra = {}) => ({ type: 'codex', supported: true, installed: true, available: false, version: 'codex 1.0', models: [], transient: true, reason: 'App Server exited', checkedAt: new Date().toISOString(), ...extra });

test('O1: one transient failure keeps the last good report with its original checkedAt and retries in 30s', () => {
  const lastGood = good(new Date(Date.now() - 60000).toISOString());
  const first = mergeRuntimeReports([lastGood], [flaky()], {});
  assert.equal(first.runtimes[0].available, true);
  assert.equal(first.runtimes[0].checkedAt, lastGood.checkedAt, 'the failure time must not refresh the expiry');
  assert.equal(first.runtimes[0].probeWarning.failures, 1);
  assert.equal(first.retryMs, 30000);
  assert.equal(runtimeIssue({ capabilities: { runtimeDiscovery: true }, runtimes: first.runtimes }, 'codex', 'm'), null);
  const second = mergeRuntimeReports(first.runtimes, [flaky()], first.failures);
  assert.equal(second.runtimes[0].available, false, 'the second consecutive failure reports unavailable');
  assert.equal(second.retryMs, 60000);
  const third = mergeRuntimeReports(second.runtimes, [flaky()], second.failures);
  assert.equal(third.retryMs, 120000);
  assert.equal(mergeRuntimeReports(third.runtimes, [flaky()], third.failures).retryMs, 120000);
  const healed = mergeRuntimeReports(third.runtimes, [good()], third.failures);
  assert.equal(healed.runtimes[0].available, true);
  assert.deepEqual(healed.failures, {});
  assert.equal(healed.retryMs, null);
});

test('O1: a kept report still expires ten minutes after the last real success', () => {
  const stale = good(new Date(Date.now() - 11 * 60000).toISOString());
  const kept = mergeRuntimeReports([stale], [flaky()], {}).runtimes;
  assert.match(runtimeIssue({ capabilities: { runtimeDiscovery: true }, runtimes: kept }, 'codex', 'm'), /./);
});

test('O1: definite failures and version changes are reported at once', () => {
  const lastGood = good();
  const loggedOut = mergeRuntimeReports([lastGood], [{ ...flaky(), transient: undefined, reason: 'login required' }], {});
  assert.equal(loggedOut.runtimes[0].available, false);
  assert.equal(loggedOut.retryMs, null);
  const upgraded = mergeRuntimeReports([lastGood], [flaky({ version: 'codex 2.0' })], {});
  assert.equal(upgraded.runtimes[0].available, false);
  const neverGood = mergeRuntimeReports([], [flaky()], {});
  assert.equal(neverGood.runtimes[0].available, false);
  assert.equal(neverGood.retryMs, 30000);
});

test('O1: a confirmed missing login stays a definite failure even if the App Server then exits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-o1-')), bin = join(dir, 'codex'), before = process.env.CODEX_BIN;
  // Fake Codex: answers initialize and a logged-out account/read, then exits on the next request.
  await writeFile(bin, `#!${process.execPath}
if (process.argv[2] === '--version') { console.log('codex 1.0'); process.exit(0); }
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', line => { const m = JSON.parse(line); if (m.id === undefined) return;
  if (m.method === 'initialize') console.log(JSON.stringify({ id: m.id, result: {} }));
  else if (m.method === 'account/read') console.log(JSON.stringify({ id: m.id, result: { account: null, requiresOpenaiAuth: true } }));
  else process.exit(1); });
`); await chmod(bin, 0o755);
  try {
    process.env.CODEX_BIN = bin;
    const report = await inspectCodex();
    assert.equal(report.available, false);
    assert.equal(report.authReady, false);
    assert.equal(report.transient, undefined, 'a login failure must not be retried as transient');
    assert.equal(mergeRuntimeReports([good()], [report], {}).runtimes[0].available, false);
  } finally { if (before === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = before; await rm(dir, { recursive: true, force: true }); }
});

const P = 'p1';
function waiting() {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'demo' });
  db.put('workspaces', { id: `${P}:w1`, projectId: P, nodeId: 'w1', localRoot: '/xxxxx' });
  db.put('workspaces', { id: `${P}:w2`, projectId: P, nodeId: 'w2', localRoot: '/xxxxx' });
  db.put('roles', { id: 'a', projectId: P, name: 'Supervisor', nodeId: 'w1', runtime: 'claude', model: 'm', mode: 'workspace-write', enabled: true });
  db.put('roles', { id: 'b', projectId: P, name: 'Executor', nodeId: 'w2', runtime: 'claude', model: 'm', mode: 'workspace-write', enabled: true });
  db.put('roomMessages', { id: 'm1', projectId: P, sender: 'human', text: '@Supervisor go', taskIds: ['t1'] });
  db.put('tasks', { id: 't1', projectId: P, origin: 'chat', roleId: 'a', roleSnapshot: db.get('roles', 'a'), prompt: 'go', sourceMessageId: 'm1', status: 'in_progress', currentRunId: 'r1', contextPrepared: true });
  db.put('runs', { id: 'r1', projectId: P, taskId: 't1', roleId: 'a', roleSnapshot: db.get('roles', 'a'), nodeId: 'w1', sourceMessageId: 'm1', status: 'running', lastSeq: 0 });
  const calls = new RoleCalls(db), parent = calls.adoptTask('t1');
  db.put('coordinationRequests', { id: 'c1', projectId: P, parentRequestId: parent.id, targetRoleId: 'b', kind: 'direct', status: 'queued', summary: 'implement', targetSnapshot: db.get('roles', 'b'), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  calls.reconcile('c1');
  const queued = db.get('tasks', db.get('coordinationRequests', 'c1').taskId);
  db.put('tasks', { ...queued, contextPrepared: true });
  calls.wait(db.get('runs', 'r1'), 'resume after Executor replies');
  db.put('runs', { ...db.get('runs', 'r1'), status: 'succeeded' });
  db.put('tasks', { ...db.get('tasks', 't1'), status: 'completed', currentRunId: null });
  const rooms = new Rooms(db); rooms.touch = () => {};
  return { db, calls, parent, rooms };
}
const childTask = e => e.db.get('tasks', e.db.get('coordinationRequests', 'c1').taskId);

test('O2: an offline target wakes the waiter once after ten minutes, as an early timeout', () => {
  const e = waiting();
  assert.ok(childTask(e), 'the dependency has its queued task');
  e.rooms.schedule(id => id !== 'w2');
  const task = childTask(e);
  assert.equal(task.blockedKind, 'device_offline');
  const since = Date.parse(task.blockedSince);
  e.calls.resume(e.parent.id, since + BLOCKED_WAKE_MS - 1000);
  assert.equal(e.db.get('coordinationRequests', e.parent.id).continuationRequestId, undefined, 'not before the window');
  e.calls.resume(e.parent.id, since + BLOCKED_WAKE_MS + 1000);
  const parent = e.db.get('coordinationRequests', e.parent.id), next = e.db.get('coordinationRequests', parent.continuationRequestId);
  assert.equal(next.wakeReason, 'blocked');
  assert.deepEqual(next.waitRequestIds, ['c1']);
  assert.match(next.summary, /c1/);
  const child = e.db.get('coordinationRequests', 'c1');
  assert.equal(child.status, 'queued', 'the dependency stays active');
  assert.equal(child.blockedWake.since, task.blockedSince);
  e.rooms.schedule(id => id !== 'w2');
  assert.equal(childTask(e).blockedSince, task.blockedSince, 'the same blocked episode keeps its start time');
});

test('O2: the same blocked episode is not reported again after the waiter waits again', () => {
  const e = waiting();
  e.rooms.schedule(id => id !== 'w2');
  const since = Date.parse(childTask(e).blockedSince);
  e.calls.resume(e.parent.id, since + BLOCKED_WAKE_MS + 1000);
  const next = e.db.get('coordinationRequests', e.db.get('coordinationRequests', e.parent.id).continuationRequestId);
  e.calls.reconcile(next.id);
  const resumed = e.db.get('coordinationRequests', next.id);
  e.db.put('runs', { id: 'r2', projectId: P, taskId: resumed.taskId, roleId: 'a', roleSnapshot: e.db.get('roles', 'a'), nodeId: 'w1', requestId: next.id, status: 'running', lastSeq: 0 });
  e.db.put('tasks', { ...e.db.get('tasks', resumed.taskId), status: 'in_progress', currentRunId: 'r2' });
  e.db.put('coordinationRequests', { ...resumed, status: 'running', currentRunId: 'r2' });
  e.calls.wait(e.db.get('runs', 'r2'), 'still waiting', { requestIds: ['c1'] });
  e.db.put('runs', { ...e.db.get('runs', 'r2'), status: 'succeeded' });
  e.calls.resume(next.id, since + 2 * BLOCKED_WAKE_MS);
  assert.equal(e.db.get('coordinationRequests', next.id).continuationRequestId, undefined);
});

test('O2: a dependency that already continued is marked on its effective continuation, so it is reported once', () => {
  const e = waiting(), old = new Date(Date.now() - 2 * BLOCKED_WAKE_MS).toISOString();
  const c1 = e.db.get('coordinationRequests', 'c1'), first = e.db.get('tasks', c1.taskId);
  e.db.put('tasks', { ...first, status: 'completed' });
  e.db.put('tasks', { id: 'tn', projectId: P, origin: 'chat', roleId: 'b', roleSnapshot: e.db.get('roles', 'b'), prompt: 'continue', status: 'ready', contextPrepared: true, blockedKind: 'cli_unavailable', blockedSince: old, waitingReason: 'App Server exited' });
  e.db.put('coordinationRequests', { id: 'c1n', projectId: P, parentRequestId: c1.parentRequestId, targetRoleId: 'b', kind: 'continuation', continuationOf: 'c1', status: 'queued', taskId: 'tn', summary: 'continue', createdAt: old, updatedAt: old });
  e.db.put('coordinationRequests', { ...c1, status: 'waiting_call', continuationRequestId: 'c1n' });
  e.calls.resume(e.parent.id);
  const next = e.db.get('coordinationRequests', e.db.get('coordinationRequests', e.parent.id).continuationRequestId);
  assert.equal(next.wakeReason, 'blocked');
  assert.equal(e.db.get('coordinationRequests', 'c1n').blockedWake?.since, old, 'the mark lands on the record that was read');
  assert.equal(e.db.get('coordinationRequests', 'c1').blockedWake, undefined);
  e.calls.reconcile(next.id);
  const resumed = e.db.get('coordinationRequests', next.id);
  e.db.put('runs', { id: 'r2', projectId: P, taskId: resumed.taskId, roleId: 'a', roleSnapshot: e.db.get('roles', 'a'), nodeId: 'w1', requestId: next.id, status: 'running', lastSeq: 0 });
  e.db.put('tasks', { ...e.db.get('tasks', resumed.taskId), status: 'in_progress', currentRunId: 'r2' });
  e.db.put('coordinationRequests', { ...resumed, status: 'running', currentRunId: 'r2' });
  e.calls.wait(e.db.get('runs', 'r2'), 'still waiting', { requestIds: ['c1'] });
  e.db.put('runs', { ...e.db.get('runs', 'r2'), status: 'succeeded' });
  e.calls.resume(next.id);
  assert.equal(e.db.get('coordinationRequests', next.id).continuationRequestId, undefined, 'the same episode is not reported again');
});

test('O2: normal queueing and a paused Home never trigger a blocked wake', () => {
  const busy = waiting();
  busy.db.put('runs', { id: 'rb', projectId: P, taskId: 'x', roleId: 'b', roleSnapshot: busy.db.get('roles', 'b'), nodeId: 'w2', status: 'running', lastSeq: 0 });
  busy.db.put('workers', { id: 'w2', capabilities: {} });
  busy.rooms.schedule(() => true);
  assert.equal(childTask(busy).blockedKind ?? null, null);
  const paused = waiting();
  paused.rooms.schedule(id => id !== 'w2');
  const since = Date.parse(childTask(paused).blockedSince);
  paused.db.put('settings', { id: 'main', paused: true });
  paused.calls.resume(paused.parent.id, since + BLOCKED_WAKE_MS + 1000);
  assert.equal(paused.db.get('coordinationRequests', paused.parent.id).continuationRequestId, undefined);
});

test('O4: a relative --file path falls back from the workspace to the project root, still inside the allow-list', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wb-o4-')), workspace = join(root, 'ws'), project = join(root, 'project');
  try {
    await mkdir(join(project, '.workbench', 'docs'), { recursive: true }); await mkdir(workspace, { recursive: true });
    await writeFile(join(project, '.workbench', 'docs', 'plan.md'), 'plan');
    const found = await callDocument('.workbench/docs/plan.md', { workspace, projectRoot: project });
    assert.equal(found.text, 'plan');
    await writeFile(join(workspace, 'same.md'), 'workspace'); await writeFile(join(project, 'same.md'), 'project');
    assert.equal((await callDocument('same.md', { workspace, projectRoot: project })).text, 'workspace', 'the workspace wins');
    await assert.rejects(callDocument('missing.md', { workspace, projectRoot: project }), /ENOENT/);
    await writeFile(join(root, 'outside.md'), 'x');
    await assert.rejects(callDocument('../outside.md', { workspace, projectRoot: project }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
