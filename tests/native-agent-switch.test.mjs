// Agent switch recovery: a lost commit acknowledgement, a stuck target start, a person's cancel, and what a committed
// switch carries to the new Agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = name => import(pathToFileURL(join(root, 'src', name)).href);
const { NativeAgentSwitches } = await load('native-agent-switch.mjs');
const { createWorkerNativeAgentSwitch } = await load('native-agent-switch-worker.mjs');
const { nativeSettingsKey } = await load('native-turns.mjs');
const { Store } = await load('store.mjs');
const { FolderAccess } = await load('folder-access.mjs');
const { readNativeSession, NATIVE_SWITCH_HELLO, NATIVE_SWITCH_READY } = await load('native-sessions.mjs');
const { createNativeAgentContext } = await load('native-agent-context.mjs');

const SOURCE = '0f3a3b2c-1111-4222-8333-444444444444', TARGET = '1f3a3b2c-1111-4222-8333-444444444444';
const tick = () => new Promise(r => setImmediate(r));
function home(t, worker) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-switch-home-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Store(join(dir, 'home.sqlite'));
  db.put('workers', { id: 'n1', capabilities: { nativeAgentSwitch: 1 }, runtimes: [{ type: 'codex', available: true }] });
  const calls = [];
  const switches = new NativeAgentSwitches({ db, online: () => true, change: () => {},
    turns: { active: () => false, waiting: () => [], process: () => false }, sideAsks: { busy: () => false },
    sessionRecord: () => ({ id: 'entry-1', workspace: '/srv/work/demo', title: 'Demo' }),
    workerQuery: async (_node, action, path) => { calls.push({ action, path }); return worker(action, path); } });
  const begin = () => switches.begin('n1', { operationId: crypto.randomUUID(), source: { runtime: 'claude', sessionId: SOURCE, entryId: 'entry-1' }, targetRuntime: 'codex', expectedRevision: 0 });
  return { db, switches, calls, begin };
}
const ready = { stage: 'ready', workspace: '/srv/work/demo', target: { runtime: 'codex', sessionId: TARGET, entryId: 'entry-2' }, contextId: 'ctx', contextHash: 'hash' };

test('a commit acknowledgement lost while the Worker was away is sent again when it connects, and the Git account carries over', async t => {
  let lose = true;
  const { db, switches, calls, begin } = home(t, action => {
    if (action === 'native_agent_switch_preflight') return { workspace: '/srv/work/demo' };
    if (action === 'native_agent_switch_prepare') return ready;
    if (action === 'native_agent_switch_status') { if (lose) throw Error('Home disconnected'); return ready; }
  });
  db.put('nativeSessionSettings', { id: nativeSettingsKey('n1', 'claude', SOURCE), hostingAccountId: 'acct-1', repoUrl: 'https://example.invalid/r.git', model: 'opus' });
  const { operation } = await begin();
  assert.equal(operation.stage, 'committed');
  assert.equal(db.get('nativeAgentSwitches', operation.id).published, false, 'the acknowledgement was lost');
  const carried = db.get('nativeSessionSettings', nativeSettingsKey('n1', 'codex', TARGET));
  assert.deepEqual([carried.hostingAccountId, carried.repoUrl, carried.model], ['acct-1', 'https://example.invalid/r.git', undefined]);
  lose = false;
  switches.resume('n1');
  for (let i = 0; i < 20 && !db.get('nativeAgentSwitches', operation.id).published; i++) await tick();
  assert.equal(db.get('nativeAgentSwitches', operation.id).published, true);
  assert.equal(calls.filter(c => c.action === 'native_agent_switch_status' && c.path.commit).length, 2);
});

test('a cancel waits for the step in flight, then the Worker stops the target and the conversation keeps its Agent', async t => {
  let release;
  const { db, switches, calls, begin } = home(t, action => {
    if (action === 'native_agent_switch_preflight') return { workspace: '/srv/work/demo' };
    if (action === 'native_agent_switch_prepare') return new Promise(r => { release = () => r({ stage: 'preparing', workspace: '/srv/work/demo' }); });
    if (action === 'native_agent_switch_abort') return { stage: 'failed', settled: true, error: 'Preparation cancelled', workspace: '/srv/work/demo' };
  });
  const started = begin();
  while (!release) await tick();
  const id = db.list('nativeAgentSwitches')[0].id;
  const cancelled = switches.cancel('n1', id);
  await tick();
  assert.equal(calls.some(c => c.action === 'native_agent_switch_abort'), false, 'no abort while the prepare reply is outstanding');
  release();
  await started;
  const { operation, conversation } = await cancelled;
  assert.equal(operation.stage, 'failed');
  assert.equal(calls.find(c => c.action === 'native_agent_switch_abort').path.stop, true);
  assert.equal(conversation.pendingSwitchId, null, 'the input unlocks');
  assert.equal(conversation.segments.length, 1);
});

function worker(t, { check, prepareMs = 60000, makeContext, stop = async () => ({}), sweepMs }) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-switch-worker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Store(join(dir, 'worker.sqlite')), calls = [];
  const handler = createWorkerNativeAgentSwitch({ db, nodeId: 'n1', data: dir, projectRoot: async p => p, runtimes: () => [], isPaused: () => false, sourceBusy: () => false,
    query: async (action, path) => { calls.push({ action, path }); return action === 'terminal_stop' ? stop(db, path) : {}; }, check, prepareMs, ...(makeContext ? { makeContext } : {}), ...(sweepMs ? { sweepMs } : {}) });
  const input = { operationId: crypto.randomUUID(), conversationId: 'c1', source: { runtime: 'claude', sessionId: SOURCE }, targetRuntime: 'codex', workspace: '/srv/work/demo' };
  db.put('terminalSessions', { id: input.operationId, nodeId: 'n1', projectId: `native-tui:${input.operationId}`, status: 'active' });
  const save = patch => db.put('workerNativeAgentSwitches', { id: input.operationId, ...input, leaseId: input.operationId, stage: 'preparing', published: false, startRequested: true, ...patch });
  return { db, calls, handler, input, save };
}

test('a target that has not created its session within the deadline is stopped and the switch fails', async t => {
  const { db, calls, handler, input, save } = worker(t, { check: () => ({ processState: 'active' }) });
  save({ startRequestedAt: new Date(Date.now() - 30000).toISOString() });
  assert.equal((await handler.handle('native_agent_switch_status', input)).stage, 'preparing', 'still within the deadline');
  save({ startRequestedAt: new Date(Date.now() - 120000).toISOString() });
  const view = await handler.handle('native_agent_switch_status', input);
  assert.equal(view.stage, 'failed');
  assert.equal(view.settled, true);
  assert.deepEqual(calls.map(c => c.action), ['terminal_stop']);
  assert.equal(calls[0].path.id, input.operationId);
  assert.equal(db.get('workerNativeAgentSwitches', input.operationId).stage, 'failed');
});

test('only a cancel stops a target that is still starting; a plain abort never signals it', async t => {
  const { calls, handler, input, save } = worker(t, { check: () => ({ processState: 'active' }) });
  save({ startRequestedAt: new Date().toISOString() });
  await assert.rejects(handler.handle('native_agent_switch_abort', input), /exit is not confirmed/);
  assert.equal(calls.length, 0);
  const view = await handler.handle('native_agent_switch_abort', { ...input, stop: true });
  assert.equal(view.stage, 'failed');
  assert.deepEqual(calls.map(c => c.action), ['terminal_stop']);
});

test('sessions may prepare the same folder (new session, switch, switching back); a project binding is still held off', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wb-switch-folder-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const folder = join(dir, 'app');mkdirSync(folder);
  const access = new FolderAccess({ db: new Store(join(dir, 'worker.sqlite')), roots: [], nodeId: 'n1', local: true });
  await access.prepare({ operationId: 'session-aaaa', scope: 'native:entry-a', path: folder });
  await access.prepare({ operationId: 'switch-bbbb', scope: 'native:entry-b', path: folder });
  await access.prepare({ operationId: 'switch-cccc', scope: 'native:entry-c', path: folder });
  await assert.rejects(access.prepare({ operationId: 'project-dddd', scope: 'project:p1', path: folder }), /another pending binding/);
});

test('the message that creates a switch session is not shown, and a handoff names home paths through $HOME', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wb-switch-history-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = '/srv/work/demo', folder = join(dir, 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(folder, { recursive: true });
  const rows = [{ type: 'user', uuid: 'u1', timestamp: '2026-10-24T01:00:00.000Z', cwd: workspace, message: { role: 'user', content: NATIVE_SWITCH_HELLO } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-10-24T01:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: `**${NATIVE_SWITCH_READY.slice(0, -1)}**` }] } },
    { type: 'user', uuid: 'u2', timestamp: '2026-10-24T01:01:00.000Z', cwd: workspace, message: { role: 'user', content: 'fix the build' } },
    { type: 'assistant', uuid: 'a2', timestamp: '2026-10-24T01:01:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'READY' }] } }];
  writeFileSync(join(folder, `${TARGET}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const env = { HOME: dir, CLAUDE_CONFIG_DIR: dir }, record = { id: TARGET, runtime: 'claude', workspace };
  for (const options of [{}, { historyPage: true }]) {
    const page = await readNativeSession('claude', TARGET, { env, record, ...options });
    assert.deepEqual(page.messages.map(m => [m.role, m.text]), [['user', 'fix the build'], ['assistant', 'READY']], 'only the fixed setup exchange is hidden');
  }
  const prior = process.env.HOME; process.env.HOME = dir; t.after(() => { process.env.HOME = prior; });
  const context = await createNativeAgentContext({ conversation: { id: 'c1', workspace }, segments: [], dataDir: join(dir, 'data'), readNativeSession: async () => ({ messages: [] }) });
  const line = context.excerpt.split('\n').find(l => l.startsWith('Earlier records'));
  assert.match(line, /"\$HOME"\/'data\/native-agent-context\//);
  assert.equal(line.includes(dir), false, 'the home folder, and so the user name, is not in the handoff');
});

test('a cancel while a status check is building the handoff is not undone by that check', async t => {
  let build;const built = new Promise(r => { build = r; });
  let state = 'active';
  const { db, handler, input, save } = worker(t, { check: () => ({ processState: state }), makeContext: () => built });
  save({ startRequestedAt: new Date().toISOString() });
  state = 'released';
  db.put('terminalSessions', { ...db.get('terminalSessions', input.operationId), exitCode: 0 });
  db.put('nativeCatalogEntries', { id: input.operationId, sessionId: TARGET });
  const checking = handler.handle('native_agent_switch_status', input);
  await tick();
  const cancelling = handler.handle('native_agent_switch_abort', { ...input, stop: true });
  build({ id: 'ctx', hash: 'h', excerpt: '' });
  assert.equal((await checking).stage, 'ready');
  assert.equal((await cancelling).stage, 'failed', 'the cancel runs after the check and wins');
  assert.equal(db.get('workerNativeAgentSwitches', input.operationId).stage, 'failed');
});

test('a target that had exited as its deadline passed still counts; one that exits only when stopped does not', async t => {
  for (const exitedFirst of [true, false]) {
    let state = 'active';
    const { db, handler, input, save } = worker(t, { check: () => ({ processState: state }),
      makeContext: async () => ({ id: 'ctx', hash: 'h', excerpt: '' }),
      stop: async (store, path) => { state = 'released'; store.put('terminalSessions', { ...store.get('terminalSessions', path.id), exitCode: 0 }); return { released: true, forced: false }; } });
    save({ startRequestedAt: new Date(Date.now() - 120000).toISOString() });
    // The launcher wrote the exit code but its process was still being recorded when the check ran.
    if (exitedFirst) db.put('terminalSessions', { ...db.get('terminalSessions', input.operationId), exitCode: 0 });
    db.put('nativeCatalogEntries', { id: input.operationId, sessionId: TARGET });
    const view = await handler.handle('native_agent_switch_status', input);
    assert.equal(view.stage, exitedFirst ? 'ready' : 'failed');
    if (!exitedFirst) assert.match(view.error, /did not start within/);
  }
});

test('cancelling a switch that already failed keeps its own reason', async t => {
  const { handler, input, save, calls } = worker(t, { check: () => ({ processState: 'released' }) });
  save({ stage: 'failed', error: 'Target Agent did not start within 5 minutes; it was stopped' });
  const view = await handler.handle('native_agent_switch_abort', { ...input, stop: true });
  assert.equal(view.error, 'Target Agent did not start within 5 minutes; it was stopped');
  assert.equal(calls.length, 0);
});

test('the deadline is enforced even when nobody asks for the status, e.g. after a Worker restart', async t => {
  const { db, calls, input, save } = worker(t, { check: () => ({ processState: 'active' }), sweepMs: 30 });
  save({ startRequestedAt: new Date(Date.now() - 120000).toISOString() });
  for (let i = 0; i < 100 && db.get('workerNativeAgentSwitches', input.operationId).stage !== 'failed'; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(db.get('workerNativeAgentSwitches', input.operationId).stage, 'failed');
  assert.equal(calls[0].action, 'terminal_stop');
});
