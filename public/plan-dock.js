import {executionProgress} from './execution-progress.js';

/** Hiding applies to the current version only; the dock reappears when the same plan resumes or has new results. */
export function planDismissKey(plan) {
  return JSON.stringify([plan.id, plan.status, plan.updatedAt || plan.createdAt || '']);
}

/** 计划保留原始失败记录，仅在明确未派发时区别显示，不能用缺失的 Run 摘要推断未执行。 */
function planMemberProgress({request,run,task}) {
  if(request?.status==='failed'&&request.notExecutedReason&&!request.currentRunId&&!run&&!task?.currentRunId) {
    return {state:'not_executed',label:'Not executed',reason:request.notExecutedReason};
  }
  const progress=executionProgress({request,run,task});
  return progress.state==='stopped'?{...progress,label:'Aborted'}:progress;
}

/** 计划成员区分中止、未执行与实际失败，不改变执行状态或审核结论。 */
export function planMemberLabel(request, run, task) {
  return planMemberProgress({request,run,task}).label;
}

/** A scheduler stage can be open while every member is still queued; display execution evidence, not that lifecycle flag. */
export function planStageActivity(stage, requests=[], runs=[], tasks=[]) {
  const current=(stage?.members||[]).map(member=>{
    let request=requests.find(r=>r.id===member.requestId);
    for(let i=0;request?.continuationRequestId&&i<20;i++)request=requests.find(r=>r.id===request.continuationRequestId);
    return {request,run:runs.find(r=>r.id===request?.currentRunId),task:tasks.find(t=>t.id===request?.taskId)};
  });
  const progress=current.map(planMemberProgress);
  for(const state of ['running','waiting','queued','error','stopped','not_executed','completed']) {
    const p=progress.find(item=>item.state===state);
    if(p)return {state:p.state,label:p.label,reason:p.reason||p.detail};
  }
  const p=executionProgress({task:{status:{succeeded:'completed',cancelled:'cancelled',failed:'blocked'}[stage?.status]||'ready'}});
  return {state:p.state,label:p.label,reason:stage?.error||''};
}

/** 阻断的计划不是会自动继续的正常等待；子步骤仍按各自证据显示。 */
export function planActivity(plan, requests=[], runs=[], tasks=[]) {
  if(['blocked','failed'].includes(plan.status))return {label:'Plan error',reason:plan.error||plan.waitingReason||''};
  if(plan.status==='cancelled')return {label:'Aborted',reason:plan.error||''};
  const stage=plan.status==='running'?plan.stages?.find(s=>s.status==='running'):{members:(plan.stages||[]).flatMap(s=>s.members||[]),status:plan.status};
  return planStageActivity(stage,requests,runs,tasks);
}

/** Show only the latest plan round created for the project; closing does not fall back to older rounds, and progress is still derived from call state. */
export function planDockState(plans, requests, projectId, dismissedKeys = []) {
  const time = plan => Date.parse(plan.createdAt || plan.updatedAt || '') || 0;
  const dated = (plans || []).filter(plan => plan.projectId === projectId)
    .sort((a, b) => time(b) - time(a)).slice(0, 1);
  const byId = new Map((requests || []).map(request => [request.id, request]));
  const dismissible = dated.filter(plan => {
    if (!['succeeded', 'cancelled', 'failed', 'blocked', 'completed_with_issues', 'awaiting_acceptance'].includes(plan.status)) return false;
    const ids = new Set((plan.stages || []).flatMap(stage => (stage.members || []).map(member => member.requestId)));
    for (const id of ids) {
      const request = byId.get(id);
      if (request && !['succeeded', 'failed', 'cancelled', 'waiting_dependencies'].includes(request.status)) return false;
      if (request?.continuationRequestId) ids.add(request.continuationRequestId);
    }
    return true;
  });
  const hidden = new Set(dismissedKeys);
  const canDismiss = new Set(dismissible.map(plan => plan.id));
  const visible = dated.filter(plan => !canDismiss.has(plan.id) || !hidden.has(planDismissKey(plan)));
  const current = visible[0] || null;
  if (!current) return { current: null, plans: dated, dismissible, completed: 0, total: 0, currentStage: '' };
  const completedRequest = id => {
    let request = byId.get(id);
    const seen = new Set();
    for (let index = 0; request?.continuationRequestId && index < 20; index++) {
      if (seen.has(request.id)) break;
      seen.add(request.id);
      request = byId.get(request.continuationRequestId);
    }
    return request?.status === 'succeeded' || (current.failurePolicy==='collect_reviews' && request?.status==='failed' && !!request.currentRunId && !request.notExecutedReason);
  };
  const stages = current.stages || [];
  const total = stages.reduce((count, stage) => count + (stage.members || []).length, 0);
  const completed = stages.reduce((count, stage) => count + (stage.status === 'succeeded'
    ? (stage.members || []).length : (stage.members || []).filter(member => completedRequest(member.requestId)).length), 0);
  const currentStage = current.status==='awaiting_acceptance'?'Stage done; waiting for the supervisor to accept it':current.status==='completed_with_issues'?'Reviews collected; see replies and reports':stages.find(stage => stage.status !== 'succeeded' && !(current.failurePolicy==='collect_reviews'&&stage.status==='failed'))?.title || (current.status === 'succeeded' ? 'All done' : 'Waiting to advance');
  return { current, plans: dated, dismissible, completed, total, currentStage };
}
