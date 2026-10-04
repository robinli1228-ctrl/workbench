import { terminal } from './store.mjs';
import { tr } from './i18n.mjs';

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
    findings.push({ key: `plan:${current.id}:${current.status}`, text: tr('timerMonitor.executionPlan', { id: current.id, p2: current.status === 'failed' ? tr('timerMonitor.failed') : tr('timerMonitor.blocked'), p3: current.error || current.blockedReason || tr('timerMonitor.checkStagesRunRecords') }) });
  }
  for (const alert of db.list('runAlerts')) {
    if (alert.projectId !== projectId || alert.status !== 'open') continue;
    const run = db.get('runs', alert.id);
    if (!run || terminal.has(run.status)) continue;
    findings.push({ key: `run:${run.id}:${alert.reason}`, text: tr('timerMonitor.run', { id: run.id, reason: alert.reason }) });
  }
  return findings;
}
