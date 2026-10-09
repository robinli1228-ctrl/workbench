import {terminal} from './store.mjs';
import { tr } from './i18n.mjs';
import {currentContinuation} from './coordination-wait.mjs';

/** Message progress is derived from existing request, command, and run evidence; no separate, possibly contradictory state table is created. */
export function messageProgress(db,request,online,launch) {
  const registeredAt=request.createdAt,current=currentContinuation(db,request.id);
  if(current&&current.id!==request.id){request=current;launch=undefined;}
  const run=db.get('runs',request.currentRunId||''),task=db.get('tasks',request.taskId||'');
  const command=launch===undefined?db.list('commands').find(c=>c.type==='launch'&&c.runId===run?.id):launch;
  const parent=db.get('coordinationRequests',request.parentRequestId||'');
  const effective=currentContinuation(db,(parent||request).id);
  const next=effective?.id!==(parent||request).id?effective:null;
  const nextRun=db.get('runs',next?.currentRunId||'');
  const timestamps={registeredAt,sentAt:command?.firstSentAt,receivedAt:command?.ackedAt,startedAt:run?.startedAt,resultAt:run?.finishedAt,resumeStartedAt:nextRun?.startedAt};
  const result=(stage,label,reason='',attention=false)=>({stage,label,reason,attention,timestamps});
  if(request.status==='cancelled'||task?.status==='cancelled')return result('cancelled',tr('messageProgress.cancelled'));
  if(parent?.steeringTaskId||parent?.status==='cancelled'||request.steeringTaskId)return result('historical',tr('messageProgress.historicalResultNoLongerResumed'));
  if(run?.status==='failed'||run?.status==='interrupted'||request.status==='failed')return result('failed',run?.status==='succeeded'?tr('messageProgress.runEndedBusinessConclusionNot'):tr('messageProgress.runNotCompleted'),request.error||run?.error||request.notExecutedReason||'',true);
  if(request.status==='waiting_call')return result('waiting_reply',tr('messageProgress.waitingForAssistanceResults'),request.waitingReason||'');
  if(run?.status==='succeeded'||request.status==='succeeded') {
    if(request.kind==='consult'&&!String(run?.result||request.result||'').trim())return result('no_response',tr('messageProgress.runEndedWithoutReply'),tr('messageProgress.verifyOriginalRunItWill'),true);
    if(nextRun?.startedAt||['running','waiting_user','succeeded'].includes(nextRun?.status))return result('resumed',tr('messageProgress.resultReturnedInitiatorHasStarted'),terminal.has(nextRun.status)?tr('messageProgress.continuationRunEnded', { status: nextRun.status }):'');
    if(next)return result('waiting_resume',tr('messageProgress.resultReturnedWaitingForInitiator'));
    return result('result_saved',tr('messageProgress.resultSaved'),parent?.status==='waiting_call'?tr('messageProgress.waitingForOtherAssistanceResults'):'');
  }
  if(request.status==='waiting_delivery')return result('waiting_files',tr('messageProgress.waitingForFileDelivery'));
  const nodeId=run?.nodeId||request.targetSnapshot?.nodeId;
  if(nodeId&&!online(nodeId))return result('waiting_device',tr('messageProgress.waitingForDeviceConnect'),run?tr('messageProgress.runSceneNeedsVerificationIt'):tr('messageProgress.messageSavedItWillContinue'));
  if(run?.status==='reconciling')return result('reconciling',tr('messageProgress.runStateNeedsVerification'),run.error||'',true);
  if(run?.status==='stopping')return result('stopping',tr('messageProgress.waitingForStopConfirmation'));
  if(run?.status==='waiting_user')return result('waiting_user',tr('messageProgress.waitingForUserConfirmation'));
  if(run?.status==='running')return result('running',tr('messageProgress.cliRunning'));
  if(command?.acked)return result('worker_received',tr('messageProgress.receivedByWorkerCliStarting'));
  if(command?.lastSentAt)return result('sent',tr('messageProgress.sentWaitingForWorkerConfirmation'));
  return result('queued',tr('messageProgress.registeredWaitingForRole'),task?.waitingReason||request.waitingReason||'');
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
