// A Sessions-page message the device turns away because all its CLI slots are in use waits at the front of its session's
// queue with that reason and starts by itself once the device reports a free slot (or after the fallback interval).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeTurnsHome, NativeTurnRunner, NATIVE_CAPACITY_RETRY_MS, nativeTurnView } from '../src/native-turns.mjs';
import { Store } from '../src/store.mjs';
import { assertNativeSessionIdle } from '../src/native-sessions.mjs';

const SID = '00000000-1111-4222-8333-444444444444';
const full = () => { throw Object.assign(Error('Device CLI capacity is full'), { code: 'capacity_full' }); };

test('the Worker hands a turn back for a full device when Home can wait, and fails it for an older Home', async () => {
  for (const [deferCapacity, expected] of [[true, 'deferred'], [undefined, 'failed']]) {
    const events = [];
    const runner = new NativeTurnRunner({ send: m => events.push(m), canStart: full, resolveSession: async () => assert.fail('must not resolve'), createSession: () => assert.fail('must not start') });
    await runner.start({ id: 't1', runtime: 'claude', sessionId: SID, prompt: 'p', ...(deferCapacity ? { deferCapacity } : {}) });
    const last = events.filter(e => e.event).at(-1).event;
    assert.equal(last.status, expected);assert.match(last.error, /capacity is full/);
    assert.equal(runner.size, 0);
  }
});

test('Home keeps a deferred turn first in the queue and sends it again only after a fresh report with a free slot', t => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-native-capacity-')), db = new Store(join(dir, 'home.sqlite')), sent = [];
  t.after(() => { db.close();rmSync(dir, { recursive: true, force: true }); });
  db.put('workers', { id: 'n1', capabilities: { nativeTurns: 3 }, capacity: 3, cliUsage: { active: 2, organizer: 0, terminal: 0 }, capacityReportedAt: new Date(Date.now() - 60000).toISOString() });
  const turns = new NativeTurnsHome({ db, send: (nodeId, payload) => sent.push(payload), online: () => true, change() {}, assertIdle: input => assertNativeSessionIdle(db, { ...input, workspace: null, projectId: null }) });
  const worker = db.get('workers', 'n1');
  const first = turns.create('n1', worker, { runtime: 'claude', sessionId: SID, clientTurnId: 'client-000001', text: 'pull the latest code' });
  assert.equal(sent.length, 1);assert.equal(sent[0].deferCapacity, true);
  const later = turns.create('n1', worker, { runtime: 'claude', sessionId: SID, clientTurnId: 'client-000002', text: 'then run the tests' });
  assert.equal(later.status, 'waiting');
  turns.receive('n1', { type: 'native_turn_event', id: first.id, event: { kind: 'status', status: 'deferred', error: 'Device CLI capacity is full' } });
  const back = db.get('nativeTurns', first.id);
  assert.equal(back.status, 'waiting');assert.equal(back.waitingReason, 'device_capacity');assert.equal(back.error, undefined, 'not a failure');
  assert.deepEqual(turns.waiting('n1', 'claude', SID).map(x => x.id), [first.id, later.id], 'it keeps its place before the later message');
  assert.equal(nativeTurnView(back).waitingReason, 'device_capacity', 'the page shows why it waits');
  // A report from before the refusal, or a fresh one still full, does not send it again.
  turns.capacityChanged('n1');assert.equal(sent.length, 1);
  db.put('workers', { ...db.get('workers', 'n1'), cliUsage: { active: 3, organizer: 0, terminal: 0 }, capacityReportedAt: new Date(Date.now() + 1000).toISOString() });
  turns.capacityChanged('n1');assert.equal(sent.length, 1);
  // A fresh report with a slot: it goes out first, its reason cleared.
  db.put('workers', { ...db.get('workers', 'n1'), cliUsage: { active: 2, organizer: 0, terminal: 0 }, capacityReportedAt: new Date(Date.now() + 2000).toISOString() });
  assert.equal(turns.capacityChanged('n1'), 1);
  return new Promise(resolve => setImmediate(() => {
    assert.equal(sent.length, 2);assert.equal(sent[1].id, first.id);
    const out = db.get('nativeTurns', first.id);assert.equal(out.status, 'queued');assert.equal(out.waitingReason, null);
    assert.equal(db.get('nativeTurns', later.id).status, 'waiting', 'the later message still waits for this reply');
    resolve();
  }));
});

test('without any report a deferred turn is tried again after the fallback interval', t => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-native-capacity-')), db = new Store(join(dir, 'home.sqlite'));
  t.after(() => { db.close();rmSync(dir, { recursive: true, force: true }); });
  const turns = new NativeTurnsHome({ db, send() {}, online: () => true, change() {} });
  db.put('workers', { id: 'n1' });
  const turn = { deferredAt: new Date().toISOString() };
  assert.equal(turns.slotFree('n1', turn), false);
  assert.equal(turns.slotFree('n1', { deferredAt: new Date(Date.now() - NATIVE_CAPACITY_RETRY_MS - 1).toISOString() }), true);
});
