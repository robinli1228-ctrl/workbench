// Platform memory: one set for every project. Search ranks short entries without a model; the organizer works through every chat in receipt order,
// moves a watermark only after a batch is saved, never rewrites people's edits and retries a failed batch later.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { PlatformMemory, memoryTerms, rankMemories } from '../src/platform-memory.mjs';
import { memorySearchInput } from '../src/wb-tools.mjs';
import { updateMemoryOrganizer, normalizePlatformSettings } from '../src/platform-prompts.mjs';
import { command, forgetRun } from '../src/conversation-organizer.mjs';
import { startNativeBridges } from '../src/agent-bridge.mjs';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const P = 'p1';
function setup() {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'demo' });
  db.put('workers', { id: 'n-mac', name: 'xxxxx-mac' });
  db.put('workers', { id: 'n-srv', name: 'xxxxx-server' });
  db.put('roles', { id: 'r1', projectId: P, name: 'Dev', runtime: 'claude', nodeId: 'n-srv' });
  let clock = new Date('2026-10-29T10:00:00');
  const memory = new PlatformMemory(db, { clock: () => clock });
  return { db, memory, tick: ms => { clock = new Date(clock.getTime() + ms); }, set: value => { clock = new Date(value); } };
}
const post = (db, id, text, extra = {}) => db.put('roomMessages', { id, projectId: P, sender: 'human', text, taskIds: [], createdAt: new Date().toISOString(), ...extra });

test('terms split Han text into pairs and keep paths and words whole and in parts', () => {
  const terms = memoryTerms('Home 在 Mac 上，經由隧道 127.0.0.1:4000');
  for (const term of ['home', 'mac', '经由', '由隧', '隧道', '127.0.0.1:4000', '4000', '在']) assert.ok(terms.includes(term), term);
  assert.deepEqual(memoryTerms('測試伺服器'), memoryTerms('测试伺服器'), 'Traditional and Simplified match');
});

test('search ranks by words and lifts the caller\'s chat, CLI and device; filters narrow the list', () => {
  const { memory } = setup();
  const a = memory.save({ type: 'environment', content: 'Home 在 Mac 上，經由隧道 4000 連到伺服器', nodeId: 'n-mac' });
  const b = memory.save({ type: 'lesson', content: '不要 SIGKILL 正在啟動的 claude，會把設備登出', runtime: 'claude' });
  memory.save({ type: 'credential', content: 'Gitee 推送用 xxxxx 帳號的令牌', runtime: 'codex' });
  assert.equal(memory.search({ query: '隧道 端口' }).items[0].id, a.id);
  assert.equal(memory.search({ query: '经由隧道' }).items[0].id, a.id, 'a Simplified query finds a Traditional entry');
  assert.deepEqual(Object.keys(memory.search({ query: '隧道' }).items[0]).sort(), ['content', 'device', 'id', 'type', 'updatedAt'], 'roles get a short record');
  assert.equal(memory.search({ query: 'claude 登出' }).items[0].id, b.id);
  assert.equal(memory.search({ query: '' }).total, 3, 'without words everything is listed');
  assert.deepEqual(memory.search({ type: 'lesson' }).items.map(i => i.id), [b.id]);
  assert.equal(memory.search({ type: 'lesson' }).items[0].cli, 'claude');
  assert.equal(memory.search({ cli: 'codex' }).total, 2, 'entries for another CLI drop out; entries for any CLI stay');
  assert.equal(memory.search({ device: 'xxxxx-server' }).total, 2, 'a device name works as a filter');
  assert.match(memory.search({ query: 'nothing-like-this' }).note, /\S/);
  assert.throws(() => memory.search({ type: 'mood' }));
  // Two entries with the same words: the caller's CLI comes first.
  const c1 = memory.save({ type: 'procedure', content: 'deploy 步驟：先 build 再 restart', runtime: 'codex' });
  const c2 = memory.save({ type: 'procedure', content: 'deploy 步驟：先 build 再 restart', runtime: 'claude' });
  assert.equal(memory.search({ query: 'deploy' }, { runtime: 'claude' }).items[0].id, c2.id);
  assert.equal(memory.search({ query: 'deploy' }, { runtime: 'codex' }).items[0].id, c1.id);
});

test('organizing walks every message once, moving the watermark only when a batch is saved', async () => {
  const { db, memory, tick } = setup();
  for (let i = 0; i < 70; i++) post(db, `m${i}`, `消息 ${i}`);
  post(db, 'm-dev', '記住：測試伺服器的 Worker 容量是 4', { sender: 'agent', roleId: 'r1', senderName: 'Dev' });
  memory.request(P);
  assert.equal(memory.progress(P).pending, 71);
  const prompts = [];
  const config = { nodeId: 'n-srv', runtime: 'claude', model: 'haiku' };
  const run = (answer) => memory.drainOne({ config, canRun: () => true, agentsMd: async () => '# Rules\n- 回覆用中文', query: async prompt => { prompts.push(prompt); return typeof answer === 'function' ? answer(prompt) : answer; } });

  // A failure keeps every message and backs off.
  assert.match((await run(() => { throw new Error('model down'); })).error, /model down/);
  let progress = memory.progress(P);
  assert.equal(progress.pending, 71);assert.equal(progress.failures, 1);assert.ok(progress.retryAt);assert.equal(progress.lastError, 'model down');
  assert.deepEqual(await run({}), { waiting: progress.retryAt }, 'the request waits for the chat\'s retry time');
  assert.equal(await run({}), null, 'nothing runs before the retry time');
  tick(11 * 60000);
  assert.equal(memory.batch(P).messages.length, 30, 'a chat that failed is retried in a smaller batch');
  // Clear the failure count as a successful batch would, so the counts below follow full batches.
  db.put('memoryProgress', { ...db.get('memoryProgress', P), conversations: {} });

  const first = await run({ add: [] });
  assert.deepEqual(first, { added: 0, updated: 0, retired: 0 });
  assert.equal(memory.progress(P).pending, 11, 'one batch holds at most 60 messages');
  const input = JSON.parse(prompts.at(-1).slice(prompts.at(-1).lastIndexOf('\n{') + 1));
  assert.equal(input.messages.length, 60);assert.equal(input.agentsMd, '# Rules\n- 回覆用中文');assert.deepEqual(input.devices, ['xxxxx-mac', 'xxxxx-server']);

  await run(prompt => {
    const batch = JSON.parse(prompt.slice(prompt.lastIndexOf('\n{') + 1));
    const dev = batch.messages.find(m => m.id === 'm-dev');
    assert.deepEqual([dev.cli, dev.device, dev.author], ['claude', 'xxxxx-server', 'Dev'], 'each message says which CLI and device it came from');
    return { add: [{ type: 'environment', content: '測試伺服器的 Worker 容量是 4', device: 'xxxxx-server', sources: ['m-dev', 'not-in-batch'] }], agentsMd: ['an old-style suggestion is ignored'] };
  });
  progress = memory.progress(P);
  assert.equal(progress.pending, 0);assert.equal(progress.failures, 0);assert.equal(progress.suggestions, undefined, 'no AGENTS.md suggestions are kept');
  const [entry] = memory.list().items;
  assert.deepEqual([entry.type, entry.nodeId, entry.device, entry.sourceMessageIds], ['environment', 'n-srv', 'xxxxx-server', ['m-dev']]);
  assert.deepEqual(await run({}), { done: true }, 'a caught-up project ends its request');
  assert.equal(memory.progress(P).requestedAt, null);
  assert.equal(await run({}), null);

  // New messages later: only they are sent.
  post(db, 'm-new', '改了：Worker 容量改成 6');
  memory.request(P);
  await run(prompt => {
    const batch = JSON.parse(prompt.slice(prompt.lastIndexOf('\n{') + 1));
    assert.deepEqual(batch.messages.map(m => m.id), ['m-new']);
    assert.equal(batch.known[0].id, entry.id, 'related memory is shown so it can be updated instead of repeated');
    return { update: [{ id: entry.id, content: '測試伺服器的 Worker 容量是 6' }] };
  });
  assert.equal(memory.list().items[0].content, '測試伺服器的 Worker 容量是 6');
  assert.equal(memory.list().items[0].nodeId, 'n-srv', 'an update keeps the device it does not mention');
});

test('people\'s entries are corrected in place; superseded entries leave search; a stale batch is refused', () => {
  const { db, memory } = setup();
  post(db, 'a', 'x');
  const mine = memory.save({ type: 'decision', content: '2026-10-23 任務超過 400k token 就 compact' });
  const batch = memory.batch(P);
  memory.accept(batch, { add: [{ type: 'decision', content: '舊決定' }] });
  const old = memory.list().items.find(item => item.content === '舊決定');
  post(db, 'b', 'y');
  const next = memory.batch(P);
  assert.throws(() => memory.accept(batch, {}), /already|已经/, 'a batch that was already applied cannot move the watermark again');
  memory.accept(next, { update: [{ id: mine.id, content: '2026-10-29 任務超過 300k token 就 compact' }], supersede: [{ id: old.id, by: null }] });
  const corrected = memory.list().items.find(item => item.id === mine.id);
  assert.deepEqual([corrected.content, corrected.edited], ['2026-10-29 任務超過 300k token 就 compact', true], 'the same entry is rewritten, not copied');
  assert.deepEqual(memory.search({}).items.map(item => item.id), [mine.id]);
  post(db, 'c', 'z');
  const third = memory.batch(P);
  const key = 'k'.repeat(1700);
  assert.deepEqual(memory.accept(third, { add: [{ type: 'bogus', content: 'x' }, { type: 'credential', content: `PEM ${key}` }, { type: 'other', content: '  ' }], update: [{ id: old.id, content: 'back again' }] }),
    { added: 1, updated: 0, retired: 0 }, 'a malformed item is dropped, not the batch; a superseded entry stays retired');
  assert.equal(memory.search({ type: 'credential' }).items[0].content, `PEM ${key}`, 'a long secret is kept whole');
  assert.throws(() => memory.accept(third, { add: 'x' }), /invalid|格式/);
});

test('one chat that keeps failing does not hold back another; yielding is not a failure; deletion mid-run keeps nothing', async () => {
  const { db, memory, tick } = setup();
  db.put('groupConversations', { id: 'g2', projectId: P, title: 'second' });
  post(db, 'a', 'in main');post(db, 'b', 'in second', { conversationId: 'g2' });
  memory.request(P);
  const config = { nodeId: 'n-srv' };
  const seen = [];
  const run = answer => memory.drainOne({ config, canRun: () => true, query: async prompt => { const batch = JSON.parse(prompt.slice(prompt.lastIndexOf('\n{') + 1)); seen.push(batch.chat); return answer(batch); } });
  await run(() => { throw new Error('bad'); });
  await run(() => ({ add: [{ type: 'other', content: 'second chat fact' }] }));
  assert.deepEqual(seen, ['demo', 'second'], 'the failing main chat waits while the second chat is organized');
  assert.equal(memory.progress(P).conversations.find(c => c.conversationId === 'g2').pending, 0);
  tick(11 * 60000);
  assert.deepEqual(await run(() => { throw new Error('Organizer device currently has no free slot'); }), { error: 'Organizer device currently has no free slot' });
  const { tr } = await import('../src/i18n.mjs');
  tick(31 * 60000);
  assert.deepEqual(await run(() => { throw new Error(tr('worker.organizerDeviceCurrentlyHasNo')); }), { yielded: true }, 'a full device is a wait, not a failure');
  assert.equal(memory.progress(P).conversations.find(c => c.conversationId === P).failures, 2);
  tick(61000);
  await run(async () => { db.deleteProject(P); return { add: [{ type: 'credential', content: 'token xxxxx' }] }; });
  assert.ok(!memory.list().items.some(item => item.content === 'token xxxxx'), 'a batch from a deleted project is not saved');assert.equal(db.get('memoryProgress', P), null);
});

test('a prompt over the argument limit leaves trailing messages for the next batch', () => {
  const { db, memory } = setup();
  // Quotes and backslashes double in JSON; the batch budget counts the escaped size.
  for (let i = 0; i < 40; i++) post(db, `q${i}`, '"\\'.repeat(1300));
  const batch = memory.batch(P);
  assert.ok(batch.messages.length < 40);
  const prompt = memory.prompt(batch, [], 'x'.repeat(18000));
  assert.ok(Buffer.byteLength(prompt) <= 120000, String(Buffer.byteLength(prompt)));
  assert.equal(batch.throughSeq, batch.seqs.at(-1), 'the watermark stops after the last message sent');
});

test('the daily run asks once per day after the set time, only for projects with new messages', () => {
  const { db, memory, set } = setup();
  db.put('projects', { id: 'quiet', name: 'quiet' });
  post(db, 'a', 'hello');
  const config = { nodeId: 'n-srv', time: '03:00' };
  set('2026-10-29T02:59:00');assert.equal(memory.schedule(config), false);
  set('2026-10-29T03:00:00');assert.equal(memory.schedule(config), true);
  assert.ok(memory.progress(P).requestedAt);assert.equal(memory.progress('quiet').requestedAt, null);
  assert.equal(memory.schedule(config), false, 'once a day');
  set('2026-10-30T03:10:00');assert.equal(memory.schedule(config), true);
  assert.equal(memory.schedule({ nodeId: '' }), false, 'nothing without an organizer');
  // The saved zone decides the day and time: 03:00 in Asia/Shanghai is 19:00 UTC the day before.
  db.remove('memoryProgress', '@schedule');db.put('memoryProgress', { id: P, projectId: P, conversations: {} });
  set('2026-10-31T18:59:00Z');assert.equal(memory.schedule({ nodeId: 'n', time: '03:00', timezone: 'Asia/Shanghai' }), false);
  set('2026-10-31T19:01:00Z');assert.equal(memory.schedule({ nodeId: 'n', time: '03:00', timezone: 'Asia/Shanghai' }), true);
  assert.equal(db.get('memoryProgress', '@schedule').day, '2026-11-01');
});

test('wb memory search arguments and the organizer setting', () => {
  const now = new Date('2026-10-29T12:00:00Z');
  assert.deepEqual(memorySearchInput(['隧道', '端口', '--type', 'environment', '--cli', 'claude', '--limit', '5'], now), { query: '隧道 端口', type: 'environment', cli: 'claude', limit: 5 });
  assert.equal(memorySearchInput(['--since', '2d'], now).since, '2026-10-27T12:00:00.000Z');
  assert.throws(() => memorySearchInput(['--role', 'x']));
  assert.throws(() => memorySearchInput(['--limit', 'many']));
  const saved = updateMemoryOrganizer({}, { nodeId: 'n', runtime: 'claude', model: 'haiku', effort: '', time: '04:30' }).memoryOrganizer;
  assert.deepEqual([saved.time, saved.revision], ['04:30', 1]);
  assert.throws(() => updateMemoryOrganizer({}, { nodeId: 'n', runtime: '', model: '', effort: '', time: '04:30' }));
  assert.throws(() => updateMemoryOrganizer({}, { nodeId: '', runtime: '', model: '', effort: '', time: '25:00' }));
  assert.equal(normalizePlatformSettings({}).memoryOrganizer.time, '03:00');
  assert.equal(updateMemoryOrganizer({}, { nodeId: '', runtime: '', model: '', effort: '', time: '03:00', timezone: 'Asia/Shanghai' }).memoryOrganizer.timezone, 'Asia/Shanghai');
  assert.throws(() => updateMemoryOrganizer({}, { nodeId: '', runtime: '', model: '', effort: '', time: '03:00', timezone: 'Mars/Base' }));
});

test('memory is shared across projects; deleting a project keeps what was learned there', () => {
  const { db, memory } = setup();
  db.put('projects', { id: 'p2', name: 'other' });
  post(db, 'a', 'x');
  memory.accept(memory.batch(P), { add: [{ type: 'environment', content: 'Worker 容量是 4' }] });
  const [entry] = memory.list().items;
  assert.deepEqual([entry.sourceProjectId, entry.sourceProject], [P, 'demo']);
  assert.equal(memory.search({ query: '容量' }, { projectId: 'p2' }).items[0].id, entry.id, 'a role in another project finds it');
  memory.request(P);
  db.deleteProject(P);
  assert.equal(memory.list().items.length, 1, 'the entry outlives its project');
  assert.equal(db.get('memoryProgress', P), null, 'the project\'s watermarks go');
  assert.equal(memory.list().items[0].sourceProject, null);
});

test('the platform view: organize-now stays available for projects not yet asked; the newest failure is shown', () => {
  const { db, memory, tick } = setup();
  db.put('projects', { id: 'p2', name: 'other' });
  db.put('projects', { id: 'assistant', name: 'Platform assistant', systemConfig: true });
  post(db, 'a', 'x');
  memory.request();
  db.put('roomMessages', { id: 'b', projectId: 'p2', sender: 'human', text: 'y', taskIds: [], createdAt: new Date().toISOString() });
  let view = memory.progress();
  assert.ok(view.requestedAt);assert.equal(view.unrequested, 1, 'the second project waits for a request');
  db.put('roomMessages', { id: 'c', projectId: 'assistant', sender: 'human', text: '設備 xxxxx-mac 的 Worker 容量是 4', taskIds: [], createdAt: new Date().toISOString() });
  assert.ok(memory.progress().projects.some(item => item.projectId === 'assistant'), 'the platform assistant\'s chat is organized too');
  memory.request();
  assert.equal(memory.progress().unrequested, 0);
  memory.fail(P, P, new Error('first'));tick(1000);memory.fail('p2', 'p2', new Error('second'));
  view = memory.progress();
  assert.equal(view.lastError, 'second');assert.equal(view.errorRetryAt, memory.progress('p2').retryAt);
});

test('the organizer sees which project an existing entry came from', () => {
  const { db, memory } = setup();
  db.put('projects', { id: 'p2', name: 'other' });
  post(db, 'a', 'Worker 容量');
  memory.accept(memory.batch(P), { add: [{ type: 'environment', content: 'Worker 容量是 4' }] });
  db.put('roomMessages', { id: 'b', projectId: 'p2', sender: 'human', text: 'Worker 容量', taskIds: [], createdAt: new Date().toISOString() });
  const batch = memory.batch('p2');
  assert.equal(memory.known(batch)[0].project, 'demo');
  assert.equal(memory.search({ query: '容量' }).items[0].project, 'demo', 'roles see it too');
});

test('the settings list pages and filters on Home', () => {
  const { memory, tick } = setup();
  for (let i = 0; i < 120; i++) { memory.save({ type: i % 2 ? 'lesson' : 'environment', content: `條目 ${i} ${i % 3 ? '伺服器' : 'gitconfig'}` }); tick(1000); }
  const first = memory.list({ limit: 50 });
  assert.deepEqual([first.items.length, first.total, first.all, first.offset], [50, 120, 120, 0]);
  assert.equal(first.items[0].content, '條目 119 伺服器', 'newest first');
  assert.equal(memory.list({ offset: 100, limit: 50 }).items.length, 20);
  assert.equal(memory.list({ type: 'lesson' }).total, 60);
  assert.equal(memory.list({ query: '伺服器 条目' }).total, 80, 'words must all match, Simplified finds Traditional');
  assert.equal(memory.list({ query: 'gitconfig', type: 'environment' }).total, 20);
  assert.throws(() => memory.list({ limit: 500 }));
});

test('the daily duplicate check merges repeats, keeps the newest of a conflict and leaves distinct look-alikes', async () => {
  const { db, memory, tick } = setup();
  const a = memory.save({ type: 'environment', content: '測試伺服器 xxxxx-test 的 Worker 容量是 4' });tick(1000);
  const b = memory.save({ type: 'environment', content: '測試伺服器 xxxxx-test 的 Worker 容量是 6' });tick(1000);
  const c = memory.save({ type: 'lesson', content: '不要 SIGKILL 正在啟動的 claude，會把設備登出' });tick(1000);
  const d = memory.save({ type: 'lesson', content: '不要 SIGKILL 正在啟動的 claude 進程，否則設備會被登出' });tick(1000);
  memory.save({ type: 'procedure', content: '部署前先跑 npm test' });
  const groups = memory.similarGroups();
  assert.deepEqual(groups.map(group => group.entries.map(entry => entry.id).sort()).sort(), [[a.id, b.id].sort(), [c.id, d.id].sort()].sort());
  memory.request();
  const prompts = [];
  const run = answer => memory.drainOne({ config: { nodeId: 'n-srv' }, canRun: () => true, query: async prompt => { prompts.push(prompt); return answer; } });
  const result = await run({ merge: [{ keep: b.id, content: '測試伺服器 xxxxx-test 的 Worker 容量是 6', remove: [a.id] }, { keep: d.id, content: '不要 SIGKILL 正在啟動的 claude 進程，否則設備會被登出', remove: [c.id, 'not-in-group'] }] });
  assert.deepEqual(result, { merged: 2, removed: 2 });
  assert.match(prompts[0], /xxxxx-test/);
  assert.deepEqual(memory.list().items.map(item => item.id).sort(), [b.id, d.id, memory.list().items.find(item => item.type === 'procedure').id].sort());
  assert.deepEqual(await run({ merge: [] }), { checked: true }, 'nothing left to check ends the run');
  assert.equal(await run({ merge: [] }), null);
  // Distinct look-alikes judged once are not sent again until one of them changes.
  const e = memory.save({ type: 'environment', content: '伺服器 xxxxx-a 的 Worker 容量是 2' });memory.save({ type: 'environment', content: '伺服器 xxxxx-b 的 Worker 容量是 2' });
  memory.request();prompts.length = 0;
  await run({ merge: [] });assert.equal(prompts.length, 1);
  assert.deepEqual(await run({ merge: [] }), { checked: true });assert.equal(prompts.length, 1);
  memory.save({ id: e.id, content: '伺服器 xxxxx-a 的 Worker 容量是 3' });memory.request();
  await run({ merge: [] });assert.equal(prompts.length, 2, 'a changed entry is checked again');
});

test('chats come before the duplicate check; AGENTS.md is read once per request; "from now on" skips history', async () => {
  const { db, memory } = setup();
  for (let i = 0; i < 70; i++) post(db, `m${i}`, `消息 ${i}`);
  memory.save({ type: 'other', content: '重複 一' });memory.save({ type: 'other', content: '重複 一 二' });
  memory.request();
  const reads = [], kinds = [];
  const run = () => memory.drainOne({ config: { nodeId: 'n-srv' }, canRun: () => true, agentsMd: async id => { reads.push(id); return '# rules'; },
    query: async prompt => { kinds.push(prompt.includes('"groups"') ? 'check' : 'batch'); return prompt.includes('"groups"') ? { merge: [] } : {}; } });
  await run();await run();await run();await run();
  assert.deepEqual(kinds, ['batch', 'batch', 'check']);
  assert.deepEqual(reads, [P], 'one AGENTS.md read for both batches');
  const { db: db2, memory: memory2 } = setup();
  for (let i = 0; i < 5; i++) post(db2, `old${i}`, 'old');
  memory2.skipHistory();
  assert.equal(memory2.progress(P).pending, 0);
  post(db2, 'new', 'new');
  assert.equal(memory2.progress(P).pending, 1, 'messages after switching on are organized');
});

test('organizer CLIs read the prompt from stdin where they can and keep nothing of the run', async () => {
  const config = { model: 'm', cwd: '/tmp/x' }, prompt = 'secret material';
  for (const runtime of ['claude', 'codex']) {
    const { args, stdin } = command({ ...config, runtime }, prompt);
    assert.equal(stdin, prompt);assert.ok(!args.includes(prompt), `${runtime} keeps the material out of the process list`);
  }
  const grok = command({ ...config, runtime: 'grok' }, prompt);
  assert.ok(!grok.args.includes(prompt) && grok.args.includes('--prompt-file') && grok.promptFile === join('/tmp/x', 'prompt.txt'), 'Grok reads a private prompt file');
  assert.ok(command({ ...config, runtime: 'claude' }, prompt).args.includes('--no-session-persistence'));
  assert.ok(command({ ...config, runtime: 'codex' }, prompt).args.includes('--ephemeral'));
  assert.equal(command({ ...config, runtime: 'agy' }, prompt).stdin, null, 'Agy only takes an argument');
  const home = await mkdtemp(join(tmpdir(), 'xxxxx-home-')), cwd = await mkdtemp(join(tmpdir(), 'summary-'));
  try {
    const claudeDir = join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-')), grokDir = join(home, '.grok', 'sessions', encodeURIComponent(cwd));
    const id = '01234567-89ab-cdef-0123-456789abcdef', agy = join(home, '.gemini', 'antigravity-cli');
    for (const dir of [claudeDir, grokDir, join(agy, 'brain', id), join(agy, 'conversations'), join(agy, 'brain', 'other')]) await mkdir(dir, { recursive: true });
    await writeFile(join(agy, 'conversations', `${id}.db`), 'x');
    await forgetRun('claude', cwd, '', { HOME: home });await forgetRun('grok', cwd, '', { HOME: home });
    await forgetRun('agy', cwd, JSON.stringify({ conversation_id: id }), { HOME: home });
    assert.ok(!existsSync(claudeDir) && !existsSync(grokDir) && !existsSync(join(agy, 'brain', id)) && !existsSync(join(agy, 'conversations', `${id}.db`)));
    assert.ok(existsSync(join(agy, 'brain', 'other')), 'other conversations stay');
    await forgetRun('agy', cwd, JSON.stringify({ conversation_id: '../../etc' }), { HOME: home });
  } finally { await rm(home, { recursive: true, force: true });await rm(cwd, { recursive: true, force: true }); }
});

test('a sessions-page CLI searches memory through its own bridge folder; nothing else passes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xxxxx-bridges-')), seen = [];
  const server = createServer((req, res) => { let body = '';req.on('data', chunk => { body += chunk; });req.on('end', () => { seen.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) }); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ total: 1, items: [{ id: 'm1', content: 'ok' }] })); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await mkdir(root, { recursive: true });
  const bridge = startNativeBridges({ root, home: `http://127.0.0.1:${server.address().port}`, token: 'worker-token', device: 'n-srv' });
  t.after(async () => { bridge.stop();server.close();await rm(root, { recursive: true, force: true }); });
  // A folder left from before a restart is cleared; only folders opened for a page turn are served.
  await mkdir(join(root, 'aaaaaaaaaaaaaaaaaaaaaaaa'), { recursive: true });
  const folder = await bridge.open('claude', '11111111-2222-3333-4444-555555555555');
  assert.ok(!existsSync(join(root, 'aaaaaaaaaaaaaaaaaaaaaaaa')));
  // Run the CLI without blocking this process, which also hosts the bridge.
  const cli = args => new Promise(resolve => { const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'wb-cli.mjs'), ...args], { env: { PATH: process.env.PATH, WB_NATIVE: '1', WB_BRIDGE: folder, LANG: 'en' } });
    let stdout = '', stderr = '';child.stdout.on('data', chunk => { stdout += chunk; });child.stderr.on('data', chunk => { stderr += chunk; });child.on('close', status => resolve({ status, stdout, stderr })); });
  const found = await cli(['memory', 'search', 'Worker', '--type', 'environment']);
  assert.equal(found.status, 0, found.stderr);assert.equal(JSON.parse(found.stdout).items[0].id, 'm1');
  assert.deepEqual(seen.map(item => [item.path, item.auth, item.body.query, item.body.type, item.body.caller]), [['/api/agent/native-memory/search', 'Bearer worker-token', 'Worker', 'environment', { cli: 'claude', device: 'n-srv' }]]);
  assert.notEqual((await cli(['note', 'hi'])).status, 0, 'other wb commands are not available here');
  assert.match((await cli(['help'])).stdout, /memory search/);
});

test('merges never lose text: chained merges, edits made meanwhile, cut secrets and over-long text are refused', () => {
  const { memory, tick } = setup();
  const a = memory.save({ type: 'environment', content: 'xxxxx-test 容量 4' });tick(1000);
  const b = memory.save({ type: 'environment', content: 'xxxxx-test 容量是 4' });tick(1000);
  const c = memory.save({ type: 'environment', content: 'xxxxx-test 的容量 4' });tick(1000);
  const k1 = memory.save({ type: 'credential', content: 'xxxxx 令牌 tok_ABCDEFGHIJKLMNOP1234' });tick(1000);
  const k2 = memory.save({ type: 'credential', content: 'xxxxx 的令牌是 tok_ABCDEFGHIJKLMNOP1234' });tick(1000);
  const groups = [{ entries: [a, b, c].map(e => memory.list().items.find(i => i.id === e.id)).map(v => ({ ...v, runtime: v.runtime, nodeId: v.nodeId })), signature: 's1' },
    { entries: [k1, k2].map(e => memory.list().items.find(i => i.id === e.id)), signature: 's2' }];
  const result = memory.acceptConsolidation(groups, { merge: [
    { keep: a.id, content: 'xxxxx-test 容量是 4', remove: [b.id] },
    { keep: c.id, content: 'only the second text', remove: [a.id] },        // chained: a was already used
    { keep: k2.id, content: 'xxxxx 的令牌', type: 'other', remove: [k1.id] }  // drops the token value
  ] });
  assert.deepEqual(result, { merged: 1, removed: 1 });
  const ids = memory.list().items.map(i => i.id);
  assert.ok(ids.includes(a.id) && ids.includes(c.id) && !ids.includes(b.id) && ids.includes(k1.id) && ids.includes(k2.id));
  // A person edits an entry while the model works: the answer about it is skipped.
  const stale = [{ entries: [memory.list().items.find(i => i.id === a.id), memory.list().items.find(i => i.id === c.id)], signature: 's3' }];
  tick(1000);memory.save({ id: c.id, content: 'xxxxx-test 的容量現在是 8' });
  assert.deepEqual(memory.acceptConsolidation(stale, { merge: [{ keep: a.id, content: 'x', remove: [c.id] }] }), { merged: 0, removed: 0 });
  assert.equal(memory.list().items.find(i => i.id === c.id).content, 'xxxxx-test 的容量現在是 8');
  const fresh = [{ entries: [memory.list().items.find(i => i.id === a.id), memory.list().items.find(i => i.id === c.id)], signature: 's4' }];
  assert.deepEqual(memory.acceptConsolidation(fresh, { merge: [{ keep: c.id, content: 'y'.repeat(900), remove: [a.id] }] }), { merged: 0, removed: 0 }, 'too long is refused, not cut');
});

test('an organizing answer only changes entries as the model saw them', () => {
  const { db, memory, tick } = setup();
  const mine = memory.save({ type: 'environment', content: 'Worker 容量 4' });
  post(db, 'a', 'Worker 容量改成 6');
  const batch = memory.batch(P);
  memory.prompt(batch, memory.known(batch), null);
  tick(1000);memory.save({ id: mine.id, content: 'Worker 容量 5（人工）' });
  memory.accept(batch, { update: [{ id: mine.id, content: 'Worker 容量 6' }], add: [{ type: 'other', content: 'x'.repeat(900) }] });
  assert.equal(memory.list().items.find(i => i.id === mine.id).content, 'Worker 容量 5（人工）', 'a person\'s edit made meanwhile stays');
  assert.equal(memory.list().items.length, 1, 'an over-long new entry is dropped, not cut');
});

test('counting the backlog reads only new receipts, also after a restart', async () => {
  const { db, memory } = setup();
  db.put('groupConversations', { id: 'empty', projectId: P, title: 'never used' });
  for (let i = 0; i < 5; i++) post(db, `m${i}`, 'x');
  memory.request(P);
  const run = () => memory.drainOne({ config: { nodeId: 'n' }, canRun: () => true, query: async () => ({}) });
  await run();await run();
  assert.equal(memory.progress(P).pending, 0);
  const reads = [], original = db.receiptsAfter.bind(db);
  db.receiptsAfter = (projectId, after) => { reads.push(after); return original(projectId, after); };
  const restarted = new (memory.constructor)(db);
  restarted.progress(P);
  assert.ok(reads.every(after => after >= 5), `a fresh Home starts after what was organized, not at 0 (${reads})`);
  post(db, 'm5', 'y');
  assert.equal(restarted.progress(P).pending, 1);
  db.remove('roomMessages', 'm5');
  restarted.request(P);await restarted.drainOne({ config: { nodeId: 'n' }, canRun: () => true, query: async () => ({}) });
  assert.equal(restarted.progress(P).pending, 0, 'a deleted message stops counting');
});
