import {terminal} from './store.mjs';
import { tr } from './i18n.mjs';
import {currentContinuation} from './coordination-wait.mjs';
import {executionProgress} from '../public/execution-progress.js';

/** Reuse only this synchronous response's records, including full reply evidence; never cache across requests. */
export function messageProgressView({runs,tasks,requests}) {
  const records=new Map([['runs',runs],['tasks',tasks],['coordinationRequests',requests]].map(([kind,rows])=>[kind,new Map(rows.map(row=>[row.id,row]))]));
  return {get:(kind,id)=>records.get(kind)?.get(id)||null};
}

/** Message progress is derived from existing request, command, and run evidence; no separate, possibly contradictory state table is created. */
export function messageProgress(db,request,online,launch,launches) {
  const registeredAt=request.createdAt,current=currentContinuation(db,request.id);
  if(current&&current.id!==request.id){request=current;launch=undefined;}
  const run=db.get('runs',request.currentRunId||''),task=db.get('tasks',request.taskId||'');
  // Preserve find's first-match and missing-Run semantics while reusing the caller's current snapshot.
  const command=launch===undefined?(launches?launches.get(run?.id):db.list('commands').find(c=>c.type==='launch'&&c.runId===run?.id)):launch;
  const parent=db.get('coordinationRequests',request.parentRequestId||'');
  const effective=currentContinuation(db,(parent||request).id);
  const next=effective?.id!==(parent||request).id?effective:null;
  const nextRun=db.get('runs',next?.currentRunId||'');
  const timestamps={registeredAt,sentAt:command?.firstSentAt,receivedAt:command?.ackedAt,startedAt:run?.startedAt,resultAt:run?.finishedAt,resumeStartedAt:nextRun?.startedAt};
  const nodeId=run?.nodeId||request.targetSnapshot?.nodeId;
  const progress=executionProgress({run,task,request,online:!nodeId||online(nodeId)});
  let stage=progress.stage,reason=progress.reason||tr(`executionProgress.${stage}`);
  if(!progress.reason&&reason===`executionProgress.${stage}`)reason='';
  if(progress.state==='completed') {
    if(parent?.steeringTaskId||parent?.status==='cancelled'||request.steeringTaskId){stage='historical';reason=tr('messageProgress.historicalResultNoLongerResumed');}
    else if(nextRun?.startedAt||['running','waiting_user','succeeded'].includes(nextRun?.status)){stage='resumed';reason=tr('messageProgress.resultReturnedInitiatorHasStarted');}
    else if(next){stage='waiting_resume';reason=tr('messageProgress.resultReturnedWaitingForInitiator');}
    else if(parent?.status==='waiting_call')reason=tr('messageProgress.waitingForOtherAssistanceResults');
  } else if(progress.state==='queued'&&command?.lastSentAt){stage='sent';reason=tr('messageProgress.sentWaitingForWorkerConfirmation');}
  return {stage,state:progress.state,label:tr(`executionProgress.label.${progress.state}`),reason,attention:progress.attention,timestamps};
}

/** Only repairs missed wrap-up for runs already in a final state; it creates no replacement run and does not retry business work with an unknown outcome. */
export function reconcileCallResults(db,calls) {
  let changed=false;
  for(const request of db.pendingCallResults()) {
    if(!['running','queued'].includes(request.status)||!request.currentRunId)continue;
    const run=db.get('runs',request.currentRunId);
    if(!run||!terminal.has(run.status)||run.discussionDeliveryId||run.discussionWaiting)continue;
    calls.finish(run.id);changed=true;
  }
  return changed;
}
