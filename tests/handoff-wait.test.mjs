// A turn that only hands work to peers and waits must not add its own room message; the handoff cards already show it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Rooms, handoffOnly } from '../src/rooms.mjs';
import { RoleCalls } from '../src/role-calls.mjs';
import { saveRunReport } from '../src/run-reports.mjs';
import * as roomUI from '../public/room.js';
const { handoffWaitState } = roomUI;

const P = 'p1';
function env() {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'demo' });
  db.put('workspaces', { id: `${P}:w1`, projectId: P, nodeId: 'w1', localRoot: '/xxxxx' });
  for (const [id, name] of [['a', 'Reviewer'], ['b', 'Executor']]) db.put('roles', { id, projectId: P, name, nodeId: 'w1', runtime: 'claude', model: 'm', mode: 'workspace-write', enabled: true });
  db.put('roomMessages', { id: 'm1', projectId: P, sender: 'human', text: '@Reviewer plan and delegate', taskIds: ['t1'] });
  db.put('tasks', { id: 't1', projectId: P, origin: 'chat', roleId: 'a', roleSnapshot: db.get('roles', 'a'), prompt: 'plan and delegate', sourceMessageId: 'm1', status: 'in_progress', currentRunId: 'r1', createdAt: new Date().toISOString() });
  db.put('runs', { id: 'r1', projectId: P, taskId: 't1', roleId: 'a', roleSnapshot: db.get('roles', 'a'), nodeId: 'w1', sourceMessageId: 'm1', status: 'running', lastSeq: 0 });
  const calls = new RoleCalls(db), parent = calls.adoptTask('t1');
  db.put('coordinationRequests', { id: 'c1', projectId: P, parentRequestId: parent.id, targetRoleId: 'b', kind: 'direct', status: 'queued', summary: 'implement', createdAt: new Date().toISOString() });
  const rooms = new Rooms(db); rooms.touch = () => {};
  const finish = (patch = {}) => { const run = db.put('runs', { ...db.get('runs', 'r1'), status: 'succeeded', result: 'Dispatched to @Executor; waiting.', ...patch }); rooms.complete(run); return run; };
  return { db, calls, parent, rooms, finish };
}
const results = db => db.list('roomMessages').filter(m => m.id === 'result-r1');

test('waiting on a handoff marks the run and suppresses its result message', () => {
  const e = env();
  e.calls.wait(e.db.get('runs', 'r1'), 'resume after Executor replies');
  const marked = e.db.get('runs', 'r1');
  assert.equal(marked.handoffWait.requestId, e.parent.id);
  assert.deepEqual(marked.handoffWait.requestIds, ['c1']);
  const run = e.finish();
  assert.equal(handoffOnly(run), true);
  assert.equal(results(e.db).length, 0);
  assert.equal(e.db.get('runs', 'r1').result, 'Dispatched to @Executor; waiting.', 'the reply stays in run details');
});

test('a question for the user is still published while waiting', () => {
  const e = env();
  e.calls.wait(e.db.get('runs', 'r1'), 'resume');
  e.db.put('runReports', { id: 'r1', runId: 'r1', verdict: 'needs_input', summary: 'Choose A or B' });
  e.finish();
  assert.equal(results(e.db).length, 1);
  assert.match(results(e.db)[0].text, /Choose A or B/);
});

test('failed or stopped turns are always published', () => {
  for (const status of ['failed', 'interrupted']) {
    const e = env();
    e.calls.wait(e.db.get('runs', 'r1'), 'resume');
    e.finish({ status, error: 'boom' });
    assert.equal(results(e.db).length, 1, status);
  }
});

test('turns without a wait keep their normal result message', () => {
  const e = env();
  e.finish();
  assert.equal(results(e.db).length, 1);
});

test('explicit business reports survive a handoff wait without changing normal reply text', () => {
  for (const verdict of ['failed', 'blocked', 'passed', 'needs_input']) {
    for (const timing of ['before', 'after']) {
      const e = env(), summary = verdict === 'needs_input' ? 'Choose the invoice recovery policy' : `Invoice reconciliation verdict: ${verdict}`;
      const report = () => saveRunReport(e.db, e.db.get('runs', 'r1'), { submissionId: `${verdict}-${timing}`, verdict, summary, evidence: ['Verified invoice reconciliation against the saved ledger'] });
      if (timing === 'before') report();
      e.calls.wait(e.db.get('runs', 'r1'), 'resume after Executor replies');
      if (timing === 'after') report();
      const run = e.finish({ result: summary });
      assert.equal(handoffOnly(run, e.db.get('runReports', run.id)), false, `${verdict} ${timing}`);
      assert.equal(results(e.db).length, 1, `${verdict} ${timing}`);
      assert.ok(results(e.db)[0].text.includes(summary));
      if (verdict !== 'needs_input') assert.equal(results(e.db)[0].text, summary);
      const data = { requests: e.db.list('coordinationRequests'), roles: e.db.list('roles'), runReports: e.db.list('runReports') };
      assert.equal(roomUI.quietHandoff(run, data), false);
      assert.equal(roomUI.quietHandoff({ ...run, report: undefined }, data), false, 'the report table also prevents the quiet frontend branch');
      assert.equal(handoffWaitState(run, data), null);
      e.db.close();
    }
  }
});

test('the room shows one waiting line naming the peers, and hides it after resume', () => {
  for (const reason of ['results', 'timeout']) {
    const e = env();
    e.calls.wait(e.db.get('runs', 'r1'), 'resume');
    const run = e.finish();
    const data = () => ({ requests: e.db.list('coordinationRequests'), roles: e.db.list('roles') });
    assert.deepEqual(handoffWaitState(run, data()), { names: ['Executor'] });
    if (reason === 'results') e.db.put('coordinationRequests', { ...e.db.get('coordinationRequests', 'c1'), status: 'succeeded', result: 'Implementation completed' });
    const time = reason === 'timeout' ? Date.parse(e.db.get('coordinationRequests', e.parent.id).waitDeadlineAt) + 1 : Date.now();
    e.calls.resume(e.parent.id, time);
    const parent = e.db.get('coordinationRequests', e.parent.id);
    assert.equal(parent.status, 'waiting_call');
    assert.equal(parent.currentRunId, run.id);
    assert.equal(e.db.get('coordinationRequests', parent.continuationRequestId)?.wakeReason, reason);
    assert.equal(handoffWaitState(run, data()), null);
    assert.equal(handoffWaitState({ ...run, handoffWait: undefined }, data()), null);
    e.db.close();
  }
});
