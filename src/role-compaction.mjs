/** A role's native context past this size (400k tokens; WB_COMPACT_AT_TOKENS overrides it) is compacted once the work it was part of has ended. */
export const COMPACT_AT_TOKENS=Number(process.env.WB_COMPACT_AT_TOKENS)>0?Number(process.env.WB_COMPACT_AT_TOKENS):400000;
const OPEN_REQUEST=new Set(['succeeded','failed','cancelled']);

/**
 * Whether a role session that just finished a Run should be compacted now: the Run succeeded with a large context, its
 * process is retained on a device that can compact, and the role has nothing left on the same matter — no other Run, no
 * queued message, no discussion it waits on, no open call to it or from it. While the conversation is still on the same
 * thing, the context is left as it is.
 */
export function roleCompactionDue(db,run,{online=()=>true}={}) {
  if(!run?.roleSessionId||run.status!=='succeeded'||run.runtimeRetained!==true||run.switchOperationId)return false;
  if(!(Number(run.contextUsage?.usedTokens)>=COMPACT_AT_TOKENS))return false;
  if(db.get('workers',run.nodeId)?.capabilities?.roleCompaction!==1||!online(run.nodeId))return false;
  const session=db.get('roleSessions',run.roleSessionId);
  if(!session||session.historyClearedAt||session.compaction?.afterRunId===run.id)return false;
  const role=run.roleId;
  if(db.activeRuns().some(r=>r.id!==run.id&&(r.roleId===role||r.roleSessionId===run.roleSessionId)))return false;
  if(db.chatTasks(['ready','in_progress']).some(t=>t.roleId===role))return false;
  if(db.tasksWaitingForDiscussion().some(t=>t.roleId===role))return false;
  const calls=db.listProject('coordinationRequests',run.projectId).filter(r=>!OPEN_REQUEST.has(r.status));
  if(calls.some(r=>r.targetRoleId===role||db.get('runs',r.sourceRunId||'')?.roleId===role))return false;
  return true;
}

/** Record the request on the role session (so one Run asks once) and send it to the device that holds the process. */
export function requestRoleCompaction(db,run,send) {
  const session=db.get('roleSessions',run.roleSessionId);
  db.put('roleSessions',{...session,compaction:{afterRunId:run.id,requestedAt:new Date().toISOString(),usedTokens:run.contextUsage.usedTokens,status:'requested'}});
  send({type:'compact_role_session',roleSessionId:run.roleSessionId,afterRunId:run.id});
}

/** The device's answer; the next Run's context sample shows the new size. */
export function recordRoleCompaction(db,nodeId,m) {
  const session=db.get('roleSessions',typeof m?.roleSessionId==='string'?m.roleSessionId:'');
  if(!session||session.nodeId!==nodeId||session.compaction?.afterRunId!==m.afterRunId)return false;
  db.put('roleSessions',{...session,compaction:{...session.compaction,status:m.ok?'compacted':'skipped',finishedAt:new Date().toISOString(),
    ...(Number.isFinite(m.usedTokens)?{usedTokensAfter:m.usedTokens}:{}),...(m.ok?{}:{error:String(m.error||'').slice(0,200)})}});
  return true;
}
