import {randomUUID} from 'node:crypto';
import {attributeSourceChange} from './source-sync-provenance.mjs';
import {contentHash,manifestDigest,validateEntry,syncError} from './source-sync-manifest.mjs';
import {terminal} from './store.mjs';
import {tr} from './i18n.mjs';
import {isRoleConfigured} from './default-roles.mjs';

export const conflictHashes=c=>({base:c.base?.hash??null,sides:c.sides.map(s=>s.entry?.hash??null)});

/** Merge native tool lifecycles; completed shell evidence must follow the last observed source write. */
export function sourceVerificationProof(events) {
  const tools=new Map();let lastWrite=0;
  for(const event of events){const item=event.payload?.item;if(event.type!=='tool'||!item?.id)continue;
    const merged={...tools.get(item.id)?.item,...item};tools.set(item.id,{item:merged,event});
    if(merged.status==='completed'&&!merged.is_error&&(merged.type==='fileChange'||/^(?:Write|Edit|write_file|edit_file|write_to_file|replace_file_content)$/i.test(merged.name||'')))lastWrite=Math.max(lastWrite,event.seq||0);
  }
  return [...tools.values()].filter(({item:i,event})=>i.status==='completed'&&!i.is_error&&(event.seq||0)>=lastWrite
    &&(i.type==='commandExecution'&&i.exitCode===0||/^(?:Bash|run_command|run_shell_command)$/i.test(i.name||'')&&(i.exitCode===0||i.exit_code===0||i.name==='Bash'&&i.is_error===false))).map(v=>v.event);
}

/** Conflict ownership is a versioned task assignment, independent from a role's permanent responsibility. */
export class SourceSyncConflicts {
  constructor({db,rooms,sync,reachability=()=>false}){Object.assign(this,{db,rooms,sync,reachability});}
  open(input){const old=this.db.get('sourceSyncConflicts',input.id);return old||this.db.put('sourceSyncConflicts',input);}
  tick(){
    if(this.db.get('settings','main')?.paused)return;
    for(const conflict of this.db.list('sourceSyncConflicts').filter(c=>c.status==='open')){
      const config=this.db.get('sourceSyncConfigs',conflict.projectId);if(!config?.enabled||config.generation!==conflict.syncGeneration)continue;
      if(this.db.list('runs').some(r=>r.sourceConflictId===conflict.id&&!terminal.has(r.status)))continue;
      if((conflict.staleCount||0)>=2){this.escalate(conflict,'repeated_stale_proposal');continue;}
      if(conflict.evidencePending){this.sync.refreshEvidence?.(conflict);continue;}
      const records=this.db.listProject('sourceSyncProvenance',conflict.projectId);
      const writers=conflict.sides.map(side=>side.unknown?{certainty:'unknown',roleId:null}:attributeSourceChange({records,repositoryId:conflict.repositoryId,path:conflict.path,afterHash:side.entry?.hash??null,nodeId:side.nodeId,sourceRunId:side.sourceRunId}));
      const c=this.db.put('sourceSyncConflicts',{...conflict,writers});
      const originalTasks=writers.map(w=>w.runId&&this.db.get('runs',w.runId)).filter(Boolean).map(r=>this.db.get('tasks',r.taskId)).filter(Boolean);
      if(originalTasks.some(t=>t.requiresIndependentReview||t.reviewerRoleId||t.execution?.acceptance?.reviewerRoleId))c.requiresIndependentReview=true;
      this.db.put('sourceSyncConflicts',c);
      const owner=writers.map(w=>w.roleId&&this.db.get('roles',w.roleId)).find(r=>r?.enabled&&!r.archivedAt&&isRoleConfigured(r)&&this.db.get('repositoryWorkspaces',`${conflict.repositoryId}:${r.nodeId}`)&&this.reachability(r));
      if(owner)this.assign(c.id,c.generation,owner.id,{kind:'automatic'});else this.escalate(c,'modifier_unavailable');
    }
    for(const run of this.db.list('runs').filter(r=>r.sourceConflictId&&terminal.has(r.status)))this.finish(run.id);
  }
  escalate(c,reason){
    const supervisorId=this.db.get('projects',c.projectId)?.supervisorRoleId;
    const supervisor=supervisorId?this.db.get('roles',supervisorId):null;
    if(reason!=='independent_review_required'&&supervisor?.enabled&&!supervisor.archivedAt&&isRoleConfigured(supervisor)&&this.db.get('workspaces',`${c.projectId}:${supervisor.nodeId}`)){
      const id=`sync-assignment-${c.id}-${c.generation}`,prior=this.db.get('roomMessages',id);
      if(!prior)this.rooms.postSystemTask(c.projectId,{id,roleId:supervisor.id,source:{kind:'assignment',conflictId:c.id,generation:c.generation},
        text:tr('sourceSync.assignmentTask',{id:c.id,path:c.path,reason})});
    }
    return this.db.put('sourceSyncConflicts',{...c,status:'needs_input',reason});
  }
  assign(id,generation,roleId,actor){return this.db.transaction(()=>{
    const c=this.db.get('sourceSyncConflicts',id),role=this.db.get('roles',roleId);
    if(!c||c.generation!==generation||['resolved','cancelled'].includes(c.status))throw syncError('conflict_changed');
    if(actor.kind==='agent'&&actor.roleId!==this.db.get('projects',c.projectId)?.supervisorRoleId)throw syncError('assignment_not_allowed');
    if(['verifying','resolved_pending_sync'].includes(c.status))throw syncError('sync_busy');
    if(role?.projectId!==c.projectId||!role.enabled||role.archivedAt||!isRoleConfigured(role)||!this.db.get('repositoryWorkspaces',`${c.repositoryId}:${role.nodeId}`))throw syncError('modifier_unavailable');
    if(c.ownerRoleId===roleId&&['queued','resolving','verifying','resolved_pending_sync'].includes(c.status))return c;
    if(this.db.list('runs').some(r=>r.sourceConflictId===c.id&&!terminal.has(r.status)))throw syncError('owner_still_running');
    if(c.ownerTaskId){const task=this.db.get('tasks',c.ownerTaskId);if(task)this.db.put('tasks',{...task,status:'cancelled'});}
    const attempts=(c.attempts||0)+1;if(attempts>2&&actor.kind!=='human')return this.escalate(c,'repair_limit');
    const canonical=this.db.get('sourceSyncManifests',`${c.projectId}:${c.repositoryId}`);if(!canonical)throw syncError('baseline_missing');
    const written=(c.writers||[]).findIndex(w=>w.roleId===roleId),own=c.sides[written]||c.sides.find(s=>s.nodeId===role.nodeId)||c.sides[0];if(own.unknown)throw syncError('evidence_missing');
    const entries={...canonical.entries,[c.path]:own.entry},digest=manifestDigest(entries),assignmentId=randomUUID();
    const version={...canonical,id:contentHash(assignmentId),entries,digest};this.db.put('sourceSyncVersions',version);
    const sourceInputs=[{repositoryId:c.repositoryId,baseCommit:canonical.baseCommit,generation:c.syncGeneration,manifestRevision:canonical.revision,manifestHash:digest,manifestId:version.id}];
    const peerRoleIds=[...new Set((c.writers||[]).map(w=>w.roleId).filter(id=>id&&id!==roleId))],peerTaskIds=[];
    for(const peerId of peerRoleIds){const peerRole=this.db.get('roles',peerId);if(!peerRole?.enabled||peerRole.archivedAt||!isRoleConfigured(peerRole))continue;const peerMessageId=`sync-peer-${c.id}-${generation}-${roleId}-${peerRole.id}`;const message=this.db.get('roomMessages',peerMessageId)||this.rooms.postSystemTask(c.projectId,{id:peerMessageId,roleId:peerRole.id,
      source:{kind:'peer',conflictId:c.id,generation},text:tr('sourceSync.peerTask',{id:c.id,path:c.path,owner:role.name})});peerTaskIds.push(message.taskIds[0]);}
    const peerTaskId=peerTaskIds[0]||null;
    const repo=this.db.get('repositories',c.repositoryId);
    const message=this.rooms.postSystemTask(c.projectId,{id:`sync-repair-${c.id}-${generation}-${attempts}`,roleId,
      source:{kind:'repair',conflictId:c.id,generation,assignmentId},sourceInputs,
      execution:{isolated:true,batchId:`sync-${c.id}`,purpose:'develop',repositoryKeys:[repo.key],writeRepositories:[repo.key],baselines:[{id:repo.id,key:repo.key,commit:canonical.baseCommit}],inputs:[]},
      text:tr('sourceSync.repairTask',{id:c.id,path:c.path,generation,hashes:JSON.stringify(conflictHashes(c)),peerTaskId:peerTaskIds.join(', ')||'none'})});
    return this.db.put('sourceSyncConflicts',{...c,status:'queued',ownerRoleId:roleId,ownerTaskId:message.taskIds[0],assignmentId,peerTaskId,peerTaskIds,attempts,proposal:null,reason:null});
  });}
  owns(run,c){return run?.projectId===c.projectId&&run.roleId===c.ownerRoleId&&run.sourceConflictId===c.id&&run.sourceConflictGeneration===c.generation&&run.sourceConflictAssignmentId===c.assignmentId;}
  propose(run,input){return this.db.transaction(()=>{
    const c=this.db.get('sourceSyncConflicts',input.conflictId);if(!c||!this.owns(run,c)||input.generation!==c.generation||terminal.has(run.status))throw syncError('conflict_changed');
    const expected=conflictHashes(c);if(input.expectedHashes?.base!==expected.base||!Array.isArray(input.expectedHashes?.sides)||input.expectedHashes.sides.length!==expected.sides.length||input.expectedHashes.sides.some((hash,i)=>hash!==expected.sides[i]))throw syncError('conflict_changed');
    if(typeof input.rationale!=='string'||!input.rationale.trim()||input.rationale.length>3000||!Array.isArray(input.evidence)||!input.evidence.length||input.evidence.length>20||input.evidence.some(e=>typeof e!=='string'||!e||e.length>1500))throw syncError('verification_required');
    const candidate=this.db.get('sourceSyncCandidates',input.candidateId);
    if(!candidate?.ready||candidate.runId!==run.id||candidate.conflictId!==c.id||candidate.generation!==c.generation||!candidate.scopeVerified)throw syncError('candidate_not_ready');
    validateEntry(candidate.entry);
    const proof=sourceVerificationProof(this.db.events(run.id));
    if(!proof.length)throw syncError('verification_required');
    const proposal={id:candidate.id,runId:run.id,entry:candidate.entry,expectedHashes:input.expectedHashes,rationale:input.rationale,evidence:input.evidence,verificationEventIds:proof.map(e=>e.id)};
    this.db.put('sourceSyncConflicts',{...c,status:'resolving',proposal});return {conflictId:c.id,status:'proposed',note:tr('sourceSync.proposalPending')};
  });}
  finish(runId){
    const run=this.db.get('runs',runId),c=run?.sourceConflictId&&this.db.get('sourceSyncConflicts',run.sourceConflictId);
    if(!c||!this.owns(run,c)||!terminal.has(run.status)||c.handledRunIds?.includes(runId)||['resolved','resolved_pending_sync','verifying','needs_input'].includes(c.status))return;
    const request=run.requestId?this.db.get('coordinationRequests',run.requestId):this.db.list('coordinationRequests').find(r=>r.taskId===run.taskId);
    if(request&&(request.status==='waiting_call'||request.continuationRequestId))return;
    const updated={...c,handledRunIds:[...c.handledRunIds||[],runId]};
    const report=this.db.get('runReports',runId);
    if(run.status==='succeeded'&&report?.verdict==='passed'&&c.proposal?.runId===runId&&!run.controlLost){
      // Native exit codes are not a candidate-bound verification contract. Keep the exact proposal for independent review.
      this.escalate(updated,'independent_review_required');return;
    }
    if(c.requiresIndependentReview){this.escalate(updated,'independent_review_required');return;}
    if(run.stopRequested||run.controlLost||report?.verdict==='needs_input'||(c.attempts||0)>=2){this.escalate(updated,'verification_required');return;}
    this.db.put('sourceSyncConflicts',{...updated,status:'open',ownerTaskId:null,assignmentId:null,proposal:null});
  }
  /** Explicit browser review accepts one exact proposal; distribution still rechecks every destination. */
  acceptReview(id,generation,proposalId){
    const c=this.db.get('sourceSyncConflicts',id),run=c?.proposal&&this.db.get('runs',c.proposal.runId);
    if(!c||c.generation!==generation||c.proposal?.id!==proposalId||c.status!=='needs_input'||c.reason!=='independent_review_required'||run?.status!=='succeeded'||this.db.get('runReports',run.id)?.verdict!=='passed')throw syncError('conflict_changed');
    const reviewed={...c,status:'verifying',review:{kind:'human',proposalId,at:new Date().toISOString()}};this.db.put('sourceSyncConflicts',reviewed);
    const batch=this.sync.resolve(reviewed,c.proposal);return this.db.put('sourceSyncConflicts',{...reviewed,resolutionBatchId:batch.id});
  }
}
