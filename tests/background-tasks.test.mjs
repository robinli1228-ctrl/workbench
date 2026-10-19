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
