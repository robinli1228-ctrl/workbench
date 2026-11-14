// The user picks a device's version for ticked conflicting files on the sync panel: each is applied like a reviewed
// resolution; files without a record, being applied, or repaired by a running role are reported and left alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { SourceSyncConflicts, deviceSides } from '../src/source-sync-conflicts.mjs';

const H = c => c.repeat(64);
function setup({ paused = false } = {}) {
  const db = new Store(':memory:'), resolved = [];
  db.put('projects', { id: 'p', name: 'p' });
  const sync = { config: () => ({ generation: 3, paused }), resolve: (c, proposal) => { resolved.push({ c, proposal }); return { id: `batch-${resolved.length}` }; } };
  const side = (nodeId, h, extra = {}) => ({ nodeId, root: `/xxxxx/${nodeId}`, endpointId: `e-${nodeId}${extra.sourceRunId ? '-run' : ''}`, entry: { hash: H(h), size: 1, executable: false }, ...extra });
  const conflict = (id, path, extra = {}) => db.put('sourceSyncConflicts', { id, projectId: 'p', repositoryId: 'project-files:p', path, syncGeneration: 3, generation: 1, status: 'needs_input', scopeKind: 'directory',
    sides: [side('mac', 'a', { sourceRunId: 'r0' }), side('mac', 'b'), side('deb', 'c')], ...extra });
  return { db, resolved, conflict, conflicts: new SourceSyncConflicts({ db, rooms: null, sync }) };
}

test('a chosen device version is applied; the project-folder copy wins over an isolated output on that device', () => {
  const { db, resolved, conflict, conflicts } = setup();
  conflict('c1', 'docs/a.md', { ownerTaskId: 't1' });
  db.put('tasks', { id: 't1', projectId: 'p', status: 'ready' });
  const [r] = conflicts.choose('p', [{ repositoryId: 'project-files:p', path: 'docs/a.md', sourceNodeId: 'mac' }]);
  assert.deepEqual(r, { repositoryId: 'project-files:p', path: 'docs/a.md', status: 'applying', conflictId: 'c1' });
  assert.equal(resolved[0].proposal.entry.hash, H('b'));assert.equal(resolved[0].proposal.sourceNodeId, 'mac');assert.equal(resolved[0].proposal.sourceRoot, '/xxxxx/mac');
  const after = db.get('sourceSyncConflicts', 'c1');
  assert.equal(after.status, 'verifying');assert.equal(after.review.kind, 'human_choice');assert.equal(after.resolutionBatchId, 'batch-1');
  assert.equal(db.get('tasks', 't1').status, 'cancelled', 'the unstarted repair task is cancelled');
});

test('files that cannot be chosen now are reported, not touched', () => {
  const { db, resolved, conflict, conflicts } = setup();
  conflict('busy', 'b.md', { status: 'verifying' });
  conflict('owned', 'o.md');db.put('runs', { id: 'run1', projectId: 'p', status: 'running', sourceConflictId: 'owned' });
  conflict('old', 'g.md', { syncGeneration: 2 });
  const out = conflicts.choose('p', [
    { repositoryId: 'project-files:p', path: 'none.md', sourceNodeId: 'mac' },
    { repositoryId: 'project-files:p', path: 'b.md', sourceNodeId: 'mac' },
    { repositoryId: 'project-files:p', path: 'o.md', sourceNodeId: 'mac' },
    { repositoryId: 'project-files:p', path: 'g.md', sourceNodeId: 'mac' }]);
  assert.deepEqual(out.map(x => x.status), ['not_ready', 'busy', 'owner_running', 'not_ready']);
  conflict('c2', 'c.md');
  assert.equal(conflicts.choose('p', [{ repositoryId: 'project-files:p', path: 'c.md', sourceNodeId: 'other' }])[0].status, 'side_missing');
  assert.equal(resolved.length, 0);assert.equal(db.get('sourceSyncConflicts', 'c2').status, 'needs_input');
  assert.throws(() => conflicts.choose('p', []), /invalid_scope/);
});

test('a simple-mode conflict goes out the way its own Use version button sends it', () => {
  const { db, resolved, conflict, conflicts } = setup();
  conflict('m1', 'm.md', { detection: 'metadata', status: 'open' });
  assert.equal(conflicts.choose('p', [{ repositoryId: 'project-files:p', path: 'm.md', sourceNodeId: 'deb' }])[0].status, 'applying');
  assert.equal(resolved[0].proposal.entry.hash, H('c'));assert.equal(db.get('sourceSyncConflicts', 'm1').status, 'open');
});

test('picking the same device again after a blocked attempt starts a new batch; a pending one or a paused sync refuses', () => {
  const { db, resolved, conflict, conflicts } = setup();
  conflict('c1', 'a.md');
  const pick = () => conflicts.choose('p', [{ repositoryId: 'project-files:p', path: 'a.md', sourceNodeId: 'deb' }])[0].status;
  assert.equal(pick(), 'applying');
  db.put('sourceSyncBatches', { id: 'batch-1', projectId: 'p', kind: 'resolution', status: 'capturing', conflictIds: ['c1'] });
  db.put('sourceSyncConflicts', { ...db.get('sourceSyncConflicts', 'c1'), status: 'needs_input' });
  assert.equal(pick(), 'busy', 'a resolution still running for it');
  db.put('sourceSyncBatches', { ...db.get('sourceSyncBatches', 'batch-1'), status: 'blocked' });
  assert.equal(pick(), 'applying');
  assert.notEqual(resolved[0].proposal.id, resolved[1].proposal.id, 'a new proposal, so a new batch');
  assert.equal(db.get('sourceSyncConflicts', 'c1').resolutionBatchId, 'batch-2');
  const quiet = setup({ paused: true });quiet.conflict('c2', 'b.md');
  assert.equal(quiet.conflicts.choose('p', [{ repositoryId: 'project-files:p', path: 'b.md', sourceNodeId: 'deb' }])[0].status, 'paused');
});

test('each device is represented by its project-folder copy, not an isolated run output', () => {
  const sides = [{ nodeId: 'mac', sourceRunId: 'r0', root: '/xxxxx/run' }, { nodeId: 'mac', root: '/xxxxx/mac' }, { nodeId: 'deb', root: '/xxxxx/deb' }];
  assert.deepEqual(deviceSides({ sides }).map(s => s.root), ['/xxxxx/mac', '/xxxxx/deb']);
});
