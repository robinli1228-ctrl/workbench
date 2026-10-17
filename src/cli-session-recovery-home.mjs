import {randomUUID} from 'node:crypto';
import {effectiveExecutionRole,activeRoleSwitch} from './role-switch-policy.mjs';
import {projectTerminalLock} from './terminal-resume.mjs';
import {tr} from './i18n.mjs';
import {taskConversationId} from './role-sessions.mjs';
import {conversationIdOf,groupConversationIdOfSession} from './group-conversations.mjs';

/** Check occupancy before normal dispatch, always targeting an existing task rather than creating work. */
export class CliRecoveryHome {
  constructor({db,query,online,change}){Object.assign(this,{db,query,online,change});this.pending=new Map();this.decisions=new Map();this.stoppingTasks=new Set();}
  binding(task){
    if(!task||task.switchOperationId||!['ready','in_progress'].includes(task.status))return null;
    const run=this.db.get('runs',task.currentRunId||'');
    if(run&&(run.stopRequested||['stopping','succeeded','failed','interrupted'].includes(run.status)))return null;
    const role=effectiveExecutionRole(this.db,task),worker=this.db.get('workers',role?.nodeId);
    if(!role?.enabled||worker?.capabilities?.cliRecovery!==1||activeRoleSwitch(this.db,role.id)||projectTerminalLock(this.db,task.projectId,role.nodeId))return null;
    // A healthy admitted turn invalidates both in-flight probes and previously offered stop approvals.
    // Own deferred launches and uncertain orphan processes still use the recovery route.
    if(this.db.activeRuns(role.nodeId).some(r=>r.id!==task.currentRunId&&r.projectId===task.projectId&&r.roleId===role.id
      &&['queued','starting','running','waiting_user'].includes(r.status)&&!r.cliRecoveryWait&&!r.controlLost))return null;
    const session=run?.roleSessionId?this.db.get('roleSessions',run.roleSessionId):this.db.list('roleSessions').find(s=>s.projectId===task.projectId&&s.conversationId===taskConversationId(task)&&s.roleId===role.id&&s.status!=='archived'&&!s.candidateFor);
    if(session&&(session.projectId!==task.projectId||session.roleId!==role.id||groupConversationIdOfSession(session)!==conversationIdOf(task)||session.conversationId!==taskConversationId(task)||session.status==='archived'))return null;
    const prior=this.db.get('runs',task.continuationRunId||session?.lastRunId||session?.activeRunId||'');
    if(!session?.nativeSessionId&&!prior?.nativeSession?.id)return null;
    if(session&&(session.nodeId!==role.nodeId||session.runtime!==role.runtime))return null;
    return {taskId:task.id,projectId:task.projectId,roleId:role.id,nodeId:role.nodeId,roleSessionId:session?.id||null,
      nativeSessionId:run?.resumeNativeSessionId||session?.nativeSessionId||prior.nativeSession.id,priorRunId:task.continuationRunId||null,
      ...(task.currentRunId?{runId:task.currentRunId}:{})};
  }
  current(record){const binding=this.binding(this.db.get('tasks',record?.taskId));return binding&&JSON.stringify(binding)===JSON.stringify(record.binding);}
  reason(task){
    const binding=this.binding(task);if(!binding)return null;
    const record=this.db.get('cliRecoveries',task.id);
    if(record?.state==='ready'&&JSON.stringify(record.binding)===JSON.stringify(binding))return null;
    return record?.reason||tr('cliRecovery.checking');
  }
  /** Probe only schedulable queue heads; defer duplicate targets without sharing task-bound results or consent. */
  scheduleReason(task,checked){
    const binding=this.binding(task);if(!binding)return null;
    const {taskId,...target}=binding,key=JSON.stringify(target);
    if(checked.has(key))return tr('cliRecovery.checking');
    checked.add(key);void this.check(task);
    return this.reason(task);
  }
  async check(task){
    const binding=this.binding(task);if(!binding||!this.online(binding.nodeId)||this.pending.has(task.id))return;
    const previous=this.db.get('cliRecoveries',task.id);
    if(this.stoppingTasks.has(task.id)||previous&&JSON.stringify(previous.binding)===JSON.stringify(binding)&&Date.now()-Date.parse(previous.checkedAt||0)<5000)return;
    const operation=(async()=>{
      try{
        const result=await this.query(binding,'cli_session_check',binding,20000);
        if(this.stoppingTasks.has(task.id)||!this.current({taskId:task.id,binding}))return;
        const value={id:task.id,taskId:task.id,projectId:task.projectId,nodeId:binding.nodeId,roleId:binding.roleId,binding,checkedAt:new Date().toISOString(),
          ...result,requestId:previous?.fingerprint===result.fingerprint?previous.requestId:randomUUID()};
        this.db.put('cliRecoveries',value);
        // A final launch race retries the same accepted command/Run, not a new business execution.
        if(result.state==='ready'&&binding.runId){const run=this.db.get('runs',binding.runId);if(run?.cliRecoveryWait&&!run.stopRequested){
          for(const command of this.db.list('commands').filter(c=>c.type==='launch'&&c.runId===run.id))this.db.put('commands',{...command,acked:false,lastSentAt:null});
        }}
        this.change();
      }catch(error){if(!this.stoppingTasks.has(task.id)&&this.current({taskId:task.id,binding})){this.db.put('cliRecoveries',{...previous,id:task.id,taskId:task.id,projectId:task.projectId,nodeId:binding.nodeId,roleId:binding.roleId,binding,state:'unknown',canStop:false,reason:error.message,checkedAt:new Date().toISOString(),requestId:previous?.requestId||randomUUID()});this.change();}}
    })();
    this.pending.set(task.id,operation);operation.finally(()=>{if(this.pending.get(task.id)===operation)this.pending.delete(task.id);}).catch(()=>{});await operation;
  }
  tick(){
    // Accepted launches waiting on a last-moment race must retry even while their own Run holds capacity.
    // Ordinary ready tasks are checked by Room only after the other admission gates pass.
    for(const task of this.db.chatTasks().filter(t=>this.db.get('runs',t.currentRunId||'')?.cliRecoveryWait)){
      if(!this.db.get('settings','main')?.paused)void this.check(task);
    }
    for(const record of this.db.unresolvedRecoveries())if(!this.current(record))this.db.put('cliRecoveries',{...record,state:'resolved',canStop:false});
  }
  /** Consent targets the verified snapshot; duplicate submissions share one processing receipt. */
  confirm(projectId,taskId,input){
    const record=this.db.get('cliRecoveries',taskId);
    if(record?.projectId!==projectId||record.requestId!==input?.requestId||!input?.decisionId||typeof input.decisionId!=='string'||input.decisionId.length>100)throw Error(tr('cliRecovery.bindingChanged'));
    const saved=this.db.get('cliRecoveryDecisions',input.decisionId);
    if(saved){if(saved.taskId!==taskId||saved.requestId!==record.requestId)throw Error(tr('cliRecovery.bindingChanged'));if(saved.completed)return Promise.resolve(saved.result);}
    if(this.decisions.has(input.decisionId))return this.decisions.get(input.decisionId);
    if(this.stoppingTasks.has(taskId))throw Error(tr('cliRecovery.stopPending'));
    if(!this.current(record)||!record.canStop||this.db.get('settings','main')?.paused)throw Error(record.reason||tr('cliRecovery.bindingChanged'));
    this.stoppingTasks.add(taskId);
    const operation=(async()=>{
      this.db.put('cliRecoveryDecisions',{id:input.decisionId,projectId,taskId,requestId:record.requestId,completed:false});
      this.db.put('cliRecoveries',{...record,state:'stopping',canStop:false,reason:tr('cliRecovery.stopPending')});this.change();
      try{
        const result=await this.query(record.binding,'cli_session_stop',{...record.binding,fingerprint:record.fingerprint},20000);
        if(result.state!=='ready')throw Error(tr('cliRecovery.stopPending'));
        const receipt={state:'ready',taskId,requestId:record.requestId};this.db.put('cliRecoveryDecisions',{id:input.decisionId,projectId,taskId,requestId:record.requestId,completed:true,result:receipt});
        this.db.put('cliRecoveries',{...record,...result,canStop:false,checkedAt:new Date().toISOString()});this.change();return receipt;
      }catch(error){this.db.put('cliRecoveries',{...record,state:'waiting',canStop:record.canStop,reason:error.message,checkedAt:null});this.change();throw error;}
    })();
    this.decisions.set(input.decisionId,operation);operation.finally(()=>{this.stoppingTasks.delete(taskId);if(this.decisions.get(input.decisionId)===operation)this.decisions.delete(input.decisionId);}).catch(()=>{});return operation;
  }
}
