// A synchronized path that leaves one device's scope (it became a symlink, or its folder a nested repository) is left out on
// that device only, with its last synchronized state kept there, instead of blocking this batch and every later one; the
// other devices go on syncing it, and content that moved into such a path is not deleted where that device still has it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { manifestDigest, sortedEntries } from '../src/source-sync-manifest.mjs';
import { captureDirectorySnapshot } from '../src/source-sync-files.mjs';
import { SourceSync } from '../src/source-sync.mjs';

async function capture(root) {
  const manifest = await captureDirectorySnapshot({ root, repositoryId: 'r', generation: 1, scopePolicy: {} });
  manifest.entries = sortedEntries(manifest.entries);
  return { status: 'completed', base: { ...manifest, entries: {}, digest: manifestDigest({}, {}) }, manifest };
}

/** Devices start from the same synchronized files; `edit` changes them on disk before the batch captures them. */
async function setup(t, nodes, files, edit, { kind } = {}) {
  const roots = {};
  for (const node of nodes) {
    roots[node] = await mkdtemp(join(tmpdir(), `wb-scope-${node}-`));
    for (const [path, text] of Object.entries(files)) { await mkdir(join(roots[node], path, '..'), { recursive: true });await writeFile(join(roots[node], path), text); }
  }
  t.after(() => Promise.all(Object.values(roots).map(root => rm(root, { recursive: true, force: true }))));
  const synced = (await capture(roots[nodes[0]])).manifest.entries;
  await edit(roots);
  const db = new Store(':memory:');
  db.put('sourceSyncConfigs', { id: 'p', projectId: 'p', enabled: true, revision: 1, generation: 1 });
  db.put('sourceSyncManifests', { id: 'p:r', projectId: 'p', repositoryId: 'r', generation: 1, revision: 1, scopePolicy: {}, entries: synced, origins: {}, digest: manifestDigest(synced, {}) });
  for (const node of nodes) db.put('sourceSyncDevices', { id: `p:r:${node}`, projectId: 'p', repositoryId: 'r', nodeId: node, generation: 1, entries: synced });
  const bindings = nodes.map(nodeId => ({ repositoryId: 'r', nodeId, root: roots[nodeId], scopeKind: 'directory', scopePolicy: {} }));
  const batch = db.put('sourceSyncBatches', { id: 'b1', projectId: 'p', ...(kind ? { kind, conflictIds: ['k1'], conflictGeneration: 1 } : { conflictIds: [] }), status: 'capturing', generation: 1, revision: 1,
    scopeKind: 'directory', repositoryIds: ['r'], nodeIds: nodes, sourceNodeId: nodes[1], bindings });
  for (const node of nodes) db.put('sourceSyncCommands', { id: `cap-${node}`, projectId: 'p', batchId: 'b1', repositoryId: 'r', nodeId: node, action: 'capture', scopeKind: 'directory', root: roots[node], result: await capture(roots[node]) });
  return { db, batch, synced };
}
const applies = db => Object.fromEntries(db.listSourceSyncCommands({ projectId: 'p', batchId: 'b1', action: 'apply' }).map(c => [c.nodeId, c.changes.map(x => [x.path, x.after ? 'write' : 'delete', ...(x.move ? ['move'] : [])])]));

test('a file that became a symlink on one device is left out there only; the other device\'s edit still syncs and the batch goes on', async t => {
  const { db, batch, synced } = await setup(t, ['a', 'b'], { 'notes.md': 'old', 'keep.md': 'old' }, async ({ a, b }) => {
    await rm(join(a, 'notes.md'));await symlink(join(a, 'keep.md'), join(a, 'notes.md'));
    await writeFile(join(b, 'notes.md'), 'edited on b');await writeFile(join(b, 'keep.md'), 'edited on b');
  });
  new SourceSync({ db }).prepare(batch);
  const after = db.get('sourceSyncBatches', 'b1');
  assert.equal(after.status, 'applying', `not blocked (${after.reason || ''})`);
  assert.deepEqual(after.scopeSkipped, [{ repositoryId: 'r', path: 'notes.md', nodeId: 'a', reason: 'symlink' }]);assert.equal(after.scopeSkippedCount, 1);
  assert.deepEqual(after.sourceInputNodeIds, ['b'], 'runs on A do not take a version A cannot hold');
  assert.notDeepEqual(db.get('sourceSyncManifests', 'p:r').entries['notes.md'], synced['notes.md'], 'B\'s edit is the synchronized state');
  assert.deepEqual(applies(db), { a: [['keep.md', 'write']] }, 'A gets keep.md; its symlink is neither read nor replaced');
  assert.deepEqual(db.get('sourceSyncDevices', 'p:r:a').entries['notes.md'], synced['notes.md'], 'A keeps its last synchronized state for the path');
});

test('a move into a folder one device leaves out: the third device gets the move, the excluding one keeps its copy', async t => {
  const { db, batch } = await setup(t, ['a', 'b', 'c'], { 'doc.md': 'the document', 'vend/x.md': 'x' }, async ({ a, b }) => {
    await mkdir(join(a, 'vend', '.git'));
    await rename(join(b, 'doc.md'), join(b, 'vend', 'doc.md'));
  });
  new SourceSync({ db }).prepare(batch);
  const after = db.get('sourceSyncBatches', 'b1');
  assert.equal(after.status, 'applying', `not blocked (${after.reason || ''})`);
  assert.ok(after.scopeSkipped.every(item => item.nodeId === 'a' && item.path.startsWith('vend/')));
  const entries = db.get('sourceSyncManifests', 'p:r').entries;
  assert.ok(entries['vend/doc.md'] && entries['doc.md'] === null, 'the move is the synchronized state');
  const changes = applies(db);
  assert.deepEqual(changes.c, [['doc.md', 'delete', 'move'], ['vend/doc.md', 'write', 'move']], 'C receives the move, not a bare delete');
  assert.equal(changes.a, undefined, 'A deletes nothing: the content moved into a folder A leaves out');
});

test('an unrelated deletion of bytes a left-out path already held is applied on the excluding device too', async t => {
  const { db, batch } = await setup(t, ['a', 'b', 'c'], { 'other.md': 'x', 'vend/x.md': 'x' }, async ({ a, b }) => {
    await mkdir(join(a, 'vend', '.git'));
    await rm(join(b, 'other.md'));
  });
  new SourceSync({ db }).prepare(batch);
  const changes = applies(db);
  assert.deepEqual(changes.a, [['other.md', 'delete']], 'A deletes other.md like C: vend/x.md held the same bytes before this batch');
  assert.deepEqual(changes.c, [['other.md', 'delete']]);
});

test('a resolution batch, which needs every side of its path, still stops', async t => {
  const { db, batch } = await setup(t, ['a', 'b'], { 'notes.md': 'old' }, async ({ a }) => { await rm(join(a, 'notes.md'));await symlink('/xxxxx', join(a, 'notes.md')); }, { kind: 'resolution' });
  db.put('sourceSyncConflicts', { id: 'k1', projectId: 'p', repositoryId: 'r', path: 'notes.md', status: 'resolving', generation: 1 });
  new SourceSync({ db }).prepare(batch);
  assert.equal(db.get('sourceSyncBatches', 'b1').reason, 'source_scope_changed');
});
