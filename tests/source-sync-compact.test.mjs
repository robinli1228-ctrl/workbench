// Once Home acknowledges a capture, the Worker drops the two whole file lists the record carried (the command's baseline and
// the result's manifest); records acknowledged earlier are compacted a few at a time; nothing unacknowledged is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { contentHash } from '../src/source-sync-manifest.mjs';
import { compactSyncCommand, compactAcknowledgedCommands } from '../src/data-retention.mjs';
import { SourceSyncClient } from '../src/source-sync-transport.mjs';

const list = n => Object.fromEntries(Array.from({ length: n }, (_, i) => [`dir/file-${i}.md`, { hash: contentHash(String(i)), size: i, executable: false }]));

function record(db, id, { acknowledged = false, action = 'capture', status = 'completed' } = {}) {
  const command = { id, projectId: 'p1', batchId: 'b1', repositoryId: 'r1', action, scopeKind: 'directory', baselineEntries: list(500) };
  const result = action === 'capture' ? { status, base: { entries: {} }, manifest: { entries: list(500), excluded: [] } } : { status, files: [] };
  db.put('sourceSyncCommands', { id, projectId: 'p1', command, fingerprint: contentHash(JSON.stringify(command)), status, result });
  db.put('sourceSyncTransport', { id, projectId: 'p1', batchId: 'b1', ready: true, ...(acknowledged ? { acknowledgedAt: '2026-11-08T00:00:00Z' } : {}) });
  return command;
}

test('an acknowledged capture keeps its status, fingerprint and counts but not the file lists; others are left alone', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-compact-'));t.after(() => rm(dir, { recursive: true, force: true }));
  const db = new Store(':memory:');
  const command = record(db, 'a'.repeat(64));
  const size = () => db.db.prepare("SELECT LENGTH(data) AS n FROM records WHERE kind='sourceSyncCommands' AND id=?").get('a'.repeat(64)).n;
  const before = size();
  const client = new SourceSyncClient({ db, data: dir, home: 'http://127.0.0.1:9', send: () => {}, resolveBinding: async () => null });
  const receipt = { status: 'completed', captureId: 'a'.repeat(64) };
  db.put('sourceSyncReceipts', { id: 'a'.repeat(64), projectId: 'p1', result: receipt });
  client.acknowledge('a'.repeat(64), { receiptHash: contentHash(JSON.stringify(receipt)) });
  const kept = db.get('sourceSyncCommands', 'a'.repeat(64));
  assert.equal(kept.command.baselineEntries, null);assert.equal(kept.result.manifest.entries, null);assert.equal(kept.compacted, true);
  assert.equal(kept.result.status, 'completed');assert.equal(kept.fingerprint, contentHash(JSON.stringify(command)));
  assert.ok(size() < before / 20, `${before} -> ${size()} bytes`);
  assert.equal(compactSyncCommand(db, 'a'.repeat(64)), false, 'once');

  // Not acknowledged, not a capture, or not finished: untouched.
  record(db, 'b'.repeat(64));record(db, 'c'.repeat(64), { acknowledged: true, action: 'apply' });record(db, 'd'.repeat(64), { acknowledged: true, status: 'reconciling' });
  for (let i = 0; i < 45; i++) record(db, contentHash(`old-${i}`), { acknowledged: true });
  assert.equal(await compactAcknowledgedCommands(db, { chunk: 7 }), 45, 'earlier acknowledged captures, a chunk at a time');
  assert.ok(db.get('sourceSyncCommands', 'b'.repeat(64)).command.baselineEntries, 'unacknowledged capture kept whole');
  assert.ok(db.get('sourceSyncCommands', 'c'.repeat(64)).command.baselineEntries, 'apply command untouched');
  assert.ok(db.get('sourceSyncCommands', 'd'.repeat(64)).result.manifest.entries, 'unfinished capture untouched');
  assert.equal(await compactAcknowledgedCommands(db), 0);
});

test('a late resend, a replay racing the acknowledgement, or a cancel of a compacted capture reruns and reports nothing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-compact-replay-'));t.after(() => rm(dir, { recursive: true, force: true }));
  const db = new Store(':memory:'), { SourceSyncWorker } = await import('../src/source-sync-worker.mjs'), sent = [];
  const command = record(db, 'e'.repeat(64), { acknowledged: true });
  db.put('sourceSyncTransport', { ...db.get('sourceSyncTransport', 'e'.repeat(64)), ready: false, message: { commandId: 'e'.repeat(64), secret: 's', projectId: 'p1' } });
  compactSyncCommand(db, 'e'.repeat(64));
  // Home unreachable: any plan fetch or upload would fail the test.
  const client = new SourceSyncClient({ db, data: dir, home: 'http://127.0.0.1:9', send: m => sent.push(m), resolveBinding: async () => null });
  await client.execute({ commandId: 'e'.repeat(64), secret: 's', projectId: 'p1' });
  assert.equal(db.get('sourceSyncReceipts', 'e'.repeat(64)), null, 'no receipt is created from the compacted result');
  assert.equal(db.get('sourceSyncTransport', 'e'.repeat(64)).ready, true, 'the transfer is settled, so recovery and blob cleanup are not held');
  assert.equal(db.get('sourceSyncTransport', 'e'.repeat(64)).recoveryError, undefined);
  client.cancel('e'.repeat(64));assert.deepEqual(sent, [], 'nothing replayed or re-sent');
  // The acknowledgement landed while a resend was already running: the stored command (now compacted) or the original.
  const worker = new SourceSyncWorker({ db, resolveBinding: async () => null, blobRoot: dir });
  for (const replay of [db.get('sourceSyncCommands', 'e'.repeat(64)).command, command]) {
    const result = await worker.execute(replay);
    assert.equal(result.compacted, true);assert.equal(db.get('sourceSyncReceipts', 'e'.repeat(64)), null);
  }
});

test('blobs of files in the Worker\'s current snapshot stay referenced after their captures are compacted', async t => {
  const { retentionPlan } = await import('../src/data-retention.mjs'), { utimes, writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'wb-compact-blobs-'));t.after(() => rm(dir, { recursive: true, force: true }));
  const db = new Store(':memory:'), current = contentHash('current'), stale = contentHash('stale');
  for (const hash of [current, stale]) { const path = join(dir, hash);await writeFile(path, 'x');await utimes(path, new Date(0), new Date(0)); }
  db.put('sourceSyncWatchStates', { id: 'p1:r1:1', projectId: 'p1', repositoryId: 'r1', generation: 1, entries: { 'a.md': { hash: current, size: 1, executable: false } } });
  const plan = await retentionPlan(db, { blobRoot: dir });
  const names = plan.blobs.map(b => b.name).join(' ');
  assert.ok(names.includes(stale), 'an unreferenced old blob goes');assert.ok(!names.includes(current), 'the snapshot keeps its file\'s blob');
});
