import { randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();

/** Platform sessions only store the mapping between a role and a native session; whether the CLI process is alive is still determined by the Worker. */
export class RoleSessions {
  constructor(db) { this.db=db; }

  /** A role in the same conversation reuses its session by default; switching device or CLI requires explicitly opening a new session. */
  getOrCreate(binding) {
    const {projectId,conversationId,roleId,nodeId,runtime}=binding || {};
    if (![projectId,conversationId,roleId,nodeId,runtime].every(value=>typeof value==='string' && value)) throw new Error('Role session binding is incomplete');
    return this.db.transaction(()=>{
      const records=this.db.list('roleSessions').filter(s=>s.projectId===projectId && s.conversationId===conversationId && s.roleId===roleId);
      const current=records.find(s=>s.status!=='archived');
      if(current) {
        if(current.nodeId!==nodeId || current.runtime!==runtime || (current.workspaceRoot||null)!==(binding.workspaceRoot||null)) throw new Error('Role session binding has changed; explicitly start a new session');
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
      if(!current || current.status==='archived') throw new Error('Role session does not exist or is archived');
      if(current.activeRunId && current.activeRunId!==runId) throw new Error('Session is in use');
      if(current.activeRunId===runId)return current;
      return this.db.put('roleSessions',{...current,status:'running',activeRunId:runId,updatedAt:now()});
    });
  }

  /** Only accept the native ID from the Run holding the lock; an unknown or changed ID must not overwrite existing history. */
  recordNative(sessionId,runId,nativeSession,workspace) {
    return this.db.transaction(()=>{
      const current=this.db.get('roleSessions',sessionId);
      if(!current || current.activeRunId!==runId) throw new Error('Session ownership has changed');
      const id=nativeSession?.id;
      if(typeof id!=='string' || !id) throw new Error('Native session ID is missing');
      if(current.nativeSessionId && current.nativeSessionId!==id) throw new Error('Native session ID has changed; cannot overwrite');
      if(current.workspace && workspace && current.workspace!==workspace) throw new Error('Session working directory has changed');
      return this.db.put('roleSessions',{...current,nativeSessionId:id,nativeSession,workspace:workspace||current.workspace,updatedAt:now()});
    });
  }

  /** Release only after the turn has truly terminated; when the state is unknown the lock is kept for reconnection checks. */
  release(sessionId,runId) {
    return this.db.transaction(()=>{
      const current=this.db.get('roleSessions',sessionId);
      if(!current || current.activeRunId!==runId) throw new Error('Session releaser does not match');
      return this.db.put('roleSessions',{...current,status:'idle',activeRunId:null,lastRunId:runId,updatedAt:now()});
    });
  }

  archive(sessionId) {
    return this.db.transaction(()=>{
      const current=this.db.get('roleSessions',sessionId);
      if(!current)throw new Error('Role session does not exist');
      if(current.activeRunId)throw new Error('Session is in use');
      if(current.status==='archived')return current;
      return this.db.put('roleSessions',{...current,status:'archived',updatedAt:now()});
    });
  }

  list(projectId,{conversationId,roleId}={}) {
    return this.db.list('roleSessions').filter(s=>s.projectId===projectId && (!conversationId || s.conversationId===conversationId) && (!roleId || s.roleId===roleId));
  }
}
