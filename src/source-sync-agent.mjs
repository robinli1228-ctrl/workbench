import {contentHash,validateEntry,syncError} from './source-sync-manifest.mjs';
import {conflictHashes} from './source-sync-conflicts.mjs';

/** All project roles can inspect sync facts; assignment and proposal are tied to actual Run identity. */
export class SourceSyncAgent {
  constructor({db,sync,conflicts,storage,query}){Object.assign(this,{db,sync,conflicts,storage,query});}
  conflict(run,id){const c=this.db.get('sourceSyncConflicts',id);if(c?.projectId!==run.projectId)throw syncError('conflict_missing');return c;}
  async execute(run,action,input={}){
    if(!input||typeof input!=='object'||Array.isArray(input))throw syncError('invalid_request');
    if(action==='status'){
      if(input.candidateId){const c=this.db.get('sourceSyncCandidates',input.candidateId);if(c?.projectId!==run.projectId)throw syncError('candidate_not_ready');return {candidateId:c.id,status:c.status,result:c.result,error:c.error};}
      return this.sync.status(run.projectId);
    }
    if(action==='request'){if(run.sourceConflictId)throw syncError('resolution_must_propose');return this.sync.request(run.projectId,{requestId:input.requestId,repositoryIds:input.repositoryIds,targetNodeIds:input.targetNodeIds,sourceNodeId:run.nodeId},{kind:'agent',runId:run.id,roleId:run.roleId});}
    if(action==='read'){
      const c=this.conflict(run,input.conflictId);
      if(input.side===undefined)return {...c,expectedHashes:conflictHashes(c),peerResults:(c.peerTaskIds||[]).map(id=>{const t=this.db.get('tasks',id),r=t?.currentRunId&&this.db.get('runs',t.currentRunId);return {taskId:id,status:r?.status||t?.status,result:r?.result||null};})};
      let side=input.side==='base'?{entry:c.base}:input.side==='proposal'?(c.proposal?{entry:c.proposal.entry}:null):c.sides.find(s=>s.endpointId===input.side);
      if(!side&&!['base','proposal'].includes(input.side)){
        const matches=c.sides.filter(s=>s.nodeId===input.side);if(matches.length>1)throw syncError('ambiguous_side','Use the endpointId returned by sync read.');
        side=matches[0]||(/^(?:0|[1-9]\d*)$/.test(String(input.side))?c.sides[Number(input.side)]:null);
      }
      if(!side)throw syncError('invalid_side');if(side.unknown)throw syncError('evidence_missing');
      if(!side.entry)return {path:c.path,deleted:true,hash:null,content:null};
      const bytes=await this.storage.read(c.projectId,side.entry.hash),offset=input.offset??0,limit=input.limit??12000;
      if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>20000)throw syncError('invalid_page');
      const text=bytes.toString('utf8'),binary=bytes.includes(0)||!Buffer.from(text).equals(bytes);
      return {path:c.path,hash:side.entry.hash,size:bytes.length,binary,offset,content:binary?null:text.slice(offset,offset+limit),nextOffset:!binary&&offset+limit<text.length?offset+limit:null};
    }
    if(action==='assign'){const c=this.conflict(run,input.conflictId);return this.conflicts.assign(c.id,input.generation,input.roleId,{kind:'agent',roleId:run.roleId});}
    if(action==='propose'){
      const c=this.conflict(run,input.conflictId);
      if(!this.conflicts.owns(run,c)||c.generation!==input.generation)throw syncError('conflict_changed');
      if(!/^[\w-]{1,100}$/.test(input.requestId||''))throw syncError('invalid_request_id');
      const id=contentHash(run.id+':'+input.requestId),fingerprint=contentHash(JSON.stringify(input)),prior=this.db.get('sourceSyncCandidates',id);
      if(prior){if(prior.fingerprint!==fingerprint)throw syncError('request_conflict');return {candidateId:id,status:prior.status,result:prior.result,error:prior.error};}
      this.db.put('sourceSyncCandidates',{id,projectId:run.projectId,runId:run.id,conflictId:c.id,generation:c.generation,assignmentId:c.assignmentId,fingerprint,input,status:'capturing'});
      void this.query(run,'source_sync_candidate',{candidateId:id,conflictId:c.id,repositoryId:c.repositoryId,path:c.path},90000).catch(error=>{
        const value=this.db.get('sourceSyncCandidates',id);if(value?.status==='capturing')this.db.put('sourceSyncCandidates',{...value,status:'blocked',error:error.code||'capture_failed'});
      });
      return {candidateId:id,status:'capturing',next:'Use wb sync status with candidateId before reporting completion.'};
    }
    throw syncError('invalid_sync_action');
  }
  candidate(run,id){const value=this.db.get('sourceSyncCandidates',id),conflict=value&&this.conflict(run,value.conflictId);
    if(!value||value.runId!==run.id||!this.conflicts.owns(run,conflict)||value.generation!==conflict.generation||value.assignmentId!==conflict.assignmentId)throw syncError('conflict_changed');return value;}
  /** Candidate scope is checked on the Worker against its pinned resolution manifest, not against model prose. */
  stageCandidate(run,input){
    const value=this.candidate(run,input.candidateId),c=this.conflict(run,value.conflictId);validateEntry(input.entry);
    if(!run.sourceInputs?.some(i=>i.repositoryId===c.repositoryId&&i.manifestId===input.baselineManifestId)||!Array.isArray(input.changedPaths)||input.changedPaths.some(p=>p!==c.path))throw syncError('candidate_scope_changed');
    const capturedFingerprint=contentHash(JSON.stringify({entry:input.entry,baselineManifestId:input.baselineManifestId,changedPaths:input.changedPaths}));
    if(value.capturedFingerprint&&value.capturedFingerprint!==capturedFingerprint)throw syncError('candidate_changed');
    const staged={...value,entry:input.entry,scopeVerified:true,baselineManifestId:input.baselineManifestId,capturedFingerprint};this.db.put('sourceSyncCandidates',staged);return {candidateId:value.id,staged:true};
  }
  async completeCandidate(run,id){
    const value=this.candidate(run,id);if(!value.scopeVerified||value.entry===undefined)throw syncError('candidate_not_ready');
    if(value.entry&&!await this.storage.has(run.projectId,value.entry))throw syncError('blob_missing');
    const ready={...value,ready:true,status:'ready'};this.db.put('sourceSyncCandidates',ready);
    try{const result=this.conflicts.propose(run,{...value.input,candidateId:id});this.db.put('sourceSyncCandidates',{...ready,status:'proposed',result});return result;}
    catch(error){this.db.put('sourceSyncCandidates',{...ready,status:'blocked',error:error.code||'verification_required'});throw error;}
  }
}
