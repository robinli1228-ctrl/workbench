// The sync panel lists the files waiting to sync (name, place, direction, size, time) without storing that list: each
// device compares the observation it already keeps with the synchronized list Home sends, whole the first time and as a
// small change afterwards, and a running batch shows what it is writing where.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { contentHash, sortedEntries } from '../src/source-sync-manifest.mjs';
import { ChangeLists, changedFiles } from '../src/source-sync-changes.mjs';
import { SourceSyncHome } from '../src/source-sync-transport.mjs';

const entry = (text, executable = false) => ({ hash: contentHash(text), size: text.length, executable });
const P = 'p1', R = `${P}:docs`;

test('only what differs from the last synchronized state is listed, in path order', () => {
  const synced = { 'a.md': entry('a'), 'b.md': entry('b'), 'gone.md': entry('g') };
  const observed = { 'a.md': entry('a'), 'b.md': entry('bb'), 'new.md': entry('new') };
  assert.deepEqual(changedFiles(observed, synced).map(i => [i.path, i.change, i.size, i.previousSize]),
    [['b.md', 'modified', 2, 1], ['gone.md', 'deleted', null, 1], ['new.md', 'added', 3, null]]);
  assert.deepEqual(changedFiles({ 'x.sh': entry('x', true) }, { 'x.sh': entry('x') }).map(i => i.change), ['modified'], 'a mode change counts');
});

test('Home sends the whole list once, then only the change; a device lists its edits with time; nothing is stored', async t => {
  const roots = { mac: await mkdtemp(join(tmpdir(), 'wb-chg-mac-')), deb: await mkdtemp(join(tmpdir(), 'wb-chg-deb-')) }, data = await mkdtemp(join(tmpdir(), 'wb-chg-h-'));
  t.after(() => Promise.all([...Object.values(roots), data].map(dir => rm(dir, { recursive: true, force: true }))));
  const synced = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`f${i}.md`, entry(`v${i}`)]));
  // Each device's Worker: its own store with the observation it keeps, and the in-memory change lists.
  const workers = {}, sent = [];
  for (const node of ['mac', 'deb']) {
    const db = new Store(':memory:');
    db.put('sourceSyncWatchConfig', { id: 'main', scopes: [{ projectId: P, repositoryId: R, generation: 1, nodeId: node, root: roots[node] }] });
    db.put('sourceSyncWatchStates', { id: `${P}:${R}:1`, projectId: P, repositoryId: R, generation: 1, status: 'watching', checkedAt: '2026-11-10T06:00:00Z', entries: { ...synced } });
    workers[node] = { db, lists: new ChangeLists({ db }) };
  }
  const hdb = new Store(':memory:'), online = new Set(['mac', 'deb']);
  hdb.put('projects', { id: P, name: 'p' });
  hdb.put('repositories', { id: R, projectId: P, key: 'docs', name: 'docs' });
  for (const node of ['mac', 'deb', 'old']) hdb.put('workers', { id: node, name: node, capabilities: { sourceSyncChanges: node === 'old' ? undefined : 1 } });
  hdb.put('sourceSyncConfigs', { id: P, projectId: P, enabled: true, mode: 'continuous', scopeKind: 'directory', generation: 1, revision: 1, nodeIds: ['mac', 'deb', 'old'],
    bindings: ['mac', 'deb', 'old'].map(nodeId => ({ repositoryId: R, nodeId, root: `/xxxxx/${nodeId}` })) });
  for (const node of ['mac', 'deb', 'old']) hdb.put('sourceSyncDevices', { id: `${P}:${R}:${node}`, projectId: P, repositoryId: R, nodeId: node, generation: 1, entries: { ...synced, 'removed-earlier.md': null } });
  online.add('old');
  const query = async ({ nodeId }, action, input) => { assert.equal(action, 'source_sync_changes');sent.push({ nodeId, bytes: JSON.stringify(input).length });return workers[nodeId].lists.changes(input); };
  const home = new SourceSyncHome({ db: hdb, data, online: id => online.has(id), socket: () => null, change: () => {}, rooms: null, query });
  const before = hdb.db.prepare('SELECT COUNT(*) AS n FROM records').get().n;

  let result = await home.changes(P);
  assert.deepEqual(result.devices.map(d => [d.nodeId, d.status, d.scopes?.[0]?.total]), [['mac', 'ok', 0], ['deb', 'ok', 0], ['old', 'worker_unsupported', undefined]]);
  const whole = sent.find(s => s.nodeId === 'mac').bytes;assert.ok(whole > 20000, `first request carries the whole list (${whole} bytes)`);

  // Mac edits a file and adds one; Debian deletes one and edits the same file as Mac.
  await writeFile(join(roots.mac, 'f1.md'), 'edited on mac');await writeFile(join(roots.mac, 'note.md'), 'new');
  await utimes(join(roots.mac, 'f1.md'), new Date('2026-11-10T05:40:00Z'), new Date('2026-11-10T05:40:00Z'));
  const mac = workers.mac.db.get('sourceSyncWatchStates', `${P}:${R}:1`);
  workers.mac.db.put('sourceSyncWatchStates', { ...mac, entries: { ...mac.entries, 'f1.md': entry('edited on mac'), 'note.md': entry('new') } });
  const deb = workers.deb.db.get('sourceSyncWatchStates', `${P}:${R}:1`), debEntries = { ...deb.entries, 'f1.md': entry('edited on debian') };delete debEntries['f2.md'];
  workers.deb.db.put('sourceSyncWatchStates', { ...deb, entries: debEntries });
  sent.length = 0;result = await home.changes(P);
  assert.ok(sent.every(s => s.bytes < 1000), `later requests send only the change: ${JSON.stringify(sent)}`);
  const macScope = result.devices[0].scopes[0], debScope = result.devices[1].scopes[0];
  assert.deepEqual(macScope.items.map(i => [i.path, i.change, i.size]), [['f1.md', 'modified', 13], ['note.md', 'added', 3]]);
  assert.equal(macScope.items[0].modifiedAt, '2026-11-10T05:40:00.000Z', 'the time is the file\'s modification time on that device');
  assert.deepEqual(debScope.items.map(i => [i.path, i.change]), [['f1.md', 'modified'], ['f2.md', 'deleted']]);
  assert.equal(debScope.items[1].modifiedAt, undefined);

  // After a batch the synchronized list changes: the next request carries that change only, and the edit is no longer listed.
  hdb.put('sourceSyncDevices', { ...hdb.get('sourceSyncDevices', `${P}:${R}:mac`), entries: { ...synced, 'f1.md': entry('edited on mac'), 'note.md': entry('new') } });
  sent.length = 0;result = await home.changes(P);
  assert.equal(result.devices[0].scopes[0].total, 0);assert.ok(sent.every(s => s.bytes < 1000));

  // A restarted Worker lost its copy: it asks for the whole list once and still answers in the same refresh.
  workers.deb.lists = new ChangeLists({ db: workers.deb.db });
  sent.length = 0;result = await home.changes(P);
  assert.equal(result.devices[1].scopes[0].total, 2);assert.equal(sent.filter(s => s.nodeId === 'deb').length, 2);

  online.delete('deb');result = await home.changes(P);assert.equal(result.devices[1].status, 'offline');
  assert.equal(hdb.db.prepare('SELECT COUNT(*) AS n FROM records').get().n, before, 'Home stores nothing for the list');
});

test('a running batch lists each file it writes, from the device whose version it is to the device receiving it', async t => {
  const data = await mkdtemp(join(tmpdir(), 'wb-chg-b-'));t.after(() => rm(data, { recursive: true, force: true }));
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'p' });
  db.put('sourceSyncConfigs', { id: P, projectId: P, enabled: true, mode: 'manual', scopeKind: 'directory', generation: 1, revision: 1, nodeIds: ['mac', 'deb'], bindings: [] });
  db.put('sourceSyncManifests', { id: `${P}:${R}`, projectId: P, repositoryId: R, generation: 1, revision: 2, entries: {}, origins: { 'a.md': { nodeId: 'mac' } } });
  db.put('sourceSyncBatches', { id: 'b'.repeat(64), projectId: P, status: 'applying', generation: 1, revision: 2, sourceNodeId: 'mac', nodeIds: ['mac', 'deb'] });
  db.put('sourceSyncCommands', { id: 'c1', projectId: P, batchId: 'b'.repeat(64), repositoryId: R, nodeId: 'deb', action: 'apply',
    changes: [{ path: 'a.md', before: entry('a'), after: entry('aaa') }, { path: 'old.md', before: entry('o'), after: null }] });
  const home = new SourceSyncHome({ db, data, online: () => true, socket: () => null, change: () => {}, rooms: null, query: async () => { throw new Error('manual mode asks no device'); } });
  const result = await home.changes(P);
  assert.equal(result.mode, 'manual');assert.deepEqual(result.devices, []);
  assert.deepEqual(result.applying.map(i => [i.path, i.change, i.from, i.to, i.size, i.done]), [['a.md', 'modified', 'mac', 'deb', 3, false], ['old.md', 'deleted', 'mac', 'deb', null, false]]);
});

test('a large folder is listed from the baseline the Worker already holds; with none it says so instead of sending it whole', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wb-chg-big-')), data = await mkdtemp(join(tmpdir(), 'wb-chg-bh-'));
  t.after(() => Promise.all([root, data].map(dir => rm(dir, { recursive: true, force: true }))));
  const synced = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`d/f${i}.md`, entry(`v${i}`)]));
  const wdb = new Store(':memory:'), lists = new ChangeLists({ db: wdb }), sent = [];
  wdb.put('sourceSyncWatchConfig', { id: 'main', scopes: [{ projectId: P, repositoryId: R, generation: 1, nodeId: 'mac', root }] });
  // The device edited one file, and one synchronized path became a link here (left out of its scope, still on disk).
  const observed = { ...synced, 'd/f7.md': entry('edited') };delete observed['d/f9.md'];
  await mkdir(join(root, 'd'), { recursive: true });await symlink('/xxxxx', join(root, 'd', 'f9.md'));
  wdb.put('sourceSyncWatchStates', { id: `${P}:${R}:1`, projectId: P, repositoryId: R, generation: 1, status: 'watching', entries: observed });
  const hdb = new Store(':memory:');
  hdb.put('projects', { id: P, name: 'p' });hdb.put('workers', { id: 'mac', name: 'mac', capabilities: { sourceSyncChanges: 1 } });
  hdb.put('sourceSyncConfigs', { id: P, projectId: P, enabled: true, mode: 'continuous', scopeKind: 'directory', generation: 1, revision: 1, nodeIds: ['mac'], bindings: [{ repositoryId: R, nodeId: 'mac', root: '/xxxxx' }] });
  hdb.put('sourceSyncDevices', { id: `${P}:${R}:mac`, projectId: P, repositoryId: R, nodeId: 'mac', generation: 1, entries: synced });
  const query = async (target, action, input) => { sent.push(JSON.stringify(input).length);return lists.changes(input); };
  const home = new SourceSyncHome({ db: hdb, data, online: () => true, socket: () => null, change: () => {}, rooms: null, query });

  let result = await home.changes(P);
  assert.equal(result.devices[0].scopes[0].status, 'too_large');assert.deepEqual(sent, [], 'nothing near the device message limit is sent');

  // After a capture the Worker holds that baseline (with a removal marker) and Home knows which plan it served.
  const baseline = { ...synced, 'old.md': null };
  wdb.put('sourceSyncBaselines', { id: `${P}:${R}`, projectId: P, repositoryId: R, hash: contentHash(JSON.stringify(sortedEntries(baseline))), entries: baseline });
  hdb.put('sourceSyncCommands', { id: 'cap1', projectId: P, batchId: 'b0', repositoryId: R, nodeId: 'mac', action: 'capture', baselineEntries: baseline });
  hdb.put('sourceSyncBaselinesServed', { id: `${P}:${R}:mac`, projectId: P, hash: contentHash(JSON.stringify(sortedEntries(baseline))), commandId: 'cap1' });
  result = await home.changes(P);
  const scope = result.devices[0].scopes[0];
  assert.equal(scope.status, 'ok');assert.ok(sent.every(n => n < 2000), `a change against the held baseline: ${sent}`);
  assert.deepEqual(scope.items.map(i => [i.path, i.change]), [['d/f7.md', 'modified']], 'the left-out link is not listed as a deletion');

  // A scope whose last scan failed reports that, not its previous observation.
  wdb.put('sourceSyncWatchStates', { ...wdb.get('sourceSyncWatchStates', `${P}:${R}:1`), status: 'blocked', error: 'scan_failed' });
  assert.equal((await home.changes(P)).devices[0].scopes[0].status, 'blocked');

  // Simple mode keeps no hashes to compare with: no device is asked.
  hdb.put('sourceSyncConfigs', { ...hdb.get('sourceSyncConfigs', P), detection: 'metadata' });sent.length = 0;
  assert.deepEqual((await home.changes(P)).devices, []);assert.deepEqual(sent, []);
});
