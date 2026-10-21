// Directory events drive source observation; the periodic sweeps are a backstop whose cadence depends on watcher health.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = name => import(pathToFileURL(join(root, 'src', name)).href);
const { Store } = await load('store.mjs');
const { SourceSyncWatch, OBSERVATION_INTERVALS, RETRY_BASE_MS, RETRY_MAX_MS } = await load('source-sync-watch.mjs');
const { readSourceFile } = await load('source-sync-files.mjs');

const MINUTE = 60000;
function env(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-watch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'a.txt'), 'alpha');
  writeFileSync(join(dir, 'docs', 'b.md'), 'bravo');
  const db = new Store(':memory:'), sent = [];
  let now = Date.parse('2026-10-20T10:00:00Z');
  const watch = new SourceSyncWatch({ db, send: m => sent.push(m), resolveBinding: scope => ({ root: scope.root }), clock: () => now, ...options });
  t.after(() => watch.close());
  const scope = { projectId: 'p1', repositoryId: 'repo1', generation: 1, scopeKind: 'directory', root: dir, scopePolicy: {} };
  const statuses = () => sent.filter(m => m.type === 'source_sync_watch_status');
  const advance = ms => { now += ms; };
  return { dir, db, sent, watch, scope, id: 'p1:repo1:1', statuses, advance };
}

test('a fully watched scope sweeps metadata every 5 minutes and hashes everything hourly, not every 30 seconds', async t => {
  const { watch, scope, id, statuses, advance } = env(t);
  await watch.configure({ version: 'v1', scopes: [scope] });
  await watch.tick();
  assert.equal(statuses().length, 1);
  assert.equal(statuses()[0].status, 'watching');
  assert.equal(watch.observations.get(id).fullHash, true);
  for (let i = 0; i < 9; i++) { advance(30000); await watch.tick(); }
  assert.equal(statuses().length, 1, 'no sweep while directory watchers are healthy and nothing changed');
  advance(30000); await watch.tick();
  assert.equal(statuses().length, 2, 'metadata sweep after 5 minutes');
  assert.equal(watch.observations.get(id).fullHash, false);
  assert.equal(watch.observations.get(id).metrics.reused, 2, 'unchanged files reuse their hashes');
  for (let i = 0; i < 10; i++) { advance(5 * MINUTE); await watch.tick(); }
  assert.equal(watch.observations.get(id).fullHash, false);
  advance(5 * MINUTE); await watch.tick();
  assert.equal(watch.observations.get(id).fullHash, true, 'full hash after 60 minutes');
  assert.deepEqual(OBSERVATION_INTERVALS.watching, { metadata: 5 * MINUTE, fullHash: 60 * MINUTE });
});

test('a degraded scope keeps the 30-second sweep and the 5-minute full hash', async t => {
  const { watch, scope, id, statuses, advance } = env(t, { maxWatches: 1 });
  await watch.configure({ version: 'v1', scopes: [scope] });
  await watch.tick();
  assert.equal(statuses()[0].status, 'reconciling');
  advance(30000); await watch.tick();
  assert.equal(statuses().length, 2);
  assert.equal(watch.observations.get(id).fullHash, false);
  for (let i = 0; i < 9; i++) { advance(30000); await watch.tick(); }
  assert.equal(watch.observations.get(id).fullHash, true);
});

test('a directory event checks only the changed path at once and raises a dirty notice', async t => {
  const { dir, watch, scope, id, sent, statuses, advance } = env(t);
  await watch.configure({ version: 'v1', scopes: [scope] });
  await watch.tick();
  const digest = statuses()[0].digest;
  writeFileSync(join(dir, 'a.txt'), 'alpha changed');
  advance(1000); watch.hint(id, 'a.txt');
  advance(600); await watch.tick();
  assert.equal(statuses().length, 2);
  assert.notEqual(statuses()[1].digest, digest);
  assert.deepEqual(watch.observations.get(id).metrics, { hashed: 1, bytesRead: 13 }, 'only the hinted file is read');
  const dirty = sent.findLast(m => m.type === 'source_sync_dirty');
  assert.equal(dirty?.digest, statuses()[1].digest);
  // The sweep clock did not restart: the 5-minute metadata sweep is still due at the usual time.
  advance(5 * MINUTE - 1600); await watch.tick();
  assert.equal(statuses().length, 3);
});

test('a walked observation reuses an unchanged file after one lstat and still rejects links or changed content', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-read-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'a.txt'), 'alpha');
  const first = await readSourceFile(dir, 'a.txt', {});
  const cached = { metadata: first.metadata, entry: first.entry };
  const metrics = {};
  const reused = await readSourceFile(dir, 'a.txt', {}, { walked: true, cached, metrics });
  assert.deepEqual(reused.entry, first.entry); assert.equal(reused.bytes, null); assert.deepEqual(metrics, { reused: 1, bytesRead: 0 });
  writeFileSync(join(dir, 'a.txt'), 'alpha2');
  const changed = await readSourceFile(dir, 'a.txt', {}, { walked: true, cached, metrics });
  assert.notEqual(changed.entry.hash, first.entry.hash); assert.equal(metrics.hashed, 1);
  unlinkSync(join(dir, 'a.txt')); symlinkSync('/etc/hostname', join(dir, 'a.txt'));
  await assert.rejects(readSourceFile(dir, 'a.txt', {}, { walked: true, cached, metrics }), /unsafe_file/);
  unlinkSync(join(dir, 'a.txt'));
  assert.deepEqual(await readSourceFile(dir, 'a.txt', {}, { walked: true, cached, metrics }), { entry: null, bytes: null });
});

test('a symbolic link in the tree is listed as excluded; the scope keeps watching instead of failing every 30 seconds', async t => {
  const { dir, db, watch, scope, id, statuses, advance } = env(t);
  mkdirSync(join(dir, '.agents', 'skills'), { recursive: true });
  symlinkSync('../../skills/elsewhere', join(dir, '.agents', 'skills', 'linked'));
  await watch.configure({ version: 'v1', scopes: [scope] });
  await watch.tick();
  assert.equal(statuses().length, 1);
  assert.equal(statuses()[0].status, 'watching', 'the link does not block the other files');
  assert.deepEqual(Object.keys(db.get('sourceSyncWatchStates', id).entries).sort(), ['a.txt', 'docs/b.md']);
  assert.deepEqual(watch.observations.get(id).snapshot.excluded.find(e => e.path === '.agents/skills/linked'), { path: '.agents/skills/linked', reason: 'symlink' });
  for (let i = 0; i < 9; i++) { advance(30000); await watch.tick(); }
  assert.equal(statuses().length, 1, 'no retry loop: nothing failed');
});

test('a failing scope backs off from 30 seconds to 10 minutes and keeps its observation cache for the next success', async t => {
  let broken = false;
  const { watch, scope, id, statuses, advance } = env(t, { resolveBinding: scope => { if (broken) throw Object.assign(new Error('unreadable'), { code: 'scan_failed' }); return { root: scope.root }; } });
  await watch.configure({ version: 'v1', scopes: [scope] });
  await watch.tick();
  const cache = watch.observations.get(id).cache;
  assert.ok(cache.size, 'a successful scan published its cache');
  broken = true;
  const delays = [];
  for (let i = 0; i < 8; i++) {
    advance(RETRY_MAX_MS); await watch.tick();
    delays.push(watch.retryAt.get(id) - Date.parse('2026-10-20T10:00:00Z') - RETRY_MAX_MS * (i + 1));
  }
  assert.deepEqual(delays, [30000, 60000, 120000, 240000, 480000, 600000, 600000, 600000]);
  assert.equal(RETRY_BASE_MS, 30000); assert.equal(RETRY_MAX_MS, 600000);
  assert.equal(statuses().at(-1).status, 'blocked');
  assert.equal(watch.observations.get(id).cache, cache, 'the cache from the last good scan is kept');
  advance(1000); await watch.tick();
  assert.equal(statuses().length, 9, 'inside the back-off window nothing is retried');
  broken = false;
  advance(RETRY_MAX_MS); await watch.tick();
  assert.equal(statuses().at(-1).status, 'watching');
  // More than an hour passed during the back-off, so this recovery is the hourly full hash; the cache is republished by it.
  assert.equal(watch.observations.get(id).fullHash, true);
  assert.equal(watch.observations.get(id).cache.size, 2);
  assert.equal(watch.failures.get(id), undefined, 'success resets the back-off');
});
