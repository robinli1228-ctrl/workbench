// Messages sent while a taken-over session is replying wait in Home's queue; the next starts when the reply ends, steer interrupts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = name => import(pathToFileURL(join(root, 'src', name)).href);
const { NativeTurnsHome } = await load('native-turns.mjs');
const { Store } = await load('store.mjs');
const SID = '00000000-1111-4222-8333-444444444444';
const tick = () => new Promise(resolve => setImmediate(resolve));

function home({ online = () => true } = {}) {
  const db = new Store(':memory:'), sent = [], credentials = [];
  const turns = new NativeTurnsHome({ db, send: (nodeId, m) => sent.push({ nodeId, ...m }), online, change() {}, assertIdle() {}, attachments: { resolve: () => [] }, gitCredential: async () => { credentials.push(1); return 'token'; } });
  const worker = { capabilities: { nativeTurns: 3 } };
  const send = (clientTurnId, text) => turns.create('n1', worker, { runtime: 'claude', sessionId: SID, clientTurnId, text });
  const status = (id, status) => turns.receive('n1', { type: 'native_turn_event', id, event: { kind: 'status', status } });
  const starts = () => sent.filter(m => m.type === 'native_turn').map(m => m.prompt);
  return { db, sent, turns, send, status, starts, credentials };
}

test('a message sent during a reply waits, then starts by itself when the reply ends, with a fresh Git credential', async () => {
  const { db, turns, send, status, starts, credentials } = home();
  const a = send('client-turn-a', 'first');
  const b = send('client-turn-b', 'second'), c = send('client-turn-c', 'third');
  assert.equal(a.status, 'queued'); assert.equal(b.status, 'waiting'); assert.equal(c.status, 'waiting');
  assert.deepEqual(starts(), ['first']);
  assert.deepEqual(turns.list('n1', 'claude', SID).map(t => t.status), ['queued', 'waiting', 'waiting']);
  status(a.id, 'running'); await tick();
  assert.deepEqual(starts(), ['first'], 'nothing starts while the reply is still running');
  status(a.id, 'succeeded'); await tick();
  assert.deepEqual(starts(), ['first', 'second']);
  assert.equal(db.get('nativeTurns', b.id).status, 'queued'); assert.equal(db.get('nativeTurns', c.id).status, 'waiting');
  assert.equal(credentials.length, 1, 'the credential is resolved at dispatch, not stored with the queue');
  status(b.id, 'failed'); await tick();
  assert.deepEqual(starts(), ['first', 'second', 'third']);
});

test('steer puts a queued message first and interrupts the current reply; cancel withdraws it without touching the Worker', async () => {
  const { db, sent, turns, send, status, starts } = home();
  const a = send('client-turn-a', 'first'), b = send('client-turn-b', 'second'), c = send('client-turn-c', 'third');
  const steered = turns.steer('n1', c.id);
  assert.equal(steered.steer, true); assert.equal(steered.status, 'waiting');
  assert.equal(db.get('nativeTurns', a.id).status, 'stopping');
  assert.ok(sent.some(m => m.type === 'native_turn_stop' && m.id === a.id));
  const cancelled = turns.stop('n1', b.id);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(sent.filter(m => m.type === 'native_turn_stop').length, 1);
  status(a.id, 'interrupted'); await tick();
  assert.deepEqual(starts(), ['first', 'third']);
  assert.equal(turns.list('n1', 'claude', SID).find(t => t.id === b.id).status, 'cancelled');
});

test('ending the takeover or losing the device drops queued messages instead of sending them later', async () => {
  const { db, turns, send } = home();
  const a = send('client-turn-a', 'first'), b = send('client-turn-b', 'second');
  turns.release('n1', { runtime: 'claude', sessionId: SID });
  assert.equal(db.get('nativeTurns', b.id).status, 'cancelled'); assert.match(db.get('nativeTurns', b.id).error, /Takeover ended/);
  const again = send('client-turn-c', 'third');
  assert.equal(again.status, 'waiting', 'the first turn is still active until the Worker reports');
  turns.disconnected('n1');
  assert.equal(db.get('nativeTurns', again.id).status, 'cancelled');
  assert.equal(db.get('nativeTurns', a.id).status, 'interrupted');
});

test('a paused queue holds its messages after the reply ends; steer still sends one, resume sends the rest', async () => {
  const { turns, send, status, starts } = home();
  const a = send('client-turn-a', 'first'), b = send('client-turn-b', 'second'), c = send('client-turn-c', 'third');
  assert.equal(turns.setQueue('n1', { runtime: 'claude', sessionId: SID, paused: true }).queue.paused, true);
  status(a.id, 'succeeded'); await tick();
  assert.deepEqual(starts(), ['first'], 'nothing leaves a paused queue when the reply ends');
  const d = send('client-turn-d', 'fourth');
  assert.equal(d.status, 'waiting', 'a new message joins the paused queue even though the session is idle');
  turns.steer('n1', c.id); await tick();
  assert.deepEqual(starts(), ['first', 'third'], 'steering is an explicit send');
  status(c.id, 'succeeded'); await tick();
  assert.deepEqual(starts(), ['first', 'third'], 'the queue stays paused after the steered message');
  turns.setQueue('n1', { runtime: 'claude', sessionId: SID, paused: false }); await tick();
  assert.deepEqual(starts(), ['first', 'third', 'second']);
  status(b.id, 'succeeded'); await tick();
  assert.deepEqual(starts(), ['first', 'third', 'second', 'fourth']);
});

test('an emptied queue un-pauses itself, so a later message is not held by a pause nobody can see', async () => {
  const { turns, send, status, starts } = home();
  const a = send('client-turn-a', 'first'), b = send('client-turn-b', 'second');
  turns.setQueue('n1', { runtime: 'claude', sessionId: SID, paused: true });
  turns.withdraw('n1', b.id);
  assert.equal(turns.queueState('n1', 'claude', SID).paused, false);
  status(a.id, 'succeeded'); await tick();
  assert.equal(send('client-turn-c', 'third').status, 'queued');
  assert.deepEqual(starts(), ['first', 'third']);
  assert.equal(turns.setQueue('n1', { runtime: 'claude', sessionId: SID, paused: true }).queue.paused, false, 'an empty queue cannot be paused');
});

test('the dragged order decides what goes next; a stale order is rejected', async () => {
  const { turns, send, status, starts } = home();
  const a = send('client-turn-a', 'first'), b = send('client-turn-b', 'second'), c = send('client-turn-c', 'third'), d = send('client-turn-d', 'fourth');
  assert.throws(() => turns.setQueue('n1', { runtime: 'claude', sessionId: SID, order: [d.id, b.id] }), /queue changed/);
  const result = turns.setQueue('n1', { runtime: 'claude', sessionId: SID, order: [d.id, b.id, c.id] });
  assert.deepEqual(result.items.map(t => t.prompt), ['fourth', 'second', 'third']);
  const e = send('client-turn-e', 'fifth');
  assert.deepEqual(turns.waiting('n1', 'claude', SID).map(t => t.prompt), ['fourth', 'second', 'third', 'fifth'], 'a later message joins at the end');
  status(a.id, 'succeeded'); await tick();
  assert.deepEqual(starts(), ['first', 'fourth']);
  assert.ok(Number.isFinite(turns.list('n1', 'claude', SID).find(t => t.id === b.id).queueRank));
  void e;
});

test('withdraw (delete or edit) only takes a message that is still waiting, and marks it as the user\'s own removal', async () => {
  const { db, sent, turns, send, status } = home();
  const a = send('client-turn-a', 'first'), b = send('client-turn-b', 'second');
  const gone = turns.withdraw('n1', b.id);
  assert.equal(gone.status, 'cancelled'); assert.equal(gone.withdrawn, true);
  assert.throws(() => turns.withdraw('n1', a.id), /already been sent/);
  assert.equal(db.get('nativeTurns', a.id).status, 'queued', 'a message that already left the queue is never interrupted by withdraw');
  assert.equal(sent.filter(m => m.type === 'native_turn_stop').length, 0);
  assert.equal(turns.stop('n1', send('client-turn-c', 'third').id).withdrawn, true, 'the queue\'s own delete is a withdrawal too');
  status(a.id, 'succeeded'); await tick();
});

test('the CLI process going away keeps the queue: a failed turn, an idle exit and a paused queue all survive; only ending the takeover drops it', async () => {
  const { db, turns, send, status, starts } = home();
  const a = send('client-turn-a', 'first'), b = send('client-turn-b', 'second');
  status(a.id, 'failed'); await tick();
  assert.deepEqual(starts(), ['first', 'second'], 'a failed reply does not drop the next message');
  const c = send('client-turn-c', 'third');
  turns.setQueue('n1', { runtime: 'claude', sessionId: SID, paused: true });
  status(b.id, 'succeeded'); await tick();
  assert.deepEqual(starts(), ['first', 'second'], 'paused: nothing starts');
  // The resident CLI idles out while the queue is paused.
  turns.receive('n1', { type: 'native_takeover_closed', runtime: 'claude', sessionId: SID, reason: 'idle' }); await tick();
  assert.equal(db.get('nativeTurns', c.id).status, 'waiting', 'an idle exit leaves the paused message in the queue');
  assert.equal(turns.queueState('n1', 'claude', SID).paused, true);
  turns.setQueue('n1', { runtime: 'claude', sessionId: SID, paused: false }); await tick();
  assert.deepEqual(starts(), ['first', 'second', 'third'], 'resuming starts a fresh process for the kept message');
  const d = send('client-turn-d', 'fourth');
  turns.release('n1', { runtime: 'claude', sessionId: SID });
  assert.equal(db.get('nativeTurns', d.id).status, 'cancelled'); assert.match(db.get('nativeTurns', d.id).error, /Takeover ended/);
});
