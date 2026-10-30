// .worktrees never syncs: a scan excludes it as one folder, a receiver refuses its paths, and records that still hold
// entries synchronized before the rule are cleaned at startup without sending deletions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { SourceSync } from '../src/source-sync.mjs';
import { captureDirectorySnapshot } from '../src/source-sync-files.mjs';
import { validateSourcePath, manifestDigest } from '../src/source-sync-manifest.mjs';

test('a worktree folder is excluded whole, with or without outputs, and its paths are refused on receipt', async t => {
  const root = await mkdtemp(join(tmpdir(), 'no-wt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.worktrees', 'task', 'repo'), { recursive: true });
  await writeFile(join(root, '.worktrees', 'task', 'repo', '.git'), 'gitdir: elsewhere');
  await writeFile(join(root, '.worktrees', 'task', 'repo', 'b.txt'), 'b');
  await writeFile(join(root, 'notes.md'), 'n');
  for (const scopePolicy of [{ sharedDocs: true }, { contentMode: 'source-and-outputs' }]) {
    const snapshot = await captureDirectorySnapshot({ root, repositoryId: 'project-files:p', generation: 1, scopePolicy });
    assert.deepEqual(Object.keys(snapshot.entries), ['notes.md']);
    assert.deepEqual(snapshot.excluded, [{ path: '.worktrees', reason: 'excluded' }]);
  }
  for (const path of ['.worktrees/task/repo/b.txt', '.worktrees/run-1/c.txt']) assert.throws(() => validateSourcePath(path, { sharedDocs: true }), e => e.code === 'unsafe_path');
});

test('startup drops synchronized worktree entries from stored records and bumps the canonical revision once', () => {
  const db = new Store(':memory:'), entry = { hash: 'a'.repeat(64), size: 1, executable: false };
  const keep = { 'notes.md': entry }, stale = { ...keep, '.worktrees/task/repo/b.txt': entry, '.worktrees/old/x.txt': null };
  db.put('sourceSyncManifests', { id: 'p:r', projectId: 'p', repositoryId: 'r', generation: 1, revision: 3, scopeKind: 'directory', scopePolicy: { sharedDocs: true }, entries: stale, digest: 'stale', origins: { 'notes.md': { nodeId: 'a' }, '.worktrees/task/repo/b.txt': { nodeId: 'b' } } });
  db.put('sourceSyncDevices', { id: 'p:r:a', projectId: 'p', repositoryId: 'r', nodeId: 'a', generation: 1, revision: 3, entries: stale });
  db.put('sourceSyncDevices', { id: 'p:r:b', projectId: 'p', repositoryId: 'r', nodeId: 'b', generation: 1, revision: 3, entries: keep });
  db.put('sourceSyncMetadataBaselines', { id: 'm1', projectId: 'p', repositoryId: 'r', generation: 1, path: '.worktrees/task/repo/b.txt' });
  db.put('sourceSyncMetadataBaselines', { id: 'm2', projectId: 'p', repositoryId: 'r', generation: 1, path: 'notes.md' });
  db.put('sourceSyncConflicts', { id: 'c1', projectId: 'p', repositoryId: 'r', path: '.worktrees/task/repo/b.txt', status: 'open' });
  db.put('sourceSyncConflicts', { id: 'c2', projectId: 'p', repositoryId: 'r', path: 'notes.md', status: 'open' });
  db.put('tasks', { id: 't1', projectId: 'p', sourceConflictId: 'c1', status: 'open' });
  db.put('tasks', { id: 't2', projectId: 'p', sourceConflictId: 'c1', status: 'running', currentRunId: 'run' });
  const sync = new SourceSync({ db });
  assert.equal(sync.dropExcludedEntries(), 4, 'the manifest, one device record, one baseline and one conflict change');
  const manifest = db.get('sourceSyncManifests', 'p:r');
  assert.deepEqual(manifest.entries, keep);
  assert.deepEqual(manifest.origins, { 'notes.md': { nodeId: 'a' } });
  assert.equal(manifest.digest, manifestDigest(keep, { sharedDocs: true }));
  assert.equal(manifest.revision, 4);
  assert.ok(db.list('sourceSyncVersions').some(v => v.revision === 4 && v.digest === manifest.digest), 'the cleaned manifest is a pinnable version');
  assert.deepEqual(db.get('sourceSyncDevices', 'p:r:a').entries, keep);
  assert.equal(db.get('sourceSyncDevices', 'p:r:b').revision, 3, 'an untouched record is not rewritten');
  assert.deepEqual(db.list('sourceSyncMetadataBaselines').map(b => b.id), ['m2']);
  assert.deepEqual(db.list('sourceSyncConflicts').map(c => [c.id, c.status]), [['c1', 'cancelled'], ['c2', 'open']]);
  assert.deepEqual(db.list('tasks').map(t => [t.id, t.status]), [['t1', 'cancelled'], ['t2', 'running']], 'a repair task already running is left to finish');
  assert.equal(sync.dropExcludedEntries(), 0, 'a second start changes nothing');
  assert.equal(db.get('sourceSyncManifests', 'p:r').revision, 4);
  db.close();
});

test('pending commands from before the start that name excluded paths block their batch once; cancelled conflicts stay cancelled', () => {
  const db = new Store(':memory:'), entry = { hash: 'a'.repeat(64), size: 1, executable: false };
  db.put('sourceSyncBatches', { id: 'b1', projectId: 'p', status: 'applying', revision: 1, bindings: [] });
  db.put('sourceSyncBatches', { id: 'b2', projectId: 'p', status: 'applying', revision: 1, bindings: [] });
  db.put('sourceSyncCommands', { id: 'c1', projectId: 'p', nodeId: 'a', batchId: 'b1', action: 'apply', scopePolicy: { sharedDocs: true }, changes: [{ path: '.worktrees/task/b.txt', before: null, after: entry }] });
  db.put('sourceSyncCommands', { id: 'c2', projectId: 'p', nodeId: 'a', batchId: 'b2', action: 'apply', scopePolicy: { sharedDocs: true }, changes: [{ path: 'notes.md', before: null, after: entry }] });
  const sync = new SourceSync({ db });
  let reads = 0; const list = db.listSourceSyncCommands.bind(db);
  db.listSourceSyncCommands = options => { if (options?.pending && !options.projectId) reads++; return list(options); };
  sync.schedule();
  assert.equal(db.get('sourceSyncBatches', 'b1').status, 'blocked');
  assert.equal(db.get('sourceSyncBatches', 'b1').reason, 'source_scope_changed');
  assert.equal(db.get('sourceSyncBatches', 'b2').status, 'applying', 'a batch without excluded paths keeps going');
  const first = reads; sync.schedule();
  assert.equal(reads - first, first - 1, 'later ticks do not scan the pending commands again');
  db.put('sourceSyncConflicts', { id: 'k1', projectId: 'p', repositoryId: 'r', path: 'notes.md', status: 'cancelled', generation: 1 });
  db.put('sourceSyncBatches', { id: 'b3', projectId: 'p', kind: 'resolution', status: 'reading', revision: 1, conflictIds: ['k1'], conflictGeneration: 1, bindings: [] });
  sync.blockPreparation(db.get('sourceSyncBatches', 'b3'), 'target_failed');
  assert.equal(db.get('sourceSyncConflicts', 'k1').status, 'cancelled', 'a failed resolution does not reopen a cancelled conflict');
  db.close();
});
