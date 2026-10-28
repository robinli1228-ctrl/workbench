import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { CollaborationSessions, setCollaborationSessionsEnabled } from '../src/collaboration-sessions.mjs';
import { SessionQueue, QueuePump, setQueueConfig, grantBudget, raiseAlert, clearAlert, reassignRequest } from '../src/session-queue.mjs';
import { renderBatch } from '../src/session-queue-worker.mjs';
import { executionRules } from '../src/platform-prompts.mjs';
import { ProactiveFollowup } from '../src/proactive-followup.mjs';

const P = 'p1';
function env({ budget = 20 } = {}) {
  const db = new Store(':memory:'); let clock = Date.parse('2026-10-12T08:00:00Z');
  const now = () => clock, advance = s => { clock += s * 1000; };
  db.queueNow = now;
  db.put('projects', { id: P, name: 'demo', supervisorRoleId: 'sup' });
  db.put('roles', { id: 'sup', projectId: P, name: 'sup', model: 'm', enabled: true, systemSupervisor: true });
  for (const id of ['a', 'b']) db.put('roles', { id, projectId: P, name: id, nodeId: 'w1', runtime: 'codex', model: 'm', enabled: true });
  db.put('workers', { id: 'w1', capabilities: { sessionQueue: 2 } });
  setCollaborationSessionsEnabled(db, P, true);
  setQueueConfig(db, P, { budgetBatches: budget, backlogMessages: 3, backlogWaitSeconds: 600 });
  db.put('roomMessages', { id: 'root', projectId: P, sender: 'human', text: 'goal' });
  new CollaborationSessions(db).create(P, { id: 's0', goal: 'g', participants: ['a', 'b'], sourceMessageId: 'root' });
  db.put('collaborationSessions', { ...db.get('collaborationSessions', 's0'), broadcast: true });
  const queue = new SessionQueue(db, { now }); let n = 0;
  const say = (roleId, text) => { const id = `m${++n}`; db.put('roomMessages', { id, projectId: P, sender: 'agent', roleId, replyToId: 'root', text }); return id; };
  const sent = [];
  const pump = new QueuePump(db, { now, online: () => false, render: renderBatch, send: (nodeId, m) => sent.push(m) });
  const alertTasks = () => db.list('tasks').filter(t => t.sessionQueueAlert);
  return { db, queue, say, advance, pump, alertTasks, now, sent };
}

test('backlog alerts once, clears on recovery, and alerts again when crossed again', () => {
  const e = env();
  e.say('a', '1'); e.say('a', '2');
  assert.equal(e.pump.checkBacklog().length, 0);
  e.say('a', '3');
  assert.equal(e.pump.checkBacklog().length, 1);
  assert.equal(e.pump.checkBacklog().length, 0);                         // still over: no repeat
  const b = e.queue.seal(P, 'b', { workerId: 'w1', reservation: { id: 'r1', generation: 1 } });
  assert.equal(b, null);                                                   // quiet window not elapsed
  e.advance(60); const sealed = e.queue.seal(P, 'b', { workerId: 'w1', reservation: { id: 'r1', generation: 1 } });
  assert.ok(sealed); e.pump.checkBacklog();                                // back under -> cleared
  assert.equal(e.db.get('sessionQueueAlerts', 'backlog:s0:b').active, false);
  e.db.list('tasks').filter(t => t.sessionQueueAlert).forEach(t => e.db.put('tasks', { ...t, status: 'in_progress', currentRunId: 'x' }));
  e.say('a', '4'); e.say('a', '5'); e.say('a', '6');
  assert.equal(e.pump.checkBacklog().length, 1);                           // crossed again -> new alert
  assert.equal(e.db.get('sessionQueueAlerts', 'backlog:s0:b').count, 2);
});

test('budget alert re-arms after a grant; merged into one pending supervisor task per matter', () => {
  const e = env({ budget: 1 });
  e.say('a', 'x'); e.advance(60);
  const b = e.queue.seal(P, 'b', { workerId: 'w1', reservation: { id: 'r1', generation: 1 } });
  e.queue.markDelivering(b.id); e.queue.confirmStarted(b.id, { runId: 'run1', reservationId: 'r1' });
  e.say('b', 'y'); e.advance(60);
  assert.equal(e.queue.seal(P, 'a', { workerId: 'w1', reservation: { id: 'r2', generation: 1 } }), null);
  e.pump.checkBacklog();
  assert.equal(e.alertTasks().length, 1);
  grantBudget(e.db, P, 's0', { additional: 1 });
  assert.equal(e.db.get('sessionQueueAlerts', 'budget_exhausted:s0').active, false);
  const b2 = e.queue.seal(P, 'a', { workerId: 'w1', reservation: { id: 'r3', generation: 1 } });
  e.queue.markDelivering(b2.id); e.queue.confirmStarted(b2.id, { runId: 'run2', reservationId: 'r3' });
  e.queue.complete(b.id, { outcome: 'replied' });
  e.say('a', 'z'); e.advance(60);
  assert.equal(e.queue.seal(P, 'b', { workerId: 'w1', reservation: { id: 'r4', generation: 1 } }), null);
  assert.equal(e.db.get('sessionQueueAlerts', 'budget_exhausted:s0').count, 2);
  assert.equal(e.alertTasks().length, 1);                                  // supervisor not started yet: merged
  assert.deepEqual(e.alertTasks()[0].sessionQueueAlert.kinds, ['budget_exhausted', 'budget_exhausted']);
});

test('closing a session ends its cycle and keeps the record; accepted tasks are untouched', () => {
  const e = env();
  e.db.put('tasks', { id: 'accepted', projectId: P, status: 'in_progress', roleId: 'a' });
  e.say('a', 'x'); e.advance(60);
  assert.ok(e.queue.seal(P, 'b', { workerId: 'w1', reservation: { id: 'r1', generation: 1 } }));
  new CollaborationSessions(e.db).close(P, 's0');
  const cycle = e.db.get('sessionCycles', 'cycle:s0');
  assert.equal(cycle.ended, true); assert.equal(cycle.used + cycle.reserved, 1);
  assert.equal(e.db.get('tasks', 'accepted').status, 'in_progress');
});

test('reassignment is refused once execution started and keeps the original link otherwise', () => {
  const e = env();
  // RoleCalls stand-in with the same cancel/create contract (the real one also needs a workspace binding).
  const calls = { cancel: id => e.db.put('coordinationRequests', { ...e.db.get('coordinationRequests', id), status: 'cancelled' }),
    create: input => e.db.put('coordinationRequests', { ...input, status: 'queued' }) };
  const r = calls.create({ id: 'req1', projectId: P, targetRoleId: 'a', kind: 'consult', summary: 'check' });
  const moved = reassignRequest(e.db, calls, P, r.id, 'b');
  assert.equal(moved.targetRoleId, 'b'); assert.equal(moved.reassignedFrom, 'req1');
  assert.equal(e.db.get('coordinationRequests', 'req1').reassignedTo, moved.id);
  assert.equal(e.db.get('coordinationRequests', 'req1').status, 'cancelled');
  const r2 = calls.create({ id: 'req2', projectId: P, targetRoleId: 'a', kind: 'consult', summary: 'check' });
  e.db.put('coordinationRequests', { ...e.db.get('coordinationRequests', r2.id), status: 'running', currentRunId: 'run-x' });
  assert.throws(() => reassignRequest(e.db, calls, P, 'req2', 'b'), /started|\u5f00\u59cb/);
});

test('retained collaboration batch runs no longer receive removed pass guidance', () => {
  const base = { id: 'r', roleSnapshot: { name: 'a' }, reportRequired: false };
  for (const minimal of [true, false]) {
    assert.ok(!executionRules(base, { minimal }).includes('wb pass'));
    assert.ok(!executionRules({ ...base, collaborationBatchId: 'b1' }, { minimal }).includes('wb pass'));
  }
});

test('silence follow-up: queue alert replies do not restart the timer; wb pass creates no message', () => {
  const e = env(), followup = new ProactiveFollowup(e.db);
  followup.save(P, { revision: 0, enabled: true, silenceMinutes: 10 });
  e.db.put('tasks', { id: 'alert', projectId: P, sessionQueueAlert: { sessionId: 's0', kinds: ['backlog'] } });
  e.db.put('runs', { id: 'alert-run', projectId: P, taskId: 'alert', roleId: 'sup' });
  e.db.put('roomMessages', { id: 'human1', projectId: P, sender: 'human', text: 'hello' });
  const anchored = followup.observe(P).anchorMessageId;
  e.db.put('roomMessages', { id: 'sup-alert-reply', projectId: P, sender: 'agent', roleId: 'sup', runId: 'alert-run', text: 'noted' });
  assert.equal(followup.observe(P).anchorMessageId, anchored);
  e.db.put('roomMessages', { id: 'peer', projectId: P, sender: 'agent', roleId: 'a', text: 'real update' });
  assert.equal(followup.observe(P).anchorMessageId, 'peer');
});

test('acceptance #1/#16: existing-session broadcast never calls the supervisor and sends nothing external', () => {
  const e = env();
  e.say('a', 'x'); e.say('b', 'y');
  const receipts = e.queue.status(P).receipts;
  assert.ok(!receipts.some(r => r.roleId === 'sup'));
  assert.equal(e.db.list('tasks').length, 0);
  e.advance(60); e.pump.tick();                                            // workers offline -> nothing sent anywhere
  assert.deepEqual(e.sent, []);
});
