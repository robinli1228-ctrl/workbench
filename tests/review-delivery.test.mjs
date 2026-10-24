// A fixed review delivery is recorded as such, refused for Workers that would advance baselines, and runs in its own session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Deliveries, reviewDeliveryIssue } from '../src/git-delivery.mjs';
import { taskConversationId } from '../src/role-sessions.mjs';

const P = 'p1', SHA = 'a'.repeat(40);
function env(capabilities) {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'demo' });
  db.put('workers', { id: 'w1', capabilities });
  const run = db.put('runs', { id: 'r1', projectId: P, nodeId: 'w1', status: 'succeeded', repositories: [{ id: 'repo1', repoUrl: 'https://example.invalid/x.git' }] });
  return { db, run, deliveries: new Deliveries(db) };
}

test('a review delivery keeps its purpose and an old Worker is refused before anything is published', () => {
  const ok = env({ reviewDeliveries: 1 });
  const review = ok.deliveries.request(ok.run, { requestId: 'rev-1', commit: SHA, summary: 'review this', purpose: 'review' });
  assert.equal(review.purpose, 'review');
  const plain = ok.deliveries.request(ok.run, { requestId: 'dev-1', commit: SHA, summary: 'ship this' });
  assert.equal(plain.purpose, undefined, 'ordinary deliveries are unchanged');
  assert.throws(() => ok.deliveries.request(ok.run, { requestId: 'rev-1', commit: SHA, summary: 'review this' }), /conflict/i, 'the same ID cannot silently drop the review purpose');
  assert.throws(() => ok.deliveries.request(ok.run, { requestId: 'x', commit: SHA, summary: 's', purpose: 'deploy' }));
  const old = env({});
  assert.throws(() => old.deliveries.request(old.run, { requestId: 'rev-1', commit: SHA, summary: 'review this', purpose: 'review' }), /Upgrade|升级/);
  assert.equal(reviewDeliveryIssue({ capabilities: {} }, { purpose: 'review' }) !== null, true);
  assert.equal(reviewDeliveryIssue({ capabilities: {} }, {}), null);
});

test('a review task runs in its own role-session key; ordinary tasks keep theirs', () => {
  assert.equal(taskConversationId({ projectId: P, id: 't1', reviewDeliveryId: 'd1', sourceSessionKey: 'k1' }), `${P}:review:k1`);
  assert.equal(taskConversationId({ projectId: P, id: 't2' }), P);
});
