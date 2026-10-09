import { randomUUID } from 'node:crypto';
import { tr } from './i18n.mjs';
import {activeRoleSwitch} from './role-switch-policy.mjs';

const now = () => new Date().toISOString();

/** Platform sessions only store the mapping between a role and a native session; whether the CLI process is alive is still determined by the Worker. */
export class RoleSessions {
  constructor(db) { this.db=db; }

  /** A role in the same conversation reuses its session by default; switching device or CLI requires explicitly opening a new session. */
  getOrCreate(binding) {
    const {projectId,conversationId,roleId,nodeId,runtime}=binding || {};
    if (![projectId,conversationId,roleId,nodeId,runtime].every(value=>typeof value==='string' && value)) throw new Error(tr('roleSessions.roleSessionBindingIncomplete'));
    return this.db.transaction(()=>{
      const records=this.db.list('roleSessions').filter(s=>s.projectId===projectId && s.conversationId===conversationId && s.roleId===roleId);
      const current=records.find(s=>s.status!=='archived' && !s.candidateFor);
      if(current) {
        if(current.nodeId!==nodeId || current.runtime!==runtime || (current.workspaceRoot||null)!==(binding.workspaceRoot||null)) throw new Error(tr('roleSessions.roleSessionBindingHasChanged'));
        return current;
      }
      const value={id:randomUUID(),projectId,conversationId,roleId,nodeId,runtime,model:binding.model||null,workspaceRoot:binding.workspaceRoot||null,
        generation:Math.max(0,...records.map(s=>s.generation||0))+1,nativeSessionId:null,nativeSession:null,
        workspace:null,status:'idle',activeRunId:null,lastRunId:null,predecessorSessionId:records.at(-1)?.id||null,createdAt:now(),updatedAt:now()};
      return this.db.put('roleSessions',value);
    });
  }

  /** Resending the same run ID just returns the existing lock; a second Run is not allowed to resume the native ID at the same time. */
  claim(sessionId,runId) {
    return this.db.transaction(()=>{
      const current=this.db.get('roleSessions',sessionId);
      if(!current || current.status==='archived') throw new Error(tr('roleSessions.roleSessionDoesNotExist'));
      if(current.activeRunId && current.activeRunId!==runId) throw new Error(tr('roleSessions.sessionInUse'));
      if(current.activeRunId===runId)return current;
      return this.db.put('roleSessions',{...current,status:'running',activeRunId:runId,updatedAt:now()});
    });
  }

  /** Only accept the native ID from the Run holding the lock; an unknown or changed ID must not overwrite existing history. */
  recordNative(sessionId,runId,nativeSession,workspace) {
    return this.db.transaction(()=>{
      const current=this.db.get('roleSessions',sessionId);
      if(!current || current.activeRunId!==runId) throw new Error(tr('roleSessions.sessionOwnershipHasChanged'));
      const id=nativeSession?.id;
      if(typeof id!=='string' || !id) throw new Error(tr('roleSessions.nativeSessionIdMissing'));
      if(current.nativeSessionId && current.nativeSessionId!==id) throw new Error(tr('roleSessions.nativeSessionIdHasChanged'));
      if(current.workspace && workspace && current.workspace!==workspace) throw new Error(tr('roleSessions.sessionWorkingDirectoryHasChanged'));
      return this.db.put('roleSessions',{...current,nativeSessionId:id,nativeSession,workspace:workspace||current.workspace,updatedAt:now()});
    });
  }

  /** Release only after the turn has truly terminated; when the state is unknown the lock is kept for reconnection checks. */
  release(sessionId,runId) {
    return this.db.transaction(()=>{
      const current=this.db.get('roleSessions',sessionId);
      if(!current || current.activeRunId!==runId) throw new Error(tr('roleSessions.sessionReleaserDoesNotMatch'));
      return this.db.put('roleSessions',{...current,status:'idle',activeRunId:null,lastRunId:runId,updatedAt:now()});
    });
  }

  archive(sessionId) {
    return this.db.transaction(()=>{
      const current=this.db.get('roleSessions',sessionId);
      if(!current)throw new Error(tr('roleSessions.roleSessionDoesNotExist2'));
      if(activeRoleSwitch(this.db,current.roleId))throw new Error('CLI switch in progress; cannot reset this session.');
      if(current.activeRunId)throw new Error(tr('roleSessions.sessionInUse2'));
      if(current.status==='archived')return current;
      return this.db.put('roleSessions',{...current,status:'archived',updatedAt:now()});
    });
  }

  list(projectId,{conversationId,roleId}={}) {
    return this.db.list('roleSessions').filter(s=>!s.historyClearedAt && s.projectId===projectId && (!conversationId || s.conversationId===conversationId) && (!roleId || s.roleId===roleId));
  }

  /** Clear the role's session associations, preserving shared chat and audit records; later dispatch starts a fresh native session. */
  clearHistory(projectId,roleId,expectedSessionId=null) {
    return this.db.transaction(()=>{
      const role=this.db.get('roles',roleId);
      if(role?.projectId!==projectId)throw new Error(tr('home.roleDoesNotBelongProject'));
      if(activeRoleSwitch(this.db,roleId))throw new Error(tr('roleSessions.historySwitchBusy'));
      const sessions=this.list(projectId,{roleId}),ids=new Set(sessions.map(s=>s.id));
      const current=sessions.find(s=>s.conversationId===projectId && s.status!=='archived' && !s.candidateFor);
      if((current?.id||null)!==expectedSessionId)throw new Error(tr('roleSessions.historySessionChanged'));
      const runs=this.db.list('runs').filter(r=>r.projectId===projectId && r.roleId===roleId);
      if(sessions.some(s=>s.activeRunId) || runs.some(r=>!['succeeded','failed','interrupted'].includes(r.status))
        || this.db.list('tasks').some(t=>t.projectId===projectId && t.roleId===roleId && ['ready','in_progress'].includes(t.status))
        || this.db.list('coordinationRequests').some(r=>r.projectId===projectId && r.targetRoleId===roleId && !['succeeded','failed','cancelled'].includes(r.status))
        || this.db.list('discussionDeliveries').some(d=>d.projectId===projectId && (d.recipientRoleId===roleId || ids.has(d.recipientSessionId)) && ['queued','dispatched','runtime_accepted','reconciling'].includes(d.status)))throw new Error(tr('roleSessions.historyBusy'));
      const runIds=new Set(runs.map(run=>run.id));
      if(this.db.list('terminalSessions').some(s=>s.projectId===projectId && (s.nodeId===role.nodeId || runIds.has(s.runId)) && !['released','cancelled'].includes(s.status)))throw new Error(tr('roleSessions.historyTerminalBusy'));
      const clearedAt=now();
      for(const session of sessions)this.db.put('roleSessions',{...session,status:'archived',historyClearedAt:clearedAt,nativeSessionId:null,nativeSession:null,workspace:null,lastRunId:null,updatedAt:clearedAt});
      const visibleRuns=runs.filter(r=>!r.historyClearedAt);
      for(const run of visibleRuns)this.db.put('runs',{...run,historyClearedAt:clearedAt});
      return {roleId,clearedAt,clearedSessions:sessions.length,clearedRuns:visibleRuns.length,nextSession:'new'};
    });
  }
}
