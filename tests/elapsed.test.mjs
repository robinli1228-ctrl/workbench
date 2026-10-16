// Running work shows how long it has been executing; queued or finished work shows no timer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatElapsed } from '../public/elapsed.js';
import { roleActivity } from '../public/role-icons.js';

test('elapsed time is compact and zero-padded', () => {
  assert.equal(formatElapsed(12_400), '12s');
  assert.equal(formatElapsed(3 * 60_000 + 5_000), '3m 05s');
  assert.equal(formatElapsed(3_600_000 + 7 * 60_000), '1h 07m');
  assert.equal(formatElapsed(-5), '0s');
});

test('a running role carries its run start time; a queued one does not', () => {
  const role = { id: 'r', name: 'dev', enabled: true, configured: true, nodeId: 'w', runtime: 'codex', model: 'm' };
  const startedAt = new Date(Date.now() - 90_000).toISOString();
  const task = { id: 't', roleId: 'r', status: 'in_progress', currentRunId: 'run1', createdAt: startedAt };
  const running = roleActivity(role, [task], [{ id: 'run1', roleId: 'r', taskId: 't', status: 'running', startedAt, createdAt: startedAt }], { worker: { online: true } });
  assert.equal(running.startedAt, startedAt);
  const queued = roleActivity(role, [task], [{ id: 'run1', roleId: 'r', taskId: 't', status: 'queued', createdAt: startedAt }], { worker: { online: true } });
  assert.equal(queued.startedAt, undefined);
});
