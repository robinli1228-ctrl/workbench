// Pausing a project's file sync stops what is running and starts nothing new, without leaving sync: resuming continues.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { SourceSync } from '../src/source-sync.mjs';
import { SourceSyncHome } from '../src/source-sync-transport.mjs';

function project(db) {
  db.put('projects', { id: 'p1', name: 'p' });
  db.put('sourceSyncConfigs', { id: 'p1', projectId: 'p1', enabled: true, revision: 4, generation: 2, scopeKind: 'directory', mode: 'continuous', nodeIds: ['mac', 'srv'], repositoryIds: ['project-files:p1'], displayNodeId: 'mac', bindings: [] });
  db.put('sourceSyncBatches', { id: 'q1', projectId: 'p1', kind: 'sync', status: 'queued', revision: 1, bindings: [], nodeIds: ['mac', 'srv'] });
  db.put('sourceSyncBatches', { id: 't1', projectId: 'p1', kind: 'sync', status: 'transferring', revision: 3, bindings: [], nodeIds: ['mac', 'srv'] });
  db.put('sourceSyncBatches', { id: 'v1', projectId: 'p1', kind: 'preview', status: 'capturing', revision: 1, bindings: [], nodeIds: ['mac', 'srv'] });
  db.put('sourceSyncCommands', { id: 'c1', projectId: 'p1', batchId: 'q1', nodeId: 'srv', action: 'capture' });
  db.put('sourceSyncWatchNotices', { id: 'srv:p1:project-files:p1', projectId: 'p1', nodeId: 'srv', repositoryId: 'project-files:p1', generation: 2, noticeId: 'n1', batchId: 'q1', attempts: 2, queuedAt: '2026-10-31T00:00:00.000Z' });
}

test('pausing stops running batches, keeps the change notices for later and refuses new batches; resuming allows them again', () => {
  const db = new Store(':memory:');project(db);
  const sync = new SourceSync({ db });
  const paused = sync.pause('p1', { paused: true });
  assert.equal(paused.paused, true);assert.equal(paused.revision, 4, 'not a configuration change');assert.equal(paused.generation, 2);
  assert.equal(db.get('sourceSyncBatches', 'q1').status, 'cancelling', 'a batch with a pending device command is cancelled the usual way');
  assert.equal(db.get('sourceSyncBatches', 't1').status, 'cancelled');assert.equal(db.get('sourceSyncBatches', 't1').reason, 'sync_paused');
  assert.equal(db.get('sourceSyncBatches', 'v1').status, 'capturing', 'a preview is left alone');
  const notice = db.get('sourceSyncWatchNotices', 'srv:p1:project-files:p1');
  assert.equal(notice.batchId, null);assert.equal(notice.attempts, 0);assert.ok(!notice.handled, 'the change still syncs after resuming');
  assert.throws(() => sync.request('p1', { requestId: 'r1', sourceNodeId: 'srv', targetNodeIds: ['mac'] }), /sync_paused/);
  assert.equal(sync.pause('p1', { paused: true }).paused, true, 'pausing twice changes nothing');
  const resumed = sync.pause('p1', { paused: false });
  assert.equal(resumed.paused, false);assert.equal(resumed.revision, 4);
  assert.throws(() => sync.request('p1', { requestId: 'r2', sourceNodeId: 'srv', targetNodeIds: ['mac'] }), error => error.code !== 'sync_paused');
  assert.throws(() => sync.pause('p1', { paused: 'yes' }), /invalid_scope/);
  db.put('sourceSyncConfigs', { ...db.get('sourceSyncConfigs', 'p1'), enabled: false });
  assert.throws(() => sync.pause('p1', { paused: true }), /sync_disabled/);
});

test('a paused project gets no watch configuration and its devices\' change notices are answered as obsolete', async t => {
  const data = await mkdtemp(join(tmpdir(), 'wb-pause-'));t.after(() => rm(data, { recursive: true, force: true }));
  const db = new Store(':memory:');project(db);
  const sent = [], socket = { send: text => sent.push(JSON.parse(text)) };
  const home = new SourceSyncHome({ db, data, online: () => true, socket: () => socket, change: () => {}, rooms: null, query: async () => ({}) });
  home.sync.pause('p1', { paused: true });
  const before = db.listProject('sourceSyncWatchNotices', 'p1')[0];
  home.watchMessage('srv', { type: 'source_sync_dirty', projectId: 'p1', repositoryId: 'project-files:p1', generation: 2, noticeId: '6f1a2b3c-0000-4000-8000-000000000001', digest: 'a'.repeat(64) });
  assert.deepEqual(sent.at(-1), { type: 'source_sync_dirty_ack', noticeId: '6f1a2b3c-0000-4000-8000-000000000001', disposition: 'obsolete' });
  assert.deepEqual(db.listProject('sourceSyncWatchNotices', 'p1')[0], before, 'no notice recorded while paused');
  // The browser route.
  const req = Object.assign((await import('node:stream')).Readable.from([Buffer.from(JSON.stringify({ paused: false }))]), { method: 'POST', url: '/api/projects/p1/source-sync/pause', headers: {} });
  const res = { writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); }, setHeader() {} };
  await home.browserHttp(req, res, '/api/projects/p1/source-sync/pause');
  assert.equal(res.body.paused, false);
});
