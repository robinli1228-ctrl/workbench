// Resident Claude: every input waits for its own echo; tasks left by an earlier turn show on the turn they hold open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { applyNativeTurnEvent, NativeTurnsHome } from '../src/native-turns.mjs';
import { Store } from '../src/store.mjs';
import { NativeCliSession } from '../src/native-turn-sessions.mjs';

const SID = '11111111-2222-4333-8444-555555555555';
function resident(control = null) {
  const out = [], sent = [];
  const session = new NativeCliSession({ cwd: tmpdir(), runtime: 'claude', keepAlive: true, resumeSessionId: SID, control, emit: (type, payload) => out.push({ type, payload }) });
  session.initialized = true; session.proc = { stdin: { writable: true, write: (line, cb) => { sent.push(JSON.parse(line)); cb?.(); } } };
  const turn = prompt => { out.length = 0; session.done = false; session.sendTurn(prompt); return sent.at(-1).uuid; };
  const echo = uuid => session.receive({ type: 'user', isReplay: true, uuid, session_id: SID, parent_tool_use_id: null, message: { role: 'user', content: 'x' } });
  const say = text => { session.receive({ type: 'assistant', message: { content: [{ type: 'text', text }] }, session_id: SID }); session.receive({ type: 'result', subtype: 'success', result: text, session_id: SID }); };
  const sys = (subtype, rest) => session.receive({ type: 'system', subtype, session_id: SID, ...rest });
  const lc = (uuid, state) => session.receive({ type: 'command_lifecycle', command_uuid: uuid, state, session_id: SID });
  const ended = () => out.filter(e => e.type === 'status' && ['succeeded', 'failed', 'interrupted'].includes(e.payload.status)).map(e => e.payload.status);
  const delivery = () => out.filter(e => e.type === 'status' && e.payload.inputDeliveryState).map(e => e.payload.inputDeliveryState);
  return { session, out, sent, turn, echo, say, sys, lc, ended, delivery };
}

test('a message that starts with a path waits for its own echo; output before it is not its reply', () => {
  const r = resident();
  const uuid = r.turn('/srv/app/x.log why does this fail?');
  assert.ok(uuid, 'a path-led message is sent with an echo id');
  r.say('NOTICE');
  assert.equal(r.session.done, false, "a background notice's result does not end this turn");
  r.echo(uuid); r.say('the log says why');
  assert.equal(r.session.done, true);
  assert.match(r.out.filter(e => e.type === 'status').map(e => e.payload.inputDeliveryState).join(','), /accepted/);
});

test('a slash command also waits for its echo, or for its own started receipt when a build gives no echo', () => {
  const r = resident();
  let uuid = r.turn('/compact');
  r.say('NOTICE');
  assert.equal(r.session.done, false);
  r.echo(uuid); r.say('');
  assert.equal(r.session.done, true);
  uuid = r.turn('/model haiku');
  r.session.receive({ type: 'command_lifecycle', command_uuid: 'other', state: 'started', session_id: SID });
  r.say('NOTICE');
  assert.equal(r.session.done, false, "another command's start is not this input's");
  r.sys('task_started', { task_id: 'q1', task_type: 'local_agent', description: 'Queued work' });
  r.sys('background_tasks_changed', { tasks: [{ task_id: 'q1' }] });
  r.session.receive({ type: 'command_lifecycle', command_uuid: uuid, state: 'started', session_id: SID });
  assert.deepEqual(r.out.filter(e => e.type === 'task').map(e => [e.payload.id, e.payload.earlier]), [['q1', true]], 'started via its receipt, it lists what holds it open too');
  r.sys('task_notification', { task_id: 'q1', status: 'completed' }); r.sys('background_tasks_changed', { tasks: [] });
  r.say('Set model');
  assert.equal(r.session.done, true);
  // A plain prompt is never settled by the started receipt alone: its own echo marks where its reply starts.
  uuid = r.turn('hello');
  r.session.receive({ type: 'command_lifecycle', command_uuid: uuid, state: 'started', session_id: SID });
  r.say('NOTICE');
  assert.equal(r.session.done, false);
});

test('a task an earlier turn left running is listed on the next turn it holds open, with its real age, and its end shows there', () => {
  const r = resident();
  const first = r.turn('start the dev server');
  r.echo(first);
  r.sys('task_started', { task_id: 'b1', task_type: 'local_bash', description: 'npm run dev' });
  r.sys('background_tasks_changed', { tasks: [{ task_id: 'b1' }] });
  r.session.done = true; // the turn was stopped; the dev server keeps running in the process
  const second = r.turn('now check the page');
  const carried = r.out.filter(e => e.type === 'task').map(e => e.payload);
  assert.deepEqual(carried.map(x => [x.id, x.status, x.kind, x.description, x.earlier]), [['b1', 'running', 'shell', 'npm run dev', true]]);
  assert.ok(carried[0].elapsedMs >= 0);
  // Its end may come before this turn's echo; it is this turn's row, so it still reports.
  r.sys('task_notification', { task_id: 'b1', status: 'completed' });
  assert.deepEqual(r.out.filter(e => e.type === 'task').map(e => [e.payload.id, e.payload.status]), [['b1', 'running'], ['b1', 'completed']]);
  let turn = { id: 't', status: 'running', events: [] };
  turn = applyNativeTurnEvent(turn, { kind: 'task', task: { ...carried[0], elapsedMs: 90000 } });
  assert.equal(turn.tasks[0].earlier, true);
  assert.ok(Date.now() - Date.parse(turn.tasks[0].startedAt) >= 89000, 'its time counts from when it really started');
  r.sys('background_tasks_changed', { tasks: [] });
  r.echo(second); r.say('ok');
  r.turn('third');
  assert.equal(r.out.filter(e => e.type === 'task').length, 0, 'a finished task is not carried again');
});

test('past 20 tasks the oldest finished rows leave first; a running one stays', () => {
  let turn = { id: 't', status: 'running', events: [] };
  turn = applyNativeTurnEvent(turn, { kind: 'task', task: { id: 'long', status: 'running', kind: 'agent' } });
  for (let i = 0; i < 25; i += 1) {
    turn = applyNativeTurnEvent(turn, { kind: 'task', task: { id: `s${i}`, status: 'running', kind: 'shell' } });
    turn = applyNativeTurnEvent(turn, { kind: 'task', task: { id: `s${i}`, status: 'completed' } });
  }
  assert.equal(turn.tasks.length, 20);
  assert.equal(turn.tasks[0].id, 'long');
  assert.equal(turn.tasks[0].status, 'running');
  assert.equal(turn.tasks.at(-1).id, 's24');
});

test('a stop before the echo withdraws only this input; the notice turn Claude is running goes on and its result is not this turn\'s', () => {
  const r = resident();
  const uuid = r.turn('hello');
  r.session.stop();
  const req = r.sent.at(-1);
  assert.deepEqual(req.request, { subtype: 'cancel_async_message', message_uuid: uuid }, 'no interrupt: the running notice turn is not ours');
  r.say('NOTICE');
  assert.equal(r.session.done, false, "the notice turn's result does not end the stop");
  r.session.receive({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response: { cancelled: true } } });
  r.lc(uuid, 'cancelled');
  assert.deepEqual(r.ended(), ['interrupted']);
  assert.deepEqual(r.delivery(), ['not_delivered']);
  assert.equal(r.out.find(e => e.payload?.inputDeliveryState)?.payload.inputRejection, undefined, 'a stop is not a rejection');
  assert.ok(!r.out.some(e => e.type === 'message' && /NOTICE/.test(e.payload.text || '')));
});

test('if Claude cannot withdraw the input, the stop falls back to interrupting the running turn', () => {
  const r = resident();
  r.turn('hello');
  r.session.stop();
  const req = r.sent.at(-1);
  r.session.receive({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response: { cancelled: false } } });
  assert.deepEqual(r.sent.at(-1).request, { subtype: 'interrupt' });
  r.say('aborted');
  assert.deepEqual(r.ended(), ['interrupted']);
  // The echo winning the race against the withdrawal also stops it as a running turn.
  const s = resident(), uuid = s.turn('again');
  s.session.stop(); s.echo(uuid);
  assert.deepEqual(s.sent.at(-1).request, { subtype: 'interrupt' });
  s.say('aborted');
  assert.deepEqual(s.ended(), ['interrupted']);
  assert.deepEqual(s.delivery(), ['accepted']);
  // Once Claude reported it started, the stop interrupts directly.
  const u = resident(), id = u.turn('third');
  u.lc(id, 'started'); u.session.stop();
  assert.deepEqual(u.sent.at(-1).request, { subtype: 'interrupt' });
});

test('an input Claude cancels before its echo, without a stop, ends undelivered as a per-input rejection; once started it counts as delivered', () => {
  const r = resident();
  const uuid = r.turn('hello');
  r.lc('other', 'cancelled');
  assert.deepEqual(r.ended(), []);
  r.lc(uuid, 'cancelled');
  assert.equal(r.session.done, true);
  assert.deepEqual(r.ended(), ['failed']);
  assert.equal(r.out.find(e => e.payload?.inputDeliveryState).payload.inputRejection, 'cancelled');
  let turn = { id: 't', runtime: 'claude', status: 'running', events: [] };
  turn = applyNativeTurnEvent(turn, { kind: 'status', inputDeliveryState: 'not_delivered', inputRejection: 'cancelled' });
  assert.equal(turn.inputRejection, 'cancelled', 'Home keeps it, so two in a row are not taken for a CLI that cannot start');
  const s = resident(), id = s.turn('hello');
  s.lc(id, 'started'); s.lc(id, 'cancelled');
  assert.deepEqual(s.ended(), ['failed']);
  assert.deepEqual(s.delivery(), ['accepted'], 'taken into a turn that was aborted: it reached the model');
});

test('a slash input whose build gives no echo ends on its own completed receipt', () => {
  const r = resident();
  const uuid = r.turn('/model haiku');
  r.say('NOTICE');
  assert.equal(r.session.done, false);
  r.lc(uuid, 'completed');
  assert.deepEqual(r.ended(), ['succeeded']);
});

test('tasks started while the input still waited (by the notice answered first) are listed once its echo arrives', () => {
  const r = resident();
  const uuid = r.turn('hello');
  r.sys('task_started', { task_id: 'a9', task_type: 'local_agent', description: 'Check the notice', subagent_type: 'general-purpose' });
  r.sys('background_tasks_changed', { tasks: [{ task_id: 'a9' }] });
  assert.equal(r.out.filter(e => e.type === 'task').length, 0, 'before the echo it is not yet this turn\'s');
  r.echo(uuid);
  const shown = r.out.filter(e => e.type === 'task').map(e => e.payload);
  assert.deepEqual(shown.map(x => [x.id, x.earlier, x.agentType]), [['a9', true, 'general-purpose']]);
  r.sys('task_notification', { task_id: 'a9', status: 'completed' });
  assert.equal(r.out.filter(e => e.type === 'task').at(-1).payload.status, 'completed');
});

test('a control turn ends with its own result, not held open or listed with tasks other turns left running', () => {
  const r = resident('model');
  r.sys('task_started', { task_id: 'b1', task_type: 'local_bash', description: 'npm run dev' });
  r.sys('background_tasks_changed', { tasks: [{ task_id: 'b1' }] });
  const uuid = r.turn('/model haiku');
  r.echo(uuid); r.say('Set model');
  assert.deepEqual(r.ended(), ['succeeded']);
  assert.equal(r.out.filter(e => e.type === 'task').length, 0);
  assert.equal(r.session.backgroundTasks.size, 1, 'the live list itself is kept for later turns');
});

test("a subagent's own background list does not replace the session's", () => {
  const r = resident();
  r.sys('background_tasks_changed', { tasks: [{ task_id: 'b1' }] });
  r.session.receive({ type: 'system', subtype: 'background_tasks_changed', tasks: [], parent_tool_use_id: 'toolu_1', session_id: SID });
  assert.equal(r.session.backgroundTasks.size, 1);
});

test('/clear and its aliases are refused for page input; Claude would continue in another session', t => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-native-clear-'));
  const db = new Store(join(dir, 'home.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const turns = new NativeTurnsHome({ db, send() {}, online: () => true, change() {}, assertIdle() {} });
  const worker = { id: 'n1', capabilities: { nativeTurns: 3 } };
  for (const text of ['/clear', ' /reset', '/new name']) assert.throws(() => turns.create('n1', worker, { runtime: 'claude', sessionId: SID, clientTurnId: `client-clear-${text.length}`, text }), /start a new session/);
  assert.doesNotThrow(() => turns.create('n1', worker, { runtime: 'claude', sessionId: SID, clientTurnId: 'client-clear-ok', text: '/newline handling question' }));
});

test('a reused resident Claude still hosts permission prompts: the turn control kind does not hide the permission host', () => {
  const r = resident();
  const uuid = r.turn('first'); r.echo(uuid); r.say('ok');
  r.session.proc.killed = false; r.session.proc.exitCode = null; r.session.proc.signalCode = null;
  r.session.reuse({ emit: (type, payload) => r.out.push({ type, payload }), control: null });
  r.session.sendTurn('second'); r.echo(r.sent.at(-1).uuid);
  r.session.receive({ type: 'control_request', request_id: 'perm-ask', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which?', options: [{ label: 'A' }] }] } } });
  assert.equal(r.out.filter(e => e.type === 'question').length, 1);
  r.session.answerQuestion({ id: 'perm-ask', skip: true }); r.say('done');
  r.session.reuse({ emit: () => {}, control: 'model' });
  assert.equal(r.session.controlTurn, 'model');
  assert.equal(typeof r.session.control, 'function');
});

test("a one-shot Claude keeps the base class's background list (the control-turn override applies only to control results)", () => {
  const session = new NativeCliSession({ cwd: tmpdir(), runtime: 'claude', keepAlive: false, resumeSessionId: SID, emit() {} });
  session.receive({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1' }], session_id: SID });
  assert.equal(session.backgroundTasks.size, 1);
});

test('a control turn is exactly its own command; it cannot carry /clear or another command', t => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-native-control-'));
  const db = new Store(join(dir, 'home.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const turns = new NativeTurnsHome({ db, send() {}, online: () => true, change() {}, assertIdle() {} });
  const worker = { id: 'n1', capabilities: { nativeTurns: 3 } }, body = (n, control, text) => ({ runtime: 'claude', sessionId: SID, clientTurnId: `client-ctl-${n}`, control, text });
  for (const [n, control, text] of [[1, 'model', '/clear'], [2, 'model', '/model x\n/clear'], [3, 'effort', '/model high'], [4, 'model', '/model']]) assert.throws(() => turns.create('n1', worker, body(n, control, text)), /Invalid control message/);
  assert.doesNotThrow(() => turns.create('n1', worker, body(5, 'model', '/model haiku')));
  assert.equal(turns.create('n1', worker, body(6, 'compact', '/clear')).prompt, '/compact', 'a compaction always sends /compact');
});
