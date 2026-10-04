import { terminal } from './store.mjs';

/** Read-only inspection of the current project, so that earlier failed plans are not repeatedly treated as new faults. */
export function progressFindings(db, projectId, _now) {
  const findings = [];
  const plans = db.list('executionPlans').filter(plan => plan.projectId === projectId)
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
  const current = plans.find(plan => ['blocked', 'failed'].includes(plan.status) && (
    plan.parentRequestId
      ? !['succeeded', 'failed', 'cancelled'].includes(db.get('coordinationRequests', plan.parentRequestId)?.status)
      : plan.id === plans[0]?.id
  ));
  if (current) {
    findings.push({ key: `plan:${current.id}:${current.status}`, text: `Execution plan ${current.id} ${current.status === 'failed' ? 'failed' : 'is blocked'}: ${current.error || current.blockedReason || 'Check the stages and run records'}` });
  }
  for (const alert of db.list('runAlerts')) {
    if (alert.projectId !== projectId || alert.status !== 'open') continue;
    const run = db.get('runs', alert.id);
    if (!run || terminal.has(run.status)) continue;
    findings.push({ key: `run:${run.id}:${alert.reason}`, text: `Run ${run.id}: ${alert.reason}` });
  }
  return findings;
}
