// A group-chat role may ask the user through its CLI's question tool when Home can show and answer it: the question waits
// as a card, the turn waits with it, and the answer goes back into the same turn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CliPrintSession } from '../src/cli-print-session.mjs';
import { CodexSession } from '../src/codex.mjs';
import { Store } from '../src/store.mjs';
import { warmSessionFingerprint } from '../src/warm-sessions.mjs';

const claude = (questions, extra = {}) => {
  const events = [], writes = [];
  const session = new CliPrintSession({ cwd: '/tmp', model: 'm', runtime: 'claude', keepAlive: true, askUser: questions, emit: (type, payload) => events.push({ type, ...payload }), ...extra });
  session.proc = { stdin: { write: line => writes.push(JSON.parse(line)), end() {} }, kill() {}, exitCode: null };
  return { session, events, writes };
};
const ask = { type: 'control_request', request_id: 'perm-ask', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion',
  input: { questions: [{ question: 'Deploy now?', header: 'Deploy', multiSelect: false, options: [{ label: 'Yes', description: 'ship it' }, { label: 'No' }] }] } } };

test('a group-chat Claude hosts questions only when asked to: a permission host instead of skipping permissions', () => {
  assert.deepEqual(claude(true).session.args('hi').filter(a => /permission/.test(a)), ['--permission-mode', '--permission-prompt-tool']);
  assert.ok(claude(true).session.args('hi').includes('stdio'));
  assert.ok(claude(false).session.args('hi').includes('--dangerously-skip-permissions'));
  assert.equal(claude(true, { runtime: 'agy' }).session.questionsSupported, false, 'only Claude has the tool');
  assert.equal(claude(true, { keepAlive: false }).session.questionsSupported, false, 'a one-shot turn cannot answer');
});

test('AskUserQuestion becomes a waiting question; the answer goes back as updatedInput and the turn runs on', () => {
  const { session, events, writes } = claude(true);
  session.sendTurn('hi');
  assert.equal(writes[0].request.subtype, 'initialize', 'the SDK handshake precedes the first message');
  session.receive({ type: 'control_request', request_id: 'perm-bash', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
  assert.deepEqual(writes.at(-1).response.response, { behavior: 'allow', updatedInput: { command: 'ls' } }, 'other tools are allowed as before');
  session.receive(ask);
  const question = events.find(e => e.type === 'question');
  assert.equal(question.id, 'perm-ask');assert.equal(question.questions[0].question, 'Deploy now?');
  assert.ok(events.some(e => e.type === 'status' && e.status === 'waiting_user'));
  session.answerQuestion({ id: 'perm-ask', answers: { q1: ['No'] } });
  assert.deepEqual(writes.at(-1).response.response, { behavior: 'allow', updatedInput: { ...ask.request.input, answers: { 'Deploy now?': 'No' } } });
  assert.ok(events.some(e => e.type === 'question_resolved' && e.id === 'perm-ask'));
  assert.equal(events.at(-1).status, 'running');
  assert.throws(() => session.answerQuestion({ id: 'perm-ask', answers: { q1: ['Yes'] } }), /no longer waiting/);
});

test('stopping a turn that waits for an answer denies the question', async () => {
  const { session, events, writes } = claude(true);
  session.receive(ask);
  await session.stop();
  assert.equal(writes.at(-1).response.response.behavior, 'deny');
  assert.deepEqual(events.filter(e => e.type === 'question_resolved').map(e => e.status), ['expired']);
});

test('a group-chat Codex opts into request_user_input only when asked to', () => {
  const codex = questions => new CodexSession({ cwd: '/tmp', model: 'm', emit() {}, askUser: questions });
  assert.deepEqual(codex(true).launchArgs().slice(0, 2), ['-c', 'features.default_mode_request_user_input=true']);
  assert.ok(!codex(false).launchArgs().includes('-c'));
});

test('a process that hosts questions is never reused for a turn that cannot answer them, and back', () => {
  const base = { folder: '/tmp', runtimeType: 'claude', model: 'm', effort: null, roleName: 'Dev', roleInstructions: '', env: {} };
  assert.notEqual(warmSessionFingerprint({ ...base, questions: true }), warmSessionFingerprint(base));
  assert.equal(warmSessionFingerprint({ ...base, questions: false }), warmSessionFingerprint(base), 'existing processes keep their fingerprint');
});

test('Home keeps the question beside the run until it is answered, skipped or the turn ends', () => {
  const db = new Store(':memory:');
  db.put('runs', { id: 'r1', projectId: 'p', nodeId: 'w', taskId: 't1', status: 'running', seq: 0, lastSeq: 0 });
  let seq = 0;const event = (type, payload) => db.event({ id: `e${++seq}`, runId: 'r1', seq, type, payload });
  event('question', { id: 'r1:perm-ask', questionId: 'perm-ask', runId: 'r1', kind: 'question', status: 'pending', questions: [{ id: 'q1', question: 'Deploy now?', options: [] }] });
  event('status', { status: 'waiting_user' });
  assert.equal(db.get('approvals', 'r1:perm-ask').status, 'pending');assert.equal(db.get('approvals', 'r1:perm-ask').kind, 'question');
  event('question_resolved', { id: 'r1:perm-ask' });
  assert.equal(db.get('approvals', 'r1:perm-ask').status, 'answered');
  event('question', { id: 'r1:perm-2', questionId: 'perm-2', runId: 'r1', kind: 'question', status: 'pending', questions: [{ id: 'q1', question: 'Again?', options: [] }] });
  event('status', { status: 'succeeded' });
  assert.equal(db.get('approvals', 'r1:perm-2').status, 'expired', 'a turn that ended takes no answer');
});

test('a reused Codex process keeps its waiting questions: the next turn can still ask, end and be stopped', () => {
  const events = [];
  const session = new CodexSession({ cwd: '/tmp', model: 'm', emit() {}, askUser: true, keepAlive: true });
  session.done = true;session.proc = { killed: false, exitCode: null, signalCode: null, stdin: { write() {} } };
  session.reuse({ cwd: '/tmp', model: 'm', emit: (type, payload) => events.push({ type, ...payload }), askUser: true, keepAlive: true });
  assert.ok(session.questions instanceof Map, 'the reuse options do not replace the waiting questions');
  session.write = () => true;
  session.receive({ id: 7, method: 'item/tool/requestUserInput', params: { itemId: 'c1', questions: [{ id: 'go', question: 'Release?', options: [{ label: 'Yes' }] }] } });
  assert.ok(events.some(e => e.type === 'question' && e.id === 'c1'));
  assert.doesNotThrow(() => session.finish('succeeded'));
  assert.ok(events.some(e => e.type === 'status' && e.status === 'succeeded'));
});

test('Claude may not leave a question nobody can answer: none between turns, one at a time', () => {
  const { session, events, writes } = claude(true);
  session.receive(ask);
  session.receive({ ...ask, request_id: 'perm-second' });
  assert.equal(writes.at(-1).response.request_id, 'perm-second');assert.equal(writes.at(-1).response.response.behavior, 'deny');
  assert.equal(events.filter(e => e.type === 'question').length, 1);
  session.answerQuestion({ id: 'perm-ask', skip: true });
  session.done = true;
  session.receive({ ...ask, request_id: 'perm-idle' });
  assert.equal(writes.at(-1).response.response.behavior, 'deny', 'a question after the turn ended is refused at once');
  assert.equal(events.filter(e => e.type === 'question').length, 1);
});

// Claude called AskUserQuestion but its permission request never came: the turn must not wait on a question nobody sees.
const toolCall = { type: 'assistant', message: { id: 'msg-q', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_ask1', name: 'AskUserQuestion', input: ask.request.input }] } };
const echoed = session => session.receive({ type: 'user', isReplay: true, uuid: session.echoUuid, session_id: session.echoSession, message: { role: 'user', content: 'hi' } });
const traces = events => events.filter(e => e.type === 'log' && e.text.startsWith('[question]')).map(e => e.text);

test('a question whose permission request never comes is shown from the tool call; the answer goes on as the next message', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, events, writes } = claude(true);
  session.sendTurn('hi');echoed(session);session.receive(toolCall);
  assert.equal(events.some(e => e.type === 'question'), false, 'the request normally follows at once');
  t.mock.timers.tick(8000);
  const question = events.find(e => e.type === 'question');
  assert.equal(question.id, 'toolu_ask1');assert.equal(question.questions[0].question, 'Deploy now?');
  assert.equal(events.filter(e => e.type === 'status').at(-1).status, 'waiting_user');
  session.answerQuestion({ id: 'toolu_ask1', answers: { q1: ['No'] } });
  assert.equal(writes.at(-1).request.subtype, 'interrupt', 'the tool cannot take the answer, so the turn is interrupted');
  assert.ok(events.some(e => e.type === 'question_resolved' && e.id === 'toolu_ask1'));
  session.receive({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '' });
  const next = writes.at(-1);
  assert.equal(next.type, 'user');assert.match(next.message.content, /"Deploy now\?"="No"/);
  assert.equal(session.done, false, 'the same run carries on with the answer');
  assert.ok(!events.some(e => e.type === 'status' && ['succeeded', 'failed'].includes(e.status)));
  assert.deepEqual(traces(events).map(text => text.split(' ').slice(1, 4).join(' ')), ['AskUserQuestion called (olu_ask1);', 'no permission request', 'answer cannot reach', 'turn interrupted; sending']);
});

test('a permission request in time is the normal question; one arriving late is attached to the question already shown', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const quick = claude(true);quick.session.sendTurn('hi');echoed(quick.session);quick.session.receive(toolCall);quick.session.receive(ask);t.mock.timers.tick(8000);
  assert.deepEqual(quick.events.filter(e => e.type === 'question').map(e => e.id), ['perm-ask'], 'no second card from the tool call');
  const late = claude(true);late.session.sendTurn('hi');echoed(late.session);late.session.receive(toolCall);t.mock.timers.tick(8000);
  late.session.receive({ ...ask, request: { ...ask.request, tool_use_id: 'toolu_ask1' } });
  assert.equal(late.events.filter(e => e.type === 'question').length, 1);
  late.session.answerQuestion({ id: 'toolu_ask1', answers: { q1: ['Yes'] } });
  assert.deepEqual(late.writes.at(-1).response.response, { behavior: 'allow', updatedInput: { ...ask.request.input, answers: { 'Deploy now?': 'Yes' } } }, 'the late request takes the answer');
});
