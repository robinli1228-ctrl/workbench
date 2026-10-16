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

/** Replies retain their task owner; a child's clarification uses its real caller chain, never the asking role's yield grant. */
export function discussionCollaborationTask(db,task,roleId) {
  if(task.roleId===roleId)return task;
  let request=db.get('coordinationRequests',task.requestId||'');const seen=new Set();
  while(request&&!seen.has(request.id)) {
    seen.add(request.id);assertConversationRecord(task,request);
    if(request.targetRoleId===roleId)return {...task,roleId,requestId:request.id,collaborationYield:null};
    request=db.get('coordinationRequests',request.continuationOf||request.parentRequestId||'');
  }
  return {...task,roleId,requestId:null,collaborationYield:null};
}

/** Read-only view of roles whose own collaboration is unfinished: a formal call wait, its pending continuation, or a formal
 *  discussion wait. Unrelated same-role tasks in the same chat stay queued. Nothing is released automatically: after the
 *  project's no-progress window the chain is marked stalled and any queued task may then be let through by a human.
 *  A human "handle this first" runs that task's whole chain before the waiting owner resumes, one at a time. */
export function collaborationQueueView(db,time=Date.now()) {
  const heads=[...db.schedulableRequests(),...db.pendingCallResults().filter(r=>r.status==='running')];
  const states=[],seen=new Set();
  const push=(base,progressAt,waiting)=>{
    const minutes=releaseMinutes(db.get('projects',base.projectId)),releaseAt=progressAt+minutes*60000;
    const rootTask=db.get('tasks',base.rootTaskId||'');
    states.push({...base,progressAt:new Date(progressAt).toISOString(),releaseAt:new Date(releaseAt).toISOString(),
      stalled:waiting&&time>=releaseAt,released:false,releaseMinutes:minutes,yielded:Boolean(rootTask?.collaborationYield)});
  };
  for(const head of heads) {
    if(seen.has(head.id)||head.steeringTaskId||!head.targetRoleId)continue;seen.add(head.id);
    const waiting=head.status==='waiting_call'&&!head.continuationRequestId;
    if(!waiting&&!(head.kind==='continuation'&&head.continuationOf&&!settledStatuses.has(head.status)))continue;
    if(db.get('tasks',head.taskId||'')?.status==='cancelled')continue;
    const root=collaborationRoot(db,head);
    let dependencies=[];try{dependencies=waiting?waitDependencies(db,head):[];}catch{dependencies=[];}
    const progressAt=Math.max(stamp(head.updatedAt),stamp(head.createdAt),stamp(head.waitEvent?.observedAt),...dependencies.map(d=>Math.max(stamp(d.updatedAt),stamp(d.createdAt))));
    push({projectId:head.projectId,conversationId:conversationIdOf(head),roleId:head.targetRoleId,rootRequestId:root?.id||head.id,rootTaskId:root?.taskId||null,
      currentRequestId:head.id,taskId:head.taskId||null,phase:waiting?'waiting_reply':head.currentRunId?'processing_reply':'resume_queued',
      waitingRequestIds:dependencies.filter(d=>!settledStatuses.has(d.status)).map(d=>d.id)},progressAt,waiting);
  }
  // Formal discussion waits protect the asking role just like call waits; its resume arrives as a discussion turn.
  for(const task of db.tasksWaitingForDiscussion()) {
    const request=task.requestId?db.get('coordinationRequests',task.requestId):null,root=request?collaborationRoot(db,request):null;
    if(root&&states.some(s=>s.rootRequestId===root.id))continue;
    push({projectId:task.projectId,conversationId:conversationIdOf(task),roleId:task.roleId,rootRequestId:root?.id||`task:${task.id}`,rootTaskId:root?.taskId||task.id,
      currentRequestId:request?.id||null,taskId:task.id,phase:'waiting_discussion',waitingRequestIds:[]},
      Math.max(stamp(task.updatedAt),stamp(task.createdAt),stamp(task.discussionWait?.since)),true);
  }
  const queuedYields=db.chatTasks(['ready','in_progress']).filter(t=>t.collaborationYield);
  const sameScope=(a,b)=>a.projectId===b.projectId&&conversationIdOf(a)===conversationIdOf(b)&&a.roleId===b.roleId;
  const scope=task=>states.filter(s=>sameScope(s,task));
  const rootOf=task=>{const request=task.requestId?db.get('coordinationRequests',task.requestId):null;return request?collaborationRoot(db,request)?.id:`task:${task.id}`;};
  /** A yield stays active until its task and any collaboration it started have settled. */
  const activeYield=task=>queuedYields.find(t=>sameScope(t,task))||scope(task).find(s=>s.yielded)||null;
  return {states,activeYield,
    forTask(task) {
      const own=scope(task),yieldTask=queuedYields.find(t=>sameScope(t,task)),yieldChain=own.find(s=>s.yielded);
      if(task.collaborationYield)return {allowed:true,yielded:true};
      const root=rootOf(task);
      if(yieldChain&&yieldChain.rootRequestId===root)return {allowed:true,own:true};
      // While a human-chosen task (or the chain it started) is running, even the waiting owner's continuation waits.
      if(yieldTask||yieldChain)return {allowed:false,yieldActive:true,state:yieldChain||own[0]||null,minutesLeft:null};
      if(!own.length)return {allowed:true};
      if(own.some(s=>s.rootRequestId===root))return {allowed:true,own:true};
      const next=own.reduce((a,b)=>stamp(a.releaseAt)<=stamp(b.releaseAt)?a:b);
      return {allowed:false,state:next,stalled:own.some(s=>s.stalled),minutesLeft:Math.max(0,Math.ceil((stamp(next.releaseAt)-time)/60000))};
    }};
}
