// Each recent-output card carries one time: the newest of its write record, its newest mention and the file's
// modification, and the list is ordered by that time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { recentProjectArtifacts } from '../src/run-artifacts.mjs';

const P = 'p1';
function env() {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'demo' });
  db.put('workers', { id: 'w1', name: 'mac' });
  const run = (id, name, runtime, at) => db.put('runs', { id, projectId: P, nodeId: 'w1', workspace: '/xxxxx/proj', roleId: id, roleSnapshot: { name, runtime }, status: 'succeeded', createdAt: at, updatedAt: at, finishedAt: at, lastSeq: 0 });
  // A recorded tool event, stored as Home keeps it.
  const write = (runId, path, at, seq = 1) => db.db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(`${runId}-${seq}`, runId, seq, JSON.stringify({ id: `${runId}-${seq}`, runId, seq, type: 'tool', createdAt: at,
    payload: { item: { id: `${runId}-tool-${seq}`, type: 'fileChange', status: 'completed', changes: [{ path, kind: { type: 'add' } }] } } }));
  const mention = (runId, path, at) => db.put('roomMessages', { id: `msg-${runId}`, projectId: P, runId, sender: 'agent', text: `Final: [REVIEW](<${path}>)`, createdAt: at });
  return { db, run, write, mention };
}
const list = (db, modified = {}) => recentProjectArtifacts(db, P,
  async (run, action, paths) => ({ files: paths.map(path => ({ path, size: 10, ...(modified[path] ? { modifiedAt: modified[path] } : {}) })) }), () => true);

test('a later mention moves the card up and is the one time it shows', async () => {
  const e = env(), review = '.workbench/docs/r/REVIEW.md', other = '.workbench/docs/r/OTHER.md';
  e.run('codex', 'Executor', 'codex', '2026-10-26T11:05:00.000Z'); e.write('codex', review, '2026-10-26T11:05:00.000Z');
  e.run('later', 'Builder', 'claude', '2026-10-26T13:00:00.000Z'); e.write('later', other, '2026-10-26T13:00:00.000Z');
  e.run('sup', 'Supervisor', 'codex', '2026-10-26T14:54:00.000Z'); e.mention('sup', review, '2026-10-26T14:54:00.000Z');
  const { items } = await list(e.db, { [review]: '2026-10-26T13:06:00.000Z' });
  assert.deepEqual(items.map(i => i.name), ['REVIEW.md', 'OTHER.md'], 'ordered by the newest evidence, not by the old write record');
  assert.equal(items.length, 2, 'the mention and the write record stay one card');
  assert.deepEqual(items[0].latest, { kind: 'reference', at: '2026-10-26T14:54:00.000Z', roleName: 'Supervisor', runtime: null });
  assert.equal(items[0].recordedAt, '2026-10-26T11:05:00.000Z', 'the file is still read through its write record');
});

test('a modification newer than every record is the time shown', async () => {
  const e = env(), path = '.workbench/docs/r/REVIEW.md';
  e.run('codex', 'Executor', 'codex', '2026-10-26T11:05:00.000Z'); e.write('codex', path, '2026-10-26T11:05:00.000Z');
  const { items } = await list(e.db, { [path]: '2026-10-26T13:06:00.000Z' });
  assert.deepEqual(items[0].latest, { kind: 'modified', at: '2026-10-26T13:06:00.000Z', roleName: null, runtime: null });
  const { items: plain } = await list(e.db);
  assert.deepEqual(plain[0].latest, { kind: 'write', at: '2026-10-26T11:05:00.000Z', roleName: 'Executor', runtime: 'codex' }, 'without a newer time the write record stands');
});

test('shared project files get the same single newest time and order', async () => {
  const e = env(), review = '.workbench/docs/r/REVIEW.md', other = '.workbench/docs/r/OTHER.md';
  e.run('codex', 'Executor', 'codex', '2026-10-26T11:05:00.000Z'); e.write('codex', review, '2026-10-26T11:05:00.000Z');
  e.run('later', 'Builder', 'claude', '2026-10-26T13:00:00.000Z'); e.write('later', other, '2026-10-26T13:00:00.000Z');
  e.run('sup', 'Supervisor', 'codex', '2026-10-26T14:54:00.000Z'); e.mention('sup', review, '2026-10-26T14:54:00.000Z');
  const projectFiles = { reference: (run, path) => ({ scopeId: 's1', path }), legacyReadable: () => false, config: () => ({}),
    read: async (projectId, scopeId, path) => ({ path: `/xxxxx/proj/${path}`, shared: true, syncState: 'synced', modifiedAt: path === review ? '2026-10-26T13:06:00.000Z' : '2026-10-26T13:00:00.000Z' }) };
  const { items } = await recentProjectArtifacts(e.db, P, async () => ({}), () => true, projectFiles);
  assert.deepEqual(items.map(i => i.name), ['REVIEW.md', 'OTHER.md']);
  assert.deepEqual(items[0].latest, { kind: 'reference', at: '2026-10-26T14:54:00.000Z', roleName: 'Supervisor', runtime: null });
  assert.equal(items[0].sourceKind, 'write', 'still read through its write record');
});
