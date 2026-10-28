// The top-bar light for a project's file sync. Red needs attention and carries a retry only when a new batch can help (otherwise
// open:true); orange is work in flight; green is in step; off is not enabled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { runWithLanguage } from '../src/i18n.mjs';
import { syncIndicator } from '../src/sync-indicator.mjs';

const P = 'p1', NOW = Date.parse('2026-10-28T10:00:00.000Z');
const CAPS = { sourceSync: 1, sourceSyncDirectory: 1 };
function env({ enabled = true, config = {} } = {}) {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'demo' });
  for (const [id, name] of [['mac', 'Mac'], ['srv', 'Server']]) db.put('workers', { id, name, capabilities: CAPS, lastSeen: new Date(NOW).toISOString() });
  db.put('sourceSyncConfigs', { id: P, projectId: P, enabled, generation: 2, revision: 3, nodeIds: ['mac', 'srv'], scopeKind: 'directory', mode: 'continuous', ...config });
  const watch = (nodeId, status, extra = {}) => db.put('sourceSyncWatchStates', { id: `${nodeId}:${P}`, projectId: P, nodeId, generation: 2, status, ...extra });
  const batch = (id, status, extra = {}) => db.put('sourceSyncBatches', { id, projectId: P, kind: 'sync', generation: 2, status, sourceNodeId: 'mac', nodeIds: ['mac', 'srv'], ...extra });
  const conflict = (id, status) => db.put('sourceSyncConflicts', { id, projectId: P, status, path: `${id}.txt` });
  watch('mac', 'watching'); watch('srv', 'watching');
  return { db, watch, batch, conflict, light: (online = () => true, now = NOW) => syncIndicator(db, P, { online, now }) };
}
const color = l => l.state;

test('off, green, and a degraded watcher is still in step', () => runWithLanguage('en', () => {
  assert.equal(color(env({ enabled: false }).light()), 'off');
  const e = env();
  assert.equal(color(e.light()), 'green');
  e.watch('mac', 'reconciling');
  assert.equal(color(e.light()), 'green', 'out of watch slots, the device falls back to periodic scans and keeps syncing');
  e.batch('done', 'completed');
  assert.equal(color(e.light()), 'green');
}));

test('orange: open batches, conflicts already being worked on, a running initialization, a device reconnecting', () => runWithLanguage('en', () => {
  const b = env(); b.batch('run', 'applying');
  assert.equal(color(b.light()), 'orange');
  const p = env(); p.batch('pre', 'capturing', { kind: 'preview' });
  assert.equal(color(p.light()), 'green', 'a scope preview is not sync traffic');
  for (const status of ['initializing', 'resolved_pending_sync', 'proposed', 'queued', 'resolving', 'verifying']) {
    const c = env(); c.conflict('c1', status);
    assert.equal(color(c.light()), 'orange', status);
  }
  const i = env(); i.db.put('sourceSyncInitializations', { id: 'j1', projectId: P, generation: 2, status: 'running' });
  assert.equal(color(i.light()), 'orange');
  const r = env();
  assert.equal(color(r.light(id => id !== 'srv')), 'orange', 'a Worker that just dropped is reconnecting');
  assert.equal(color(r.light(id => id !== 'srv', NOW + 61000)), 'red', 'a minute without a heartbeat is offline');
}));

test('red that only a person can fix opens the sync panel', () => runWithLanguage('en', () => {
  const expectOpen = (l, what) => { assert.equal(l.state, 'red', what); assert.equal(l.open, true, what); assert.equal(l.retry, undefined, what); };
  const gone = env(); gone.db.remove('workers', 'srv');
  expectOpen(gone.light(id => id !== 'srv'), 'a removed device');
  assert.match(gone.light(id => id !== 'srv').title, /removed device/);
  const old = env(); old.db.put('workers', { id: 'srv', name: 'Server', capabilities: { sourceSync: 1 }, lastSeen: new Date(NOW).toISOString() });
  expectOpen(old.light(), 'a Worker without directory sync');
  const meta = env({ config: { detection: 'metadata' } });
  expectOpen(meta.light(), 'simple mode needs sourceSyncMetadataMode');
  const unsupported = env(); unsupported.watch('srv', 'blocked', { error: 'worker_unsupported' });
  expectOpen(unsupported.light(), 'Home reported the Worker cannot watch');
  for (const status of ['open', 'needs_input']) { const c = env(); c.conflict('c1', status); expectOpen(c.light(), status); }
  const resolved = env(); resolved.conflict('c1', 'resolved');
  assert.equal(color(resolved.light()), 'green');
  const paused = env(); paused.db.put('sourceSyncInitializations', { id: 'j1', projectId: P, generation: 2, status: 'paused' });
  expectOpen(paused.light(), 'a paused initialization');
  const left = env(); left.batch('m1', 'completed', { pendingMetadata: [{ path: 'a.txt', reason: 'metadata_conflict' }] });
  expectOpen(left.light(), 'files the last batch left behind');
  const watch = env(); watch.watch('mac', 'blocked', { error: 'source_busy' });
  expectOpen(watch.light(), 'a failed watcher retries by itself; a batch would not clear it');
}));

test('a blocked batch is retried from its source only when a new batch can help', () => runWithLanguage('en', () => {
  const e = env(); e.batch('b1', 'blocked', { reason: 'source_busy', sourceNodeId: 'srv' });
  const blocked = e.light();
  assert.equal(blocked.state, 'red');
  assert.deepEqual(blocked.retry, { sourceNodeId: 'srv', targetNodeIds: ['mac'] });
  e.batch('b2', 'cancelled');
  assert.deepEqual(e.light().retry, blocked.retry, 'a cancelled batch after it proves nothing');
  e.batch('b3', 'completed');
  assert.equal(color(e.light()), 'green', 'a later successful batch clears it');
  for (const extra of [{ reason: 'manifest_too_large' }, { reason: 'source_busy', actor: { kind: 'agent', runId: 'r1' } }]) {
    const x = env(); x.batch('b1', 'blocked', extra);
    assert.equal(x.light().retry, undefined, JSON.stringify(extra)); assert.equal(x.light().open, true);
  }
  const older = env(); older.batch('b0', 'blocked', { reason: 'source_busy', generation: 1 });
  assert.equal(color(older.light()), 'green', 'a batch of an earlier sync generation is not this sync');
}));
