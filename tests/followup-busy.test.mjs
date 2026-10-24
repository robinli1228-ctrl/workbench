// The silence follow-up counts quiet time only: a role still working (or a message still queued) is not silence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { ProactiveFollowup } from '../src/proactive-followup.mjs';
import { tr } from '../src/i18n.mjs';

const P = 'p1';
test('a running reply or a queued message keeps the follow-up from firing; it fires only after the quiet window', () => {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'Chat', root: '/tmp/chat' });
  let now = Date.now(); // message receipts carry the store's real time
  const followup = new ProactiveFollowup(db, null, { clock: () => new Date(now) });
  followup.save(P, { revision: 0, enabled: true, silenceMinutes: 10 });
  db.put('roomMessages', { id: 'human1', projectId: P, sender: 'human', text: 'please build it' });
  followup.tick();
  assert.equal(followup.get(P).anchorMessageId, 'human1');
  // A role is working for longer than the window without posting.
  db.put('runs', { id: 'r1', projectId: P, roleId: 'a', status: 'running' });
  now += 11 * 60000; followup.tick();
  let state = followup.get(P);
  assert.equal(state.waitingReason, null);
  assert.equal(Date.parse(state.dueAt), now + 10 * 60000);
  // The run ends, then a queued message keeps it busy.
  db.put('runs', { ...db.get('runs', 'r1'), status: 'succeeded' });
  db.put('tasks', { id: 't2', projectId: P, origin: 'chat', status: 'ready' });
  now += 11 * 60000; followup.tick();
  assert.equal(followup.get(P).waitingReason, null);
  db.put('tasks', { ...db.get('tasks', 't2'), status: 'succeeded' });
  // Quiet, but the window restarted when the work was last seen: not yet.
  now += 5 * 60000; followup.tick();
  assert.equal(followup.get(P).waitingReason, null);
  // Ten quiet minutes later it fires (here: no supervisor configured, so it records why it cannot).
  now += 6 * 60000; followup.tick();
  assert.equal(followup.get(P).waitingReason, tr('followup.noSupervisor'));
});
