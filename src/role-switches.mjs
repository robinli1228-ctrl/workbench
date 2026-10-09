import {createHash, randomUUID} from 'node:crypto';
import {Rooms} from './rooms.mjs';
import {Coordinator} from './coordinator.mjs';
import {RoleSessions} from './role-sessions.mjs';
import {activeRoleSwitch, belongsToDrain, switchSettled} from './role-switch-policy.mjs';

const terminal = new Set(['succeeded','failed','interrupted']);
const planTerminal = new Set(['succeeded','completed_with_issues','completed','cancelled','blocked']);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const canonical = value => JSON.stringify(value, function(key,item) {return item && typeof item==='object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])) : item;});
export const switchHash = value => createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');
/** Browser progress contains no checkpoint bodies, native account metadata or lease secrets. */
export const roleSwitchView = op => ({id:op.id,projectId:op.projectId,roleId:op.roleId,status:op.status,from:op.original.runtime,to:op.candidate.runtime,
  error:op.error||op.lastError||null,reason:op.reason||null,sourceRunId:op.steps.handoff?.runId||null,verificationRunId:op.steps.verified?.runId||null,
  handoffHash:op.steps.handoff?.hash||null,committedAt:op.committedAt||null,createdAt:op.createdAt,updatedAt:op.updatedAt,released:Boolean(op.steps.released)});
const sessions = (db,role) => db.list('roleSessions').filter(s=>s.projectId===role.projectId && s.roleId===role.id && s.conversationId===role.projectId && s.status!=='archived' && !s.candidateFor);

/** Home is the authority for the switch transaction, not the browser or a native CLI. */
export class RoleSwitches {
  constructor(db,{now=Date.now}={}) {this.db=db;this.now=now;}
  stamp() {return new Date(this.now()).toISOString();}
  save(op,change) {return this.db.put('roleSwitches',{...op,...change,updatedAt:this.stamp()});}
  operation(id) {const op=this.db.get('roleSwitches',id);if(!op)throw new Error('CLI switch not found.');return op;}
  get(projectId,roleId,id) {const op=this.operation(id);if(op.projectId!==projectId||op.roleId!==roleId)throw new Error('CLI switch does not belong to this role.');return op;}
  /** Freeze full history once; transfer it over authenticated HTTP rather than the bounded command socket. */
  history(id) {
    const op=this.operation(id),prior=this.db.get('roleSwitchHistory',id);if(prior)return prior;
    const text=JSON.stringify(this.db.list('runs').filter(r=>r.projectId===op.projectId&&r.roleId===op.roleId&&!r.switchOperationId&&!r.historyClearedAt).map(r=>({runId:r.id,sessionId:r.roleSessionId,status:r.status,task:this.db.get('tasks',r.taskId)?.prompt||'',result:r.result||'',error:r.error||''})));
    return this.db.put('roleSwitchHistory',{id,projectId:op.projectId,roleId:op.roleId,text,hash:switchHash(text)});
  }

  /** Freeze only execution-relevant workspace metadata, not a transient last-checked timestamp. */
  workspace(role) {
    const root=this.db.get('workspaces',`${role.projectId}:${role.nodeId}`)?.localRoot;
    if(!root)throw new Error('Bind the project workspace before switching CLI.');
    const repositories=this.db.list('repositories').filter(r=>r.projectId===role.projectId).map(r=>{
      const w=this.db.get('repositoryWorkspaces',`${r.id}:${role.nodeId}`);
      return {id:r.id,key:r.key,repoUrl:r.repoUrl,baseBranch:r.baseBranch,baseCommit:r.baseCommit,localRoot:w?.localRoot||null};
    });
    return {root,repositories};
  }

  /** Validate the whole draft with the ordinary form's pure validator, never a trial write. */
  preview(projectId,roleId,draft) {
    const role=this.db.get('roles',roleId);
    if(!role||role.projectId!==projectId||role.archivedAt||role.platformAssistant)throw new Error('Role unavailable for CLI switch.');
    if(draft.nodeId!==role.nodeId)throw new Error('CLI switch only supports the same device.');
    if(!draft.runtime||draft.runtime===role.runtime)throw new Error('Select a different CLI.');
    if(![role.runtime,draft.runtime].every(runtime=>['codex','grok'].includes(runtime)))throw new Error('Safe CLI switching is not yet verified for this adapter. Supported: Codex and Grok.');
    if(this.db.get('workers',role.nodeId)?.capabilities?.roleSwitch!==1)throw new Error('Upgrade the Worker to support CLI handoff and switch.');
    let candidate,supervisorConfig=null;
    if(role.systemSupervisor) {
      supervisorConfig=new Coordinator(this.db,{migrate:false}).validateSupervisor(projectId,role.nodeId,draft);
      candidate={...role,runtime:supervisorConfig.runtime,model:supervisorConfig.model,effort:supervisorConfig.effort,revision:(role.revision||1)+1};
    } else candidate=new Rooms(this.db).validateRole(projectId,{...draft,id:role.id,revision:role.revision||1});
    const current=sessions(this.db,role);
    const workspace=this.workspace(role);
    if(current.length>1)throw new Error('Multiple current sessions require reconciliation.');
    if(current[0]&&(current[0].nodeId!==role.nodeId||current[0].runtime!==role.runtime||current[0].workspaceRoot!==workspace.root))throw new Error('Original session binding is inconsistent; reconcile it before switching.');
    if(this.db.list('terminalSessions').some(s=>s.projectId===projectId&&s.nodeId===role.nodeId&&!['released','cancelled'].includes(s.status)))throw new Error('Project is under manual terminal control.');
    return {role,candidate,supervisorConfig,workspace,sourceSessionId:current[0]?.id||null,sourceGeneration:current[0]?.generation||null};
  }

  /** Idempotency, role ownership and original revisions are captured in one database transaction. */
  begin(projectId,roleId,input) {
    return this.db.transaction(()=>{
      if(!uuid(input?.operationId)||!uuid(input?.leaseId))throw new Error('Switch and lease IDs must be UUIDs.');
      const fingerprint=switchHash({projectId,roleId,input}),prior=this.db.get('roleSwitches',input.operationId);
      if(prior){if(prior.fingerprint!==fingerprint)throw new Error('CLI switch ID payload conflict.');return prior;}
      if(activeRoleSwitch(this.db,roleId))throw new Error('A CLI switch is already in progress.');
      const role=this.db.get('roles',roleId);
      if(input.expectedRoleRevision!==(role?.revision||1))throw new Error('Role configuration changed; reopen the editor.');
      const config=role?.systemSupervisor&&this.db.get('supervisorConfigs',`${projectId}:${role.nodeId}`);
      if(role?.systemSupervisor&&input.expectedSupervisorRevision!==(config?.revision||0))throw new Error('Supervisor configuration changed.');
      const p=this.preview(projectId,roleId,input.draft);
      const tasks=this.db.list('tasks').filter(t=>t.projectId===projectId&&['ready','in_progress','awaiting_acceptance','waiting_discussion'].includes(t.status));
      const requests=this.db.list('coordinationRequests').filter(r=>r.projectId===projectId&&!['succeeded','failed','cancelled'].includes(r.status));
      const plans=this.db.list('executionPlans').filter(p=>p.projectId===projectId&&!planTerminal.has(p.status));
      return this.db.put('roleSwitches',{id:input.operationId,projectId,roleId,nodeId:role.nodeId,fingerprint,status:'draining',leaseId:input.leaseId,leaseUntil:this.now()+120000,
        original:p.role,candidate:p.candidate,supervisorConfig:p.supervisorConfig,originalSupervisorConfig:config||null,
        workspace:p.workspace,workspaceHash:switchHash(p.workspace),sourceSessionId:p.sourceSessionId,sourceGeneration:p.sourceGeneration,
        drainTaskIds:tasks.map(t=>t.id),drainRequestIds:requests.map(r=>r.id),drainPlanIds:plans.map(p=>p.id),
        steps:{},createdAt:this.stamp(),updatedAt:this.stamp()});
    });
  }
  renew(id,leaseId) {return this.db.transaction(()=>{const op=this.operation(id);if(op.leaseId!==leaseId)throw new Error('Switch lease mismatch.');if(switchSettled(op))return op;if(op.leaseUntil<=this.now())return this.cancel(id,'lease_expired');return this.save(op,{leaseUntil:this.now()+120000});});}
  cancel(id,reason='operator') {return this.db.transaction(()=>{const op=this.operation(id);return switchSettled(op)?op:this.save(op,{status:'cancelling',reason});});}
  block(id,error) {const op=this.operation(id);return switchSettled(op)||op.status==='cancelling'?op:this.save(op,{status:'blocked',error:String(error?.message||error)});}

  /** Stage identity independently; release() cannot accidentally make it the current session. */
  stageCandidate(id) {
    return this.db.transaction(()=>{
      const op=this.operation(id);
      if(!['draining','handoff','verifying'].includes(op.status))throw new Error('Switch cannot create a candidate now.');
      if(op.candidateSessionId)return this.db.get('roleSessions',op.candidateSessionId);
      const all=this.db.list('roleSessions').filter(s=>s.roleId===op.roleId&&s.projectId===op.projectId);
      const candidate=this.db.put('roleSessions',{id:randomUUID(),projectId:op.projectId,conversationId:op.projectId,roleId:op.roleId,nodeId:op.nodeId,
        runtime:op.candidate.runtime,model:op.candidate.model,workspaceRoot:op.workspace.root,workspace:null,nativeSessionId:null,nativeSession:null,
        generation:Math.max(0,...all.map(s=>s.generation||0))+1,status:'idle',activeRunId:null,lastRunId:null,candidateFor:op.id,predecessorSessionId:op.sourceSessionId,createdAt:this.stamp(),updatedAt:this.stamp()});
      this.save(op,{candidateSessionId:candidate.id});return candidate;
    });
  }

  /** Accepted work drains across peer calls; independent queued messages do not extend this set. */
  draining(op) {
    const relevant=t=>t.projectId===op.projectId&&belongsToDrain(this.db,op,t);
    return this.db.list('tasks').some(t=>relevant(t)&&['ready','in_progress','awaiting_acceptance','waiting_discussion'].includes(t.status))
      ||this.db.list('runs').some(r=>r.projectId===op.projectId&&!terminal.has(r.status)&&relevant(this.db.get('tasks',r.taskId)||{}))
      ||this.db.list('coordinationRequests').some(r=>op.drainRequestIds.includes(r.id)&&!['succeeded','failed','cancelled'].includes(r.status))
      ||this.db.list('executionPlans').some(p=>op.drainPlanIds.includes(p.id)&&!planTerminal.has(p.status));
  }

  /** Actions have stable IDs and are persisted before any network dispatch. */
  nextAction(id) {
    return this.db.transaction(()=>{
      let op=this.operation(id);
      if(!switchSettled(op)&&op.leaseUntil<=this.now()&&op.status!=='cancelling')op=this.cancel(id,'lease_expired');
      if(switchSettled(op))return {type:op.steps.released?'wait':'release_worker',id:`${id}:release`,operation:op};
      if(op.status==='blocked')return {type:'wait',operation:op};
      if(op.status==='cancelling') {
        const active=this.db.list('runs').filter(r=>r.switchOperationId===id&&!terminal.has(r.status));
        return {type:active.length?'stop':'release_worker',id:`${id}:cancel`,runIds:active.map(r=>r.id),operation:op};
      }
      if(op.status==='draining') {
        if(this.draining(op))return {type:'wait',operation:op};
        const current=sessions(this.db,op.original)[0];
        const history=this.db.list('runs').some(r=>r.projectId===op.projectId&&r.roleId===op.roleId&&!r.switchOperationId&&!r.historyClearedAt)||this.db.list('roleSessions').some(s=>s.projectId===op.projectId&&s.roleId===op.roleId&&s.nativeSessionId&&!s.candidateFor&&!s.historyClearedAt);
        op=this.save(op,{status:'handoff',sourceSessionId:current?.id||null,sourceGeneration:current?.generation||null,noHistory:!history});
      }
      let type=op.status==='handoff'?'handoff':op.status==='verifying'?'verify':op.status==='prepared'?'commit':'wait';
      if(!op.steps.inspected)type='inspect';
      else if(op.status==='verifying'&&op.steps.verified)type='prepare_worker';
      return {type,id:`${id}:${type}`,operation:op};
    });
  }

  /** Only internal runtime receipts advance stages; browser requests cannot supply success evidence. */
  recordStep(id,receipt) {
    return this.db.transaction(()=>{
      let op=this.operation(id);
      if(switchSettled(op)&&receipt.step!=='released')return op;
      if(!['inspected','handoff','verified','prepared','released'].includes(receipt.step))throw new Error('Unknown CLI switch receipt.');
      if(op.steps[receipt.step]){if(switchHash(op.steps[receipt.step])!==switchHash(receipt))throw new Error('Conflicting CLI switch receipt.');return op;}
      if(receipt.step==='released') {
        if(!receipt.settled)throw new Error('Worker settlement is unconfirmed.');
        if(op.status==='cancelling') {
          if(this.db.list('runs').some(r=>r.switchOperationId===id&&!terminal.has(r.status)))throw new Error('Maintenance still running.');
          const candidate=op.candidateSessionId&&this.db.get('roleSessions',op.candidateSessionId);
          if(candidate?.activeRunId)throw new Error('Candidate still locked.');
          if(candidate)this.db.put('roleSessions',{...candidate,status:'archived',updatedAt:this.stamp()});
          op={...op,status:'cancelled'};
        }
      } else {
        if(['cancelling','blocked'].includes(op.status))return op;
        if(receipt.step==='handoff') {
          if(op.status!=='handoff'||(!op.noHistory&&!receipt.runId)||!receipt.text||!receipt.hash)throw new Error('Handoff evidence incomplete.');
          if(switchHash(receipt.text)!==receipt.hash)throw new Error('Handoff hash mismatch.');
          op={...op,status:'verifying'};
        }
        if(receipt.step==='verified'&&(op.status!=='verifying'||receipt.handoffHash!==op.steps.handoff?.hash||!receipt.runId))throw new Error('Candidate verification evidence mismatch.');
        if(receipt.step==='prepared') {
          if(!op.steps.verified||!receipt.settled||!receipt.workspaceUnchanged||receipt.handoffHash!==op.steps.handoff.hash)throw new Error('Worker preparation incomplete.');
          op={...op,status:'prepared'};
        }
      }
      return this.save(op,{steps:{...op.steps,[receipt.step]:receipt}});
    });
  }

  /** One atomic promotion decides the cancellation race and updates supervisor records together. */
  commit(id) {
    return this.db.transaction(()=>{
      const op=this.operation(id);
      if(op.status==='committed')return op;
      if(op.status!=='prepared'||op.leaseUntil<=this.now()||!op.steps.prepared?.settled)throw new Error('Switch is not ready to commit.');
      const role=this.db.get('roles',op.roleId);
      if(switchHash(role)!==switchHash(op.original)||switchHash(this.workspace(role))!==op.workspaceHash)throw new Error('Role or workspace changed during handoff.');
      if(role.systemSupervisor&&switchHash(this.db.get('supervisorConfigs',`${op.projectId}:${op.nodeId}`))!==switchHash(op.originalSupervisorConfig))throw new Error('Supervisor configuration changed during handoff.');
      if(this.draining(op)||this.db.list('runs').some(r=>r.roleId===op.roleId&&!terminal.has(r.status)))throw new Error('Role execution not settled.');
      const source=op.sourceSessionId&&this.db.get('roleSessions',op.sourceSessionId),candidate=this.db.get('roleSessions',op.candidateSessionId);
      if(source&&(source.generation!==op.sourceGeneration||source.activeRunId||source.status==='archived'))throw new Error('Source session changed.');
      if(!candidate||candidate.candidateFor!==id||candidate.activeRunId||!candidate.nativeSessionId||candidate.runtime!==op.candidate.runtime)throw new Error('Candidate session not verified.');
      for(const step of ['handoff','verified']) {
        const runId=op.steps[step]?.runId;if(step==='handoff'&&op.noHistory)continue;
        const run=runId&&this.db.get('runs',runId);
        if(run?.status!=='succeeded'||run.switchOperationId!==id)throw new Error('Maintenance run not completed.');
        if(this.db.list('commands').some(c=>c.runId===runId&&!c.acked))throw new Error('Maintenance command is not acknowledged.');
      }
      if(source)this.db.put('roleSessions',{...source,status:'archived',updatedAt:this.stamp()});
      const {candidateFor,...promoted}=candidate;
      this.db.put('roleSessions',{...promoted,status:'idle',promotedBy:id,updatedAt:this.stamp()});
      this.db.put('roles',{...op.candidate,updatedAt:this.stamp()});
      if(role.systemSupervisor) {
        this.db.put('supervisorConfigs',{...op.supervisorConfig,updatedAt:this.stamp()});
        const project=this.db.get('projects',op.projectId);this.db.put('projects',{...project,supervisorNodeId:op.nodeId});
      }
      for(const task of this.db.list('tasks')) {
        if(task.roleId!==op.roleId||task.status!=='ready'||this.db.list('runs').some(r=>r.taskId===task.id))continue;
        const executionBinding={switchOperationId:id,role:op.candidate};
        this.db.put('tasks',{...task,executionBinding});
        const request=task.requestId&&this.db.get('coordinationRequests',task.requestId);
        if(request?.status==='queued')this.db.put('coordinationRequests',{...request,executionBinding});
      }
      for(const request of this.db.list('coordinationRequests')) {
        if(request.projectId===op.projectId&&request.targetRoleId===op.roleId&&!request.currentRunId&&['queued','waiting_delivery','waiting_dependencies'].includes(request.status))
          this.db.put('coordinationRequests',{...request,executionBinding:{switchOperationId:id,role:op.candidate}});
      }
      return this.save(op,{status:'committed',committedAt:this.stamp()});
    });
  }
}
