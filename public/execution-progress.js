const finalRuns=new Set(['succeeded','failed','interrupted']);
export const executionProgressLabels=Object.freeze({queued:'Pending execution',running:'In progress',waiting:'Waiting',completed:'Completed',stopped:'Stopped',error:'Execution error'});
const tones={queued:'waiting',running:'working',waiting:'waiting',completed:'idle',stopped:'idle',error:'blocked'};

/** One read-only progress projection for Home and the UI. Reports and acceptance never change execution progress. */
export function executionProgress({run,task,request,online=true}={}) {
  if(run?.discussionDeliveryId){task=null;request=null;}
  else if(run?.id&&task?.currentRunId&&task.currentRunId!==run.id){
    task=null;
    // Keep this turn's own final delivery evidence, never a later continuation's state.
    if(request?.currentRunId!==run.id||request.continuationRequestId||!['succeeded','failed','cancelled'].includes(request.status))request=null;
  }
  const result=(state,stage,detail='',reason='')=>({state,stage,label:executionProgressLabels[state],tone:tones[state],attention:state==='error',detail,reason});
  const live=run&&!finalRuns.has(run.status);
  // A cancel request is not proof of process exit; disconnected or unreconciled processes keep their locks.
  if(live&&(!online||run.status==='reconciling'))return result('waiting',!online?'waiting_device':'reconciling','Execution state needs reconciling',run.error||'');
  if(live&&(run.status==='stopping'||run.stopRequested))return result('running','stopping','Waiting for stop confirmation');
  if(run?.status==='interrupted'||(!live&&(request?.status==='cancelled'||task?.status==='cancelled')))return result('stopped','cancelled','This round was stopped');
  if(run?.status==='failed')return result('error','failed','This round failed; see the logs',run.error||request?.error||'');
  if(run?.status==='waiting_user')return result('waiting','waiting_user','Waiting for user confirmation');
  if(['running','starting','preparing'].includes(run?.status))return result('running',run.status==='running'?'running':'worker_received',run.status==='running'?'CLI running':'CLI starting');
  if(run?.status==='queued')return result('queued','queued','Waiting to be scheduled',task?.waitingReason||'');
  if(task?.discussionWait||task?.status==='waiting_discussion'||run?.discussionWaiting)return result('waiting','waiting_reply','Waiting for the current question to be handled',task?.waitingReason||'');
  const waiting={waiting_call:['waiting_reply','Waiting for other roles to reply'],waiting_delivery:['waiting_files','Waiting for file delivery'],waiting_dependencies:['waiting_dependencies','Waiting on prior steps'],waiting_input:['waiting_user','Waiting for user confirmation']}[request?.status];
  if(request?.status==='waiting_call'&&request.resumeError?.kind==='transient')return result('waiting','resume_retrying','Replies arrived; retrying the follow-up',request.resumeError.message||'');
  if(waiting)return result('waiting',...waiting,request.waitingReason||'');
  if(request?.status==='failed'&&request.failureKind==='resume_failed')return result('error','resume_failed','Replies arrived, but the follow-up failed',request.error||'');
  if(request?.status==='failed'&&(!run||run.status!=='succeeded'||request.error||request.failureKind||request.notExecutedReason))return result('error','failed','Task did not start; see the logs',request.error||request.notExecutedReason||'');
  if(task?.status==='ready')return result(online?'queued':'waiting',online?'queued':'waiting_device',online?'Waiting to be scheduled':'Waiting for the device to connect',task.waitingReason||'');
  if(run?.status==='succeeded'||request?.status==='succeeded') {
    // Compact workspace snapshots deliberately omit reply bodies; only Home's full projection can prove an empty reply.
    if(request?.kind==='consult'&&(request.messageProgress?.stage==='no_response'||(!run?.summaryOnly&&![run?.result,request.result,request.reportSummary,run?.report?.summary].some(text=>typeof text==='string'&&text.trim()))))return result('error','no_response','Run ended without a reply');
    return result('completed','result_saved');
  }
  if(!online)return result('waiting','waiting_device','Waiting for the device to connect');
  if(task?.status==='blocked')return result('error','failed','Task did not start; see the logs',task.error||task.waitingReason||'');
  if(['completed','awaiting_acceptance','done'].includes(task?.status))return result('completed','result_saved');
  if(request?.status==='running'||task?.status==='in_progress')return result('waiting','reconciling','Execution state needs reconciling');
  return result('queued','queued','Waiting to be scheduled',task?.waitingReason||request?.waitingReason||'');
}
