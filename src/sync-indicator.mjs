import { tr } from './i18n.mjs';

// Conflicts waiting for a person, and conflicts already being worked on (initialization, a queued or running repair, a fix in flight).
const CONFLICT_DECIDE = new Set(['open', 'needs_input']);
const CONFLICT_DONE = new Set(['resolved', 'cancelled']);
// Block reasons a new batch cannot fix: limits, a changed scope or binding, setup and version problems.
const PERMANENT = new Set(['batch_too_large', 'manifest_too_large', 'file_too_large', 'storage_full', 'source_scope_changed', 'git_baseline_mismatch',
  'source_run_failed', 'binding_changed', 'binding_missing', 'display_mac_required', 'display_node_required', 'worker_unsupported', 'invalid_scope',
  'overlapping_scope', 'scope_read_only', 'metadata_two_devices', 'metadata_baseline_required', 'deliver_to_project_first', 'runtime_directory',
  'unsafe_file', 'nested_repository', 'invalid_repository']);
// A Worker that just dropped is usually reconnecting; it counts as offline only after this long without a heartbeat.
const RECONNECT_GRACE_MS = 60000;

/** Whether a Worker can take part in this configuration's kind of sync. */
const capable = (worker, config) => {
  const c = worker?.capabilities || {};
  return c.sourceSync === 1 && (config.scopeKind !== 'directory' || c.sourceSyncDirectory === 1)
    && (config.detection !== 'metadata' || c.sourceSyncMetadataMode === 1) && (config.contentMode !== 'source-and-outputs' || c.sourceSyncOutputs === 1);
};

/**
 * One light for a project's file sync across its devices: red needs attention, orange is in progress, green is in step, off is not
 * enabled. Red carries a retry (a new batch from the same source) only when a new batch can help, and open:true otherwise.
 */
export function syncIndicator(db, projectId, { online = () => true, conflicts = null, now = Date.now() } = {}) {
  const config = db.get('sourceSyncConfigs', projectId);
  if (!config?.enabled) return { state: 'off', title: tr('syncIndicator.off') };
  const nodes = config.nodeIds || [], worker = id => db.get('workers', id);
  const name = id => worker(id)?.name || tr('syncIndicator.removedDevice'), names = ids => [...new Set(ids)].map(name).join(tr('syncIndicator.separator'));
  const red = (title, extra = { open: true }) => ({ state: 'red', title, ...extra });
  const orange = title => ({ state: 'orange', title });
  const lastSeen = id => Date.parse(worker(id)?.lastSeen || '') || 0;
  const away = nodes.filter(id => !online(id)), offline = away.filter(id => !worker(id) || now - lastSeen(id) > RECONNECT_GRACE_MS);
  if (offline.length) return red(tr('syncIndicator.offline', { names: names(offline) }));
  const watchers = db.listProject('sourceSyncWatchStates', projectId).filter(w => w.generation === config.generation);
  const outdated = [...nodes.filter(id => !capable(worker(id), config)), ...watchers.filter(w => w.error === 'worker_unsupported').map(w => w.nodeId)];
  if (outdated.length) return red(tr('syncIndicator.outdated', { names: names(outdated) }));
  const open = (conflicts || db.listProject('sourceSyncConflicts', projectId)).filter(c => !CONFLICT_DONE.has(c.status));
  const decide = open.filter(c => CONFLICT_DECIDE.has(c.status)).length;
  if (decide) return red(tr('syncIndicator.conflicts', { count: decide }));
  const initialization = db.listProject('sourceSyncInitializations', projectId).filter(j => j.generation === undefined || j.generation === config.generation);
  if (initialization.some(j => j.status === 'paused')) return red(tr('syncIndicator.initializationPaused'));
  const paused = db.get('settings', 'main')?.paused;
  const batches = db.listSourceSyncBatches({ projectId }).filter(b => b.kind !== 'preview' && b.generation === config.generation);
  if (paused && batches.length) return red(tr('syncIndicator.pausedQueued'));
  if (batches.length || open.length || initialization.some(j => j.status === 'running') || away.length)
    return orange(away.length ? tr('syncIndicator.reconnecting', { names: names(away) }) : tr('syncIndicator.syncing'));
  const failedWatch = watchers.find(w => w.status === 'blocked');
  if (failedWatch) return red(tr('syncIndicator.watchFailed', { name: name(failedWatch.nodeId), reason: failedWatch.error || 'blocked' }));
  // The newest finished batch of this generation; a cancelled batch says nothing about whether the devices match.
  const last = db.lastSourceSyncBatch(projectId, config.generation);
  const left = last?.pendingMetadata?.length || last?.pendingMetadataCount || 0;
  if (left) return red(tr('syncIndicator.filesLeft', { count: left }));
  if (last?.status === 'blocked') {
    const reason = last.reason || 'blocked', title = tr('syncIndicator.blocked', { reason });
    // A batch an agent started syncs that run's own copy, and a retry here would sync the project folder instead.
    if (paused || PERMANENT.has(reason) || last.actor?.kind === 'agent' || !nodes.includes(last.sourceNodeId)) return red(title + tr('syncIndicator.openPanel'));
    return red(title + tr('syncIndicator.clickRetry'), { retry: { sourceNodeId: last.sourceNodeId, targetNodeIds: nodes.filter(id => id !== last.sourceNodeId) } });
  }
  return { state: 'green', title: tr('syncIndicator.synced', { names: names(nodes) }) };
}
