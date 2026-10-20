// A workspace read gets one project's page summaries straight from SQLite; they project exactly like the full records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = name => import(pathToFileURL(join(root, 'src', name)).href);
const { Store } = await load('store.mjs');
const { workspaceState, workspaceScope, PAGE_SUMMARY_PATHS } = await load('workspace-state.mjs');
const { pageSummaries, summaryQuery } = await load('workspace-summaries.mjs');
const { messageProgress, messageProgressView } = await load('message-progress.mjs');

const body = (kb, seed) => `${seed} 正文 `.repeat(Math.ceil((kb * 1024) / 8)).slice(0, kb * 1024);
const at = minute => `2026-10-20T10:${String(minute).padStart(2, '0')}:00.000Z`;
function seeded() {
  const db = new Store(':memory:');
  for (const id of ['p1', 'p2']) db.put('projects', { id, name: id, root: `/tmp/${id}`, createdAt: at(0) });
  const role = { id: 'r1', name: 'Dev', runtime: 'claude', prompt: body(2, 'prompt'), instructions: body(4, 'ins'), systemPrompt: 'sys' };
  let i = 0;
  const run = (projectId, extra) => { i++; db.put('runs', { id: `run${i}`, projectId, taskId: `t${i}`, roleId: 'r1', nodeId: 'n1', status: 'succeeded', roleSnapshot: role, originalRoleSnapshot: role, executionBinding: { nodeId: 'n1', role }, contextPacket: body(40, 'ctx'), teamContext: body(8, 'team'), inputTask: body(2, 'in'), runtimeInstructions: 'x', executionConfiguration: { a: 1 }, error: 'e'.repeat(500), createdAt: at(i), startedAt: at(i), finishedAt: at(i + 1), ...extra }); return `run${i}`; };
  const task = (projectId, runId, extra = {}) => db.put('tasks', { id: `t${runId.slice(3)}`, projectId, roleId: 'r1', status: 'completed', currentRunId: runId, prompt: body(2, 'p'), inputTask: 'in', contextPacket: body(40, 'c'), teamContext: 't', roleSnapshot: role, executionBinding: { role }, origin: 'chat', createdAt: at(1), ...extra });
  const request = (projectId, runId, extra = {}) => db.put('coordinationRequests', { id: `req${runId.slice(3)}`, projectId, taskId: `t${runId.slice(3)}`, currentRunId: runId, targetRoleId: 'r1', status: 'succeeded', kind: 'consult', summary: body(3, 's'), resumeSummary: 'rs', execution: { log: 'l' }, fingerprint: 'f', targetSnapshot: { nodeId: 'n1' }, executionBinding: { role }, createdAt: at(1), ...extra });
  // p1: a consult that replied in the run result, one that replied only through the report, one with no reply at all.
  const replied = run('p1', { result: body(8, 'res'), report: { summary: body(6, 'sum'), verdict: 'ok' } }); task('p1', replied); request('p1', replied);
  const reported = run('p1', { result: '   ' }); task('p1', reported); request('p1', reported, { reportSummary: 'short report' });
  const silent = run('p1', { result: '' }); task('p1', silent); request('p1', silent);
  db.put('runReports', { id: replied, projectId: 'p1', roleId: 'r1', summary: body(6, 'rep'), verdict: 'ok' });
  for (const id of [replied, reported, silent]) db.put('commands', { id: `c-${id}`, type: 'launch', runId: id, nodeId: 'n1', acked: true, firstSentAt: at(1), ackedAt: at(1), launchInput: { platformPrompt: body(10, 'pp') } });
  // p2: a running run must still mark the sidebar; its finished history must not be read at all.
  const other = run('p2', { status: 'running', result: null }); task('p2', other, { status: 'in_progress' }); request('p2', other, { status: 'running' });
  run('p2', { result: body(8, 'old') });
  db.put('workers', { id: 'n1', name: 'W', runtimes: [] });
  return db;
}
const withProgress = (rows, launches) => {
  const view = messageProgressView(rows), map = new Map(launches.map(c => [c.runId, c]));
  return rows.requests.map(r => { const { fingerprint, targetSnapshot, ...rest } = r; return { ...rest, messageProgress: messageProgress(view, r, () => true, map.get(r.currentRunId) || null, map) }; });
};
const base = db => ({ projects: db.list('projects'), workers: db.list('workers').map(w => ({ ...w, online: true })), roleSessions: [], conversations: [], nativeTurnExecutions: [] });

test('summaries from SQLite project to the same page state as full records, including progress and sidebar marks', () => {
  const db = seeded();
  const full = { runs: db.list('runs'), tasks: db.list('tasks'), requests: db.list('coordinationRequests'), runReports: db.list('runReports') };
  const launches = db.list('commands').filter(c => c.type === 'launch');
  const page = pageSummaries(db, 'p1');
  assert.equal(page.runs.length, 3); assert.equal(page.otherActiveRuns.length, 1); assert.equal(page.launches.length, 3);
  assert.equal('launchInput' in page.launches[0], false);
  for (const run of page.runs) for (const field of ['result', 'contextPacket', 'teamContext']) assert.equal(field in run, false, `${field} never leaves SQLite`);
  assert.deepEqual(page.runs.map(r => r.hasReply), [true, false, false]);
  assert.deepEqual(page.requests.map(r => r.hasReply), [false, true, false]);
  const fromFull = workspaceState({ ...base(db), ...full, requests: withProgress(full, launches) }, 'p1').state;
  const fromPage = workspaceState({ ...base(db), runs: [...page.runs, ...page.otherActiveRuns], tasks: page.tasks, runReports: page.runReports, requests: withProgress(page, page.launches) }, 'p1').state;
  for (const key of ['runs', 'tasks', 'requests', 'runReports', 'sidebarExecutions']) assert.deepEqual(fromPage[key], fromFull[key], key);
  assert.deepEqual(fromPage.requests.map(r => r.messageProgress.stage), ['result_saved', 'result_saved', 'no_response']);
  assert.deepEqual(fromPage.sidebarExecutions.map(e => e.projectIds), [['p2']]);
  assert.equal('hasReply' in fromPage.runs[0], false); assert.equal('hasReply' in fromPage.requests[0], false);
});

test('the scoped read resolves the same project as the projection, and its query needs no sort step', () => {
  const db = seeded();
  assert.deepEqual(workspaceScope(db, 'p2'), { projectId: 'p2' });
  assert.deepEqual(workspaceScope(db, 'deleted'), { projectId: 'p1' });
  assert.deepEqual(workspaceScope(new Store(':memory:'), 'p1'), { projectId: null });
  const plan = db.db.prepare(`EXPLAIN QUERY PLAN ${summaryQuery(`json_remove(data,${PAGE_SUMMARY_PATHS.runReports.map(f => `'$.${f}'`).join(',')})`)}`).all('runs', 'p1').map(r => r.detail).join('\n');
  assert.match(plan, /records_kind_project/); assert.doesNotMatch(plan, /TEMP B-TREE/);
});
