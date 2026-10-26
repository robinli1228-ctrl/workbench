import {assertConversationRecord,conversationIdOf} from './group-conversations.mjs';

/** Pin the wake's feedback identity; ambiguous same-time results without an explicit trigger must not select a random peer. */
export function continuationFeedback(children,triggerRequestId=null) {
  let child=triggerRequestId?children.find(c=>c.id===triggerRequestId||c.resultRequestId===triggerRequestId):null;
  if(!child){
    if(children.length===1)child=children[0];
    else{
      const times=children.map(c=>Date.parse(c.updatedAt));
      if(!times.length||times.some(t=>!Number.isFinite(t)))return null;
      const last=Math.max(...times),latest=children.filter((c,i)=>times[i]===last);
      if(latest.length!==1)return null;
      child=latest[0];
    }
  }
  return child?.currentRunId?{requestId:child.resultRequestId||child.id,runId:child.currentRunId}:null;
}

/** Legacy wakes use only their saved dependency set, never the chat tail or results that changed after the wake. */
export function legacyContinuationFeedback(db,request,previous) {
  if(previous.continuationRequestId!==request.id||previous.waitEvent?.reason!=='results'||!Array.isArray(previous.waitEvent.requestIds))return null;
  const cutoff=Date.parse(request.createdAt),owners=new Set();let owner=previous;
  if(!Number.isFinite(cutoff))return null;
  while(owner){
    if(owners.has(owner.id)||owner.projectId!==request.projectId||conversationIdOf(owner)!==conversationIdOf(request)||owner.targetRoleId!==request.targetRoleId)return null;
    owners.add(owner.id);if(!owner.continuationOf)break;owner=db.get('coordinationRequests',owner.continuationOf);if(!owner)return null;
  }
  const children=[];
  for(const id of previous.waitEvent.requestIds){
    const original=db.get('coordinationRequests',id);
    if(!original||!owners.has(original.parentRequestId)||original.projectId!==request.projectId||conversationIdOf(original)!==conversationIdOf(request))return null;
    let current;try{current=currentContinuation(db,id);}catch{return null;}
    const time=Date.parse(current?.updatedAt);
    if(!current||!['succeeded','failed','cancelled'].includes(current.status)||!Number.isFinite(time)||time>cutoff)return null;
    children.push({...current,id:original.id,resultRequestId:current.id});
  }
  return continuationFeedback(children);
}

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
/**
 * The calls a wait depends on. With uncarried, a call that settled while its owner was busy with an earlier result is
 * included until a wake has carried it; only an explicit wb wait for that call uses this, so it never reappears by itself.
 */
export function waitDependencies(db,request,{uncarried=false}={}) {
  if(!request)return [];
  const selected=request.status==='waiting_call'&&Array.isArray(request.waitRequestIds),ids=new Set(request.waitRequestIds||[]);
  if(!selected) {
    const owners=new Set([request.id]),reported=new Set(),legacy=new Set();let ancestor=request;
    while(ancestor.continuationOf) {
      const previous=db.get('coordinationRequests',ancestor.continuationOf);
      assertConversationRecord(request,previous);
      if(!previous||previous.projectId!==request.projectId||previous.targetRoleId!==request.targetRoleId||owners.has(previous.id))throw new Error('Invalid dependency ownership chain.');
      owners.add(previous.id);ancestor=previous;
      // What an earlier wake already carried; a wait recorded before wake events counts as having carried all its calls.
      const carried=previous.waitEvent?.requestIds||previous.waitRequestIds;
      if(Array.isArray(carried))carried.forEach(id=>reported.add(id));else legacy.add(previous.id);
    }
    for(const child of db.list('coordinationRequests').filter(r=>owners.has(r.parentRequestId)&&!r.continuationOf))
      if(child.parentRequestId===request.id||!['succeeded','failed','cancelled'].includes(currentContinuation(db,child.id)?.status)
        ||uncarried&&!reported.has(child.id)&&!legacy.has(child.parentRequestId))ids.add(child.id);
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
    summary:String(r.reportSummary||r.result||r.error||'').slice(0,1500),readCommand:`wb history read ${r.id}`})):[];
}

const settledStatuses=new Set(['succeeded','failed','cancelled']);
/** The first request of an owner's continuation chain identifies one collaboration, however many times it resumed. */
export function collaborationRoot(db,request) {
  let current=request;const seen=new Set();
  while(current?.continuationOf&&!seen.has(current.id)){seen.add(current.id);const previous=db.get('coordinationRequests',current.continuationOf);if(!previous)break;current=previous;}
  return current||null;
}
/** Where an open wait sits in its chat's queue: the slot it was given (or dragged to), else the time the wait began. */
export const waitQueueKey=request=>Number.isFinite(request.queueOrder)?request.queueOrder:(Date.parse(request.waitStartedAt||request.updatedAt||request.createdAt)||0);

/** Waits recorded before queue slots existed get the slot they began in, once, before a wake could move their updatedAt. */
export function stampWaitSlots(db) {
  let stamped=0;
  for(const r of db.schedulableRequests())if(r.status==='waiting_call'&&!Number.isFinite(r.queueOrder)){
    db.put('coordinationRequests',{...r,queueOrder:Date.parse(r.waitStartedAt||r.updatedAt||r.createdAt)||Date.now()});stamped++;
  }
  return stamped;
}

/**
 * Open waits, shown in their chat's queue so the user can see and reorder them. A wait never holds back the items behind
 * it; when its results arrive, the wake takes the wait's slot (see RoleCalls.reconcile) and runs in that order.
 */
export function queuedWaits(db) {
  // A wait whose own caller was cancelled or redirected closes without a wake (RoleCalls.resume), so it is not listed.
  const closing=r=>{const source=r.parentRequestId?db.get('coordinationRequests',r.parentRequestId):null;return Boolean(source&&(source.status==='cancelled'||source.steeringTaskId));};
  return db.schedulableRequests().filter(r=>r.status==='waiting_call'&&!r.continuationRequestId&&!r.steeringTaskId&&r.targetRoleId
    &&db.get('tasks',r.taskId||'')?.status!=='cancelled'&&!closing(r)).map(r=>{
    let dependencies=[];try{dependencies=waitDependencies(db,r);}catch{dependencies=[];}
    const open=dependencies.filter(d=>!settledStatuses.has(d.status));
    return {id:`wait:${r.id}`,requestId:r.id,projectId:r.projectId,conversationId:conversationIdOf(r),roleId:r.targetRoleId,roleName:db.get('roles',r.targetRoleId)?.name||r.targetSnapshot?.name||null,queueOrder:waitQueueKey(r),
      since:r.waitStartedAt||r.updatedAt||null,deadlineAt:r.waitDeadlineAt||null,total:dependencies.length,
      waitingFor:open.map(d=>({requestId:d.id,roleId:d.targetRoleId,roleName:d.targetSnapshot?.name||db.get('roles',d.targetRoleId||'')?.name||null}))};
  });
}
