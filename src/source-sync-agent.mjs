import {contentHash,validateEntry,syncError} from './source-sync-manifest.mjs';
import {conflictHashes} from './source-sync-conflicts.mjs';
import {sourceScopeBinding} from './source-sync-scopes.mjs';
import {reviewView,reviewSourceFileAllowed} from './collaboration-sessions.mjs';

/** All project roles can inspect sync facts; assignment and proposal are tied to actual Run identity. */
export class SourceSyncAgent {
  constructor({db,sync,conflicts,storage,query}){Object.assign(this,{db,sync,conflicts,storage,query});}
  conflict(run,id){const c=this.db.get('sourceSyncConflicts',id);if(c?.projectId!==run.projectId)throw syncError('conflict_missing');
    if(!this.visible(run,c))throw syncError('review_document_not_released');return c;}
  /** Sync storage is not an alternate route around independent-review document visibility. */
  visible(run,c){return !reviewView(this.db,run).reviewGuarded||c.sides?.length>0&&c.sides.every(s=>reviewSourceFileAllowed(this.db,run,{sourceNodeId:s.nodeId,sourceRunId:s.sourceRunId,reviewPath:c.path.replace(/^\.workbench\//,''),hash:s.entry?.hash,scopeId:c.repositoryId}));}
  /**
   * Has one file arrived? Per scope, the canonical entry and each participating device's acknowledged entry with its
   * observation time: consistent, in_transit (a sync batch is active for that device), conflict, or unknown. An offline
   * device or a missing acknowledgement is unknown, never "not arrived". Unreleased review documents show no hashes.
   */
  fileStatus(run,input){
    const path=input.path;
    if(typeof path!=='string'||!path||path.length>500||path.startsWith('/')||path.split('/').some(part=>part==='..'||part===''))throw syncError('invalid_path');
    const config=this.db.get('sourceSyncConfigs',run.projectId),guarded=reviewView(this.db,run).reviewGuarded;
    // Historical scopes and acknowledgements remain stored, but cannot prove delivery in the current configuration.
    const nodeIds=[...new Set(config?.nodeIds||[])];
    const manifests=this.db.listProject('sourceSyncManifests',run.projectId).filter(m=>config?.enabled&&config.repositoryIds?.includes(m.repositoryId)&&m.generation===config.generation&&(input.repositoryId===undefined||m.repositoryId===input.repositoryId));
    const devices=this.db.listProject('sourceSyncDevices',run.projectId).filter(d=>d.generation===config?.generation&&nodeIds.includes(d.nodeId)),batches=this.db.listProject('sourceSyncBatches',run.projectId).filter(b=>b.generation===config?.generation&&['queued','capturing','applying'].includes(b.status));
    const conflicts=this.db.listProject('sourceSyncConflicts',run.projectId).filter(c=>c.path===path&&!['resolved','cancelled'].includes(c.status));
    const entryOf=(entries,key)=>entries&&Object.hasOwn(entries,key)?entries[key]:null;
    const scopes=manifests.map(m=>{
      const canonical=entryOf(m.entries,path),acks=devices.filter(d=>d.repositoryId===m.repositoryId);
      if(!canonical&&!acks.some(d=>entryOf(d.entries,path)))return null;
      // Authorize the actual returned version; a permitted canonical baseline does not release a newer peer acknowledgement.
      const hidden=(nodeId,hash)=>guarded&&path.startsWith('.workbench/')&&!reviewSourceFileAllowed(this.db,run,{sourceNodeId:nodeId,reviewPath:path.replace(/^\.workbench\//,''),hash,scopeId:m.repositoryId});
      const sides=nodeIds.map(nodeId=>{
        const ack=acks.find(d=>d.nodeId===nodeId),entry=entryOf(ack?.entries,path),online=Boolean(this.sync.online(nodeId));
        const same=ack&&(entry?.hash||null)===(canonical?.hash||null);
        // An offline device's last acknowledgement is history, not a current match: it stays unknown even when the hash agrees.
        const state=conflicts.some(c=>c.repositoryId===m.repositoryId)?'conflict':!online?'unknown':same?'consistent'
          :batches.some(b=>b.repositoryIds?.includes(m.repositoryId)&&(b.nodeIds||[]).includes(nodeId))?'in_transit':'unknown';
        const veil=hidden(nodeId,entry?.hash);
        return {nodeId,online,state,hash:veil?null:entry?.hash||null,size:veil?null:entry?.size??null,observedAt:ack?.updatedAt||null,
          ...(veil?{reason:'review_document_not_released'}:!ack?{reason:'no_acknowledgement'}:!online?{reason:'device_offline'}:{})};
      });
      const state=sides.some(s=>s.state==='conflict')?'conflict':sides.length&&sides.every(s=>s.state==='consistent')?'consistent':sides.some(s=>s.state==='in_transit')?'in_transit':'unknown';
      return {repositoryId:m.repositoryId,state,canonical:hidden(run.nodeId,canonical?.hash)?null:canonical?{hash:canonical.hash,size:canonical.size??null}:null,
        canonicalUpdatedAt:m.updatedAt||null,devices:sides,conflictIds:conflicts.filter(c=>c.repositoryId===m.repositoryId).map(c=>c.id)};
    }).filter(Boolean);
    return {path,observedAt:new Date().toISOString(),enabled:Boolean(config?.enabled),state:scopes.length?scopes.some(s=>s.state==='conflict')?'conflict':scopes.every(s=>s.state==='consistent')?'consistent':scopes.some(s=>s.state==='in_transit')?'in_transit':'unknown':'unknown',
      ...(scopes.length?{}:{reason:'not_in_sync_scope'}),scopes};
  }
  async execute(run,action,input={}){
    if(!input||typeof input!=='object'||Array.isArray(input))throw syncError('invalid_request');
    if(action==='status'){
      if(input.path!==undefined)return this.fileStatus(run,input);
      if(input.candidateId){const c=this.db.get('sourceSyncCandidates',input.candidateId);if(c?.projectId!==run.projectId||c.runId!==run.id)throw syncError('candidate_not_ready');this.conflict(run,c.conflictId);return {candidateId:c.id,status:c.status,result:c.result,error:c.error};}
      const state=this.sync.status(run.projectId);return reviewView(this.db,run).reviewGuarded?{...state,conflicts:state.conflicts.filter(c=>this.visible(run,c))}:state;
    }
    if(action==='request'){if(run.sourceConflictId)throw syncError('resolution_must_propose');return this.sync.request(run.projectId,{requestId:input.requestId,repositoryIds:input.repositoryIds,targetNodeIds:input.targetNodeIds,sourceNodeId:run.nodeId},{kind:'agent',runId:run.id,roleId:run.roleId});}
    if(action==='read'){
      const c=this.conflict(run,input.conflictId);
      if(input.side===undefined){const view=reviewView(this.db,run);return {...c,expectedHashes:conflictHashes(c),peerResults:(c.peerTaskIds||[]).map(id=>{const t=view.get('tasks',id),r=t?.currentRunId&&view.get('runs',t.currentRunId);return {taskId:id,status:r?.status||t?.status,result:r?.result||null};})};}
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
      const directory=c.scopeKind==='directory'?{scopeKind:'directory',scopePolicy:c.scopePolicy,root:sourceScopeBinding(this.db,c.projectId,c.repositoryId,run.nodeId)?.localRoot,assignmentId:c.assignmentId}:{};
      void this.query(run,'source_sync_candidate',{candidateId:id,conflictId:c.id,repositoryId:c.repositoryId,path:c.path,...directory},90000).catch(error=>{
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
    const matches=c.scopeKind==='directory'?input.scopeKind==='directory'&&input.baselineManifestId===c.assignmentId&&input.path===c.path&&input.root===sourceScopeBinding(this.db,c.projectId,c.repositoryId,run.nodeId)?.localRoot:run.sourceInputs?.some(i=>i.repositoryId===c.repositoryId&&i.manifestId===input.baselineManifestId);
    if(!matches||!Array.isArray(input.changedPaths)||input.changedPaths.some(p=>p!==c.path))throw syncError('candidate_scope_changed');
    const capturedFingerprint=contentHash(JSON.stringify({entry:input.entry,root:input.root,baselineManifestId:input.baselineManifestId,changedPaths:input.changedPaths}));
    if(value.capturedFingerprint&&value.capturedFingerprint!==capturedFingerprint)throw syncError('candidate_changed');
    const staged={...value,entry:input.entry,root:input.root,scopeVerified:true,baselineManifestId:input.baselineManifestId,capturedFingerprint};this.db.put('sourceSyncCandidates',staged);return {candidateId:value.id,staged:true};
  }
  async completeCandidate(run,id){
    const value=this.candidate(run,id);if(!value.scopeVerified||value.entry===undefined)throw syncError('candidate_not_ready');
    if(value.entry&&!await this.storage.has(run.projectId,value.entry))throw syncError('blob_missing');
    const ready={...value,ready:true,status:'ready'};this.db.put('sourceSyncCandidates',ready);
    try{const result=this.conflicts.propose(run,{...value.input,candidateId:id});this.db.put('sourceSyncCandidates',{...ready,status:'proposed',result});return result;}
    catch(error){this.db.put('sourceSyncCandidates',{...ready,status:'blocked',error:error.code||'verification_required'});throw error;}
  }
}
