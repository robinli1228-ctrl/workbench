// A capture's baseline travels down as a change against the one the Worker was last sent for the scope: later captures of a
// large folder fetch a few hundred bytes instead of the whole list, the Worker rebuilds exactly Home's list, and anything
// that does not match (no held baseline, a changed one, a retry) falls back to the whole plan.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../src/store.mjs';
import { contentHash, sortedEntries } from '../src/source-sync-manifest.mjs';
import { SourceSyncHome, SourceSyncClient } from '../src/source-sync-transport.mjs';

const hashOf = entries => contentHash(JSON.stringify(sortedEntries(entries)));

test('later captures fetch only the baseline change, rebuilt exactly; a mismatch or a retry gets the whole plan', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wb-base-root-')), homeData = await mkdtemp(join(tmpdir(), 'wb-base-h-')), workerData = await mkdtemp(join(tmpdir(), 'wb-base-w-'));
  await mkdir(join(root, 'docs'));
  for (let i = 0; i < 300; i++) await writeFile(join(root, i % 2 ? 'docs' : '', `file-${i}.md`), `content ${i}`);
  const hdb = new Store(':memory:'), wdb = new Store(':memory:');
  hdb.put('projects', { id: 'p1', name: 'p' });hdb.put('sourceSyncBatches', { id: 'b1', projectId: 'p1', status: 'preparing', generation: 1 });
  const home = new SourceSyncHome({ db: hdb, data: homeData, online: () => true, socket: () => null, change: () => {}, rooms: null, query: async () => ({}) });
  let planBytes = [];
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname, chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks), replay = Object.assign(Readable.from(bytes.length ? [bytes] : []), { method: req.method, headers: req.headers });
    if (path.endsWith('/plan')) { const end = res.end.bind(res);res.end = text => { planBytes.push(Buffer.byteLength(text || ''));return end(text); }; }
    try { if (!await home.workerHttp(replay, res, path)) { res.writeHead(404);res.end(); } } catch (error) { res.writeHead(400);res.end(JSON.stringify({ code: error.code, error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.close();await Promise.all([root, homeData, workerData].map(dir => rm(dir, { recursive: true, force: true }))); });
  const client = new SourceSyncClient({ db: wdb, data: workerData, home: `http://127.0.0.1:${server.address().port}`, send: () => {}, resolveBinding: async () => ({ root, generation: 1 }), activeRuns: () => [], takeoverState: () => false, paused: () => false });
  let canonical = {}, n = 0;
  const capture = async () => {
    const id = contentHash(`capture-${++n}`), secret = `s${n}`;planBytes = [];
    hdb.put('sourceSyncCommands', { id, secret, projectId: 'p1', batchId: 'b1', nodeId: 'n1', action: 'capture', repositoryId: 'project-files:p1', generation: 1, scopeKind: 'directory', scopePolicy: {},
      baselineEntries: sortedEntries(canonical), baselineHash: hashOf(canonical) });
    await client.execute({ commandId: id, secret, projectId: 'p1' });
    const local = wdb.get('sourceSyncCommands', id);
    const { result, lastResult, secret: _, status, lastSentAt, ackedAt, receivedAt, ...plan } = hdb.get('sourceSyncCommands', id);
    assert.equal(JSON.stringify(local.command), JSON.stringify(plan), 'the Worker ran exactly the command Home holds, byte for byte');
    assert.equal(local.command.baselineDelta, undefined);assert.equal(local.command.baselineFrom, undefined);
    // Home's canonical after the batch: the capture merged in, removed paths kept as null markers, new ones at the end.
    const stored = hdb.get('sourceSyncUploads', id).bundle, next = { ...canonical };
    for (const path of Object.keys(next)) if (!Object.hasOwn(stored.manifest.entries, path)) next[path] = null;
    for (const [path, value] of Object.entries(stored.manifest.entries)) next[path] = value;canonical = next;
    return { id, plan: planBytes.reduce((a, b) => a + b, 0), fetches: planBytes.length, full: JSON.stringify(canonical).length };
  };
  const first = await capture();
  assert.equal(first.fetches, 1);assert.ok(first.plan < 2000, 'a first capture has an empty baseline');
  const second = await capture();
  assert.ok(second.plan > second.full, `nothing held for this baseline yet: the whole list (${second.plan} bytes)`);
  await writeFile(join(root, 'docs', 'file-1.md'), 'edited');await writeFile(join(root, 'docs', 'new.md'), 'new');await rm(join(root, 'file-0.md'));
  const third = await capture();
  assert.ok(third.plan < 2000 && third.full > 20000, `held baseline: ${third.plan} bytes for a ${third.full}-byte list`);
  assert.equal(third.fetches, 1);
  const fourth = await capture();
  assert.ok(fourth.plan < 2000 && fourth.fetches === 1, `after the edits (markers and appended paths): ${fourth.plan} bytes`);

  // A held baseline that no longer matches its hash: the rebuild is refused and the whole plan fetched once more.
  const held = wdb.get('sourceSyncBaselines', 'p1:project-files:p1');
  wdb.put('sourceSyncBaselines', { ...held, entries: { ...held.entries, 'docs/file-3.md': null } });
  const corrupt = await capture();
  assert.equal(corrupt.fetches, 2, 'delta refused, whole plan fetched');assert.ok(corrupt.plan > corrupt.full);
  const healed = await capture();
  assert.ok(healed.plan < 2000, `the next one is a delta again: ${JSON.stringify(healed)}`);

  // A retry of a command the Worker already stored never takes a delta: it must rebuild the exact command it ran.
  wdb.remove('sourceSyncTransport', healed.id);
  const record = wdb.get('sourceSyncCommands', healed.id);wdb.put('sourceSyncCommands', { ...record, result: undefined, status: 'pending' });
  planBytes = [];await client.execute({ commandId: healed.id, secret: `s${n}`, projectId: 'p1' });
  assert.ok(planBytes[0] > healed.full, 'the retry got the whole plan');
  assert.equal(wdb.get('sourceSyncCommands', healed.id).result?.status, 'completed', 'and ran: the whole list matches the command it rebuilt from a change');
  assert.equal(wdb.get('sourceSyncTransport', healed.id)?.recoveryError, undefined);
});

test('an older Worker that sends no held hashes, and a command without a hash, get the whole plan as before', async t => {
  const data = await mkdtemp(join(tmpdir(), 'wb-base-old-'));t.after(() => rm(data, { recursive: true, force: true }));
  const db = new Store(':memory:');
  db.put('projects', { id: 'p1', name: 'p' });db.put('sourceSyncBatches', { id: 'b1', projectId: 'p1', status: 'preparing', generation: 1 });
  const home = new SourceSyncHome({ db, data, online: () => true, socket: () => null, change: () => {}, rooms: null, query: async () => ({}) });
  const entries = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, { hash: contentHash(String(i)), size: i, mode: 420 }]));
  const plan = async (command, held) => {
    db.put('sourceSyncCommands', command);
    const req = Object.assign(Readable.from([]), { method: 'GET', headers: { authorization: `Bearer ${command.secret}`, ...(held ? { 'x-source-sync-baselines': held } : {}) } });
    const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); } };
    await home.workerHttp(req, res, `/api/worker/source-sync/${command.id}/plan`);return res;
  };
  const base = { secret: 's', projectId: 'p1', batchId: 'b1', nodeId: 'n1', action: 'capture', repositoryId: 'r', generation: 1, scopeKind: 'directory', scopePolicy: {} };
  const one = await plan({ ...base, id: 'a'.repeat(64), baselineEntries: entries, baselineHash: hashOf(entries) });
  const changed = { ...entries, f0: { hash: contentHash('x'), size: 1, mode: 420 } };
  const old = await plan({ ...base, id: 'b'.repeat(64), baselineEntries: changed, baselineHash: hashOf(changed) });
  assert.equal(old.headers['x-source-sync-baseline'], undefined, 'no held hashes: whole plan');assert.equal(Object.keys(old.body.baselineEntries).length, 50);
  const unhashed = await plan({ ...base, id: 'c'.repeat(64), baselineEntries: changed }, hashOf(changed));
  assert.equal(unhashed.headers['x-source-sync-baseline'], undefined, 'no hash on the command: whole plan');
  const delta = await plan({ ...base, id: 'd'.repeat(64), baselineEntries: entries, baselineHash: hashOf(entries) }, hashOf(changed));
  assert.equal(delta.headers['x-source-sync-baseline'], 'delta');assert.equal(delta.body.baselineEntries, null);
  assert.deepEqual(Object.keys(delta.body.baselineDelta.changed), ['f0']);
  assert.equal(one.headers['x-source-sync-baseline'], undefined);
});

test('Home issues a capture\'s baseline in path order with its hash, whatever order its canonical list is in', async () => {
  const { SourceSync } = await import('../src/source-sync.mjs');
  const db = new Store(':memory:'), entry = n => ({ hash: contentHash(String(n)), size: n, executable: false });
  const canonical = { 'z.md': entry(1), 'a.md': entry(2), 'm/new.md': entry(3), 'gone.md': null };
  db.put('projects', { id: 'p1', name: 'p' });
  db.put('sourceSyncConfigs', { id: 'p1', projectId: 'p1', enabled: true, revision: 1, generation: 1 });
  db.put('sourceSyncManifests', { id: 'p1:r', projectId: 'p1', repositoryId: 'r', generation: 1, revision: 1, entries: canonical, scopePolicy: {} });
  db.put('sourceSyncBatches', { id: 'b1', projectId: 'p1', status: 'queued', generation: 1, revision: 1, scopeKind: 'directory', repositoryIds: ['r'], nodeIds: ['n1', 'n2'],
    bindings: ['n1', 'n2'].map(nodeId => ({ repositoryId: 'r', nodeId, root: `/xxxxx/${nodeId}`, scopeKind: 'directory', scopePolicy: {} })) });
  new SourceSync({ db, online: () => true }).schedule();
  const captures = db.listSourceSyncCommands({ projectId: 'p1', batchId: 'b1', action: 'capture' });
  assert.equal(captures.length, 2);
  for (const c of captures) {
    assert.deepEqual(Object.keys(c.baselineEntries), ['a.md', 'gone.md', 'm/new.md', 'z.md']);
    assert.equal(c.baselineHash, hashOf(canonical));
  }
});
