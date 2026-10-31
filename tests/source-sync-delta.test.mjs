// Directory captures travel as a change against the command's baseline: Home rebuilds exactly the Worker's manifest (same
// JSON text, so receipt hashes agree) and refuses a delta that does not fit the baseline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../src/store.mjs';
import { manifestDelta, applyManifestDelta, manifestDigest, contentHash, sortedEntries } from '../src/source-sync-manifest.mjs';
import { captureDirectorySnapshot } from '../src/source-sync-files.mjs';
import { SourceSyncHome } from '../src/source-sync-transport.mjs';

const entry = n => ({ hash: n.toString(16).padStart(64, '0'), size: n, mode: 420 });

test('a delta rebuilds the same path-ordered entries from any baseline order, deletion markers and odd names included', () => {
  let seed = 11;
  const random = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const odd = ['__proto__', 'constructor', '0', '10', '007', 'Ünïcode.md', 'a b.md'];
  for (let round = 0; round < 300; round++) {
    // Home's canonical: any order (new paths appended at the end), with null markers for deleted files.
    const baseline = Object.create(null);
    for (let i = 30 + random(40); i > 0; i--) { const name = random(7) === 0 ? odd[random(odd.length)] : `dir${random(4)}/f${random(200)}.txt`;baseline[name] = random(8) === 0 ? null : entry(random(1000)); }
    const capture = Object.create(null);
    for (const path of Object.keys(baseline)) if (baseline[path] !== null && random(8)) capture[path] = random(6) ? baseline[path] : entry(random(1000));
    for (let i = random(5); i > 0; i--) capture[`new/${round}-${i}.txt`] = entry(i);
    const entries = sortedEntries(capture), delta = manifestDelta(baseline, entries);
    assert.equal(JSON.stringify(applyManifestDelta(JSON.parse(JSON.stringify(baseline)), JSON.parse(JSON.stringify(delta)))), JSON.stringify(entries), `round ${round}`);
    assert.ok(!delta.removed.some(path => baseline[path] === null), 'deletion markers are not listed');
  }
  const baseline = { 'a.txt': entry(1), 'b.txt': entry(2), gone: null };
  assert.deepEqual(JSON.parse(JSON.stringify(manifestDelta(baseline, sortedEntries({ 'a.txt': entry(1), 'b.txt': entry(2) })))), { changed: {}, removed: [] }, 'nothing changed: an empty delta');
  // A large rebuild is a sort, not one insertion per path.
  const big = Object.create(null);for (let i = 0; i < 100000; i++) big[`f${i}.txt`] = entry(i);
  const more = Object.create(null);for (let i = 0; i < 50000; i++) more[`a${i}.txt`] = entry(i);
  const started = Date.now();applyManifestDelta(big, { changed: more, removed: [] });
  assert.ok(Date.now() - started < 1500, `150,000 entries rebuilt in ${Date.now() - started} ms`);
});

test('a delta that does not fit the baseline is refused', () => {
  const baseline = { 'a.txt': entry(1), 'b.txt': entry(2), gone: null };
  for (const delta of [
    { changed: {}, removed: ['zz.txt'] },
    { changed: {}, removed: ['gone'] },
    { changed: { 'b.txt': entry(5) }, removed: ['b.txt'] },
    { changed: [], removed: [] },
    { changed: {}, removed: 'a.txt' },
    null,
  ]) assert.throws(() => applyManifestDelta(baseline, delta), /invalid_manifest/, JSON.stringify(delta));
});

/** Home's real upload handler, driven with a request body and a recording response. */
async function put(home, command, path, value) {
  const req = Readable.from(value === undefined ? [] : [Buffer.from(JSON.stringify(value))]);
  Object.assign(req, { method: value === undefined ? 'GET' : 'PUT', headers: { authorization: `Bearer ${command.secret}` } });
  const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, writeHead(status) { this.status = status; }, end(text) { this.body = text ? JSON.parse(text) : null; } };
  await home.workerHttp(req, res, `/api/worker/source-sync/${command.id}/${path}`);
  return res;
}

test('Home stores the delta-rebuilt capture with the exact text and receipt hash of the full one', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wb-delta-')), data = await mkdtemp(join(tmpdir(), 'wb-delta-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(data, { recursive: true, force: true })]));
  await mkdir(join(root, 'docs'), { recursive: true });
  for (const name of ['a.md', 'docs/b.md', 'docs/c.md', 'z.md']) await writeFile(join(root, name), name);
  const scope = { root, repositoryId: 'project-files:p1', generation: 1, scopePolicy: {} };
  const before = await captureDirectorySnapshot(scope);
  // A file added between kept ones, one changed, one removed.
  await writeFile(join(root, 'docs/bb.md'), 'new');await writeFile(join(root, 'a.md'), 'changed');await rm(join(root, 'z.md'));
  const manifest = await captureDirectorySnapshot(scope), base = { ...manifest, entries: {}, digest: manifestDigest({}, {}) };manifest.entries = sortedEntries(manifest.entries);
  const db = new Store(':memory:');
  db.put('projects', { id: 'p1', name: 'p' });
  db.put('sourceSyncBatches', { id: 'b1', projectId: 'p1', status: 'preparing', generation: 1 });
  const home = new SourceSyncHome({ db, data, online: () => true, socket: () => null, change: () => {}, rooms: null, query: async () => ({}) });
  const plain = { id: 'a'.repeat(64), secret: 's1', projectId: 'p1', batchId: 'b1', nodeId: 'n1', action: 'capture', repositoryId: 'project-files:p1', generation: 1, scopeKind: 'directory', scopePolicy: {}, baselineEntries: before.entries };
  const deltaCommand = { ...plain, id: 'b'.repeat(64), secret: 's2' };
  db.put('sourceSyncCommands', plain);db.put('sourceSyncCommands', deltaCommand);

  const plan = await put(home, deltaCommand, 'plan');
  assert.equal(plan.headers['x-source-sync-delta'], '1', 'Home offers deltas');
  const full = { base, manifest }, delta = manifestDelta(before.entries, manifest.entries);
  assert.deepEqual(delta.removed, ['z.md']);assert.equal(Object.keys(delta.changed).length, 2);
  const sent = { base, manifest: { ...manifest, entries: null }, delta };
  assert.ok(JSON.stringify(sent).length < JSON.stringify(full).length);
  assert.equal((await put(home, plain, 'capture', full)).status, 200);
  assert.equal((await put(home, deltaCommand, 'capture', sent)).status, 200);
  const stored = id => JSON.stringify(db.get('sourceSyncUploads', id).bundle);
  assert.equal(stored(deltaCommand.id), stored(plain.id), 'same bundle text as a full upload');
  assert.equal(stored(deltaCommand.id), JSON.stringify(full));
  const receipt = await put(home, deltaCommand, 'receipt');
  db.put('sourceSyncCommands', { ...db.get('sourceSyncCommands', deltaCommand.id), result: { status: 'completed', captureId: deltaCommand.id } });
  const proof = await put(home, deltaCommand, 'receipt');
  assert.equal(proof.body.receiptHash, contentHash(JSON.stringify({ status: 'completed', ...full })), 'the Worker\'s receipt hash matches');
  assert.ok(receipt.status === 200);

  // A delta with a wrong digest-bearing manifest is refused like a wrong full manifest.
  const wrong = { ...deltaCommand, id: 'c'.repeat(64), secret: 's3' };db.put('sourceSyncCommands', wrong);
  await assert.rejects(put(home, wrong, 'capture', { base, manifest: { ...manifest, entries: null }, delta: { ...delta, removed: [] } }), /invalid_manifest/, 'a rebuild that misses a removal fails the digest');
});

test('a real Worker client and Home: later captures upload only their changes, and Home keeps the Worker\'s exact result', async t => {
  const http = await import('node:http'), { SourceSyncClient } = await import('../src/source-sync-transport.mjs');
  const root = await mkdtemp(join(tmpdir(), 'wb-delta-root-')), homeData = await mkdtemp(join(tmpdir(), 'wb-delta-h-')), workerData = await mkdtemp(join(tmpdir(), 'wb-delta-w-'));
  await mkdir(join(root, 'docs'));
  for (let i = 0; i < 200; i++) await writeFile(join(root, i % 2 ? 'docs' : '', `file-${i}.md`), `content ${i}`);
  const hdb = new Store(':memory:'), wdb = new Store(':memory:');
  hdb.put('projects', { id: 'p1', name: 'p' });hdb.put('sourceSyncBatches', { id: 'b1', projectId: 'p1', status: 'preparing', generation: 1 });
  const home = new SourceSyncHome({ db: hdb, data: homeData, online: () => true, socket: () => null, change: () => {}, rooms: null, query: async () => ({}) });
  let uploaded = 0;
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname, chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);if (req.method === 'PUT' && path.endsWith('/capture')) uploaded += bytes.length;
    const replay = Object.assign(Readable.from(bytes.length ? [bytes] : []), { method: req.method, headers: req.headers });
    try { if (!await home.workerHttp(replay, res, path)) { res.writeHead(404);res.end(); } } catch (error) { res.writeHead(400);res.end(JSON.stringify({ code: error.code, error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.close();await Promise.all([root, homeData, workerData].map(dir => rm(dir, { recursive: true, force: true }))); });
  const client = new SourceSyncClient({ db: wdb, data: workerData, home: `http://127.0.0.1:${server.address().port}`, send: () => {}, resolveBinding: async () => ({ root, generation: 1 }), activeRuns: () => [], takeoverState: () => false, paused: () => false });
  let canonical = {}, n = 0;
  const capture = async () => {
    const id = contentHash(`capture-${++n}`), secret = `s${n}`;uploaded = 0;
    hdb.put('sourceSyncCommands', { id, secret, projectId: 'p1', batchId: 'b1', nodeId: 'n1', action: 'capture', repositoryId: 'project-files:p1', generation: 1, scopeKind: 'directory', scopePolicy: {}, baselineEntries: canonical });
    await client.execute({ commandId: id, secret });
    const stored = hdb.get('sourceSyncUploads', id).bundle, local = wdb.get('sourceSyncCommands', id).result;
    assert.equal(JSON.stringify({ status: 'completed', ...stored }), JSON.stringify(local), 'Home holds the Worker\'s exact result');
    // Home's canonical: new paths appended at the end, deleted ones kept as null markers (as SourceSync merges).
    const next = { ...canonical };for (const path of Object.keys(next)) if (!Object.hasOwn(stored.manifest.entries, path)) next[path] = null;
    for (const [path, value] of Object.entries(stored.manifest.entries)) next[path] = value;canonical = next;
    return { uploaded, full: JSON.stringify(stored).length };
  };
  const first = await capture();
  assert.ok(first.uploaded >= first.full, 'a first capture sends the whole manifest');
  const unchanged = await capture();
  assert.ok(unchanged.uploaded < 2048 && unchanged.full > 20000, `nothing changed: ${unchanged.uploaded} bytes for a ${unchanged.full}-byte manifest`);
  await writeFile(join(root, 'docs', 'file-1.md'), 'edited');await writeFile(join(root, 'docs', 'file-100a.md'), 'new');await rm(join(root, 'file-0.md'));
  const edited = await capture();
  assert.ok(edited.uploaded < 4096, `three changes: ${edited.uploaded} bytes`);
  assert.ok(canonical['file-0.md'] === null && Object.hasOwn(canonical, 'docs/file-100a.md'));
  // The new path sits at the end of Home's canonical, the deleted one stays as a marker: still a delta, still exact.
  const again = await capture();
  assert.ok(again.uploaded < 2048, `unchanged after edits: ${again.uploaded} bytes`);
});

test('sync uploads: paced when Home measures the link, and given up only when the link stops taking bytes', async t => {
  const http = await import('node:http'), { SourceSyncClient } = await import('../src/source-sync-transport.mjs'), { MediaPace } = await import('../src/media-pace.mjs');
  let mode = 'read', received = 0;const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    if (mode === 'stuck') { req.socket.pause();return; }
    for await (const chunk of req) received += chunk.length;
    res.writeHead(200, { 'Content-Type': 'application/json' });res.end('{}');
  });
  server.on('connection', socket => sockets.add(socket));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy();server.close(); });
  const pace = new MediaPace({ rate: 200 * 1024 }), dir = await mkdtemp(join(tmpdir(), 'wb-pace-'));t.after(() => rm(dir, { recursive: true, force: true }));
  const client = new SourceSyncClient({ db: new Store(':memory:'), data: dir, home: `http://127.0.0.1:${server.address().port}`, send: () => {}, resolveBinding: async () => null, pace });
  const blob = Buffer.alloc(300 * 1024, 1), message = { commandId: 'a'.repeat(64), secret: 's' };
  let started = Date.now();await client.request({ ...message, paced: true }, `blobs/${'b'.repeat(64)}`, 'PUT', blob);
  assert.ok(Date.now() - started >= 1000, `300 KB at 200 KB/s took ${Date.now() - started} ms`);assert.equal(received, blob.length);
  started = Date.now();await client.request(message, `blobs/${'b'.repeat(64)}`, 'PUT', blob);
  assert.ok(Date.now() - started < 1000, 'a Home that does not measure the link gets the upload unpaced');
  // A link that takes nothing: the upload stops on its own (here after 400 ms; a minute in service).
  mode = 'stuck';client.stallMs = 400;started = Date.now();
  await assert.rejects(client.request(message, `blobs/${'b'.repeat(64)}`, 'PUT', Buffer.alloc(8 * 1024 * 1024)), /transfer_failed/);
  assert.ok(Date.now() - started < 5000);
});

test('Home counts sync uploads toward the measured link and says so in the plan', async t => {
  const data = await mkdtemp(join(tmpdir(), 'wb-pace-home-'));t.after(() => rm(data, { recursive: true, force: true }));
  const db = new Store(':memory:'), watched = [];
  db.put('projects', { id: 'p1', name: 'p' });db.put('sourceSyncBatches', { id: 'b1', projectId: 'p1', status: 'preparing', generation: 1 });
  const command = { id: 'd'.repeat(64), secret: 's', projectId: 'p1', batchId: 'b1', nodeId: 'n1', action: 'capture', repositoryId: 'r', generation: 1, scopeKind: 'directory', scopePolicy: {}, baselineEntries: {} };
  db.put('sourceSyncCommands', command);
  const home = new SourceSyncHome({ db, data, online: () => true, socket: () => null, change: () => {}, rooms: null, query: async () => ({}), watchUpload: (nodeId, req) => { watched.push([nodeId, req.method]);return () => watched.push(['stopped']); } });
  const plan = await put(home, command, 'plan');
  assert.equal(plan.headers['x-source-sync-pace'], '1');
  const res = { headers: {}, setHeader() {}, writeHead(status) { this.status = status; }, end() { this.close?.(); }, once(event, fn) { if (event === 'close') this.close = fn; } };
  const req = Object.assign(Readable.from([Buffer.from('{}')]), { method: 'PUT', headers: { authorization: 'Bearer s' } });
  await home.workerHttp(req, res, `/api/worker/source-sync/${command.id}/capture`).catch(() => {});
  assert.deepEqual(watched.slice(0, 1), [['n1', 'PUT']]);
  const plain = new SourceSyncHome({ db, data, online: () => true, socket: () => null, change: () => {}, rooms: null, query: async () => ({}) });
  assert.equal((await put(plain, command, 'plan')).headers['x-source-sync-pace'], undefined, 'no pacing without a link measure');
});
