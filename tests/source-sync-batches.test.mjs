// The per-second sync tick selects work from the open-batch index instead of parsing the whole batch history.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { Store } = await import(pathToFileURL(join(root, 'src', 'store.mjs')).href);

test('listSourceSyncBatches returns only open batches, by project or status, through the partial index', () => {
  const db = new Store(':memory:');
  const put = (id, projectId, status) => db.put('sourceSyncBatches', { id, projectId, status, bindings: [], createdAt: '2026-10-21T00:00:00.000Z' });
  for (let i = 0; i < 300; i++) put(`old-${i}`, i % 2 ? 'p1' : 'p2', ['completed', 'partial_conflict', 'blocked', 'cancelled', 'preview_ready', 'evidence_ready'][i % 6]);
  put('q1', 'p1', 'queued'); put('c1', 'p1', 'capturing'); put('q2', 'p2', 'queued'); put('t1', 'p2', 'transferring');
  assert.deepEqual(db.listSourceSyncBatches().map(b => b.id), ['q1', 'c1', 'q2', 't1']);
  assert.deepEqual(db.listSourceSyncBatches({ status: 'queued' }).map(b => b.id), ['q1', 'q2']);
  assert.deepEqual(db.listSourceSyncBatches({ projectId: 'p1' }).map(b => b.id), ['q1', 'c1']);
  assert.deepEqual(db.listSourceSyncBatches({ projectId: 'p3' }), []);
  db.put('sourceSyncBatches', { ...db.get('sourceSyncBatches', 'c1'), status: 'completed' });
  assert.deepEqual(db.listSourceSyncBatches({ projectId: 'p1' }).map(b => b.id), ['q1'], 'a finished batch leaves the index');
  const plan = db.db.prepare("EXPLAIN QUERY PLAN SELECT data FROM records INDEXED BY records_source_batch_open WHERE kind='sourceSyncBatches' AND COALESCE(json_extract(data,'$.status'),'') NOT IN ('completed','partial_conflict','blocked','cancelled','preview_ready','evidence_ready')").all();
  assert.ok(plan.some(r => /records_source_batch_open/.test(r.detail)), 'the open-batch index is used');
});
