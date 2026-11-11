// A CLI's or role's question the user answered reads as two replies with the user's answer between them: the Sessions page
// history turns the question tool call and its result into the user's own answer message, a page-answered question splits a
// live turn, and a group-chat role's question keeps what the role said before asking.
import test from 'node:test';
import assert from 'node:assert/strict';
import { historyMessages } from '../src/native-sessions.mjs';
import { answerRows } from '../public/question-answer.js';
import { applyNativeTurnEvent } from '../src/native-turns.mjs';
import { Store } from '../src/store.mjs';

const ask = (id, questions) => ({ type: 'assistant', timestamp: '2026-11-11T05:45:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'I will confirm two things first.' }, { type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }] } });
const result = (id, content, extra = {}) => ({ type: 'user', timestamp: '2026-11-11T05:47:00Z', ...extra, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(extra.isError ? { is_error: true } : {}) }] } });

// History pages are parsed one record at a time (pageRows), so each record is labelled on its own and the page pairs them.
const perRecord = (rows, runtime) => rows.flatMap(row => historyMessages([row], runtime));

test('Claude: the question call and its answer become the user\'s answer message, between the two replies', () => {
  const rows = [ask('a1', [{ question: 'When should it start?', options: [{ label: 'When idle' }] }, { question: 'Anything else?', options: [] }]),
    result('a1', 'Your questions have been answered: "When should it start?"="When idle", "Anything else?"="Leave T55 alone". You can now continue.'),
    { type: 'assistant', timestamp: '2026-11-11T05:52:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }];
  const labelled = perRecord(rows, 'claude');
  assert.deepEqual(labelled.map(m => m.role), ['assistant', 'question_call', 'question_answer', 'assistant'], 'each record on its own; no tool step');
  // The tool-detail read sees the same rows at the same positions.
  assert.equal(rows.flatMap(row => historyMessages([row], 'claude', { fullTools: true })).length, labelled.length);
  const out = answerRows(labelled);
  assert.deepEqual(out.map(m => m.role), ['assistant', 'user', 'assistant']);
  assert.deepEqual(out[1].answer.items, [{ question: 'When should it start?', answer: ['When idle'] }, { question: 'Anything else?', answer: ['Leave T55 alone'] }]);
  assert.equal(out[1].timestamp, '2026-11-11T05:47:00Z');
  // Recorded answers win over the text.
  const recorded = answerRows(perRecord([ask('a2', [{ question: 'Q?', options: [] }]), result('a2', 'x', { toolUseResult: { answers: { 'Q?': 'From the record' } } })], 'claude'));
  assert.deepEqual(recorded.at(-1).answer.items, [{ question: 'Q?', answer: ['From the record'] }]);
  // A skipped, declined or interrupted question: the result carries no answers, the pair still says so.
  const skipped = answerRows(perRecord([ask('a3', [{ question: 'Q?', options: [] }]), result('a3', 'The user skipped these questions.', { isError: true })], 'claude'));
  assert.deepEqual(skipped.map(m => m.role), ['assistant', 'user']);assert.equal(skipped.at(-1).answer.skipped, true);
  // The call on an earlier page: the result still names its questions; an ordinary tool result is left alone.
  assert.deepEqual(answerRows(perRecord([result('a4', 'The user answered: "Which one?"="The second". Read the answers carefully')], 'claude'))[0].answer.items, [{ question: 'Which one?', answer: ['The second'] }]);
  assert.equal(answerRows(perRecord([result('x', 'file contents')], 'claude'))[0].role, 'tool_result');
  // A question still waiting (no result yet) shows nothing; the page's card stands for it.
  assert.deepEqual(answerRows(perRecord([ask('a5', [{ question: 'Q?', options: [] }])], 'claude')).map(m => m.role), ['assistant']);
  // Answer rows are not prompts for the side question's turn count or the page's prompt budget.
  assert.equal(labelled.filter(m => m.role === 'user').length, 0);
});

test('Codex: request_user_input and its answers by question id; a secret answer is never shown', () => {
  const rows = [{ type: 'response_item', timestamp: 't1', payload: { type: 'function_call', name: 'request_user_input', call_id: 'c1', arguments: JSON.stringify({ questions: [{ id: 'mode', question: 'Which mode?' }, { id: 'note', question: 'Note?' }, { id: 'key', question: 'API key?', isSecret: true }] }) } },
    { type: 'response_item', timestamp: 't2', payload: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ answers: { mode: { answers: ['Fast'] }, key: { answers: ['xxxxx'] } } }) } }];
  const [m] = answerRows(perRecord(rows, 'codex'));
  assert.equal(m.role, 'user');
  assert.deepEqual(m.answer.items, [{ question: 'Which mode?', answer: ['Fast'] }, { question: 'Note?', skipped: true }, { question: 'API key?', answer: [], secret: true }]);
});

test('a question answered on the page stays in the turn\'s events, where the page splits the reply', () => {
  let turn = { id: 't', status: 'running', events: [], createdAt: '2026-11-11T05:41:00Z' };
  turn = applyNativeTurnEvent(turn, { kind: 'message', text: 'Before.' });
  turn = applyNativeTurnEvent(turn, { kind: 'question', id: 'q', questions: [{ id: 'q1', question: 'Go?' }, { id: 'q2', question: 'Key?', secret: true }] });
  turn = { ...turn, question: { ...turn.question, answered: true, answers: { q1: ['Yes'], q2: ['xxxxx'] }, skip: false } };
  turn = applyNativeTurnEvent(turn, { kind: 'question_resolved', id: 'q' });
  const answer = turn.events.find(e => e.type === 'answer');
  assert.ok(answer, 'answer event recorded');assert.deepEqual(answer.payload.questions, [{ id: 'q1', question: 'Go?' }, { id: 'q2', question: 'Key?', secret: true }]);
  assert.deepEqual(answer.payload.answers, { q1: ['Yes'], q2: ['(filled)'] }, 'a secret answer is not kept');
  assert.equal(turn.status, 'running');assert.equal(turn.question, undefined);
  // A question the CLI withdrew (no answer from the page) adds nothing.
  let other = applyNativeTurnEvent({ id: 'u', status: 'running', events: [] }, { kind: 'question', id: 'q', questions: [{ id: 'q1', question: 'Go?' }] });
  other = applyNativeTurnEvent(other, { kind: 'question_resolved', id: 'q' });
  assert.equal(other.events.some(e => e.type === 'answer'), false);
});

test('a group-chat role\'s question keeps what the role said since its previous question', () => {
  const db = new Store(':memory:');
  db.put('runs', { id: 'r1', projectId: 'p', status: 'running', lastSeq: 0 });
  let seq = 0;const event = (type, payload) => db.event({ id: `e${++seq}`, runId: 'r1', seq, type, payload, createdAt: `2026-11-11T05:4${seq}:00Z` });
  event('message', { text: 'Reading the code.', phase: 'commentary' });
  event('message', { text: 'I will confirm two things first.', phase: 'commentary' });
  event('question', { id: 'r1:q1', questionId: 'q1', runId: 'r1', kind: 'question', status: 'pending', questions: [{ id: 'a', question: 'Go?' }] });
  const first = db.get('approvals', 'r1:q1');
  assert.equal(first.lead, 'Reading the code.\n\nI will confirm two things first.');assert.equal(first.seq, 3);
  event('message', { text: 'Next part.', phase: 'commentary' });
  event('question', { id: 'r1:q2', questionId: 'q2', runId: 'r1', kind: 'question', status: 'pending', questions: [{ id: 'a', question: 'Again?' }] });
  assert.equal(db.get('approvals', 'r1:q2').lead, 'Next part.', 'only since the previous question');
  event('question', { id: 'r1:q3', questionId: 'q3', runId: 'r1', kind: 'question', status: 'pending', questions: [{ id: 'a', question: 'Straight away?' }] });
  assert.equal(db.get('approvals', 'r1:q3').lead, undefined, 'a question asked without words first has no lead');
});
