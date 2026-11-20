// Watch batches capture only the directories that changed, after a quiet period; a full sweep covers every directory now and then.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { SourceSyncHome, WATCH_QUIET_MS, WATCH_MAX_WAIT_MS, WATCH_SWEEP_MS } from '../src/source-sync-transport.mjs';
import { excludedSourcePath } from '../src/source-sync-manifest.mjs';

const REPOS = ['project-files:p1', 'code-a:p1', 'code-b:p1'];
async function setup(t) {
  const data = await mkdtemp(join(tmpdir(), 'wb-watch-scope-'));t.after(() => rm(data, { recursive: true, force: true }));
  const db = new Store(':memory:');let clock = Date.parse('2026-11-20T00:00:00Z');
  db.put('projects', { id: 'p1', name: 'p' });
  db.put('sourceSyncConfigs', { id: 'p1', projectId: 'p1', enabled: true, revision: 1, generation: 3, scopeKind: 'directory', mode: 'continuous', nodeIds: ['mac', 'srv'], repositoryIds: REPOS, displayNodeId: 'mac', bindings: [] });
  const home = new SourceSyncHome({ db, data, online: () => true, socket: () => ({ send() {} }), change: () => {}, rooms: null, query: async () => ({}), now: () => clock });
  const calls = [];home.sync.request = (projectId, input) => { calls.push(input); return { id: `b${calls.length}` }; };
  let n = 0;
  const notice = (repositoryId, node = 'srv') => home.watchMessage(node, { type: 'source_sync_dirty', projectId: 'p1', repositoryId, generation: 3, noticeId: `6f1a2b3c-0000-4000-8000-${String(++n).padStart(12, '0')}`, digest: String(n % 10).repeat(64), observedAt: new Date(clock).toISOString() });
  const settle = () => { for (const r of db.listProject('sourceSyncWatchNotices', 'p1')) db.put('sourceSyncWatchNotices', { ...r, handled: true }); };
  return { db, home, calls, notice, settle, tick: ms => { clock += ms; home.watchTick(); } };
}

test('a change waits for 30 quiet seconds, then only its directory is captured; the first batch after a start is a full sweep', async t => {
  const { home, calls, notice, settle, tick } = await setup(t);
  notice('code-a:p1');tick(10000);
  assert.equal(calls.length, 0, 'still within the quiet period');
  tick(WATCH_QUIET_MS);
  assert.equal(calls.length, 1);assert.equal(calls[0].repositoryIds, undefined, 'the first watch batch after Home starts covers every directory');
  settle();notice('code-a:p1');notice('code-a:p1', 'mac');tick(WATCH_QUIET_MS + 1);
  assert.deepEqual(calls[1].repositoryIds, ['code-a:p1'], 'only the changed directory, on both devices');
  settle();notice('project-files:p1');notice('code-b:p1');tick(WATCH_QUIET_MS + 1);
  assert.deepEqual(calls[2].repositoryIds.sort(), ['code-b:p1', 'project-files:p1']);
  // Every few hours, and after a device reconnects, the batch covers all directories again.
  settle();notice('code-a:p1');tick(WATCH_SWEEP_MS);
  assert.equal(calls[3].repositoryIds, undefined);
  settle();home.sweepDue('p1');notice('code-b:p1');tick(WATCH_QUIET_MS + 1);
  assert.equal(calls[4].repositoryIds, undefined, 'a reconnected device asks for one full sweep');
  settle();notice('code-b:p1');tick(WATCH_QUIET_MS + 1);
  assert.deepEqual(calls[5].repositoryIds, ['code-b:p1']);
});

test('a directory that keeps changing (a heartbeat) still syncs: at most two minutes after its first change', async t => {
  const { calls, notice, tick } = await setup(t);
  notice('project-files:p1');
  for (let waited = 0; waited + 10000 < WATCH_MAX_WAIT_MS; waited += 10000) { tick(10000); notice('project-files:p1'); }
  assert.equal(calls.length, 0, 'every change restarts the quiet period');
  tick(10000);
  assert.equal(calls.length, 1, 'but not beyond the maximum wait');
});

test('a synced folder\'s top-level tmp/ stays on its device; other tmp folders and shared docs still sync', () => {
  assert.equal(excludedSourcePath('tmp/mac-baidu-setup/heartbeat-locked-followup.json'), true);
  assert.equal(excludedSourcePath('tmp/a.txt', { contentMode: 'source-and-outputs' }), true);
  assert.equal(excludedSourcePath('src/tmp/fixture.json'), false);
  assert.equal(excludedSourcePath('tmp'), false);
  assert.equal(excludedSourcePath('.workbench/docs/report/TMS-AI-COVERAGE.html', { sharedDocs: true }), false);
});
