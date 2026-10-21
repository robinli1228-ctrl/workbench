// Data retention: finished sync bookkeeping and orphaned blobs are reclaimed; history and anything still in use stays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = name => import(pathToFileURL(join(root, 'src', name)).href);
const { Store } = await load('store.mjs');
const { retentionPlan, dataStats, cleanupData, vacuumIfWasteful, normalizeRetention, RETENTION_DEFAULTS } = await load('data-retention.mjs');

const NOW = Date.parse('2026-10-21T12:00:00Z'), DAY = 86400000, ago = days => new Date(NOW - days * DAY).toISOString();
const hash = n => n.toString(16).padStart(64, 'a');
const entries = n => Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`src/f${i}.mjs`, { hash: hash(n * 100 + i), size: 10 + i }]));

test('Home keeps commands of open batches and recent ones; finished, acknowledged, day-old ones go with their ack cache', async () => {
  const db = new Store(':memory:');
  db.put('sourceSyncBatches', { id: 'b-done', projectId: 'p1', status: 'completed', updatedAt: ago(3) });
  db.put('sourceSyncBatches', { id: 'b-open', projectId: 'p1', status: 'applying', updatedAt: ago(3) });
  db.put('sourceSyncBatches', { id: 'b-fresh', projectId: 'p1', status: 'completed', updatedAt: ago(0.2) });
  db.put('sourceSyncCommands', { id: 'c-done', projectId: 'p1', batchId: 'b-done', nodeId: 'n1', action: 'capture', baselineEntries: entries(1), result: { status: 'completed', manifest: { entries: entries(2) } }, ackedAt: ago(3), receivedAt: ago(3) });
  db.put('sourceSyncCommands', { id: 'c-open', projectId: 'p1', batchId: 'b-open', nodeId: 'n1', action: 'apply', ackedAt: ago(3), result: { status: 'completed', files: [] } });
  db.put('sourceSyncCommands', { id: 'c-fresh', projectId: 'p1', batchId: 'b-fresh', nodeId: 'n1', action: 'capture', ackedAt: ago(0.2), result: { status: 'completed' } });
  db.put('sourceSyncCommands', { id: 'c-unacked', projectId: 'p1', batchId: 'b-done', nodeId: 'n2', action: 'capture' });
  db.put('sourceSyncReceiptAcks', { id: `c-done:${hash(9)}`, nodeId: 'n1', ack: {} });
  db.put('sourceSyncReceiptAcks', { id: `c-open:${hash(8)}`, nodeId: 'n1', ack: {} });
  const plan = await retentionPlan(db, { now: NOW });
  assert.deepEqual(plan.records.map(x => `${x.kind}/${x.id}`).sort(), ['sourceSyncCommands/c-done', `sourceSyncReceiptAcks/c-done:${hash(9)}`]);
  assert.ok(plan.bytes > 1000);
  const stats = await dataStats(db, { now: NOW });
  const commands = stats.kinds.find(k => k.kind === 'sourceSyncCommands');
  assert.equal(commands.count, 4); assert.equal(commands.reclaimableCount, 1); assert.ok(commands.reclaimableBytes > 1000 && commands.reclaimableBytes < commands.bytes);
  assert.equal(stats.blobs, null, 'Home has no blob store');
  const summary = await cleanupData(db, { now: NOW, batch: 1 });
  assert.deepEqual(summary.deleted, { sourceSyncCommands: 1, sourceSyncReceiptAcks: 1 });
  assert.ok(!db.get('sourceSyncCommands', 'c-done'));
  assert.ok(db.get('sourceSyncCommands', 'c-open') && db.get('sourceSyncCommands', 'c-fresh') && db.get('sourceSyncCommands', 'c-unacked'));
  assert.equal(db.get('settings', 'data-maintenance').lastCleanupAt, new Date(NOW).toISOString());
  assert.equal((await dataStats(db, { now: NOW })).lastCleanupAt, new Date(NOW).toISOString());
});

test('Worker commands go only after their receipt was acknowledged; blobs nothing refers to go after 7 days', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-retention-')), blobRoot = join(dir, 'blobs');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Store(':memory:');
  const blob = (n, days, bytes = 'x'.repeat(100)) => { const path = join(blobRoot, hash(n)); writeFileSync(path, bytes); const at = (NOW - days * DAY) / 1000; utimesSync(path, at, at); };
  mkdirSync(blobRoot);
  blob(1, 10); blob(2, 10); blob(3, 10); blob(4, 2); writeFileSync(join(blobRoot, 'not-a-blob.txt'), 'keep');
  // c-old: acknowledged 3 days ago, result refers to blob 1 (still referenced until the command is gone).
  db.put('sourceSyncCommands', { id: 'c-old', projectId: 'p1', command: { action: 'capture', baselineEntries: entries(1) }, fingerprint: 'f', status: 'completed', result: { status: 'completed', manifest: { entries: { 'a.txt': { hash: hash(1), size: 100 } } } } });
  db.put('sourceSyncTransport', { id: 'c-old', projectId: 'p1', ready: true, acknowledgedAt: ago(3) });
  // c-pending: done but Home has not acknowledged its receipt; it refers to blob 2.
  db.put('sourceSyncCommands', { id: 'c-pending', projectId: 'p1', command: { action: 'capture' }, fingerprint: 'f', status: 'completed', result: { status: 'completed', manifest: { entries: { 'b.txt': { hash: hash(2), size: 100 } } } } });
  db.put('sourceSyncTransport', { id: 'c-pending', projectId: 'p1', ready: true });
  db.put('sourceSyncReceipts', { id: 'c-pending', projectId: 'p1', result: { status: 'completed' } });
  db.put('sourceSyncJournals', { id: 'j1', commandId: 'c-old', status: 'applied' });
  db.put('sourceSyncJournals', { id: 'j2', commandId: 'c-old', status: 'prepared' });
  db.put('sourceSyncCancellations', { id: 'c-old', commandId: 'c-old' });
  const plan = await retentionPlan(db, { blobRoot, now: NOW });
  assert.deepEqual(plan.records.map(x => `${x.kind}/${x.id}`).sort(), ['sourceSyncCancellations/c-old', 'sourceSyncCommands/c-old', 'sourceSyncJournals/j1', 'sourceSyncTransport/c-old']);
  assert.deepEqual(plan.blobs.map(b => b.name).sort(), [hash(1), hash(3)], 'blob 1 goes with c-old in the same pass, blob 2 stays for the pending command, blob 4 is too young');
  const stats = await dataStats(db, { blobRoot, now: NOW });
  assert.equal(stats.blobs.count, 4); assert.equal(stats.blobs.reclaimableCount, 2); assert.equal(stats.blobs.reclaimableBytes, 200);
  assert.equal(stats.reclaimableBytes, plan.bytes + 200);
  const first = await cleanupData(db, { blobRoot, now: NOW });
  assert.equal(first.blobsDeleted, 2); assert.equal(first.deleted.sourceSyncCommands, 1);
  assert.ok(db.get('sourceSyncJournals', 'j2'), 'a prepared journal is evidence of unfinished work and stays');
  // A second pass finds nothing more.
  const second = await cleanupData(db, { blobRoot, now: NOW });
  assert.equal(second.blobsDeleted, 0); assert.deepEqual(second.deleted, {});
  assert.deepEqual([hash(1), hash(2), hash(3), hash(4)].map(n => existsSync(join(blobRoot, n))), [false, true, false, true]);
  assert.ok(existsSync(join(blobRoot, 'not-a-blob.txt')), 'only hash-named files are ever touched');
  assert.equal(normalizeRetention({ blobDays: -1, manifestVersions: 9999 }).blobDays, RETENTION_DEFAULTS.blobDays);
  assert.equal(normalizeRetention({ manifestVersions: 9999 }).manifestVersions, 500);
});

test('manifest versions keep the newest 20 per repository plus any a binding or an open conflict still names', async () => {
  const db = new Store(':memory:');
  for (let i = 1; i <= 25; i++) db.put('sourceSyncVersions', { id: hash(i), projectId: 'p1', repositoryId: 'r1', entries: {}, digest: hash(900 + i) });
  for (let i = 1; i <= 3; i++) db.put('sourceSyncVersions', { id: hash(50 + i), projectId: 'p1', repositoryId: 'r2', entries: {} });
  db.put('repositoryWorkspaces', { id: 'rw', projectId: 'p1', nodeId: 'n1', repositoryId: 'r1', localRoot: '/x', sourceBaseManifestId: hash(2) });
  db.put('sourceSyncConflicts', { id: 'k1', projectId: 'p1', status: 'open', versionId: hash(3) });
  db.put('sourceSyncConflicts', { id: 'k2', projectId: 'p1', status: 'resolved', versionId: hash(4) });
  const plan = await retentionPlan(db, { now: NOW });
  assert.deepEqual(plan.records.map(x => x.id).sort(), [hash(1), hash(4), hash(5)].sort(), 'versions 1-5 are beyond the newest 20; 2 (binding) and 3 (open conflict) stay');
  assert.equal((await retentionPlan(db, { now: NOW, policy: { manifestVersions: 2 } })).records.filter(x => x.id.startsWith('00000')).length, 0);
});

test('VACUUM returns freed pages to the file system, only when enough of the file is free', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-vacuum-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Store(join(dir, 'store.sqlite'));
  for (let i = 0; i < 400; i++) db.put('sourceSyncCommands', { id: `c${i}`, projectId: 'p1', batchId: 'b', ackedAt: ago(5), receivedAt: ago(5), result: { status: 'completed' }, pad: 'p'.repeat(20000) });
  db.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const full = statSync(join(dir, 'store.sqlite')).size;
  assert.equal(vacuumIfWasteful(db, { now: NOW }).vacuumed, false, 'nothing is free yet');
  await cleanupData(db, { now: NOW });
  const result = vacuumIfWasteful(db, { now: NOW, minBytes: 1024 });
  assert.equal(result.vacuumed, true);
  db.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.ok(statSync(join(dir, 'store.sqlite')).size < full / 10, 'the file shrank');
  assert.equal(db.get('settings', 'data-maintenance').lastVacuumAt, new Date(NOW).toISOString());
  db.close();
});
