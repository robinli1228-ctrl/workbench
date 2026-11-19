// A resident Claude turn that leaves background tasks running is not over: the Run stays active until they finish.
// Event shapes follow a stream recorded from Claude Code 2.1.303 (Agent tool with run_in_background).
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = name => import(pathToFileURL(join(root, 'src', name)).href);
const { CliPrintSession } = await load('cli-print-session.mjs');
const { WarmSessions } = await load('warm-sessions.mjs');

const SID = '163d8877-79eb-45b4-bd10-5ba6466a2ca5';
const task = { task_id: 'a6e1055d1cbd255bd', task_type: 'local_agent', description: 'Run review' };
const init = { type: 'system', subtype: 'init', session_id: SID };
const tasks = list => ({ type: 'system', subtype: 'background_tasks_changed', tasks: list, session_id: SID });
const reply = text => ({ type: 'assistant', session_id: SID, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const result = (text, extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: SID, ...extra });

function residentSession() {
  const events = [];
  const session = new CliPrintSession({ cwd: '/tmp', runtime: 'claude', model: 'm', keepAlive: true, emit: (type, p) => events.push({ type, ...p }) });
  const statuses = () => events.filter(e => e.type === 'status' && e.status && e.status !== 'running').map(e => e.status);
  const finals = () => events.filter(e => e.type === 'message' && e.phase === 'final_answer').map(e => e.text);
  return { session, events, statuses, finals };
}

test('a reply that leaves background tasks running keeps the Run active until the summary turn ends it', () => {
  const { session, statuses, finals } = residentSession();
  for (const m of [init, tasks([task]), reply('launched, will summarize later'), result('launched, will summarize later')]) session.receive(m);
  assert.equal(session.done, false);
  assert.deepEqual(statuses(), []);
  // Subagent output and the task list change keep arriving after the first result.
  session.receive({ type: 'assistant', session_id: SID, parent_tool_use_id: 'toolu_1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: {} }] } });
  for (const m of [{ type: 'system', subtype: 'task_notification', task_id: task.task_id, status: 'completed', session_id: SID }, tasks([]), init,
    { type: 'system', subtype: 'status', status: 'requesting', session_id: SID }, reply('All reviews done: bg-done'),
    result('All reviews done: bg-done', { origin: { kind: 'task-notification', producer: 'session-task' } })]) session.receive(m);
  assert.equal(session.done, true);
  assert.deepEqual(statuses(), ['succeeded']);
  assert.deepEqual(finals(), ['All reviews done: bg-done']);
});

test('a result with no background tasks still ends the resident turn at once', () => {
  const { session, statuses, finals } = residentSession();
  for (const m of [init, tasks([]), reply('done'), result('done')]) session.receive(m);
  assert.equal(session.done, true);
  assert.deepEqual(statuses(), ['succeeded']);
  assert.deepEqual(finals(), ['done']);
});

test('a nested background task still running after the summary turn keeps the Run active', () => {
  const { session, statuses } = residentSession();
  const nested = { task_id: 'bwvj5hgpb', task_type: 'local_bash', parent_task_id: task.task_id };
  for (const m of [init, tasks([task]), result('launched'), tasks([nested]), init, result('agent finished, shell still running')]) session.receive(m);
  assert.equal(session.done, false);
  assert.deepEqual(statuses(), []);
});

test('when the last task ends without a summary turn, the Run keeps waiting for its owner result', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, statuses, finals } = residentSession();
  for (const m of [init, tasks([task]), result('launched, will summarize later'), tasks([])]) session.receive(m);
  t.mock.timers.tick(14999);
  assert.equal(session.done, false);
  t.mock.timers.tick(1);
  assert.equal(session.done, false);
  assert.deepEqual(statuses(), []);
  assert.deepEqual(finals(), []);
  session.receive(result('owner summary'));
  assert.deepEqual(statuses(), ['succeeded']);
  assert.deepEqual(finals(), ['owner summary']);
});

test('a summary turn that starts within the grace period is waited for, not cut short', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, statuses, finals } = residentSession();
  for (const m of [init, tasks([task]), result('launched'), tasks([]), init]) session.receive(m);
  t.mock.timers.tick(60000);
  assert.equal(session.done, false);
  session.receive(result('summary'));
  assert.deepEqual(statuses(), ['succeeded']);
  assert.deepEqual(finals(), ['summary']);
});

test('idle warm processes are kept for 15 minutes by default', () => {
  assert.equal(new WarmSessions().idleMs, 15 * 60 * 1000);
});

test('a resident turn counts only output after its own echo: a reply to a notice queued first does not end it', () => {
  const { session, events, statuses, finals } = residentSession();
  const written = [];
  session.proc = { stdin: { write: (line, done) => { written.push(JSON.parse(line)); done?.(); } } };
  session.sendTurn('the user question');
  const sent = written.at(-1), accepted = () => events.filter(e => e.type === 'status' && e.inputDeliveryState === 'accepted').length;
  assert.ok(sent.uuid, 'the input carries its own uuid');
  assert.equal(accepted(), 0, 'delivery is confirmed by the echo, not the write');
  // After a restart Claude first answers the notice of a background command the old process left.
  for (const m of [init, { type: 'user', isReplay: true, uuid: 'notice-1', session_id: SID, parent_tool_use_id: null, message: { role: 'user', content: '<task-notification>…' } },
    reply('No response requested.'), result('No response requested.')]) session.receive(m);
  assert.equal(session.done, false, 'the notice turn does not end this one');
  assert.deepEqual(statuses(), []);
  for (const m of [{ type: 'user', isReplay: true, uuid: sent.uuid, session_id: SID, parent_tool_use_id: null, message: { role: 'user', content: 'the user question' } },
    reply('the real answer'), result('the real answer')]) session.receive(m);
  assert.equal(accepted(), 1);
  assert.equal(session.done, true);
  assert.deepEqual(statuses(), ['succeeded']);
  assert.deepEqual(finals(), ['the real answer']);
});

test('group chat run record: subagent and background-command cards come from the run task events', async () => {
  const { runTasks } = await import('../public/run-log-data.js');
  const at = s => new Date(Date.parse('2026-11-19T07:00:00Z') + s * 1000).toISOString();
  const events = [
    { type: 'task', createdAt: at(0), payload: { id: 'a1', status: 'running', kind: 'agent', description: 'Count files', agentType: 'general-purpose', model: 'haiku' } },
    { type: 'task', createdAt: at(1), payload: { id: 'a1', status: 'running', model: 'claude-haiku-5-5', activity: 'Running ls' } },
    { type: 'task', createdAt: at(2), payload: { id: 's1', status: 'running', kind: 'shell', description: 'Sleep 25 seconds' } },
    { type: 'task', createdAt: at(5), payload: { id: 'a1', status: 'completed', durationMs: 4000 } },
    { type: 'task', createdAt: at(6), payload: { id: 'zz', status: 'completed' } }
  ];
  const live = runTasks(events, { status: 'running' });
  assert.deepEqual(live.map(x => [x.id, x.kind, x.status, x.model || null]), [['a1', 'agent', 'completed', 'claude-haiku-5-5'], ['s1', 'shell', 'running', null]]);
  assert.equal(live[0].durationMs, 4000);
  const ended = runTasks(events, { status: 'succeeded', finishedAt: at(30) });
  assert.equal(ended[1].status, 'unknown', 'a task still running when the run ended is not claimed finished');
});

test('a group chat Claude run reports its subagents and background shells as task events', async () => {
  const { CliPrintSession } = await load('cli-print-session.mjs');
  const out = [], session = new CliPrintSession({ cwd: '/xxxxx', runtime: 'claude', model: 'haiku', emit: (type, payload) => out.push({ type, payload }) });
  session.receive({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { model: 'haiku', description: 'Count files' } }] } });
  session.receive({ type: 'system', subtype: 'task_started', task_id: 'k1', task_type: 'local_agent', tool_use_id: 'tu1', description: 'Count files', subagent_type: 'general-purpose' });
  session.receive({ type: 'system', subtype: 'task_notification', task_id: 'k1', status: 'completed' });
  const tasks = out.filter(e => e.type === 'task').map(e => e.payload);
  assert.deepEqual(tasks.map(x => [x.id, x.status, x.kind || null, x.model || null]), [['k1', 'running', 'agent', 'haiku'], ['k1', 'completed', null, null]]);
});

test('an idle Claude process still learns that its background task ended (the next turn does not wait for it)', async () => {
  const { CliPrintSession } = await load('cli-print-session.mjs');
  const session = new CliPrintSession({ cwd: '/xxxxx', runtime: 'claude', model: 'haiku', emit() {} });
  session.receive({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'x' }] });
  session.done = true;
  session.receive({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  assert.equal(session.backgroundTasks.size, 0);
});
