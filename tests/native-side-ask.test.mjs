// Side questions: a trimmed read-only copy of the session, never written back, removed on close, expiry or restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = name => import(pathToFileURL(join(root, 'src', name)).href);
const { trimClaudeSession, SideAsks, SIDE_ASK_LIMITS } = await load('native-side-ask.mjs');
const { createHomeSideAsks } = await load('native-side-ask-home.mjs');
const { Store } = await load('store.mjs');

const PARENT = '11111111-2222-4333-8444-555555555555';
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function claudeHistory(dir, turns, { lastIncomplete = false } = {}) {
  const rows = [{ type: 'ai-title', aiTitle: 'demo', sessionId: PARENT }], at = i => `2026-10-21T06:${String(i).padStart(2, '0')}:00.000Z`;
  let prev = null, n = 0;
  const push = row => { const r = { ...row, uuid: uuid(++n), parentUuid: prev, sessionId: PARENT, isSidechain: false, cwd: '/srv/work/demo' }; prev = r.uuid; rows.push(r); };
  for (let i = 1; i <= turns; i++) {
    push({ type: 'user', timestamp: at(i), message: { role: 'user', content: `question ${i}` } });
    rows.push({ type: 'api-request-blob', sessionId: PARENT, message: { role: 'user', content: [{ type: 'text', text: 'blob'.repeat(50) }] } });
    push({ type: 'assistant', timestamp: at(i), message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${i}`, name: 'Read', input: { file_path: '/tmp/x.png' } }] } });
    if (!(lastIncomplete && i === turns)) {
      push({ type: 'user', timestamp: at(i), toolUseResult: { big: 'x'.repeat(500) }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(4000) } }] }] } });
      push({ type: 'assistant', timestamp: at(i), message: { role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] } });
    }
    rows.push({ type: 'user', isSidechain: true, sessionId: PARENT, uuid: `side-${i}`, parentUuid: null, message: { role: 'user', content: 'subagent prompt' } });
  }
  const path = join(dir, `${PARENT}.jsonl`);
  writeFileSync(path, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return path;
}
const sandbox = t => { const dir = mkdtempSync(join(tmpdir(), 'wb-side-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test('the temporary Claude session holds the last 10 turns, conversation rows only, no pictures, under its own ID', async t => {
  const dir = sandbox(t), parentPath = claudeHistory(dir, 14), tempId = uuid(999), tempPath = join(dir, `${tempId}.jsonl`);
  const result = await trimClaudeSession({ parentPath, tempPath, tempId });
  assert.equal(result.prompts, 10);
  const rows = readFileSync(tempPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows[0].type, 'user'); assert.equal(rows[0].message.content, 'question 5'); assert.equal(rows[0].parentUuid, null, 'the first kept row is a root');
  assert.ok(rows.every(r => r.sessionId === tempId), 'every row names the temporary session');
  assert.ok(rows.every(r => ['user', 'assistant'].includes(r.type) && !r.isSidechain), 'request logs, metadata and subagent rows are left out');
  assert.ok(rows.every(r => !('toolUseResult' in r)));
  assert.ok(!readFileSync(tempPath, 'utf8').includes('"type":"image"'), 'pictures become a note');
  assert.match(readFileSync(tempPath, 'utf8'), /picture from the main session is left out/);
  assert.equal(rows.at(-1).message.content[0].text, 'answer 14');
  assert.ok(!readFileSync(parentPath, 'utf8').includes(tempId), 'the parent is untouched');
  await assert.rejects(trimClaudeSession({ parentPath, tempPath, tempId }), /EEXIST/, 'never overwrites a file');
});

test('a last turn still running in the main session (a tool call without its result) is left out', async t => {
  const dir = sandbox(t), parentPath = claudeHistory(dir, 4, { lastIncomplete: true }), tempId = uuid(998), tempPath = join(dir, `${tempId}.jsonl`);
  const result = await trimClaudeSession({ parentPath, tempPath, tempId });
  assert.equal(result.prompts, 3);
  const text = readFileSync(tempPath, 'utf8');
  assert.ok(!text.includes('question 4') && text.includes('answer 3'));
  const one = claudeHistory(sandbox(t), 1, { lastIncomplete: true });
  await assert.rejects(trimClaudeSession({ parentPath: one, tempPath: join(dirname(one), 'x.jsonl'), tempId: uuid(997) }), /no complete turn/);
});

function worker(t, { runtime = 'claude', prompts = { id: 'p1' } } = {}) {
  const dir = sandbox(t), db = new Store(':memory:'), sent = [], created = [], deleted = [];
  let now = Date.parse('2026-10-21T08:00:00Z');
  const parentPath = claudeHistory(dir, 3);
  const fake = options => { const s = { options, starts: 0, stops: 0,
    async start(prompt) { s.starts++; s.prompt = prompt; options.emit('status', { status: 'running', ...(runtime === 'codex' ? { threadId: options.resumeSessionId || 'fork-thread-1' } : {}) }); options.emit('message', { text: `answer to ${prompt}` }); options.emit('context_usage', { usedTokens: 1200 }); options.emit('status', { status: 'succeeded' }); },
    stop() { s.stops++; } }; created.push(s); return s; };
  const asks = new SideAsks({ db, send: m => sent.push(m), env: { HOME: dir }, createClaude: fake, createCodex: fake, deleteThread: async id => { deleted.push(id); },
    parentState: async () => ({ ...prompts, workspace: '/srv/work/demo' }), historyFile: async () => ({ path: parentPath }), clock: () => now });
  const ask = (n, extra = {}) => asks.ask({ sideId: uuid(1), questionId: uuid(100 + n), runtime, sessionId: PARENT, prompt: `q${n}`, record: { id: PARENT, runtime, workspace: '/srv/work/demo' }, ...extra });
  return { dir, db, sent, created, deleted, asks, ask, prompts, advance: ms => { now += ms; } };
}

test('Claude: the first question makes the temporary session, follow-ups resume it read-only, a newer main prompt preserves the branch', async t => {
  const w = worker(t);
  await w.ask(1);
  const first = w.db.get('sideAsks', uuid(1));
  assert.ok(first.tempPath && existsSync(first.tempPath), 'the temporary session file exists next to the parent');
  assert.equal(w.created[0].options.resumeSessionId, first.tempId);
  assert.equal(w.created[0].options.keepAlive, false);
  const events = w.sent.filter(m => m.questionId === uuid(101)).map(m => m.event.kind === 'status' ? m.event.status : m.event.kind);
  assert.deepEqual(events, ['scope', 'running', 'running', 'message', 'context_usage', 'succeeded']);
  await w.ask(2, { followUp: true });
  assert.equal(w.created[1].options.resumeSessionId, first.tempId, 'the follow-up continues the same temporary session');
  assert.equal(w.asks.size, 0, 'no process stays after an answer');
  // The main session moved on: the follow-up keeps the same independent copy.
  w.prompts.id = 'p2';
  await w.ask(3, { followUp: true });
  const second = w.db.get('sideAsks', uuid(1));
  assert.equal(second.tempId, first.tempId); assert.equal(existsSync(first.tempPath), true);
  assert.equal(w.sent.some(m => m.questionId === uuid(103) && m.event.kind === 'restarted'), false);
  // Clearing removes the copy and the record.
  await w.asks.close(uuid(1));
  assert.equal(existsSync(second.tempPath), false); assert.ok(!w.db.get('sideAsks', uuid(1)));
});

test('a follow-up the Worker no longer knows (it restarted) starts over and says so; expiry and restart clean up', async t => {
  const w = worker(t);
  await w.ask(1, { followUp: true });
  assert.ok(w.sent.some(m => m.event.kind === 'restarted'));
  w.advance(SIDE_ASK_LIMITS.idleMs + 1000); await w.asks.sweep();
  assert.equal(w.db.list('sideAsks').length, 0);
  assert.deepEqual(w.sent.at(-1), { type: 'side_ask_closed', sideId: uuid(1), reason: 'idle' });
  await w.ask(2);
  const path = w.db.get('sideAsks', uuid(1)).tempPath;
  await w.asks.sweep({ all: true });
  assert.equal(existsSync(path), false, 'a Worker start removes every temporary session');
  assert.equal(w.sent.at(-1).reason, 'restart');
});

test('Codex: the first question forks read-only, later ones resume the fork, closing deletes the fork thread', async t => {
  const w = worker(t, { runtime: 'codex' });
  await w.ask(1);
  assert.equal(w.created[0].options.forkFrom, PARENT); assert.equal(w.created[0].options.resumeSessionId, null);
  assert.equal(w.db.get('sideAsks', uuid(1)).forkId, 'fork-thread-1');
  await w.ask(2, { followUp: true });
  assert.equal(w.created[1].options.forkFrom, null); assert.equal(w.created[1].options.resumeSessionId, 'fork-thread-1');
  await w.asks.close(uuid(1));
  assert.deepEqual(w.deleted, ['fork-thread-1']);
});

test('a second question while one is being answered, an Agy session or a full device is refused', async t => {
  const w = worker(t);
  w.asks.running.set(uuid(1), { session: { stop() {} } });
  await w.ask(1);
  assert.match(w.sent.at(-1).event.error, /still being answered/);
  w.asks.running.clear();
  await w.asks.ask({ sideId: uuid(2), questionId: uuid(200), runtime: 'agy', sessionId: PARENT, prompt: 'x' });
  assert.match(w.sent.at(-1).event.error, /Claude and Codex/);
  const full = new SideAsks({ db: new Store(':memory:'), send: m => w.sent.push(m), canStart: () => { throw new Error('Device CLI capacity is full'); } });
  await full.ask({ sideId: uuid(3), questionId: uuid(300), runtime: 'claude', sessionId: PARENT, prompt: 'x' });
  assert.match(w.sent.at(-1).event.error, /capacity is full/);
});

test('Home keeps side questions in memory only: one at a time, closed explicitly, by idle or age', () => {
  const sent = [];let now = Date.parse('2026-10-21T08:00:00Z');
  const home = createHomeSideAsks({ send: (nodeId, m) => sent.push({ nodeId, ...m }), online: () => true, clock: () => now });
  const worker = { id: 'n1', capabilities: { nativeSideAsk: 1 } };
  assert.throws(() => home.ask('n1', { capabilities: {} }, { runtime: 'claude', sessionId: PARENT, prompt: 'x' }), /Upgrade/);
  assert.throws(() => home.ask('n1', worker, { runtime: 'agy', sessionId: PARENT, prompt: 'x' }), /Claude and Codex/);
  const a = home.ask('n1', worker, { runtime: 'claude', sessionId: PARENT, prompt: 'first?', model: 'claude-haiku-5-5' });
  assert.equal(sent.at(-1).type, 'side_ask'); assert.equal(sent.at(-1).followUp, false); assert.equal(sent.at(-1).model, 'claude-haiku-5-5');
  const q = a.questions[0].id;
  home.receive('n1', { type: 'side_ask_event', sideId: a.id, questionId: q, event: { kind: 'scope', turns: 10 } });
  home.receive('n1', { type: 'side_ask_event', sideId: a.id, questionId: q, event: { kind: 'status', status: 'running' } });
  assert.throws(() => home.ask('n1', worker, { sideId: a.id, runtime: 'claude', sessionId: PARENT, prompt: 'too soon' }), /still being answered/);
  home.receive('n1', { type: 'side_ask_event', sideId: a.id, questionId: q, event: { kind: 'message', text: 'the answer' } });
  home.receive('n1', { type: 'side_ask_event', sideId: a.id, questionId: q, event: { kind: 'status', status: 'succeeded' } });
  let v = home.get(a.id);
  assert.equal(v.turns, 10); assert.equal(v.questions[0].status, 'succeeded'); assert.ok(v.questions[0].endedAt);
  assert.ok(v.questions[0].events.some(e => e.type === 'message' && e.payload?.text === 'the answer' || e.text === 'the answer'));
  home.ask('n1', worker, { sideId: a.id, runtime: 'claude', sessionId: PARENT, prompt: 'follow-up' });
  assert.equal(sent.at(-1).followUp, true); assert.equal(home.get(a.id).questions.length, 2);
  // Only one side question: another session's question closes this one.
  const b = home.ask('n1', worker, { runtime: 'codex', sessionId: 'thread-2', prompt: 'other?' });
  assert.equal(home.get(a.id).closed, true); assert.equal(home.get(a.id).reason, 'replaced');
  assert.ok(sent.some(m => m.type === 'side_ask_close' && m.sideId === a.id));
  // Explicit clearing closes the side question; asking again starts over and says so.
  home.stop(b.id);
  assert.equal(home.get(b.id).reason, 'cleared');
  const c = home.ask('n1', worker, { sideId: b.id, runtime: 'codex', sessionId: 'thread-2', prompt: 'again?' });
  assert.notEqual(c.id, b.id); assert.equal(c.restarted, true);
  // Idle for an hour.
  now += 61 * 60000; home.sweep();
  assert.equal(home.get(c.id).reason, 'idle'); assert.equal(home.size(), 0);
});

test('the Worker downloads a side question file only while that question is open', () => {
  const home = createHomeSideAsks({ send() {}, online: () => true, attachments: { resolve: (owner, ids) => ids.map(id => ({ id, name: 'a.txt', mime: 'text/plain', size: 3, sha256: 'f'.repeat(64) })) }, owner: n => `native:${n}` });
  const side = home.ask('n1', { capabilities: { nativeSideAsk: 1 } }, { runtime: 'claude', sessionId: PARENT, prompt: 'see file', attachmentIds: [uuid(5)] });
  assert.deepEqual(home.attachmentFor(side.id, uuid(5)), { owner: 'native:n1', id: uuid(5) });
  assert.throws(() => home.attachmentFor(side.id, uuid(6)), /open side question/);
  home.receive('n1', { type: 'side_ask_event', sideId: side.id, questionId: side.questions[0].id, event: { kind: 'status', status: 'succeeded' } });
  assert.throws(() => home.attachmentFor(side.id, uuid(5)), /open side question/);
});
