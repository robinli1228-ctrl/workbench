import {terminal} from './store.mjs';

/** Message progress is derived from existing request, command, and run evidence; no separate, possibly contradictory state table is created. */
export function messageProgress(db,request,online,launch) {
  const run=db.get('runs',request.currentRunId||''),task=db.get('tasks',request.taskId||'');
  const command=launch===undefined?db.list('commands').find(c=>c.type==='launch'&&c.runId===run?.id):launch;
  const parent=db.get('coordinationRequests',request.parentRequestId||'');
  const next=db.get('coordinationRequests',(parent||request).continuationRequestId||'');
  const nextRun=db.get('runs',next?.currentRunId||'');
  const timestamps={registeredAt:request.createdAt,sentAt:command?.firstSentAt,receivedAt:command?.ackedAt,startedAt:run?.startedAt,resultAt:run?.finishedAt,resumeStartedAt:nextRun?.startedAt};
  const result=(stage,label,reason='',attention=false)=>({stage,label,reason,attention,timestamps});
  if(request.status==='cancelled'||task?.status==='cancelled')return result('cancelled','Cancelled');
  if(parent?.steeringTaskId||parent?.status==='cancelled'||request.steeringTaskId)return result('historical','Historical result; no longer resumed');
  if(run?.status==='failed'||run?.status==='interrupted'||request.status==='failed')return result('failed',run?.status==='succeeded'?'Run ended; business conclusion not passed':'Run not completed',request.error||run?.error||request.notExecutedReason||'',true);
  if(request.status==='waiting_call')return result('waiting_reply','Waiting for assistance results',request.waitingReason||'');
  if(run?.status==='succeeded'||request.status==='succeeded') {
    if(request.kind==='consult'&&!String(run?.result||request.result||'').trim())return result('no_response','Run ended without a reply','Verify the original run; it will not be rerun automatically',true);
    if(nextRun?.startedAt||['running','waiting_user','succeeded'].includes(nextRun?.status))return result('resumed','Result returned; the initiator has started the continuation',terminal.has(nextRun.status)?`Continuation run ended: ${nextRun.status}`:'');
    if(next)return result('waiting_resume','Result returned; waiting for the initiator to continue');
    return result('result_saved','Result saved',parent?.status==='waiting_call'?'Waiting for other assistance results or for the initiator to end this turn':'');
  }
  if(request.status==='waiting_delivery')return result('waiting_files','Waiting for file delivery');
  const nodeId=run?.nodeId||request.targetSnapshot?.nodeId;
  if(nodeId&&!online(nodeId))return result('waiting_device','Waiting for the device to connect',run?'The run scene needs verification; it will not be redispatched automatically':'Message saved; it will continue when the device recovers');
  if(run?.status==='reconciling')return result('reconciling','Run state needs verification',run.error||'',true);
  if(run?.status==='stopping')return result('stopping','Waiting for stop confirmation');
  if(run?.status==='waiting_user')return result('waiting_user','Waiting for user confirmation');
  if(run?.status==='running')return result('running','CLI running');
  if(command?.acked)return result('worker_received','Received by the Worker; CLI starting');
  if(command?.lastSentAt)return result('sent','Sent; waiting for Worker confirmation');
  return result('queued','Registered; waiting for the role',task?.waitingReason||request.waitingReason||'');
}

/** Only repairs missed wrap-up for runs already in a final state; it creates no replacement run and does not retry business work with an unknown outcome. */
export function reconcileCallResults(db,calls) {
  let changed=false;
  for(const request of db.list('coordinationRequests')) {
    if(!['running','queued'].includes(request.status)||!request.currentRunId)continue;
    const run=db.get('runs',request.currentRunId);
    if(!run||!terminal.has(run.status)||run.discussionDeliveryId||run.discussionWaiting)continue;
    calls.finish(run.id);changed=true;
  }
  return changed;
}
