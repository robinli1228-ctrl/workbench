// A role whose CLI cannot work now is named at once (signed out, quota used up, model gone), and failures read plainly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Rooms } from '../src/rooms.mjs';
import { cliUnavailable, cliFailureText } from '../src/cli-availability.mjs';

const N = 'w1', P = 'p1';
const worker = runtime => ({ id: N, capabilities: { runtimeDiscovery: true, roomRoles: true }, runtimes: [{ type: 'claude', supported: true, available: true, models: [{ id: 'haiku' }], ...runtime }] });

test('only definite states make a CLI unavailable: missing, signed out, model gone, Codex quota used up with no credits', () => {
  const now = Date.parse('2026-10-23T10:00:00Z'), later = '2026-10-23T15:00:00Z';
  assert.equal(cliUnavailable(worker({}), 'claude', 'haiku', now), null);
  assert.equal(cliUnavailable(worker({ available: false, authState: 'signed_out', reason: 'Not logged in' }), 'claude', 'haiku', now), 'Not logged in');
  // A probe that timed out or failed is not a sign-out: the work queues as before.
  assert.equal(cliUnavailable(worker({ available: false, reason: 'probe timed out' }), 'claude', 'haiku', now), null);
  assert.ok(cliUnavailable(worker({}), 'claude', 'opus', now));
  assert.equal(cliUnavailable(worker({ available: false, models: [] }), 'claude', 'opus', now), null);
  assert.ok(cliUnavailable(worker({}), 'codex', null, now));
  const codex = quota => ({ id: N, capabilities: { runtimeDiscovery: true }, runtimes: [{ type: 'codex', supported: true, available: true, models: [{ id: 'gpt' }], quota }] });
  const spent = { fiveHour: { remainingPercent: 0, resetsAt: later } };
  assert.match(cliUnavailable(codex({ ...spent, credits: { hasCredits: false, unlimited: false } }), 'codex', 'gpt', now), /15|resets|恢复/);
  assert.equal(cliUnavailable(codex({ ...spent, credits: { hasCredits: true, unlimited: false } }), 'codex', 'gpt', now), null);
  assert.equal(cliUnavailable(codex(spent), 'codex', 'gpt', now), null);
  assert.equal(cliUnavailable(codex({ ...spent, credits: { hasCredits: false } }), 'codex', 'gpt', Date.parse(later) + 1), null);
  // A Claude window at 100% may still run on extra usage; it is not refused.
  assert.equal(cliUnavailable(worker({ quota: spent }), 'claude', 'haiku', now), null);
  // A Worker that has not reported yet keeps queueing as before.
  assert.equal(cliUnavailable({ capabilities: {} }, 'claude', 'haiku', now), null);
});

test('a quota or sign-in failure reads plainly, with the CLI text kept', () => {
  assert.match(cliFailureText('Claude AI usage limit reached|1792780000'), /usage limit reached/);
  assert.notEqual(cliFailureText('Claude AI usage limit reached'), 'Claude AI usage limit reached');
  assert.notEqual(cliFailureText('Invalid API key · Please run /login'), 'Invalid API key · Please run /login');
  assert.equal(cliFailureText('Some other failure'), 'Some other failure');
  assert.equal(cliFailureText('fatal: Authentication failed for repository'), 'fatal: Authentication failed for repository');
  assert.equal(cliFailureText('prompt is too long: context limit reached'), 'prompt is too long: context limit reached');
});

test('an @ to a role whose CLI is signed out is refused at once, naming the reason', () => {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'Chat', root: '/tmp/chat' });
  db.put('workers', worker({ available: false, authState: 'signed_out', reason: 'Not logged in' }));
  db.put('workspaces', { id: `${P}:${N}`, projectId: P, nodeId: N, localRoot: '/tmp/chat' });
  db.put('roles', { id: 'a', projectId: P, name: 'Dev', enabled: true, configured: true, nodeId: N, runtime: 'claude', model: 'haiku' });
  const rooms = new Rooms(db); rooms.touch = () => {};
  assert.throws(() => rooms.post(P, { clientMessageId: 'm1', text: '@Dev hello' }), /Dev[\s\S]*Not logged in/);
  assert.equal(db.list('tasks').length, 0);
  db.put('workers', worker({}));
  rooms.post(P, { clientMessageId: 'm2', text: '@Dev hello' });
  assert.equal(db.list('tasks').length, 1);
});
