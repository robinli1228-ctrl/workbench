/** Follow only the same owner's continuation chain; a peer reply must not jump to a different task or project. */
export function currentContinuation(db,requestId) {
  let current=db.get('coordinationRequests',requestId);const seen=new Set();
  while(current?.continuationRequestId&&current.status!=='cancelled'&&!current.steeringTaskId) {
    if(seen.has(current.id))throw new Error('Invalid coordination continuation cycle.');seen.add(current.id);
    const next=db.get('coordinationRequests',current.continuationRequestId);
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
      if(!previous||previous.projectId!==request.projectId||previous.targetRoleId!==request.targetRoleId||owners.has(previous.id))throw new Error('Invalid dependency ownership chain.');
      owners.add(previous.id);ancestor=previous;
    }
    for(const child of db.list('coordinationRequests').filter(r=>owners.has(r.parentRequestId)&&!r.continuationOf))
      if(child.parentRequestId===request.id||!['succeeded','failed','cancelled'].includes(currentContinuation(db,child.id)?.status))ids.add(child.id);
  }
  return [...ids].map(id=>{
    const child=db.get('coordinationRequests',id);
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
