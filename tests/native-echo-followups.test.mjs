// Resident Claude: every input waits for its own echo; tasks left by an earlier turn show on the turn they hold open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { applyNativeTurnEvent } from '../src/native-turns.mjs';
import { NativeCliSession } from '../src/native-turn-sessions.mjs';

const SID = '11111111-2222-4333-8444-555555555555';
function resident() {
  const out = [], sent = [];
  const session = new NativeCliSession({ cwd: tmpdir(), runtime: 'claude', keepAlive: true, resumeSessionId: SID, emit: (type, payload) => out.push({ type, payload }) });
  session.initialized = true; session.proc = { stdin: { write: (line, cb) => { sent.push(JSON.parse(line)); cb?.(); } } };
  const turn = prompt => { out.length = 0; session.done = false; session.sendTurn(prompt); return sent.at(-1).uuid; };
  const echo = uuid => session.receive({ type: 'user', isReplay: true, uuid, session_id: SID, parent_tool_use_id: null, message: { role: 'user', content: 'x' } });
  const say = text => { session.receive({ type: 'assistant', message: { content: [{ type: 'text', text }] }, session_id: SID }); session.receive({ type: 'result', subtype: 'success', result: text, session_id: SID }); };
  const sys = (subtype, rest) => session.receive({ type: 'system', subtype, session_id: SID, ...rest });
  return { session, out, turn, echo, say, sys };
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
  r.session.receive({ type: 'command_lifecycle', command_uuid: uuid, state: 'started', session_id: SID });
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
