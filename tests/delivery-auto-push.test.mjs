// A cross-device Git delivery is pushed without waiting for a person: confirmed when registered, and an older pending one too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Deliveries } from '../src/git-delivery.mjs';

test('a delivery is confirmed as it is registered and published once its run has succeeded', () => {
  const db = new Store(':memory:');
  db.put('projects', { id: 'p1', name: 'Chat', root: '/tmp/chat', repoUrl: 'https://example.invalid/xxxxx/repo.git' });
  const run = db.put('runs', { id: 'r1', projectId: 'p1', nodeId: 'w1', status: 'running', roleId: 'a' });
  const deliveries = new Deliveries(db);
  const d = deliveries.request(run, { requestId: 'req1', commit: '422ce0cd48e29537fea5f76cad5f43b31b12c544', summary: 'review this' });
  assert.ok(d.approvedAt);
  assert.equal(d.approvedBy, 'auto');
  assert.deepEqual(deliveries.schedule(), []);
  db.put('runs', { ...run, status: 'succeeded' });
  assert.deepEqual(deliveries.schedule(), ['w1']);
  assert.equal(db.get('deliveries', d.id).status, 'publishing');
  assert.equal(db.get('commands', `delivery:${d.id}`).type, 'delivery_publish');
  // One left pending by an older Home is confirmed on the next pass.
  db.put('deliveries', { ...db.get('deliveries', d.id), id: 'old', status: 'awaiting_approval', approvedAt: null, approvedBy: undefined });
  deliveries.schedule();
  assert.ok(db.get('deliveries', 'old').approvedAt);
  assert.equal(db.get('deliveries', 'old').status, 'publishing');
});
