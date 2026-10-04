import { projectRepositories } from './project-space.mjs';
import { terminal } from './store.mjs';
import { callTerminal, packCoordinationResults } from './role-calls.mjs';
import {runFailureKind} from './run-reports.mjs';

const now=()=>new Date().toISOString();
const effects=new Set(['plan','audit','develop','test','merge','migration','deploy','production']);
const exclusive=new Set(['migration','deploy','production']);

export const SCHEDULING_RULES=`Execution scheduling: you only assign, verify, and summarize; you do not write business code or detailed business plans yourself.
A single @-mentioned working role executes directly; when several are @-mentioned they have been handed to you to evaluate, and you must cover every role the user named. For a complex plan, schedule a planning role first; you must not substitute for it.
First run wb setup catalog to get the real roles and repositories. A simple single-role task can use wb call; for multiple roles or step dependencies, submit one execution schedule with wb schedule '<JSON>'.
Use wb timer only when given an explicit wall-clock time or recurrence requirement; it manages only the current project's timed jobs and is different from the stage schedule wb schedule. Run wb timer list first to avoid creating duplicates, and use a stable requestId for write operations. When progress patrols are healthy, the model is not woken; you are notified only on new anomalies; do not set an ordinary work loop as a high-frequency patrol.
Format: {"id":"stable-id","reason":"why it is arranged this way","stages":[{"title":"Independent review","mode":"parallel","members":[{"role":"role name","purpose":"audit","text":"specific requirements","writeRepositories":[]}]}]}
mode is parallel or serial; purpose is plan/audit/develop/test/merge/migration/deploy/production. The top-level repositories may list the repository keys actually needed for reading and writing in this run; if omitted, all are prepared; role permissions do not change. At the end of every stage you must submit a business conclusion with wb report.
Reviews can run in parallel; development in different repositories can run in parallel, with writeRepositories listing the repository keys; parallel development in the same module must be followed immediately by a single-member merge stage in which a designated executor merges, then testing. Planning, development, and testing each occupy separate stages; database migration, deployment, and production operations must run serially and exclusively.
The platform advances automatically after each stage completes. The failurePolicy interface defaults to stop: if a dependent step fails, it stops. When organizing several roles to independently review the same input read-only, put them in their own batch and explicitly choose failurePolicy:"collect_reviews"; do not mix them with later modification steps. This mode is limited to all members having purpose=audit and no writeRepositories: once the run is confirmed to have ended, a temporary service error (such as 503 or a clear network connection error) is saved as the original error and the next member continues, with no automatic retry; output that exceeds the limit is separately recorded as "Incomplete result", the gap is likewise kept and the independent reviews continue, and it must not be treated as a temporary service fault or as review approval. Explicitly negative opinions are also collected and the run continues. Permission/login problems, unknown errors, user cancellation, waiting for a user answer, version anomalies, or an unclear process state still stop it, and you must not switch models or work around them on your own. When a tester/planner role reviews a design read-only, that also uses audit; actually running tests, editing documents, developing, merging, or deploying must be scheduled in a separate strict plan and must not be mixed into collect_reviews.
An independent review reads only the shared input and does not treat other reviews' results as a prerequisite for passing. After collecting the successes, negatives, and gaps, summarize first, then schedule modifications separately based on the valid opinions; a missing review must not be treated as approval. When code needs to be handed off, this round's changes must be committed; uncommitted files are not transferred across devices automatically; a missing version follows the original Git delivery flow for confirmation, and you must not push on your own.
After a successful submission, end the current turn immediately; the platform has registered the wait and will automatically wake you to summarize when all stages finish. Do not poll, do not call again, and do not run an extra wb wait. Attachments are passed along with the schedule. Parallelism is limited by device capacity.
The platform may fall back to same-device serial execution because of a dirty directory or a non-Git directory, and a cross-device version mismatch will block; you must report this truthfully. To call other roles, do not use @ in group-chat text in place of the wb tools.`;

/** A lightweight stage plan reuses the call queue; the supervisor does the judging, and the state machine handles only verified execution facts. */
export class ExecutionPlans {
  constructor(db,calls,query,deliveryTools={}) { Object.assign(this,{db,calls,query,deliveryTools}); this.busy=false; }
  submit(run,input) {
    const project=this.db.get('projects',run.projectId);
    if (!run.roleSnapshot?.systemSupervisor || project?.supervisorRoleId!==run.roleId) throw new Error('Only the project supervisor can approve an execution schedule');
    if (!/^[a-zA-Z0-9_-]{1,70}$/.test(input.id||'') || typeof input.reason!=='string' || !input.reason.trim() || input.reason.length>1000) throw new Error('A stable plan ID and a scheduling reason are required');
    if (!Array.isArray(input.stages) || !input.stages.length || input.stages.length>8) throw new Error('A schedule needs 1-8 stages');
    const failurePolicy=input.failurePolicy??'stop';
    if(!['stop','collect_reviews'].includes(failurePolicy))throw new Error('failurePolicy supports only stop or collect_reviews');
    if(failurePolicy==='collect_reviews' && input.stages.some(s=>!Array.isArray(s.members)||s.members.some(m=>m.purpose!=='audit'||(m.writeRepositories||[]).length)))throw new Error('collect_reviews allows only independent review batches with no writes');
    const roles=this.db.list('roles').filter(r=>r.projectId===run.projectId && r.enabled && !r.archivedAt && !r.systemSupervisor);
    const keys=this.db.list('repositories').filter(r=>r.projectId===run.projectId).map(r=>r.key);
    const repositoryKeys=input.repositories===undefined?null:input.repositories;
    if(repositoryKeys!==null&&(!Array.isArray(repositoryKeys)||!repositoryKeys.length||repositoryKeys.some(k=>!keys.includes(k))||new Set(repositoryKeys).size!==repositoryKeys.length))throw new Error('The repository scope for this run must use existing project keys');
    const stages=input.stages.map((s,index)=>{
      if (!['parallel','serial'].includes(s.mode) || typeof s.title!=='string' || !s.title.trim() || s.title.length>100 || !Array.isArray(s.members) || !s.members.length || s.members.length>4) throw new Error('A stage needs a title, an execution mode, and 1-4 roles');
      const members=s.members.map(m=>{
        const role=roles.find(r=>r.name===m.role || r.id===m.role);
        if (!role || !effects.has(m.purpose) || typeof m.text!=='string' || !m.text.trim() || m.text.length>9000) throw new Error('The stage role, purpose, or execution requirement is invalid');
        const writes=m.writeRepositories || [];
        if (!Array.isArray(writes) || writes.some(k=>!keys.includes(k))) throw new Error('Write repositories must use existing project keys');
        if(repositoryKeys && writes.some(k=>!repositoryKeys.includes(k)))throw new Error('The write repository is outside the scope of this run');
        if (['develop','merge'].includes(m.purpose) && !writes.length) throw new Error('Development and merge must declare write repositories');
        return {roleId:role.id,role:role.name,nodeId:role.nodeId,purpose:m.purpose,text:m.text.trim(),writeRepositories:[...new Set(writes)]};
      });
      if (new Set(members.map(m=>m.roleId)).size!==members.length) throw new Error('The same role cannot be scheduled twice in one stage');
      const isExclusive=members.some(m=>exclusive.has(m.purpose));
      if (isExclusive && (s.mode!=='serial' || members.length!==1)) throw new Error('Migration, deployment, and production operations must run alone and serially');
      if (s.mode==='parallel' && !(members.every(m=>m.purpose==='audit') || members.every(m=>m.purpose==='develop'))) throw new Error('Only independent reviews or development may run in parallel within one stage; plan/develop/test must be in separate stages');
      if (s.mode==='serial' && members.length>1 && new Set(members.map(m=>m.purpose)).size>1) throw new Error('Different purposes with dependencies must be split into separate stages');
      if (s.mode==='serial' && members.length>1) throw new Error('For sequential execution, split each role into its own stage so that earlier versions are passed on');
      return {index,title:s.title.trim(),mode:s.mode,exclusive:isExclusive,members,status:'pending'};
    });
    if (stages.reduce((n,s)=>n+s.members.length,0)>12) throw new Error('A schedule allows at most 12 executions');
    for (const [i,s] of stages.entries()) {
      const writes=s.members.flatMap(m=>m.writeRepositories);
      if (s.mode==='parallel' && new Set(writes).size<writes.length && !(stages[i+1]?.members.length===1 && stages[i+1].members[0].purpose==='merge')) throw new Error('Parallel development in the same repository must be followed by a single-member merge stage');
    }
    const task=this.db.get('tasks',run.taskId);
    const missing=task?.schedulingTargets?.filter(id=>!stages.some(s=>s.members.some(m=>m.roleId===id)))||[];
    if(missing.length)throw new Error(`The schedule omits roles that this round must cover: ${missing.map(id=>task.schedulingRoster?.find(r=>r.id===id)?.name||this.db.get('roles',id)?.name||id).join(', ')}; complete it and resubmit. This schedule has not been dispatched`);
    const parent=this.calls.forRun(run),id=`schedule:${run.projectId}:${input.id}`;
    const fingerprint=JSON.stringify({stages,reason:input.reason,parent:parent.id,repositoryKeys,...(failurePolicy==='collect_reviews'?{failurePolicy}:{})});
    const prior=this.db.get('executionPlans',id);
    if(prior) { if(prior.fingerprint!==fingerprint) throw new Error('Plan ID conflicts with different parameters'); return prior; }
    if(this.db.list('executionPlans').some(p=>p.parentRequestId===parent.id)) throw new Error('A schedule was already submitted this turn; end the turn and wait for the results');
    return this.db.transaction(()=>{
      for(const stage of stages) for(const [i,m] of stage.members.entries()) {
        const r=this.calls.create({id:`${id}:${stage.index}:${i}`,projectId:run.projectId,targetRoleId:m.roleId,parentRequestId:parent.id,
          kind:'consult',summary:m.text,sourceMessageId:run.sourceMessageId,planId:id,planVersion:1,stepId:String(stage.index)});
        m.requestId=r.id;
        this.db.put('coordinationRequests',{...r,status:'waiting_dependencies',attachments:run.attachments||[]});
      }
      this.calls.wait(run,`Scheduling reason: ${input.reason}. Verify the actual result of each stage before summarizing to the user; failures, unfinished work, or version blocks must not be hidden.`);
      return this.db.put('executionPlans',{id,projectId:run.projectId,parentRequestId:parent.id,sourceRunId:run.id,sourceMessageId:run.sourceMessageId,
        reason:input.reason,fingerprint,stages,repositoryKeys,failurePolicy,requiresReports:true,status:'running',createdAt:now(),updatedAt:now()});
    });
  }
  repositories(plan,nodeId) {return projectRepositories(this.db,plan.projectId,nodeId).filter(r=>!plan.repositoryKeys||plan.repositoryKeys.includes(r.key));}
  /** Re-check the steering marker when the remote query returns, so that an old asynchronous plan cannot override the user's new direction. */
  async checked(plan,operation) {
    const result=await operation;
    if(this.db.get('coordinationRequests',plan.parentRequestId)?.steeringTaskId)throw new Error('The user has changed direction; the old plan no longer advances automatically');
    return result;
  }
  /** The query completes before the queue is released; stable call IDs and persisted stage state prevent duplicate dispatch after a restart. */
  async advance() {
    if(this.busy || this.db.get('settings','main')?.paused) return false;
    this.busy=true; let changed=false;
    try {
      for(let plan of this.db.list('executionPlans').filter(p=>p.status==='running')) {
        const parent=this.db.get('coordinationRequests',plan.parentRequestId);
        if(parent?.steeringTaskId) {this.db.put('executionPlans',{...plan,status:'blocked',steeringTaskId:parent.steeringTaskId,error:'The user has changed direction; the old plan no longer advances automatically',updatedAt:now()});changed=true;continue;}
        if(parent?.status==='cancelled') { this.db.put('executionPlans',{...plan,status:'cancelled',stages:plan.stages.map(s=>s.status==='succeeded'?s:{...s,status:'cancelled'}),updatedAt:now()});changed=true;continue; }
        // Do not share a directory with a still-running supervisor; the first stage starts only after the parent process has really exited.
        const source=this.db.get('runs',plan.sourceRunId);
        if(!terminal.has(source?.status)) continue;
        try {
          if(source.status!=='succeeded') throw new Error('The supervisor turn did not end normally; working roles were not started');
          const collect=plan.failurePolicy==='collect_reviews';
          const stage=plan.stages.find(s=>s.status!=='succeeded' && !(collect&&s.status==='failed'));
          if(!stage) {this.db.put('executionPlans',{...plan,status:plan.stages.some(s=>s.status==='failed')?'completed_with_issues':'succeeded',updatedAt:now()});changed=true;continue;}
          const requests=stage.members.map(m=>this.db.get('coordinationRequests',m.requestId));
          if(collect) {
            if(plan.stages.some(s=>s.members.some(m=>m.purpose!=='audit'||m.writeRepositories.length)))throw new Error('The independent review policy does not allow writes or other execution purposes');
            if(requests.some(r=>r.status==='cancelled'||r.outcome==='needs_input'||this.db.get('runs',r.currentRunId)?.status==='interrupted'||this.db.get('runs',r.currentRunId)?.stopRequested))throw new Error('A review was cancelled or needs user handling; later steps were not started');
            {
              // Collect only confirmed turn final states; an unknown process, a missing version, or a review that changed code cannot be let through by the fault-tolerant policy.
              const settled=requests.filter(r=>callTerminal.has(r.status));
              const runs=settled.map(request=>{
                let r=request;const seen=new Set();
                while(r?.continuationRequestId) {
                  if(seen.has(r.id)||seen.size>=20)throw new Error('The review continuation chain needs verification');
                  seen.add(r.id);r=this.db.get('coordinationRequests',r.continuationRequestId);
                }
                return this.db.get('runs',r?.currentRunId||'');
              });
              if(runs.some(r=>!r||!terminal.has(r.status)||r.controlLost))throw new Error('The review run results have not been verified; later steps were not started');
              if(runs.some(r=>r.status==='interrupted'||r.stopRequested))throw new Error('A review was stopped; later steps were not started');
              if(runs.some(r=>this.db.get('runReports',r.id)?.verdict==='needs_input'))throw new Error('A review has a question awaiting the user; later steps were not started');
              if(runs.some(r=>r.status==='failed'&&!['temporary_service','incomplete_output'].includes(runFailureKind(r))))throw new Error('A review hit a permission problem or an unconfirmed execution error; later steps were not started. Check the preserved error records');
              if(runs.some((r,i)=>r.status==='succeeded'&&!['passed','failed','blocked'].includes(settled[i].outcome)))throw new Error('A review has no clear conclusion; later steps were not started');
              if(plan.isolated && runs.some(r=>!r.repositoryVersions?.length||r.repositoryVersions.length!==plan.baselines.length||r.repositoryVersions.some(v=>v.dirty||v.commit!==plan.baselines.find(b=>b.id===v.id)?.commit)))throw new Error('An independent review made changes or lacks a version record; later steps were not started');
            }
            if(requests.every(r=>callTerminal.has(r.status))) {
              stage.status=requests.every(r=>r.status==='succeeded'&&r.outcome==='passed')?'succeeded':'failed';
              stage.finishedAt=now();
              if(stage.status==='failed')stage.error='This stage has failed, negative, or missing conclusions; the results were kept and the other independent reviews continue';
              if(!plan.stages[stage.index+1])plan.status=plan.stages.some(s=>s.status==='failed')?'completed_with_issues':'succeeded';
              this.db.put('executionPlans',{...plan,updatedAt:now()});changed=true;continue;
            }
          } else if(requests.some(r=>['failed','cancelled'].includes(r.status))) throw new Error('This stage has failed or cancelled runs; later stages were not started');
          if(!collect && requests.every(r=>r.status==='succeeded')) {
            if(plan.requiresReports && requests.some(r=>r.outcome!=='passed')) throw new Error('The stage has no passing conclusion; a normal CLI exit cannot be treated as acceptance. Review the report and reschedule');
            const stageRuns=requests.map((request,index)=>{
              let r=request;
              for(let i=0;r.continuationRequestId && i<20;i++) r=this.db.get('coordinationRequests',r.continuationRequestId);
              return {run:this.db.get('runs',r.currentRunId),member:stage.members[index]};
            });
            const runs=stageRuns.map(item=>item.run);
            if(plan.isolated && runs.some(r=>!r?.repositoryVersions || r.repositoryVersions.some(v=>v.dirty))) throw new Error('The stage contains uncommitted changes or lacks a version record; the old version cannot be passed to the next stage');
            const next=plan.stages[stage.index+1];
            if(plan.isolated) {
              const versions=new Map(plan.baselines.map(v=>[v.id,new Set([v.commit])]));
              for(const r of runs) for(const v of r.repositoryVersions) {
                const base=plan.baselines.find(b=>b.id===v.id)?.commit;
                if(v.commit!==base) { const set=versions.get(v.id);set.delete(base);set.add(v.commit); }
              }
              const conflicting=[...versions].filter(([,set])=>set.size>1);
              if(conflicting.length && next?.members[0].purpose!=='merge') throw new Error('The same repository has multiple development versions; merge them before continuing');
              if(!conflicting.length)for(const {run:r,member} of stageRuns) {
                const changed=r.repositoryVersions.filter(v=>v.commit!==plan.baselines.find(b=>b.id===v.id)?.commit);
                if(changed.some(v=>!member.writeRepositories.includes(v.key)))throw new Error('The run modified a repository not declared writable; the project baseline was not advanced');
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
            if(nodes.some(id=>this.db.get('workers',id)?.capabilities?.executionScheduling!==1)) { throw new Error('The target Worker has not been upgraded to the execution scheduling protocol'); }
            if(!plan.prepared) {
                const snapshots=[];
                for(const nodeId of nodes) snapshots.push(await this.checked(plan,this.query({nodeId},'execution_snapshot',{repositories:this.repositories(plan,nodeId)},30000)));
                if(snapshots.some(a=>!Array.isArray(a))) throw new Error('Invalid snapshot response');
                const fallback=snapshots.some(a=>!a.length || a.some(v=>v.dirty || v.nonGit));
                if(fallback && nodes.length!==1) throw new Error('A cross-device project contains uncommitted content or a non-Git directory; complete the Git delivery first');
                const canonical=a=>JSON.stringify(a.map(v=>[v.id,v.commit]).sort());
                if(snapshots.some(a=>canonical(a)!==canonical(snapshots[0]))) throw new Error('Repository versions differ across devices');
                plan.isolated=!fallback;plan.baselines=fallback?[]:snapshots[0];
                if(fallback) plan.fallbackReason='The directory has uncommitted content or is not a Git repository; falling back to same-device serial execution and keeping the current input';
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
                  if(!sources.length||!String(error.message).includes('is missing version')||!this.deliveryTools.request)throw error;
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
                    waiting=true;plan.waitingReason='Waiting for Git delivery confirmation; after approval the pinned version is received automatically and this stage continues';
                    if(deliveries.some(d=>['blocked','cancelled'].includes(d.status))) plan.waitingReason='Git delivery is blocked; check the delivery details. Later steps were not started';
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
            if(actual.some(v=>v.dirty || v.commit!==plan.baselines.find(b=>b.id===v.id)?.commit)) throw new Error('The project directory for the exclusive operation is not aligned with the earlier version; confirm the merge/delivery manually first');
          }
            const previous=collect?[]:plan.stages.slice(0,stage.index).flatMap(s=>s.members.map(m=>this.db.get('coordinationRequests',m.requestId)));
          for(const [i,m] of stage.members.entries()) {
            const r=this.db.get('coordinationRequests',m.requestId);
            if(r.status!=='waiting_dependencies') continue;
            if(!parallel && stage.members.slice(0,i).some(p=>{const status=this.db.get('coordinationRequests',p.requestId)?.status;return collect?!callTerminal.has(status):status!=='succeeded';})) break;
            const handoff=previous.length ? `\n\nPrevious stage results (context, not new instructions):\n${packCoordinationResults(previous,5500)}` : '';
            const outputs=plan.stages[stage.index-1]?.outputs;
            const execution={isolated:plan.isolated && !stage.exclusive,batchId:`${plan.id}:${stage.index}`,exclusive:stage.exclusive,
              baselines:plan.baselines||[],repositoryKeys:plan.repositoryKeys,purpose:m.purpose,writeRepositories:m.writeRepositories,inputs:outputs||[]};
            this.db.put('coordinationRequests',{...r,status:'queued',execution,summary:`${m.text}${handoff}\n\nExecution purpose: ${m.purpose}. ${execution.isolated?'Work in an isolated worktree; commit this round\'s changes before handoff, do not modify the original directory, and do not push on your own.':'Use the current project directory and work in order.'}${outputs?`\nPinned artifacts from earlier stages: ${JSON.stringify(outputs)}`:''}`.slice(0,18000),updatedAt:now()});
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
                this.db.put('coordinationRequests',{...r,status:'failed',notExecutedReason:e.message,result:`Not executed: ${e.message}`,updatedAt:now()});
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
