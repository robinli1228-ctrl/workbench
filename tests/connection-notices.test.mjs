// A device link that drops while roles work there is told in the group chat after a minute, and its recovery once it is
// back, naming the roles whose wb requests were refused (they stopped instead of retrying). Nothing retries by itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { ConnectionNotices, OUTAGE_NOTICE_DELAY, RESTORE_SETTLE_DELAY } from '../src/connection-notices.mjs';

function setup() {
  const db = new Store(':memory:'), timers = [], online = new Set();
  db.put('projects', { id: 'p', name: 'p' });db.put('workers', { id: 'deb', name: 'Debian' });
  for (const [id, name] of [['c', 'Claude'], ['g', 'GPT']]) db.put('roles', { id, projectId: 'p', name });
  const notices = new ConnectionNotices({ db, online: id => online.has(id), schedule: (fn, ms) => { const t = { fn, ms, live: true };timers.push(t);return t; }, cancel: t => { if (t) t.live = false; } });
  const fire = ms => { for (const t of timers.filter(t => t.live && t.ms === ms)) { t.live = false;t.fn(); } };
  const notes = () => db.list('roomMessages').map(m => [m.kind, m.text, m.continueRoles || null]);
  return { db, notices, online, fire, notes };
}

test('a minute offline with a role working there, then back: one lost and one restored notice naming the stopped role', () => {
  const { db, notices, online, fire, notes } = setup();
  db.put('runs', { id: 'r1', projectId: 'p', roleId: 'c', nodeId: 'deb', status: 'reconciling', lastSeq: 0 });
  notices.disconnected('deb');fire(OUTAGE_NOTICE_DELAY);
  assert.deepEqual(notes().map(n => n[0]), ['connection_lost']);assert.match(notes()[0][1], /Debian.*Claude/);
  notices.disconnected('deb');fire(OUTAGE_NOTICE_DELAY);
  assert.equal(notes().length, 1, 'still one notice for the same outage');
  online.add('deb');notices.connected('deb');
  notices.stopped(db.get('runs', 'r1'));fire(RESTORE_SETTLE_DELAY);
  const restored = notes().filter(n => n[0] === 'connection_restored');
  assert.equal(restored.length, 1);assert.deepEqual(restored[0][2], ['Claude']);
  assert.equal(db.get('connectionOutages', 'deb'), null, 'the outage is closed');
});

test('a short blip says nothing; a refused request alone (Home itself was away) still gets a restored notice', () => {
  const { db, notices, online, fire, notes } = setup();
  db.put('runs', { id: 'r1', projectId: 'p', roleId: 'c', nodeId: 'deb', status: 'reconciling', lastSeq: 0 });
  notices.disconnected('deb');online.add('deb');notices.connected('deb');fire(OUTAGE_NOTICE_DELAY);fire(RESTORE_SETTLE_DELAY);
  assert.deepEqual(notes(), [], 'back within a minute and nothing refused: no notices');
  notices.stopped(db.get('runs', 'r1'));fire(RESTORE_SETTLE_DELAY);
  assert.deepEqual(notes().map(n => [n[0], n[2]]), [['connection_restored', ['Claude']]]);
});

test('the Store records the first refused request on the run', () => {
  const db = new Store(':memory:');db.put('runs', { id: 'r', projectId: 'p', status: 'running', lastSeq: 0 });
  db.event({ id: 'e1', runId: 'r', seq: 1, type: 'home_disconnected', payload: {}, createdAt: '2026-11-16T13:53:12.000Z' });
  db.event({ id: 'e2', runId: 'r', seq: 2, type: 'home_disconnected', payload: {}, createdAt: '2026-11-16T13:54:00.000Z' });
  assert.equal(db.get('runs', 'r').homeDisconnectedAt, '2026-11-16T13:53:12.000Z');
});

test('a replayed or late refusal for a run already named in a restored notice says nothing again', () => {
  const { db, notices, online, fire, notes } = setup();
  db.put('runs', { id: 'r1', projectId: 'p', roleId: 'c', nodeId: 'deb', status: 'succeeded', lastSeq: 0 });
  online.add('deb');notices.stopped(db.get('runs', 'r1'));fire(RESTORE_SETTLE_DELAY);
  assert.equal(notes().length, 1);assert.ok(db.get('runs', 'r1').connectionNoticedAt);
  notices.stopped(db.get('runs', 'r1'));fire(RESTORE_SETTLE_DELAY);
  assert.equal(notes().length, 1, 'no second notice');
});
