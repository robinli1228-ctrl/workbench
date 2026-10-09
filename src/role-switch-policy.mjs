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
