// A role whose CLI cannot work now is named at once (signed out, quota used up, model gone), and failures read plainly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Rooms } from '../src/rooms.mjs';
import { cliUnavailable, cliFailureText } from '../src/cli-availability.mjs';

const N = 'w1', P = 'p1';
const worker = runtime => ({ id: N, capabilities: { runtimeDiscovery: true, roomRoles: true }, runtimes: [{ type: 'claude', supported: true, available: true, models: [{ id: 'haiku' }], ...runtime }] });

test('a CLI is unavailable when signed out, without the model, or with a quota window used up until it resets', () => {
  const now = Date.parse('2026-10-23T10:00:00Z'), later = '2026-10-23T15:00:00Z';
  assert.equal(cliUnavailable(worker({}), 'claude', 'haiku', now), null);
  assert.equal(cliUnavailable(worker({ available: false, reason: 'Not logged in' }), 'claude', 'haiku', now), 'Not logged in');
  assert.ok(cliUnavailable(worker({}), 'claude', 'opus', now));
  assert.ok(cliUnavailable(worker({}), 'codex', null, now));
  const spent = { fiveHour: { remainingPercent: 0, resetsAt: later } };
  assert.match(cliUnavailable(worker({ quota: spent, quotaStale: true }), 'claude', 'haiku', now), /15|resets|恢复/);
  assert.equal(cliUnavailable(worker({ quota: spent }), 'claude', 'haiku', Date.parse(later) + 1), null);
  assert.equal(cliUnavailable(worker({ quota: spent, quotaInvalidated: true }), 'claude', 'haiku', now), null);
  // A Worker that has not reported yet keeps queueing as before.
  assert.equal(cliUnavailable({ capabilities: {} }, 'claude', 'haiku', now), null);
});

test('a quota or sign-in failure reads plainly, with the CLI text kept', () => {
  assert.match(cliFailureText('Claude AI usage limit reached|1792780000'), /usage limit reached/);
  assert.notEqual(cliFailureText('Claude AI usage limit reached'), 'Claude AI usage limit reached');
  assert.notEqual(cliFailureText('Invalid API key · Please run /login'), 'Invalid API key · Please run /login');
  assert.equal(cliFailureText('Some other failure'), 'Some other failure');
});

test('an @ to a role whose CLI is signed out is refused at once, naming the reason', () => {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'Chat', root: '/tmp/chat' });
  db.put('workers', worker({ available: false, reason: 'Not logged in' }));
  db.put('workspaces', { id: `${P}:${N}`, projectId: P, nodeId: N, localRoot: '/tmp/chat' });
  db.put('roles', { id: 'a', projectId: P, name: 'Dev', enabled: true, configured: true, nodeId: N, runtime: 'claude', model: 'haiku' });
  const rooms = new Rooms(db); rooms.touch = () => {};
  assert.throws(() => rooms.post(P, { clientMessageId: 'm1', text: '@Dev hello' }), /Dev[\s\S]*Not logged in/);
  assert.equal(db.list('tasks').length, 0);
  db.put('workers', worker({}));
  rooms.post(P, { clientMessageId: 'm2', text: '@Dev hello' });
  assert.equal(db.list('tasks').length, 1);
});
