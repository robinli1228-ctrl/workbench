// A timer occurrence's status comes from its own tasks and the calls tied to its own message. An older occurrence that has
// no message ID ties to no calls: unrelated calls without a source message must not keep it "running" (which would also
// stop the timer from firing again) or be cancelled with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { ScheduledJobs } from '../src/scheduled-jobs.mjs';

const P = 'p1', at = '2026-11-28T00:00:00.000Z';
function env() {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'demo' });
  // Calls between roles that came from no chat message: explicit null, and an old record without the field.
  db.put('coordinationRequests', { id: 'c-null', projectId: P, sourceMessageId: null, status: 'running', createdAt: at });
  db.put('coordinationRequests', { id: 'c-missing', projectId: P, status: 'queued', createdAt: at });
  db.put('coordinationRequests', { id: 'c-own', projectId: P, sourceMessageId: 'timer-j1-1', status: 'succeeded', createdAt: at });
  return { db, jobs: new ScheduledJobs(db, null) };
}

test('only calls of the occurrence\'s own message count', () => {
  const { db } = env();
  assert.deepEqual(db.callStatusesForSourceMessage('timer-j1-1').map(r => r.status), ['succeeded']);
  for (const id of [null, undefined, '']) assert.deepEqual(db.callStatusesForSourceMessage(id), [], String(id));
});

test('an old failed occurrence without a message stays failed and does not hold the timer', () => {
  const { db, jobs } = env();
  for (const [id, messageId] of [['o-null', null], ['o-missing', undefined]])
    db.put('scheduledOccurrences', { id, jobId: 'j1', projectId: P, conversationId: P, ...(messageId === undefined ? {} : { messageId }), status: 'failed', taskIds: [], createdAt: at });
  db.put('scheduledOccurrences', { id: 'o-own', jobId: 'j1', projectId: P, conversationId: P, messageId: 'timer-j1-1', status: 'queued', taskIds: [], createdAt: at });
  const statuses = Object.fromEntries(jobs.list(P).occurrences.map(item => [item.id, item.status]));
  assert.deepEqual(statuses, { 'o-null': 'failed', 'o-missing': 'failed', 'o-own': 'queued' });
});
