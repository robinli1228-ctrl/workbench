/** Switch barriers are role scoped; candidate execution is never an ordinary session. */
export const switchSettled = op => ['committed', 'cancelled'].includes(op?.status);
export const activeRoleSwitch = (db, roleId) => db.list('roleSwitches').find(op => op.roleId === roleId && (!switchSettled(op)||!op.steps?.released));
export const isSwitchMaintenance = run => Boolean(run?.switchOperationId);

/** Direct configuration saves must not bypass the handoff, even without a current native session. */
export function assertBindingEditAllowed(db, role, draft = role) {
  if (!role) return;
  if (activeRoleSwitch(db, role.id)) throw new Error('CLI switch in progress; cancel and wait for settlement before editing.');
  if (role.runtime && (!draft.runtime || !draft.nodeId || !draft.model)) throw new Error('An established execution binding cannot be cleared; disable or archive the role instead.');
  if (role.runtime && role.runtime !== draft.runtime) throw new Error('Changing CLI requires a verified handoff and switch.');
}

/** A new model or effort on the same device and CLI also applies to the role's work that has not started; a running turn finishes as it began. */
export function applyToQueuedWork(db, old, role) {
  if (!old || old.nodeId !== role.nodeId || old.runtime !== role.runtime || (old.model === role.model && (old.effort || null) === (role.effort || null))) return role;
  const same = r => r && r.id === role.id && r.nodeId === role.nodeId && r.runtime === role.runtime;
  const bound = record => record.executionBinding?.role ? { executionBinding: { ...record.executionBinding, role } } : {};
  for (const task of db.chatTasks(['ready'])) {
    if (task.roleId !== role.id || task.currentRunId || task.switchOperationId || !same(task.executionBinding?.role || task.roleSnapshot)) continue;
    db.put('tasks', { ...task, roleSnapshot: role, model: role.model, ...bound(task) });
  }
  for (const request of db.listProject('coordinationRequests', role.projectId)) {
    if (request.targetRoleId !== role.id || request.currentRunId || !['queued', 'waiting_delivery'].includes(request.status) || !same(request.executionBinding?.role || request.targetSnapshot)) continue;
    db.put('coordinationRequests', { ...request, targetSnapshot: role, ...bound(request) });
  }
  return role;
}

/** A held request keeps its historical snapshot; only a later execution uses the committed binding. */
export function effectiveExecutionRole(db, task) {
  return task.executionBinding?.role || task.roleSnapshot;
}

/** Existing work and its descendants may drain; independent later work waits. */
export function roleSwitchWaitReason(db, task) {
  const op = activeRoleSwitch(db, task.roleId || task.roleSnapshot?.id);
  if (!op) return null;
  if (isSwitchMaintenance(task)) return task.switchOperationId === op.id && ['handoff','verifying'].includes(op.status) ? null : 'CLI switch maintenance is no longer authorized.';
  if (op.status === 'draining' && belongsToDrain(db, op, task)) return null;
  return 'Waiting for CLI handoff and switch.';
}

/** Follow stored provenance rather than timestamps so late peer replies do not deadlock a root. */
export function belongsToDrain(db, op, task, seen = new Set()) {
  if (!task || seen.has(task.id)) return false;
  if (op.drainTaskIds.includes(task.id) || (task.planId && op.drainPlanIds.includes(task.planId))) return true;
  seen.add(task.id);
  if(task.businessTaskId&&belongsToDrain(db,op,db.get('tasks',task.businessTaskId),seen))return true;
  const request = task.requestId && db.get('coordinationRequests', task.requestId);
  if (request && op.drainRequestIds.includes(request.id)) return true;
  for (const runId of [task.sourceRunId, task.continuationRunId, request?.sourceRunId]) {
    const run = runId && db.get('runs', runId);
    if (run && belongsToDrain(db, op, db.get('tasks', run.taskId), seen)) return true;
  }
  if (request?.parentRequestId) {
    const parent = db.get('coordinationRequests', request.parentRequestId);
    if (parent && (op.drainRequestIds.includes(parent.id) || belongsToDrain(db, op, db.get('tasks', parent.taskId), seen))) return true;
  }
  return false;
}
