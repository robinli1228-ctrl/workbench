// Steer on Claude and Codex adds the queued message to the reply that is running instead of interrupting it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { NativeTurnsHome, NativeTurnRunner } from '../src/native-turns.mjs';
import { Store } from '../src/store.mjs';
import { NativeCliSession, NativeCodexSession } from '../src/native-turn-sessions.mjs';
import { historyMessages } from '../src/native-sessions.mjs';

const SID = '00000000-1111-4222-8333-444444444444';
const tick = () => new Promise(resolve => setImmediate(resolve));

function home({ runtime = 'claude', capable = true } = {}) {
  const db = new Store(':memory:'), sent = [];
  db.put('workers', { id: 'n1', capabilities: { nativeTurns: 3, ...(capable ? { nativeSupplement: 1 } : {}) } });
  const turns = new NativeTurnsHome({ db, send: (nodeId, m) => sent.push({ nodeId, ...m }), online: () => true, change() {}, assertIdle() {}, attachments: { resolve: () => [] } });
  const worker = { capabilities: { nativeTurns: 3 } };
  const send = (clientTurnId, text) => turns.create('n1', worker, { runtime, sessionId: SID, clientTurnId, text });
  const event = (id, event) => turns.receive('n1', { type: 'native_turn_event', id, event });
  const starts = () => sent.filter(m => m.type === 'native_turn').map(m => m.prompt);
  return { db, sent, turns, send, event, starts };
}

for (const runtime of ['claude', 'codex']) test(`${runtime}: steer adds the message to the running reply; it leaves the queue and shows inside that reply`, async () => {
  const { db, sent, turns, send, event, starts } = home({ runtime });
  const a = send('client-turn-a', 'first'), b = send('client-turn-b', 'extra facts');
  event(a.id, { kind: 'status', status: 'running' });
  const steered = turns.steer('n1', b.id);
  assert.equal(steered.status, 'waiting'); assert.equal(steered.supplementing, true);
  assert.ok(!sent.some(m => m.type === 'native_turn_stop'), 'the running reply is not interrupted');
  const added = sent.find(m => m.type === 'native_turn_supplement');
  assert.deepEqual([added.id, added.supplementId, added.prompt], [a.id, b.id, 'extra facts']);
  assert.throws(() => turns.withdraw('n1', b.id), /being added/);
  assert.equal(turns.steer('n1', b.id).supplementing, true, 'a second press sends nothing more');
  assert.equal(sent.filter(m => m.type === 'native_turn_supplement').length, 1);
  event(a.id, { kind: 'supplement', supplementId: b.id });
  assert.equal(db.get('nativeTurns', b.id).status, 'merged');
  assert.deepEqual(db.get('nativeTurns', a.id).events.filter(e => e.type === 'supplement').map(e => e.payload.text), ['extra facts']);
  event(a.id, { kind: 'status', status: 'succeeded' }); await tick();
  assert.deepEqual(starts(), ['first'], 'the merged message is not sent again');
});

test('a message the CLI could not take stays first in line and starts when the reply ends, still without interrupting', async () => {
  const { db, sent, turns, send, event, starts } = home();
  const a = send('client-turn-a', 'first'), b = send('client-turn-b', 'second'), c = send('client-turn-c', 'third');
  event(a.id, { kind: 'status', status: 'running' });
  turns.steer('n1', c.id);
  event(a.id, { kind: 'supplement_failed', supplementId: c.id, error: 'Claude refused this message' });
  const back = db.get('nativeTurns', c.id);
  assert.equal(back.status, 'waiting'); assert.equal(back.steer, true); assert.equal(back.supplementOf, undefined);
  assert.ok(!sent.some(m => m.type === 'native_turn_stop'));
  event(a.id, { kind: 'status', status: 'succeeded' }); await tick();
  assert.deepEqual(starts(), ['first', 'third']);
  assert.equal(db.get('nativeTurns', b.id).status, 'waiting');
});

test('without a running reply or a capable Worker, steer only puts the message first; a stopped reply sends it as its own turn', async () => {
  let h = home({ capable: false });
  let a = h.send('client-turn-a', 'first'), b = h.send('client-turn-b', 'second');
  h.event(a.id, { kind: 'status', status: 'running' });
  h.turns.steer('n1', b.id);
  assert.ok(!h.sent.some(m => ['native_turn_supplement', 'native_turn_stop'].includes(m.type)));
  h = home();
  a = h.send('client-turn-a', 'first'); b = h.send('client-turn-b', 'second');
  h.event(a.id, { kind: 'status', status: 'running' });
  h.turns.steer('n1', b.id);
  h.turns.stop('n1', a.id);
  h.event(a.id, { kind: 'status', status: 'interrupted' }); await tick();
  assert.deepEqual(h.starts(), ['first', 'second']);
  assert.equal(h.db.get('nativeTurns', b.id).supplementOf, undefined, 'started as its own turn');
  h.event(a.id, { kind: 'supplement', supplementId: b.id });
  assert.notEqual(h.db.get('nativeTurns', b.id).status, 'merged', 'a late answer cannot merge a message that already started');
});

function resident() {
  const out = [], sent = [];
  const session = new NativeCliSession({ cwd: tmpdir(), runtime: 'claude', keepAlive: true, resumeSessionId: SID, emit: (type, payload) => out.push({ type, payload }) });
  session.initialized = true; session.proc = { stdin: { writable: true, write: (line, cb) => { sent.push(JSON.parse(line)); cb?.(); } } };
  const echo = uuid => session.receive({ type: 'user', isReplay: true, uuid, session_id: SID, parent_tool_use_id: null, message: { role: 'user', content: 'x' } });
  const say = text => { session.receive({ type: 'assistant', message: { content: [{ type: 'text', text }] }, session_id: SID }); session.receive({ type: 'result', subtype: 'success', result: text, session_id: SID }); };
  const of = type => out.filter(e => e.type === type).map(e => e.payload);
  const ended = () => of('status').filter(p => ['succeeded', 'failed', 'interrupted'].includes(p.status)).map(p => p.status);
  session.sendTurn('first'); echo(sent.at(-1).uuid);
  return { session, out, sent, echo, say, of, ended };
}

test('Claude: the added message goes to its input at once; a result before Claude reads it does not end the turn', () => {
  const r = resident();
  r.session.supplement({ id: 'q1', prompt: 'extra', images: [] });
  const written = r.sent.at(-1);
  assert.equal(written.type, 'user'); assert.equal(written.message.content, 'extra'); assert.ok(written.uuid);
  r.say('done before reading it');
  assert.equal(r.session.done, false, 'Claude answers the added message next, within this turn');
  r.echo(written.uuid);
  assert.deepEqual(r.of('supplement'), [{ id: 'q1' }]);
  r.say('answer with the extra facts');
  assert.deepEqual(r.ended(), ['succeeded']);
  assert.equal(r.of('message').filter(m => m.phase === 'final_answer').at(-1).text, 'answer with the extra facts');
});

test('Claude: a refused added message is reported, and a reply that waited only for it ends; a stop withdraws it', () => {
  let r = resident();
  r.session.supplement({ id: 'q1', prompt: 'extra', images: [] });
  const uuid = r.sent.at(-1).uuid;
  r.say('finished');
  r.session.receive({ type: 'command_lifecycle', command_uuid: uuid, state: 'refused', session_id: SID });
  assert.equal(r.of('supplement_failed')[0].id, 'q1');
  assert.deepEqual(r.ended(), ['succeeded']);
  r = resident();
  r.session.supplement({ id: 'q2', prompt: 'extra', images: [] });
  const queued = r.sent.at(-1).uuid;
  r.say('finished');
  void r.session.stop();
  assert.ok(r.sent.some(m => m.type === 'control_request' && m.request.subtype === 'cancel_async_message' && m.request.message_uuid === queued));
  assert.deepEqual(r.ended(), ['interrupted']);
  // A finished turn or one still waiting for its own input does not take a message.
  r.session.supplement({ id: 'q3', prompt: 'late', images: [] });
  assert.equal(r.of('supplement_failed').at(-1).id, 'q3');
});

test('Codex: the added message goes through turn/steer on the running turn', async () => {
  const out = [], requests = [];
  const session = new NativeCodexSession({ cwd: tmpdir(), keepAlive: true, resumeSessionId: SID, emit: (type, payload) => out.push({ type, payload }) });
  session.threadId = SID; session.turnId = 'turn-1'; session.done = false;
  session.request = async (method, params) => { requests.push({ method, params }); if (params.input[0].text === 'bad') throw Error('no active turn'); return { turnId: 'turn-1' }; };
  session.supplement({ id: 'q1', prompt: 'extra', files: [{ mime: 'image/png', path: '/tmp/x.png' }, { mime: 'text/plain', path: '/tmp/y.txt' }] });
  session.supplement({ id: 'q2', prompt: 'bad', files: [] });
  await tick();
  assert.deepEqual(requests[0], { method: 'turn/steer', params: { threadId: SID, expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'extra' }, { type: 'localImage', path: '/tmp/x.png' }] } });
  assert.deepEqual(out.map(e => [e.type, e.payload.id]), [['supplement', 'q1'], ['supplement_failed', 'q2']]);
});

test('Worker: a supplement for a reply that already ended answers at once that it was not taken', async () => {
  const posted = [];
  const runner = new NativeTurnRunner({ send: m => posted.push(m), createSession() {}, resolveSession() {}, canStart() {} });
  await runner.supplement({ id: 'turn-x', supplementId: '00000000-1111-4222-8333-555555555555', prompt: 'extra', attachments: [] });
  assert.equal(posted[0].event.kind, 'supplement_failed');
});

test('Claude history shows a message read mid-turn (a queued command) as the user message', () => {
  const rows = [{ type: 'attachment', timestamp: 't1', attachment: { type: 'queued_command', prompt: 'extra facts', commandMode: 'prompt' } },
    { type: 'attachment', timestamp: 't2', attachment: { type: 'queued_command', prompt: '<task-notification>', commandMode: 'task-notification' } }];
  assert.deepEqual(historyMessages(rows, 'claude').map(m => [m.role, m.text]), [['user', 'extra facts']]);
});
