import {assertConversationRecord,conversationIdOf} from './group-conversations.mjs';

/** Follow only the same owner's continuation chain; a peer reply must not jump to a different task or project. */
export function currentContinuation(db,requestId) {
  let current=db.get('coordinationRequests',requestId);const seen=new Set();
  while(current?.continuationRequestId&&current.status!=='cancelled'&&!current.steeringTaskId) {
    if(seen.has(current.id))throw new Error('Invalid coordination continuation cycle.');seen.add(current.id);
    const next=db.get('coordinationRequests',current.continuationRequestId);
    assertConversationRecord(current,next);
    if(!next||next.projectId!==current.projectId||next.targetRoleId!==current.targetRoleId||next.continuationOf!==current.id)throw new Error('Coordination continuation ownership changed.');
    current=next;
  }
  return current;
}

/** The dependency identities are original calls, not replacement teammate tasks created by a timeout. */
export function waitDependencies(db,request) {
  if(!request)return [];
  const selected=request.status==='waiting_call'&&Array.isArray(request.waitRequestIds),ids=new Set(request.waitRequestIds||[]);
  if(!selected) {
    const owners=new Set([request.id]);let ancestor=request;
    while(ancestor.continuationOf) {
      const previous=db.get('coordinationRequests',ancestor.continuationOf);
      assertConversationRecord(request,previous);
      if(!previous||previous.projectId!==request.projectId||previous.targetRoleId!==request.targetRoleId||owners.has(previous.id))throw new Error('Invalid dependency ownership chain.');
      owners.add(previous.id);ancestor=previous;
    }
    for(const child of db.list('coordinationRequests').filter(r=>owners.has(r.parentRequestId)&&!r.continuationOf))
      if(child.parentRequestId===request.id||!['succeeded','failed','cancelled'].includes(currentContinuation(db,child.id)?.status))ids.add(child.id);
  }
  return [...ids].map(id=>{
    const child=db.get('coordinationRequests',id);
    assertConversationRecord(request,child);
    if(!child||child.projectId!==request.projectId)throw new Error('A wait dependency is missing or outside the project.');
    const effective=currentContinuation(db,id);
    return effective?.id!==child.id?{...effective,id:child.id,resultRequestId:effective.id}:child;
  });
}

/** Task-scoped facts at actual execution admission; full answers remain available through result read. */
export function dependencySnapshot(db,requestId) {
  const request=db.get('coordinationRequests',requestId||'');
  return request?waitDependencies(db,request).map(r=>({requestId:r.id,status:r.status,outcome:r.outcome||null,waitingReason:db.get('tasks',r.taskId||'')?.waitingReason||r.waitingReason||null,
    summary:String(r.reportSummary||r.result||r.error||'').slice(0,1500),readCommand:`wb result read ${r.id}`})):[];
}

export const COLLAB_RELEASE_DEFAULT_MINUTES=40;
const settledStatuses=new Set(['succeeded','failed','cancelled']);
const stamp=value=>Date.parse(value||'')||0;
/** The first request of an owner's continuation chain identifies one collaboration, however many times it resumed. */
export function collaborationRoot(db,request) {
  let current=request;const seen=new Set();
  while(current?.continuationOf&&!seen.has(current.id)){seen.add(current.id);const previous=db.get('coordinationRequests',current.continuationOf);if(!previous)break;current=previous;}
  return current||null;
}
export function releaseMinutes(project) {
  const value=project?.collaborationWaitReleaseMinutes;
  return Number.isSafeInteger(value)&&value>=5&&value<=1440?value:COLLAB_RELEASE_DEFAULT_MINUTES;
}

/** Read-only view of roles whose own collaboration is unfinished. Unrelated same-role tasks in the same chat wait behind it,
 *  unless a human explicitly let one go first or the chain shows no progress for the project's release window. */
export function collaborationQueueView(db,time=Date.now()) {
  const heads=[...db.schedulableRequests(),...db.pendingCallResults().filter(r=>r.status==='running')];
  const states=[],seen=new Set();
  for(const head of heads) {
    if(seen.has(head.id)||head.steeringTaskId||!head.targetRoleId)continue;seen.add(head.id);
    const waiting=head.status==='waiting_call'&&!head.continuationRequestId;
    if(!waiting&&!(head.kind==='continuation'&&head.continuationOf&&!settledStatuses.has(head.status)))continue;
    if(db.get('tasks',head.taskId||'')?.status==='cancelled')continue;
    const root=collaborationRoot(db,head);
    let dependencies=[];try{dependencies=waiting?waitDependencies(db,head):[];}catch{dependencies=[];}
    const progressAt=Math.max(stamp(head.updatedAt),stamp(head.createdAt),stamp(head.waitEvent?.observedAt),...dependencies.map(d=>Math.max(stamp(d.updatedAt),stamp(d.createdAt))));
    const minutes=releaseMinutes(db.get('projects',head.projectId)),releaseAt=progressAt+minutes*60000;
    states.push({projectId:head.projectId,conversationId:conversationIdOf(head),roleId:head.targetRoleId,rootRequestId:root?.id||head.id,currentRequestId:head.id,
      taskId:head.taskId||null,phase:waiting?'waiting_reply':head.currentRunId?'processing_reply':'resume_queued',
      waitingRequestIds:dependencies.filter(d=>!settledStatuses.has(d.status)).map(d=>d.id),progressAt:new Date(progressAt).toISOString(),
      releaseAt:new Date(releaseAt).toISOString(),released:waiting&&time>=releaseAt,releaseMinutes:minutes});
  }
  const scope=task=>states.filter(s=>s.projectId===task.projectId&&s.conversationId===conversationIdOf(task)&&s.roleId===task.roleId);
  return {states,
    /** allowed=false keeps the task queued; released chains free the queue and human messages are offered first. */
    forTask(task) {
      const own=scope(task),blocking=own.filter(s=>!s.released);
      if(!blocking.length)return {allowed:true,released:own.some(s=>s.released)};
      if(task.collaborationYield)return {allowed:true,yielded:true};
      const request=task.requestId?db.get('coordinationRequests',task.requestId):null,root=request?collaborationRoot(db,request)?.id:null;
      if(root&&own.some(s=>s.rootRequestId===root))return {allowed:true,own:true};
      const next=blocking.reduce((a,b)=>stamp(a.releaseAt)<=stamp(b.releaseAt)?a:b);
      return {allowed:false,state:next,minutesLeft:Math.max(1,Math.ceil((stamp(next.releaseAt)-time)/60000))};
    }};
}
