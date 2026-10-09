import { projectRepositories } from './project-space.mjs';
import { terminal } from './store.mjs';
import { callTerminal, packCoordinationResults } from './role-calls.mjs';
import {runFailureKind} from './run-reports.mjs';
import { tr } from './i18n.mjs';
import {freezeSourceInputs} from './source-sync-input.mjs';
import {syncError} from './source-sync-manifest.mjs';

const now=()=>new Date().toISOString();
const effects=new Set(['plan','audit','develop','test','merge','migration','deploy','production']);
const exclusive=new Set(['migration','deploy','production']);

export const schedulingRules = () => tr('executionPlans.executionSchedulingYouOnlyAssign');

/** A lightweight stage plan reuses the call queue; the supervisor does the judging, and the state machine handles only verified execution facts. */
export class ExecutionPlans {
  constructor(db,calls,query,deliveryTools={}) { Object.assign(this,{db,calls,query,deliveryTools}); this.busy=false; }
  submit(run,input) {
    const project=this.db.get('projects',run.projectId);
    if (!run.roleSnapshot?.systemSupervisor || project?.supervisorRoleId!==run.roleId) throw new Error(tr('executionPlans.onlyProjectSupervisorCanApprove'));
    if (!/^[a-zA-Z0-9_-]{1,70}$/.test(input.id||'') || typeof input.reason!=='string' || !input.reason.trim() || input.reason.length>1000) throw new Error(tr('executionPlans.stablePlanIdSchedulingReason'));
    if (!Array.isArray(input.stages) || !input.stages.length || input.stages.length>8) throw new Error(tr('executionPlans.scheduleNeeds18Stages'));
    const failurePolicy=input.failurePolicy??'stop';
    if(!['stop','collect_reviews'].includes(failurePolicy))throw new Error(tr('executionPlans.failurepolicySupportsOnlyStopCollect'));
    if(failurePolicy==='collect_reviews' && input.stages.some(s=>!Array.isArray(s.members)||s.members.some(m=>m.purpose!=='audit'||(m.writeRepositories||[]).length)))throw new Error(tr('executionPlans.collectReviewsAllowsOnlyIndependent'));
    const roles=this.db.list('roles').filter(r=>r.projectId===run.projectId && r.enabled && !r.archivedAt && !r.systemSupervisor);
    const keys=this.db.list('repositories').filter(r=>r.projectId===run.projectId).map(r=>r.key);
    const repositoryKeys=input.repositories===undefined?null:input.repositories;
    if(repositoryKeys!==null&&(!Array.isArray(repositoryKeys)||!repositoryKeys.length||repositoryKeys.some(k=>!keys.includes(k))||new Set(repositoryKeys).size!==repositoryKeys.length))throw new Error(tr('executionPlans.repositoryScopeForRunMust'));
    const stages=input.stages.map((s,index)=>{
      if (!['parallel','serial'].includes(s.mode) || typeof s.title!=='string' || !s.title.trim() || s.title.length>100 || !Array.isArray(s.members) || !s.members.length || s.members.length>4) throw new Error(tr('executionPlans.stageNeedsTitleExecutionMode'));
      const members=s.members.map(m=>{
        const role=roles.find(r=>r.name===m.role || r.id===m.role);
        if (!role || !effects.has(m.purpose) || typeof m.text!=='string' || !m.text.trim() || m.text.length>9000) throw new Error(tr('executionPlans.stageRolePurposeExecutionRequirement'));
        const writes=m.writeRepositories || [];
        if (!Array.isArray(writes) || writes.some(k=>!keys.includes(k))) throw new Error(tr('executionPlans.writeRepositoriesMustUseExisting'));
        if(repositoryKeys && writes.some(k=>!repositoryKeys.includes(k)))throw new Error(tr('executionPlans.writeRepositoryOutsideScopeRun'));
        if (['develop','merge'].includes(m.purpose) && !writes.length) throw new Error(tr('executionPlans.developmentMergeMustDeclareWrite'));
        return {roleId:role.id,role:role.name,nodeId:role.nodeId,purpose:m.purpose,text:m.text.trim(),writeRepositories:[...new Set(writes)]};
      });
      if (new Set(members.map(m=>m.roleId)).size!==members.length) throw new Error(tr('executionPlans.sameRoleCannotBeScheduled'));
      const isExclusive=members.some(m=>exclusive.has(m.purpose));
      if (isExclusive && (s.mode!=='serial' || members.length!==1)) throw new Error(tr('executionPlans.migrationDeploymentProductionOperationsMust'));
      if (s.mode==='parallel' && !(members.every(m=>m.purpose==='audit') || members.every(m=>m.purpose==='develop'))) throw new Error(tr('executionPlans.onlyIndependentReviewsDevelopmentMay'));
      if (s.mode==='serial' && members.length>1 && new Set(members.map(m=>m.purpose)).size>1) throw new Error(tr('executionPlans.differentPurposesWithDependenciesMust'));
      if (s.mode==='serial' && members.length>1) throw new Error(tr('executionPlans.forSequentialExecutionSplitEach'));
      if(s.sourceSyncBatchId&&this.db.get('sourceSyncBatches',s.sourceSyncBatchId)?.projectId!==run.projectId)throw syncError('source_input_not_ready');
      return {index,title:s.title.trim(),mode:s.mode,exclusive:isExclusive,members,status:'pending',...(s.sourceSyncBatchId?{sourceSyncBatchId:s.sourceSyncBatchId}:{})};
    });
    if (stages.reduce((n,s)=>n+s.members.length,0)>12) throw new Error(tr('executionPlans.scheduleAllowsAtMost12'));
    for (const [i,s] of stages.entries()) {
      const writes=s.members.flatMap(m=>m.writeRepositories);
      if (s.mode==='parallel' && new Set(writes).size<writes.length && !(stages[i+1]?.members.length===1 && stages[i+1].members[0].purpose==='merge')) throw new Error(tr('executionPlans.parallelDevelopmentInSameRepository'));
    }
    const task=this.db.get('tasks',run.taskId);
    const missing=task?.schedulingTargets?.filter(id=>!stages.some(s=>s.members.some(m=>m.roleId===id)))||[];
    if(missing.length)throw new Error(tr('executionPlans.scheduleOmitsRolesRoundMust', { p1: missing.map(id=>task.schedulingRoster?.find(r=>r.id===id)?.name||this.db.get('roles',id)?.name||id).join(tr('executionPlans.text')) }));
    const parent=this.calls.forRun(run),id=`schedule:${run.projectId}:${input.id}`;
    const fingerprint=JSON.stringify({stages,reason:input.reason,parent:parent.id,repositoryKeys,...(failurePolicy==='collect_reviews'?{failurePolicy}:{})});
    const prior=this.db.get('executionPlans',id);
    if(prior) { if(prior.fingerprint!==fingerprint) throw new Error(tr('executionPlans.planIdConflictsWithDifferent')); return prior; }
    if(this.db.list('executionPlans').some(p=>p.parentRequestId===parent.id)) throw new Error(tr('executionPlans.scheduleWasAlreadySubmittedTurn'));
    return this.db.transaction(()=>{
      for(const stage of stages) for(const [i,m] of stage.members.entries()) {
        const r=this.calls.create({id:`${id}:${stage.index}:${i}`,projectId:run.projectId,targetRoleId:m.roleId,parentRequestId:parent.id,
          kind:'consult',summary:m.text,sourceMessageId:run.sourceMessageId,planId:id,planVersion:1,stepId:String(stage.index)});
        m.requestId=r.id;
        this.db.put('coordinationRequests',{...r,status:'waiting_dependencies',attachments:run.attachments||[]});
      }
      this.calls.wait(run,tr('executionPlans.schedulingReasonVerifyActualResult', { reason: input.reason }));
      return this.db.put('executionPlans',{id,projectId:run.projectId,parentRequestId:parent.id,sourceRunId:run.id,sourceMessageId:run.sourceMessageId,
        reason:input.reason,fingerprint,stages,repositoryKeys,failurePolicy,requiresReports:true,status:'running',createdAt:now(),updatedAt:now()});
    });
  }
  repositories(plan,nodeId) {return projectRepositories(this.db,plan.projectId,nodeId).filter(r=>!plan.repositoryKeys||plan.repositoryKeys.includes(r.key));}
  /** Re-check the steering marker when the remote query returns, so that an old asynchronous plan cannot override the user's new direction. */
  async checked(plan,operation) {
    const result=await operation;
    if(this.db.get('coordinationRequests',plan.parentRequestId)?.steeringTaskId)throw new Error(tr('executionPlans.userHasChangedDirectionOld'));
    return result;
  }
  /** The query completes before the queue is released; stable call IDs and persisted stage state prevent duplicate dispatch after a restart. */
  async advance() {
    if(this.busy || this.db.get('settings','main')?.paused) return false;
    this.busy=true; let changed=false;
    try {
      for(let plan of this.db.list('executionPlans').filter(p=>p.status==='running')) {
        const parent=this.db.get('coordinationRequests',plan.parentRequestId);
        if(parent?.steeringTaskId) {this.db.put('executionPlans',{...plan,status:'blocked',steeringTaskId:parent.steeringTaskId,error:tr('executionPlans.userHasChangedDirectionOld2'),updatedAt:now()});changed=true;continue;}
        if(parent?.status==='cancelled') { this.db.put('executionPlans',{...plan,status:'cancelled',stages:plan.stages.map(s=>s.status==='succeeded'?s:{...s,status:'cancelled'}),updatedAt:now()});changed=true;continue; }
        // Do not share a directory with a still-running supervisor; the first stage starts only after the parent process has really exited.
        const source=this.db.get('runs',plan.sourceRunId);
        if(!terminal.has(source?.status)) continue;
        try {
          if(source.status!=='succeeded') throw new Error(tr('executionPlans.supervisorTurnDidNotEnd'));
          const collect=plan.failurePolicy==='collect_reviews';
          const stage=plan.stages.find(s=>s.status!=='succeeded' && !(collect&&s.status==='failed'));
          if(!stage) {this.db.put('executionPlans',{...plan,status:plan.stages.some(s=>s.status==='failed')?'completed_with_issues':'succeeded',updatedAt:now()});changed=true;continue;}
          const requests=stage.members.map(m=>this.db.get('coordinationRequests',m.requestId));
          if(collect) {
            if(plan.stages.some(s=>s.members.some(m=>m.purpose!=='audit'||m.writeRepositories.length)))throw new Error(tr('executionPlans.independentReviewPolicyDoesNot'));
            if(requests.some(r=>r.status==='cancelled'||r.outcome==='needs_input'||this.db.get('runs',r.currentRunId)?.status==='interrupted'||this.db.get('runs',r.currentRunId)?.stopRequested))throw new Error(tr('executionPlans.reviewWasCancelledNeedsUser'));
            {
              // Collect only confirmed turn final states; an unknown process, a missing version, or a review that changed code cannot be let through by the fault-tolerant policy.
              const settled=requests.filter(r=>callTerminal.has(r.status));
              const runs=settled.map(request=>{
                let r=request;const seen=new Set();
                while(r?.continuationRequestId) {
                  if(seen.has(r.id)||seen.size>=20)throw new Error(tr('executionPlans.reviewContinuationChainNeedsVerification'));
                  seen.add(r.id);r=this.db.get('coordinationRequests',r.continuationRequestId);
                }
                return this.db.get('runs',r?.currentRunId||'');
              });
              if(runs.some(r=>!r||!terminal.has(r.status)||r.controlLost))throw new Error(tr('executionPlans.reviewRunResultsHaveNot'));
              if(runs.some(r=>r.status==='interrupted'||r.stopRequested))throw new Error(tr('executionPlans.reviewWasStoppedLaterSteps'));
              if(runs.some(r=>this.db.get('runReports',r.id)?.verdict==='needs_input'))throw new Error(tr('executionPlans.reviewHasQuestionAwaitingUser'));
              if(runs.some(r=>r.status==='failed'&&!['temporary_service','incomplete_output'].includes(runFailureKind(r))))throw new Error(tr('executionPlans.reviewHitPermissionProblemUnconfirmed'));
              if(runs.some((r,i)=>r.status==='succeeded'&&!['passed','failed','blocked'].includes(settled[i].outcome)))throw new Error(tr('executionPlans.reviewHasNoClearConclusion'));
              if(plan.isolated && runs.some(r=>!r.repositoryVersions?.length||r.repositoryVersions.length!==plan.baselines.length||r.repositoryVersions.some(v=>v.dirty&&!v.sourceInputVerified||v.commit!==plan.baselines.find(b=>b.id===v.id)?.commit)))throw new Error(tr('executionPlans.independentReviewMadeChangesLacks'));
            }
            if(requests.every(r=>callTerminal.has(r.status))) {
              stage.status=requests.every(r=>r.status==='succeeded'&&r.outcome==='passed')?'succeeded':'failed';
              stage.finishedAt=now();
              if(stage.status==='failed')stage.error=tr('executionPlans.stageHasFailedNegativeMissing');
              if(!plan.stages[stage.index+1])plan.status=plan.stages.some(s=>s.status==='failed')?'completed_with_issues':'succeeded';
              this.db.put('executionPlans',{...plan,updatedAt:now()});changed=true;continue;
            }
          } else if(requests.some(r=>['failed','cancelled'].includes(r.status))) throw new Error(tr('executionPlans.stageHasFailedCancelledRuns'));
          if(!collect && requests.every(r=>r.status==='succeeded')) {
            if(plan.requiresReports && requests.some(r=>r.outcome!=='passed')) throw new Error(tr('executionPlans.stageHasNoPassingConclusion'));
            const stageRuns=requests.map((request,index)=>{
              let r=request;
              for(let i=0;r.continuationRequestId && i<20;i++) r=this.db.get('coordinationRequests',r.continuationRequestId);
              return {run:this.db.get('runs',r.currentRunId),member:stage.members[index]};
            });
            const runs=stageRuns.map(item=>item.run);
            if(plan.isolated && stageRuns.some(({run:r,member})=>!r?.repositoryVersions || r.repositoryVersions.some(v=>v.dirty&&!(v.sourceInputVerified&&!member.writeRepositories.length)))) throw new Error(tr('executionPlans.stageContainsUncommittedChangesLacks'));
            const next=plan.stages[stage.index+1];
            if(plan.isolated) {
              const versions=new Map(plan.baselines.map(v=>[v.id,new Set([v.commit])]));
              for(const r of runs) for(const v of r.repositoryVersions) {
                const base=plan.baselines.find(b=>b.id===v.id)?.commit;
                if(v.commit!==base) { const set=versions.get(v.id);set.delete(base);set.add(v.commit); }
              }
              const conflicting=[...versions].filter(([,set])=>set.size>1);
              if(conflicting.length && next?.members[0].purpose!=='merge') throw new Error(tr('executionPlans.sameRepositoryHasMultipleDevelopment'));
              if(!conflicting.length)for(const {run:r,member} of stageRuns) {
                const changed=r.repositoryVersions.filter(v=>v.commit!==plan.baselines.find(b=>b.id===v.id)?.commit);
                if(changed.some(v=>!member.writeRepositories.includes(v.key)))throw new Error(tr('executionPlans.runModifiedRepositoryNotDeclared'));
                if(changed.length)await this.checked(plan,this.query({nodeId:r.nodeId},'execution_baseline_advance',
                  {repositories:this.repositories(plan,r.nodeId),versions:changed},30000));
              }
              stage.outputs=runs.map(r=>({runId:r.id,nodeId:r.nodeId,versions:r.repositoryVersions}));
              if(!conflicting.length) plan.baselines=plan.baselines.map(v=>({...v,commit:[...versions.get(v.id)][0]}));
            }
            stage.status='succeeded';stage.finishedAt=now();
            if(!next) plan.status='succeeded';
            this.db.put('executionPlans',{...plan,updatedAt:now()});changed=true;continue;
          }
          if(!requests.some(r=>r.status==='waiting_dependencies')) continue;
          if(stage.status==='pending') {
            if(this.db.list('runs').some(r=>r.projectId===plan.projectId && !terminal.has(r.status))) continue;
            const nodes=[...new Set(plan.stages.flatMap(s=>s.members.map(m=>m.nodeId)))];
            if(nodes.some(id=>this.db.get('workers',id)?.capabilities?.executionScheduling!==1)) { throw new Error(tr('executionPlans.targetWorkerHasNotBeen')); }
            if(stage.sourceSyncBatchId){
              const batch=this.db.get('sourceSyncBatches',stage.sourceSyncBatchId);if(batch?.status!=='completed')continue;
              const inputs=freezeSourceInputs(this.db,batch.id,stage.members[0].nodeId,plan.projectId);
              for(const member of stage.members)freezeSourceInputs(this.db,batch.id,member.nodeId,plan.projectId);
              plan.baselines=inputs.filter(i=>!plan.repositoryKeys||plan.repositoryKeys.includes(this.db.get('repositories',i.repositoryId)?.key)).map(i=>({id:i.repositoryId,key:this.db.get('repositories',i.repositoryId)?.key,commit:i.baseCommit}));
              plan.isolated=true;plan.prepared=true;
            }else if(plan.stages[stage.index-1]?.outputs?.some(o=>o.versions?.some(v=>v.dirty&&v.sourceInputVerified)))throw syncError('source_input_required');
            if(!plan.prepared) {
                const snapshots=[];
                for(const nodeId of nodes) snapshots.push(await this.checked(plan,this.query({nodeId},'execution_snapshot',{repositories:this.repositories(plan,nodeId)},30000)));
                if(snapshots.some(a=>!Array.isArray(a))) throw new Error(tr('executionPlans.invalidSnapshotResponse'));
                const fallback=snapshots.some(a=>!a.length || a.some(v=>v.dirty || v.nonGit));
                if(fallback && nodes.length!==1) throw new Error(tr('executionPlans.crossDeviceProjectContainsUncommitted'));
                const canonical=a=>JSON.stringify(a.map(v=>[v.id,v.commit]).sort());
                if(snapshots.some(a=>canonical(a)!==canonical(snapshots[0]))) throw new Error(tr('executionPlans.repositoryVersionsDifferAcrossDevices'));
                plan.isolated=!fallback;plan.baselines=fallback?[]:snapshots[0];
                if(fallback) plan.fallbackReason=tr('executionPlans.directoryHasUncommittedContentNot');
              plan.prepared=true;
            }
            if(plan.isolated) {
              if(plan.nextInputCheck && Date.parse(plan.nextInputCheck)>Date.now())continue;
              const versions=[...plan.baselines,...(plan.stages[stage.index-1]?.outputs||[]).flatMap(o=>o.versions)];
              let waiting=false;
              for(const nodeId of new Set(stage.members.map(m=>m.nodeId))) {
                const repositories=this.repositories(plan,nodeId);
                try {await this.checked(plan,this.query({nodeId},'execution_versions',{repositories,versions},30000));}
                catch(error) {
                  const sources=(plan.stages[stage.index-1]?.outputs||[]).filter(o=>o.nodeId!==nodeId);
                  if(!sources.length||!/is missing version|\u7f3a\u5c11\u7248\u672c/.test(String(error.message))||!this.deliveryTools.request)throw error;
                  const deliveries=[];
                  for(const source of sources) {
                    const run=this.db.get('runs',source.runId);
                    const items=source.versions.map(v=>({...v,repoUrl:run.repositories.find(r=>r.id===v.id)?.repoUrl,
                      changed:v.commit!==run.execution?.baselines?.find(b=>b.id===v.id)?.commit}));
                    deliveries.push(this.deliveryTools.request(run,items,plan.id));
                  }
                  plan.deliveryIds=[...new Set([...(plan.deliveryIds||[]),...deliveries.map(d=>d.id)])];
                  if(deliveries.every(d=>d.status==='ready')) {
                    await this.checked(plan,this.deliveryTools.receive(nodeId,repositories,deliveries));
                    await this.checked(plan,this.query({nodeId},'execution_versions',{repositories,versions},30000));
                  } else {
                    waiting=true;plan.waitingReason=tr('executionPlans.waitingForGitDeliveryConfirmation');
                    if(deliveries.some(d=>['blocked','cancelled'].includes(d.status))) plan.waitingReason=tr('executionPlans.gitDeliveryBlockedCheckDelivery');
                  }
                }
              }
              if(waiting){this.db.put('executionPlans',{...plan,nextInputCheck:new Date(Date.now()+5000).toISOString(),updatedAt:now()});changed=true;continue;}
              plan.waitingReason=null;plan.nextInputCheck=null;
            }
            stage.status='running';stage.startedAt=now();
            this.db.put('executionPlans',{...plan,updatedAt:now()});changed=true;
          }
          const latest=this.db.get('executionPlans',plan.id);
          if(latest.status!=='running' || this.db.get('coordinationRequests',plan.parentRequestId)?.steeringTaskId || this.db.get('coordinationRequests',plan.parentRequestId)?.status==='cancelled' || this.db.get('settings','main')?.paused) continue;
          const parallel=stage.mode==='parallel' && plan.isolated;
          if(stage.exclusive && plan.isolated && stage.members.some(m=>this.db.get('coordinationRequests',m.requestId)?.status==='waiting_dependencies')) {
            const actual=await this.checked(plan,this.query({nodeId:stage.members[0].nodeId},'execution_snapshot',{repositories:this.repositories(plan,stage.members[0].nodeId)},30000));
            if(actual.some(v=>v.dirty || v.commit!==plan.baselines.find(b=>b.id===v.id)?.commit)) throw new Error(tr('executionPlans.projectDirectoryForExclusiveOperation'));
          }
            const previous=collect?[]:plan.stages.slice(0,stage.index).flatMap(s=>s.members.map(m=>this.db.get('coordinationRequests',m.requestId)));
          for(const [i,m] of stage.members.entries()) {
            const r=this.db.get('coordinationRequests',m.requestId);
            if(r.status!=='waiting_dependencies') continue;
            if(!parallel && stage.members.slice(0,i).some(p=>{const status=this.db.get('coordinationRequests',p.requestId)?.status;return collect?!callTerminal.has(status):status!=='succeeded';})) break;
            const handoff=previous.length ? tr('executionPlans.previousStageResultsContextNot', { p1: packCoordinationResults(previous,5500) }) : '';
            const outputs=plan.stages[stage.index-1]?.outputs;
            const execution={isolated:plan.isolated && !stage.exclusive,batchId:`${plan.id}:${stage.index}`,exclusive:stage.exclusive,
              baselines:plan.baselines||[],repositoryKeys:plan.repositoryKeys,purpose:m.purpose,writeRepositories:m.writeRepositories,inputs:outputs||[]};
            const sourceInputs=stage.sourceSyncBatchId?freezeSourceInputs(this.db,stage.sourceSyncBatchId,m.nodeId,plan.projectId).filter(i=>plan.baselines.some(v=>v.id===i.repositoryId)):[];
            this.db.put('coordinationRequests',{...r,status:'queued',sourceInputs,execution,summary:tr('executionPlans.executionPurpose', { text: m.text, handoff, purpose: m.purpose, p4: execution.isolated?tr('executionPlans.workInIsolatedWorktreeCommit'):tr('executionPlans.useCurrentProjectDirectoryWork'), p5: outputs?tr('executionPlans.pinnedArtifactsFromEarlierStages', { p1: JSON.stringify(outputs) }):'' }).slice(0,18000),updatedAt:now()});
            changed=true;
          }
        } catch(e) {
          if(this.db.get('coordinationRequests',plan.parentRequestId)?.steeringTaskId)continue;
          plan=this.db.get('executionPlans',plan.id);
          this.db.transaction(()=>{
            const blockedStage=plan.stages.find(s=>s.status!=='succeeded' && !(plan.failurePolicy==='collect_reviews'&&s.status==='failed'));
            if(blockedStage)blockedStage.status='blocked';
            this.db.put('executionPlans',{...plan,status:'blocked',error:e.message,updatedAt:now()});
            for(const m of plan.stages.flatMap(s=>s.members)) {
              const r=this.db.get('coordinationRequests',m.requestId);
              if(!callTerminal.has(r.status) && !r.currentRunId) {
                this.db.put('coordinationRequests',{...r,status:'failed',notExecutedReason:e.message,result:tr('executionPlans.notExecuted', { message: e.message }),updatedAt:now()});
                if(r.taskId) this.db.put('tasks',{...this.db.get('tasks',r.taskId),status:'cancelled',waitingReason:e.message});
              }
            }
          });changed=true;
        }
      }
    } finally {this.busy=false;}
    return changed;
  }
}
