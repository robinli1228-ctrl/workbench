/** A role's native context past this size is compacted once the work it was part of has ended: 400k tokens, or 60% of a
 * smaller context window, so models with short windows are covered too (WB_COMPACT_AT_TOKENS overrides the 400k). */
export const COMPACT_AT_TOKENS=Number(process.env.WB_COMPACT_AT_TOKENS)>0?Number(process.env.WB_COMPACT_AT_TOKENS):400000;
/** The role must stay idle this long first, so a quick follow-up on the same matter neither waits for a compaction nor loses context. */
export const COMPACT_IDLE_MS=Number(process.env.WB_COMPACT_IDLE_MS)>=0&&process.env.WB_COMPACT_IDLE_MS!==undefined?Number(process.env.WB_COMPACT_IDLE_MS):180000;
const PENDING_MAX_MS=3600000,CLOSED=new Set(['succeeded','failed','cancelled']);
const threshold=usage=>Number(usage?.limitTokens)>0?Math.min(COMPACT_AT_TOKENS,Math.floor(usage.limitTokens*0.6)):COMPACT_AT_TOKENS;

/** A finished Run whose session is large, retained on a device that can compact, and not cleared. */
function candidate(db,run,online) {
  if(!run?.roleSessionId||run.status!=='succeeded'||run.runtimeRetained!==true||run.switchOperationId)return false;
  if(!(Number(run.contextUsage?.usedTokens)>=threshold(run.contextUsage)))return false;
  if(db.get('workers',run.nodeId)?.capabilities?.roleCompaction!==1||!online(run.nodeId))return false;
  const session=db.get('roleSessions',run.roleSessionId);
  return Boolean(session&&!session.historyClearedAt);
}
/** Nothing left for the role on the same matter: no other Run, queued message, discussion wait, or open call to it or from it. */
export function roleIdle(db,run) {
  const role=run.roleId;
  if(db.activeRuns().some(r=>r.id!==run.id&&(r.roleId===role||r.roleSessionId===run.roleSessionId)))return false;
  if(db.chatTasks(['ready','in_progress']).some(t=>t.roleId===role))return false;
  if(db.tasksWaitingForDiscussion().some(t=>t.roleId===role))return false;
  return !db.listProject('coordinationRequests',run.projectId).some(r=>!CLOSED.has(r.status)&&(r.targetRoleId===role||db.get('runs',r.sourceRunId||'')?.roleId===role));
}

/** When a role's Run settles: a large, retained session is marked for compaction after the idle window (once per Run). */
export function noteRoleCompaction(db,run,{online=()=>true,now=Date.now()}={}) {
  if(!candidate(db,run,online))return false;
  const session=db.get('roleSessions',run.roleSessionId);
  if(session.compaction?.afterRunId===run.id)return false;
  db.put('roleSessions',{...session,compaction:{afterRunId:run.id,status:'pending',dueAt:new Date(now+COMPACT_IDLE_MS).toISOString(),usedTokens:run.contextUsage.usedTokens}});
  return true;
}

/** Each scheduler pass: a due compaction is sent once the role is still idle; a newer Run of the session supersedes it. */
export function dueRoleCompactions(db,{online=()=>true,send,now=Date.now()}) {
  let changed=false;
  for(const session of db.list('roleSessions')){
    const c=session.compaction;if(c?.status!=='pending'||Date.parse(c.dueAt)>now)continue;
    // The session records its running and its last Run; either being a later Run means the role moved on.
    const run=db.get('runs',c.afterRunId),later=id=>Boolean(id&&id!==c.afterRunId&&Date.parse(db.get('runs',id)?.createdAt||0)>Date.parse(run?.createdAt||0));
    const newer=later(session.activeRunId)||later(session.lastRunId);
    const close=status=>{db.put('roleSessions',{...session,compaction:{...c,status,finishedAt:new Date(now).toISOString()}});changed=true;};
    if(!run||newer)close('superseded');
    else if(now-Date.parse(c.dueAt)>PENDING_MAX_MS||!candidate(db,run,online)&&online(run.nodeId))close('expired');
    else if(candidate(db,run,online)&&roleIdle(db,run)){
      db.put('roleSessions',{...session,compaction:{...c,status:'requested',requestedAt:new Date(now).toISOString()}});changed=true;
      send(run.nodeId,{type:'compact_role_session',roleSessionId:session.id,afterRunId:run.id});
    }
  }
  return changed;
}

/** The device's answer; the next Run's context sample shows the new size. */
export function recordRoleCompaction(db,nodeId,m) {
  const session=db.get('roleSessions',typeof m?.roleSessionId==='string'?m.roleSessionId:'');
  if(!session||session.nodeId!==nodeId||session.compaction?.afterRunId!==m.afterRunId||session.compaction?.status!=='requested')return false;
  db.put('roleSessions',{...session,compaction:{...session.compaction,status:m.ok?'compacted':'skipped',finishedAt:new Date().toISOString(),
    ...(Number.isFinite(m.usedTokens)?{usedTokensAfter:m.usedTokens}:{}),...(m.ok?{}:{error:String(m.error||'').slice(0,200)})}});
  return true;
}
