import { tr } from './i18n.mjs';
/** Deterministic gate of the node supervisor; communication may be forwarded, but the role binding and the designated commit cannot be changed. */
export function validateLaunch({ request, roleSnapshot, delivery, currentPlanVersion }) {
  if (!request || request.projectId !== roleSnapshot?.projectId || request.targetRoleId !== roleSnapshot.id) throw new Error(tr('workerCoordinator.callDoesNotMatchRole'));
  if (['cancelled', 'succeeded', 'failed'].includes(request.status)) throw new Error(tr('workerCoordinator.callHasAlreadyEnded'));
  if (request.planVersion && request.planVersion !== currentPlanVersion) throw new Error(tr('workerCoordinator.planVersionHasChanged'));
  for (const key of ['nodeId', 'runtime', 'model', 'revision']) {
    if ((request.targetSnapshot?.[key] ?? (key === 'revision' ? 1 : null)) !== (roleSnapshot[key] ?? (key === 'revision' ? 1 : null))) throw new Error(tr('workerCoordinator.roleExecutionConfigurationDiffersFrom'));
  }
  if (request.kind === 'handoff' && (delivery?.status !== 'ready' || delivery.projectId !== request.projectId)) throw new Error(tr('workerCoordinator.deliveryNotReadyYet'));
  return true;
}

/** A completed Runtime turn does not mean the managed process has exited; slots and final states are published together after exit. */
export function afterProcessExit(proc, complete) {
  if (!proc?.pid || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve().then(complete);
  return new Promise(resolve => proc.once('exit', resolve)).then(complete);
}

/** Commit the command result together with the send queue, so a crash cannot leave the result known but unreportable. */
export function recordDeliveryResult(db, commandId, result) {
  return db.transaction(() => {
    const command = db.get('commands', commandId), run = db.get('runs', command.runId);
    if (command.result) return null;
    const seq = (run.seq || 0) + 1;
    const event = { id: `${commandId}:result`, runId: run.id, seq, type: 'delivery', payload: result, createdAt: new Date().toISOString() };
    db.put('commands', { ...command, result });
    db.put('runs', { ...run, seq });
    db.put('outbox', event);
    return event;
  });
}

export function recoverDeliveryCommands(db) {
  for (const command of db.list('commands').filter(c => c.type === 'delivery_publish' && !c.result)) {
    recordDeliveryResult(db, command.id, { deliveryId: command.deliveryId, status: 'blocked', error: tr('workerCoordinator.workerRestartedDeliveryResultUnconfirmed') });
  }
}

/** A continuation keeps the code state of a finished run; it cannot take over another role's directory or one already occupied by a later run. */
export function continuationSource(db, run, retained=()=>false) {
  const source = db.get('runs', run.continuationRunId);
  if (!source || source.projectId !== run.projectId || source.roleId !== run.roleId || source.status !== 'succeeded' || !source.workspace) throw new Error(tr('workerCoordinator.continuationSourceNotFinishedDoes'));
  const owner = db.get('workspaceOwners', source.workspace);
  if (!source.projectScope && owner && owner.runId !== source.id) throw new Error(tr('workerCoordinator.continuationWorkspaceHasBeenTaken'));
  if (db.list('runs').some(r => r.id !== run.id && r.workspace === source.workspace && !['succeeded', 'failed', 'interrupted'].includes(r.status))) throw new Error(tr('workerCoordinator.continuationWorkspaceStillHasUnfinished'));
  if (source.pid && !retained(source.pid)) {
    try { process.kill(source.pid, 0); throw new Error(tr('workerCoordinator.sourceProcessStillRunningCannot')); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  return source;
}
