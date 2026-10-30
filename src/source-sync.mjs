import {checkInventorySize,splitSourceItems} from './source-sync-batching.mjs';
import {SourceSyncAudit} from './source-sync-audit.mjs';
import {SourceSyncMetadata} from './source-sync-metadata-home.mjs';
import {randomBytes} from 'node:crypto';
import {SOURCE_SYNC_CAPTURE_POLICY,SOURCE_SYNC_LIMITS,validateSourceCapture,contentHash,manifestDigest,compareEntry,entryEqual,linkSourceMoves,syncError,excludedSourcePath} from './source-sync-manifest.mjs';

import {buildSourceBindings,sourceScopeBinding} from './source-sync-scopes.mjs';

const stamp=()=>new Date().toISOString(),done=new Set(['completed','partial_conflict','blocked','cancelled','preview_ready','evidence_ready']);
const getEntry=(entries,path)=>Object.hasOwn(entries,path)?entries[path]:null;
const identity=(...parts)=>contentHash(JSON.stringify(parts));

/** Home owns metadata only; no filesystem or model operation runs inside its SQLite transactions. */
export class SourceSync {
  constructor({db,online=()=>false,change=()=>{},now=Date.now}){Object.assign(this,{db,online,change});this.metadata=new SourceSyncMetadata(this);this.audit=new SourceSyncAudit({db,now});}
  supportsBatching(nodeIds){return nodeIds.length>0&&nodeIds.every(id=>this.db.get('workers',id)?.capabilities?.sourceSyncBatching===1);}
  config(projectId){return this.db.get('sourceSyncConfigs',projectId)||{id:projectId,projectId,enabled:false,revision:0,generation:0};}
  /** Paths that became mandatory exclusions after they were synchronized (role worktrees under .worktrees, October 2026) leave
   * the stored canonical, per-device and metadata records at startup. Left in place, every later batch would fence on
   * source_scope_changed, a stored digest that no longer validates would wedge the batch, and an open conflict on such a path
   * would throw on every assignment tick. Deletions are never sent. */
  dropExcludedEntries(){
    const policies=new Map(),policy=(projectId,repositoryId)=>policies.get(`${projectId}:${repositoryId}`)||{};
    const strip=(record,scopePolicy)=>{const entries={},origins={};let dropped=0;
      for(const [path,entry] of Object.entries(record.entries||{})){if(excludedSourcePath(path,scopePolicy)){dropped++;continue;}entries[path]=entry;if(record.origins&&Object.hasOwn(record.origins,path))origins[path]=record.origins[path];}
      return dropped?{...record,entries,...(record.origins?{origins}:{})}:null;};
    let changed=0;
    this.db.transaction(()=>{
      for(const manifest of this.db.list('sourceSyncManifests')){policies.set(manifest.id,manifest.scopePolicy||{});const next=strip(manifest,manifest.scopePolicy||{});if(!next)continue;
        const digest=manifestDigest(next.entries,next.scopePolicy),updated={...next,digest,revision:next.revision+Number(digest!==next.digest)};
        this.db.put('sourceSyncManifests',updated);this.db.put('sourceSyncVersions',{...updated,id:identity(updated.projectId,updated.repositoryId,updated.generation,updated.revision,updated.digest)});changed++;}
      for(const ack of this.db.list('sourceSyncDevices')){const next=strip(ack,policy(ack.projectId,ack.repositoryId));if(next){this.db.put('sourceSyncDevices',next);changed++;}}
      for(const baseline of this.db.list('sourceSyncMetadataBaselines'))if(excludedSourcePath(baseline.path,policy(baseline.projectId,baseline.repositoryId))){this.db.remove('sourceSyncMetadataBaselines',baseline.id);changed++;}
      // Same cancellation as disabling sync: the conflict and its repair tasks that have not started.
      const conflicts=this.db.list('sourceSyncConflicts').filter(c=>!['resolved','cancelled'].includes(c.status)&&excludedSourcePath(c.path,policy(c.projectId,c.repositoryId)));
      if(conflicts.length){const tasks=this.db.list('tasks');
        for(const conflict of conflicts){this.db.put('sourceSyncConflicts',{...conflict,status:'cancelled'});changed++;
          for(const task of tasks.filter(t=>t.projectId===conflict.projectId&&[t.sourceConflictId,t.sourceConflictPeerId,t.sourceConflictAssignmentRequestId].includes(conflict.id)&&!t.currentRunId))this.db.put('tasks',{...task,status:'cancelled'});}}
    });
    return changed;
  }
  /** A source is a workspace endpoint, not just a device; isolated outputs remain distinct from registered receivers. */
  side(projectId,repositoryId,nodeId,entry,origin={},unknown=false){
    const command=origin.commandId?this.db.get('sourceSyncCommands',origin.commandId)||origin:origin;
    const sourceRunId=command.sourceRunId||null,root=command.root||sourceScopeBinding(this.db,projectId,repositoryId,nodeId)?.localRoot;
    return {nodeId,entry,root,sourceRunId,endpointId:identity(repositoryId,nodeId,root,sourceRunId),originCommandId:command.id||origin.commandId||null,...(unknown?{unknown:true}:{})};
  }
  /** Freeze each actual receiving folder from its capture or latest acknowledged physical version. */
  receiving(batch,captures,path){
    return batch.nodeIds.map(nodeId=>{
      const binding=sourceScopeBinding(this.db,batch.projectId,batch.repositoryIds[0],nodeId);
      const capture=captures.find(c=>c.nodeId===nodeId&&c.root===binding?.localRoot&&!c.sourceRunId);
      const ack=this.db.get('sourceSyncDevices',`${batch.projectId}:${batch.repositoryIds[0]}:${nodeId}`);
      return this.side(batch.projectId,batch.repositoryIds[0],nodeId,getEntry(capture?.result.manifest.entries||ack?.entries||{},path),{root:binding?.localRoot});
    });
  }
  /** One current conflict per path; changed evidence advances its generation and preserves the old record. */
  recordConflict(input){
    const id=identity(input.projectId,input.repositoryId,input.syncGeneration,input.path),prior=this.db.get('sourceSyncConflicts',id);
    if(prior&&!['resolved','cancelled'].includes(prior.status))input={...input,
      sides:[...new Map([...prior.sides,...input.sides].map(side=>[side.endpointId||side.nodeId,side])).values()],
      receiving:[...new Map([...prior.receiving||[],...input.receiving||[]].map(side=>[side.endpointId||side.nodeId,side])).values()]};
    const versions=sides=>sides.map(s=>[s.endpointId||s.nodeId,s.entry,Boolean(s.unknown)]);
    if(prior&&identity(versions(prior.sides))===identity(versions(input.sides))&&identity(versions(prior.receiving||[]))===identity(versions(input.receiving||[]))&&!['resolved','cancelled'].includes(prior.status))return prior;
    if(input.projectId){const manifest=this.db.get('sourceSyncManifests',`${input.projectId}:${input.repositoryId}`);if(manifest?.scopeKind==='directory')input={...input,scopeKind:'directory',scopePolicy:manifest.scopePolicy};}
    // Audit history is not a metadata GC root; carry unretired bytes forward to the next conflict.
    const pendingCopyEntries=input.detection==='metadata'&&prior?.detection==='metadata'&&!prior.copiesReleasedAt
      ? [...new Map([...(prior.pendingCopyEntries||[]),prior.base,...(prior.sides||[]).map(s=>s.entry),...(prior.receiving||[]).map(s=>s.entry),prior.proposal?.entry].filter(Boolean).map(e=>[e.hash,e])).values()] : [];
    if(prior)this.db.put('sourceSyncConflictHistory',{...prior,id:`${id}:${prior.generation}`});
    return this.db.put('sourceSyncConflicts',{...prior,...input,...(input.detection==='metadata'?{copiesReleasedAt:null,copiesCheckedAt:null,copiesNextCheckAt:null,pendingCopyEntries}:{}),id,generation:(prior?.generation||0)+1,status:'open',proposal:null,createdAt:stamp()});
  }
  resolve(conflict,proposal){return this.specialBatch(conflict,'resolution',proposal);}
  refreshEvidence(conflict){return this.specialBatch(conflict,'evidence');}
  specialBatch(conflict,kind,proposal=null){
    const original=this.db.get('sourceSyncBatches',conflict.batchId),config=this.config(conflict.projectId);
    const targetNodeIds=[...new Set(conflict.receiving?.length?conflict.receiving.map(s=>s.nodeId):original?.targetNodeIds||original?.nodeIds||[])],nodeIds=[...new Set([...targetNodeIds,...conflict.sides.map(s=>s.nodeId)])],id=identity(kind,conflict.id,conflict.generation,proposal?.id),prior=this.db.get('sourceSyncBatches',id);if(prior)return prior;
    const bindings=this.bindings(conflict.projectId,[conflict.repositoryId],targetNodeIds).map(b=>({...b,captureRole:'target',endpointId:identity(b.repositoryId,b.nodeId,b.root,null)}));
    for(const side of conflict.sides){
      if(!side.root||bindings.some(b=>b.endpointId===side.endpointId))continue;
      bindings.push({repositoryId:conflict.repositoryId,nodeId:side.nodeId,root:side.root,sourceRunId:side.sourceRunId||null,readOnlyExport:true,captureRole:'source',endpointId:side.endpointId});
    }
    return this.db.put('sourceSyncBatches',{id,projectId:conflict.projectId,kind,generation:config.generation,configRevision:config.revision,revision:1,status:'queued',sourceNodeId:nodeIds[0],
      nodeIds,targetNodeIds,sourceInputNodeIds:targetNodeIds,...(this.supportsBatching(nodeIds)?{boundedTransfers:true}:{}),scopeKind:config.scopeKind,...(config.detection?{detection:config.detection}:{}),repositoryIds:[conflict.repositoryId],bindings,conflictIds:[conflict.id],conflictGeneration:conflict.generation,proposal,createdAt:stamp()});
  }
  records(kind,projectId){return this.db.listProject?this.db.listProject(kind,projectId):this.db.list(kind).filter(x=>x.projectId===projectId);}
  bindings(projectId,repositoryIds,nodeIds,options=this.config(projectId)){
    if(!this.db.get('projects',projectId))throw syncError('project_missing');
    if(!Array.isArray(repositoryIds)||!repositoryIds.length||repositoryIds.length>30||new Set(repositoryIds).size!==repositoryIds.length
      ||!Array.isArray(nodeIds)||nodeIds.length<2||nodeIds.length>16||new Set(nodeIds).size!==nodeIds.length)throw syncError('invalid_scope');
    return buildSourceBindings(this.db,projectId,repositoryIds,nodeIds,options);
  }
  /** Preview scans without touching project files; activation references this exact reviewed scope. */
  preview(projectId,input){return this.createBatch(projectId,input,'preview');}
  configure(projectId,input){return this.db.transaction(()=>{
    const old=this.config(projectId);if(input.revision!==old.revision||typeof input.enabled!=='boolean')throw syncError('configuration_changed');
    if(this.db.listSourceSyncBatches({projectId}).some(b=>b.kind!=='preview'))throw syncError('sync_busy');
    if(this.db.listSourceSyncCommands({projectId,pending:true}).length)throw syncError('sync_busy');
    if(!input.enabled){
      if(this.records('sourceSyncConflicts',projectId).some(c=>!['resolved','cancelled'].includes(c.status)))throw syncError('unresolved_conflicts');
      if(this.db.list('runs').some(r=>r.projectId===projectId&&r.sourceConflictId&&!['succeeded','failed','interrupted'].includes(r.status)))throw syncError('owner_still_running');
      for(const conflict of this.records('sourceSyncConflicts',projectId).filter(c=>!['resolved','cancelled'].includes(c.status))){this.db.put('sourceSyncConflicts',{...conflict,status:'cancelled'});
        for(const task of this.db.list('tasks').filter(t=>t.projectId===projectId&&[t.sourceConflictId,t.sourceConflictPeerId,t.sourceConflictAssignmentRequestId].includes(conflict.id)&&!t.currentRunId))this.db.put('tasks',{...task,status:'cancelled'});
      }
      const c=this.db.put('sourceSyncConfigs',{...old,enabled:false,revision:old.revision+1,generation:old.generation+1});this.change();return c;
    }
    // A scope change must first fence the old generation and its queued repair tasks.
    if(old.enabled)throw syncError('sync_busy');
    const batch=typeof input.previewBatchId==='string'?this.db.get('sourceSyncBatches',input.previewBatchId):null;
    if(batch?.projectId!==projectId||batch.kind!=='preview'||batch.status!=='preview_ready'||batch.configRevision!==old.revision)throw syncError('preview_required');
    if(batch.scopeKind==='directory'&&this.records('sourceSyncConflicts',projectId).some(c=>!['resolved','cancelled'].includes(c.status)))throw syncError('unresolved_conflicts');
    const bindings=this.bindings(projectId,batch.repositoryIds,batch.nodeIds,batch);
    if(identity(bindings)!==identity(batch.bindings))throw syncError('binding_changed');
    const config=this.db.put('sourceSyncConfigs',{id:projectId,projectId,enabled:true,revision:old.revision+1,generation:batch.generation,repositoryIds:batch.repositoryIds,nodeIds:batch.nodeIds,bindings,...(batch.scopeKind==='directory'?{scopeKind:'directory',mode:batch.mode,displayNodeId:batch.displayNodeId,...(batch.detection?{detection:batch.detection}:{}),...(batch.contentMode?{contentMode:batch.contentMode}:{})}:{}),updatedAt:stamp()});
    if(batch.detection==='metadata'){this.metadata.configure(batch);this.change();return config;}
    for(const repositoryId of batch.repositoryIds){const captures=this.captures(batch,repositoryId);let base=captures[0].result.base;
      if(batch.scopeKind==='directory'){
        const entries={};for(const path of new Set(captures.flatMap(c=>Object.keys(c.result.manifest.entries)))){const first=getEntry(captures[0].result.manifest.entries,path);entries[path]=captures.every(c=>entryEqual(getEntry(c.result.manifest.entries,path),first))?first:null;}
        base={...base,entries,digest:manifestDigest(entries,base.scopePolicy)};
      }
      const id=`${projectId}:${repositoryId}`;
      this.db.put('sourceSyncManifests',{...base,id,projectId,repositoryId,generation:config.generation,revision:0,origins:{}});
      for(const c of captures)this.db.put('sourceSyncDevices',{id:`${id}:${c.nodeId}`,projectId,repositoryId,nodeId:c.nodeId,generation:config.generation,entries:base.entries,revision:0});
    }
    this.change();return config;
  });}
  request(projectId,input,actor={kind:'human'}){
    const config=this.config(projectId);if(!config.enabled)throw syncError('sync_disabled');
    const nodeIds=[...new Set([input.sourceNodeId,...input.targetNodeIds||[]])];
    const repositoryIds=input.repositoryIds||config.repositoryIds;
    if(!input.sourceNodeId||nodeIds.some(n=>!config.nodeIds.includes(n))||repositoryIds.some(r=>!config.repositoryIds.includes(r)))throw syncError('invalid_scope');
    return this.createBatch(projectId,{...input,nodeIds,repositoryIds},'sync',actor);
  }
  createBatch(projectId,input,kind,actor={kind:'human'}){return this.db.transaction(()=>{
    if(typeof input.requestId!=='string'||!/^[\w-]{1,100}$/.test(input.requestId))throw syncError('invalid_request_id');
    const config=this.config(projectId),options=kind==='preview'?input:config,bindings=this.bindings(projectId,input.repositoryIds,input.nodeIds,options);
    if(options.scopeKind==='directory'&&(!input.displayNodeId&&!config.displayNodeId||!(input.nodeIds||[]).includes(input.displayNodeId||config.displayNodeId)))throw syncError('display_node_required');
    if(options.scopeKind==='directory'&&this.db.get('workers',input.displayNodeId||config.displayNodeId)?.platform!=='darwin')throw syncError('display_mac_required');
    if(options.mode&& !['manual','continuous'].includes(options.mode))throw syncError('invalid_scope');
    if(actor.kind==='agent'){
      const run=this.db.get('runs',actor.runId);if(run?.projectId!==projectId||run.nodeId!==input.sourceNodeId||run.roleId!==actor.roleId||['succeeded','failed','interrupted'].includes(run.status))throw syncError('source_run_changed');
      if(options.scopeKind==='directory'&&run.execution?.isolated)throw syncError('deliver_to_project_first');
      if(options.scopeKind!=='directory')for(const binding of bindings.filter(b=>b.nodeId===input.sourceNodeId)){const repo=run.repositories?.find(r=>r.id===binding.repositoryId);if(!repo?.localRoot)throw syncError('binding_missing');
        if(repo.localRoot!==binding.root){binding.root=repo.localRoot;binding.readOnlyExport=true;binding.sourceRunId=run.id;binding.sourceBaseManifestId=run.sourceInputs?.find(v=>v.repositoryId===repo.id)?.manifestId||null;}}
    }
    const fingerprint=identity({kind,input,actor}),id=identity(projectId,kind,input.requestId),old=this.db.get('sourceSyncBatches',id);
    if(old){if(old.fingerprint!==fingerprint)throw syncError('request_conflict');return old;}
    const generation=kind==='preview'?config.generation+1:config.generation;
    const batch={id,projectId,kind,fingerprint,generation,configRevision:config.revision,revision:1,status:'queued',sourceNodeId:input.sourceNodeId||input.nodeIds[0],
      nodeIds:input.nodeIds,repositoryIds:input.repositoryIds,bindings,actor,...(this.supportsBatching(input.nodeIds)?{boundedTransfers:true}:{}),...(options.scopeKind==='directory'?{scopeKind:'directory',mode:options.mode||'manual',displayNodeId:input.displayNodeId||config.displayNodeId,...(options.detection?{detection:options.detection}:{}),...(options.contentMode?{contentMode:options.contentMode}:{})}:{}),createdAt:stamp(),conflictIds:[]};
    batch.sourceInputNodeIds=input.nodeIds.filter(nodeId=>!bindings.some(b=>b.nodeId===nodeId&&b.readOnlyExport));
    this.db.put('sourceSyncBatches',batch);this.change();return batch;
  });}
  command(batch,binding,action,extra={}){
    const id=identity(batch.id,binding.repositoryId,binding.nodeId,action,...(binding.endpointId?[binding.endpointId]:[]),...(action==='cleanup'&&extra.retirementOf?[extra.retirementOf]:[]),...(extra.part===undefined?[]:['part',extra.part])),prior=this.db.get('sourceSyncCommands',id);if(prior)return prior;
    return this.db.put('sourceSyncCommands',{id,projectId:batch.projectId,batchId:batch.id,repositoryId:binding.repositoryId,nodeId:binding.nodeId,
      generation:batch.generation,...(batch.boundedTransfers?{boundedTransfers:true}:{}),...(batch.detection==='metadata'&&batch.kind!=='preview'?{rootIdentity:this.db.get('sourceSyncMetadataScopes',`${batch.projectId}:${binding.repositoryId}:${batch.generation}:${binding.nodeId}`)?.rootIdentity}:{}),action,preview:batch.kind==='preview',root:binding.root,repoUrl:binding.repoUrl,...(binding.scopeKind==='directory'?{scopeKind:'directory',scopePolicy:binding.scopePolicy,...(batch.detection?{detection:batch.detection}:{})}:{}),...(binding.sourceRunId?{sourceRunId:binding.sourceRunId}:{}),...(binding.endpointId?{endpointId:binding.endpointId,captureRole:binding.captureRole}:{}),secret:randomBytes(32).toString('hex'),status:'queued',...extra});
  }
  /** Chunk identity and order are persisted so reconnects replay the same work and never skip an earlier part. */
  commandParts(batch,binding,action,extra,field,sizeOf){
    const parts=batch.boundedTransfers?splitSourceItems(extra[field],sizeOf):[extra[field]],commands=[];
    for(const [part,items] of parts.entries())commands.push(this.command(batch,binding,action,{...extra,[field]:items,...(parts.length>1?{part,parts:parts.length,...(commands.length?{afterCommandId:commands.at(-1).id}:{})}:{})}));
    return commands;
  }
  captures(batch,repositoryId){return this.db.listSourceSyncCommands({projectId:batch.projectId,batchId:batch.id,repositoryId,action:'capture'});}
  /** Returns persistent commands; connection code supplies resend timing and node authentication. */
  schedule(){
    // Queued and in-progress batches come from the open-batch index; finished history is never read here.
    for(const batch of this.db.listSourceSyncBatches({status:'queued'})){
      if(this.db.listSourceSyncBatches({projectId:batch.projectId}).some(b=>b.id!==batch.id&&b.status!=='queued'))continue;
      if(this.db.listSourceSyncCommands({projectId:batch.projectId,pending:true}).some(c=>c.batchId!==batch.id))continue;
      if(batch.kind!=='preview'&&(!this.config(batch.projectId).enabled||this.config(batch.projectId).generation!==batch.generation)){
        this.db.put('sourceSyncBatches',{...batch,status:'blocked',reason:'configuration_changed'});continue;
      }
      for(const binding of batch.bindings){const canonical=this.db.get('sourceSyncManifests',`${batch.projectId}:${binding.repositoryId}`);
        this.command(batch,binding,'capture',{baseCommit:batch.kind==='preview'?null:canonical?.baseCommit,...(binding.scopeKind==='directory'?{baselineEntries:canonical?.entries||{}}:{})});}
      this.db.put('sourceSyncBatches',{...batch,status:'capturing'});batch.status='capturing';
    }
    return this.db.listSourceSyncCommands({pending:true}).filter(c=>(!c.afterCommandId||['blocked','cancelling','cancelled'].includes(this.db.get('sourceSyncBatches',c.batchId)?.status)||['completed','partial_conflict'].includes(this.db.get('sourceSyncCommands',c.afterCommandId)?.result?.status))&&this.online(c.nodeId)&&(!done.has(this.db.get('sourceSyncBatches',c.batchId)?.status)||this.db.get('sourceSyncBatches',c.batchId)?.status==='blocked'||c.detection==='metadata'&&c.action==='cleanup'));
  }
  /** Validate late evidence too; acknowledging delivery must never legitimize a malformed result. */
  validateReceipt(command,result){
    if(!result||typeof result.status!=='string')throw syncError('invalid_receipt');
    if(['blocked','cancelled','waiting_idle','waiting_device','reconciling'].includes(result.status))return;
    if(command.detection==='metadata')return this.metadata.validate(command,result);
    if(command.action==='capture'){
      if(result.status!=='completed')throw syncError('invalid_receipt');
      for(const snapshot of [result.base,result.manifest])validateSourceCapture(snapshot,command);
      if(command.scopeKind!=='directory'&&(result.base.baseCommit!==result.manifest.baseCommit||command.baseCommit&&result.base.baseCommit!==command.baseCommit))throw syncError('git_baseline_mismatch');
    }else{
      if(!Array.isArray(result.files)||!['completed','partial_conflict'].includes(result.status))throw syncError('invalid_receipt');
      const files=new Map(result.files.map(f=>[f.path,f]));if(files.size!==result.files.length||files.size!==command.changes.length)throw syncError('invalid_receipt');
      for(const change of command.changes){const f=files.get(change.path);
        if(!f||!['applied','unchanged','conflict'].includes(f.status)||f.status!=='conflict'&&!entryEqual(f.after,change.after))throw syncError('invalid_receipt');}
    }
  }
  acceptReceipt(nodeId,receipt){return this.db.transaction(()=>{try{
    const command=this.db.get('sourceSyncCommands',receipt.commandId);
    if(!command||command.nodeId!==nodeId)throw syncError('receipt_owner_mismatch');
    const batch=this.db.get('sourceSyncBatches',command.batchId);if(!batch||batch.status==='cancelled'&&!(command.detection==='metadata'&&command.action==='cleanup'))return {discarded:true};
    if(command.result)return command.result;
    if(command.detection==='metadata'&&command.action==='cleanup'){
      this.validateReceipt(command,receipt.result);
      if(receipt.result.status==='completed')this.db.put('sourceSyncCommands',{...command,status:'completed',result:receipt.result,receivedAt:stamp()});
      else this.db.put('sourceSyncCommands',{...command,status:'waiting_idle',lastResult:receipt.result});
      return receipt.result;
    }
    const result=receipt.result;if(!result||typeof result.status!=='string')throw syncError('invalid_receipt');
    if(['waiting_idle','waiting_device','reconciling'].includes(result.status)){this.db.put('sourceSyncCommands',{...command,status:result.status,lastResult:result});return result;}
    if(result.status==='blocked'||result.status==='cancelled'){
      this.db.put('sourceSyncCommands',{...command,result,status:result.status});
      if(batch.status==='cancelling')this.finish(batch);
      else if(command.action==='capture')this.blockPreparation(batch,result.reason||result.status,result.limit?{limit:result.limit}:{});
      else{const blocked=this.db.put('sourceSyncBatches',{...batch,status:'blocked',reason:result.reason||result.status,...(result.limit?{limit:result.limit}:{})});this.finish(blocked);}this.change();return result;
    }
    this.validateReceipt(command,result);
    this.db.put('sourceSyncCommands',{...command,status:result.status,result,receivedAt:stamp()});
    if(batch.status==='cancelling'){this.finish(batch);this.change();return result;}
    if(command.action==='capture'){
      const captures=this.db.listSourceSyncCommands({projectId:batch.projectId,batchId:batch.id,action:'capture'});
      // A blocked batch is terminal: a late capture is recorded but never prepared or distributed.
      if(batch.status!=='blocked'&&captures.every(c=>c.result?.status==='completed'))this.prepare(batch);
    }else this.finish(batch);
    this.change();return result;
    }finally{const c=this.db.get('sourceSyncCommands',receipt.commandId);if(c?.nodeId===nodeId)this.audit.observe(this.db.get('sourceSyncBatches',c.batchId));}
  });}
  /** Failed preflight preserves exact candidate evidence and releases the conflict from its distribution-only state. */
  blockPreparation(batch,reason,details={}){
    this.db.put('sourceSyncBatches',{...batch,status:'blocked',reason,...details});this.audit.observe(this.db.get('sourceSyncBatches',batch.id));
    if(['resolution','evidence'].includes(batch.kind)){
      const conflict=this.db.get('sourceSyncConflicts',batch.conflictIds[0]);
      if(conflict?.generation===batch.conflictGeneration)this.db.put('sourceSyncConflicts',{...conflict,status:'needs_input',reason});
    }
  }
  prepare(batch){
    if(batch.detection==='metadata')return this.metadata.prepare(batch);
    // Count distinct changed content across scopes before advancing any baseline, not one repository at a time.
    if(batch.contentMode==='source-and-outputs'&&!batch.boundedTransfers){
      const offered=new Map();let bytes=0;
      for(const repositoryId of batch.repositoryIds){
        const prior=batch.kind==='preview'?{}:this.db.get('sourceSyncManifests',`${batch.projectId}:${repositoryId}`)?.entries||{};
        for(const c of this.captures(batch,repositoryId))for(const [path,entry] of Object.entries(c.result.manifest.entries)){
          if(!entry||entryEqual(entry,prior[path]||null)||offered.has(entry.hash))continue;
          offered.set(entry.hash,true);bytes+=entry.size;
          if(bytes>SOURCE_SYNC_LIMITS.batchBytes){this.blockPreparation(batch,'batch_too_large',{limit:{kind:'batch',path,maximum:SOURCE_SYNC_LIMITS.batchBytes,actual:bytes}});return;}
        }
      }
    }
    for(const repositoryId of batch.repositoryIds){const captures=this.captures(batch,repositoryId);
      try{for(const c of captures)for(const s of [c.result.base,c.result.manifest])validateSourceCapture(s,c);}catch(e){this.blockPreparation(batch,e.code||'invalid_manifest',e.limit?{limit:e.limit}:{});return;}
      if(batch.scopeKind!=='directory'&&captures[0]?.scopeKind!=='directory'&&new Set(captures.map(c=>`${c.result.base.baseCommit}:${c.result.base.digest}`)).size!==1){this.blockPreparation(batch,'git_baseline_mismatch');return;}}
    if(batch.kind==='preview'){this.db.put('sourceSyncBatches',{...batch,status:'preview_ready',revision:batch.revision+1});return;}
    // A path leaving the eligible scope is not proof of deletion. Fence all repositories before changing canonical state.
    for(const repositoryId of batch.repositoryIds){
      const canonical=this.db.get('sourceSyncManifests',`${batch.projectId}:${repositoryId}`);
      const captures=this.captures(batch,repositoryId),offered=captures.flatMap(c=>Object.entries(c.result.manifest.entries).filter(([,entry])=>entry).map(([path])=>path));
      try{const combined=Object.fromEntries(captures.flatMap(c=>Object.entries(c.result.manifest.entries).filter(([,entry])=>entry)));checkInventorySize(combined,batch.boundedTransfers);manifestDigest(combined,canonical?.scopePolicy);}catch(e){this.blockPreparation(batch,e.code||'invalid_manifest',e.limit?{limit:e.limit}:{});return;}
      for(const capture of captures){
        const ack=this.db.get('sourceSyncDevices',`${batch.projectId}:${repositoryId}:${capture.nodeId}`);
        const known=new Set([...Object.entries(canonical?.entries||{}).filter(([,entry])=>entry).map(([path])=>path),...Object.entries(ack?.entries||{}).filter(([,entry])=>entry).map(([path])=>path),...offered]);
        const excluded=[...known].find(path=>capture.result.manifest.excluded?.some(e=>path===e.path||path.startsWith(e.path.endsWith('/')?e.path:e.path+'/')));
        if(excluded){this.blockPreparation(batch,'source_scope_changed',{excludedPath:excluded});return;}
      }
    }
    if(['resolution','evidence'].includes(batch.kind)){this.prepareResolution(batch);return;}
    const conflicts=new Set(batch.conflictIds);
    const sourceInputs=[];
    for(const repositoryId of batch.repositoryIds){
      const id=`${batch.projectId}:${repositoryId}`,canonical=this.db.get('sourceSyncManifests',id);
      if(!canonical||canonical.generation!==batch.generation)throw syncError('configuration_changed');
      const captures=this.captures(batch,repositoryId).sort((a,b)=>Number(b.nodeId===batch.sourceNodeId)-Number(a.nodeId===batch.sourceNodeId));
      const entries={...canonical.entries},origins={...canonical.origins},blocked=new Set();
      if(batch.scopeKind==='directory')for(const conflict of this.records('sourceSyncConflicts',batch.projectId).filter(c=>c.repositoryId===repositoryId&&c.syncGeneration===batch.generation&&!['resolved','cancelled'].includes(c.status)))blocked.add(conflict.path);
      for(const c of captures){let ack=this.db.get('sourceSyncDevices',`${id}:${c.nodeId}`);if(!ack||ack.generation!==batch.generation)throw syncError('baseline_missing');
        const binding=batch.bindings.find(b=>b.nodeId===c.nodeId&&b.repositoryId===repositoryId);
        if(binding.readOnlyExport){const sourceBase=binding.sourceBaseManifestId?this.db.get('sourceSyncVersions',binding.sourceBaseManifestId):c.result.base;if(!sourceBase)throw syncError('baseline_missing');ack={...ack,entries:sourceBase.entries};}
        for(const path of new Set([...Object.keys(ack.entries),...Object.keys(c.result.manifest.entries),...Object.keys(entries)])){
          if(batch.scopeKind==='directory'&&blocked.has(path))continue;
          const base=getEntry(ack.entries,path),local=getEntry(c.result.manifest.entries,path),incoming=getEntry(entries,path),decision=compareEntry(base,incoming,local);
          if(decision==='apply'){entries[path]=local;origins[path]={nodeId:c.nodeId,commandId:c.id};}
          if(decision==='conflict'){
            const record=this.recordConflict({projectId:batch.projectId,repositoryId,path,syncGeneration:batch.generation,base,
              sides:[this.side(batch.projectId,repositoryId,origins[path]?.nodeId||batch.sourceNodeId,incoming,origins[path]),this.side(batch.projectId,repositoryId,c.nodeId,local,c)],
              receiving:this.receiving({...batch,repositoryIds:[repositoryId]},captures,path),batchId:batch.id});
            const key=record.id;
            conflicts.add(key);blocked.add(path);
          }
        }
      }
      for(const conflict of this.records('sourceSyncConflicts',batch.projectId).filter(c=>c.repositoryId===repositoryId&&c.syncGeneration===batch.generation&&!['resolved','cancelled'].includes(c.status))){blocked.add(conflict.path);conflicts.add(conflict.id);}
      const updated={...canonical,entries,origins,digest:manifestDigest(entries,canonical.scopePolicy),revision:canonical.revision+Number(manifestDigest(entries,canonical.scopePolicy)!==canonical.digest)};
      this.db.put('sourceSyncManifests',updated);
      const versionId=identity(batch.projectId,repositoryId,updated.generation,updated.revision,updated.digest);
      this.db.put('sourceSyncVersions',{...updated,id:versionId});
      sourceInputs.push({repositoryId,baseCommit:updated.baseCommit,generation:updated.generation,manifestRevision:updated.revision,manifestHash:updated.digest,manifestId:versionId});
      for(const c of captures){const changes=[],ack=this.db.get('sourceSyncDevices',`${id}:${c.nodeId}`),ackEntries={...ack.entries};
        if(batch.bindings.some(b=>b.repositoryId===repositoryId&&b.nodeId===c.nodeId&&b.readOnlyExport))continue;
        for(const path of new Set([...Object.keys(entries),...Object.keys(c.result.manifest.entries)])){
          if(blocked.has(path))continue;const before=getEntry(c.result.manifest.entries,path),after=getEntry(entries,path);
          if(entryEqual(before,after)){ackEntries[path]=after;continue;}changes.push({path,before,after});
        }
        this.db.put('sourceSyncDevices',{...ack,entries:ackEntries});
        if(changes.length)this.commandParts(batch,batch.bindings.find(b=>b.repositoryId===repositoryId&&b.nodeId===c.nodeId),'apply',{baseCommit:canonical.baseCommit,changes:batch.scopeKind==='directory'?linkSourceMoves(changes):changes,manifestRevision:updated.revision,manifestHash:updated.digest},'changes',c=>c.after?.size||0);
      }
    }
    const next={...batch,status:'applying',sourceInputs,conflictIds:[...conflicts],revision:batch.revision+1};this.db.put('sourceSyncBatches',next);this.finish(next);
  }
  finish(batch){
    if(batch.detection==='metadata'){if(batch.status==='cancelling'&&!this.db.listSourceSyncCommands({batchId:batch.id,pending:true}).length)this.db.put('sourceSyncBatches',{...batch,status:'cancelled'});else this.metadata.advance(batch);return;}
    if(batch.status==='cancelling'&&this.db.listSourceSyncCommands({projectId:batch.projectId,batchId:batch.id,pending:true}).length)return;
    const commands=this.db.listSourceSyncCommands({projectId:batch.projectId,batchId:batch.id,action:'apply'});if(commands.some(c=>!c.result))return;
    const failed=commands.find(c=>!['completed','partial_conflict'].includes(c.result.status));
    const stale=!this.config(batch.projectId).enabled||this.config(batch.projectId).generation!==batch.generation;
    let conflict=batch.kind==='resolution'?false:batch.conflictIds.length>0;
    const conflictIds=new Set(batch.conflictIds);
    for(const c of commands){const id=`${batch.projectId}:${c.repositoryId}:${c.nodeId}`,ack=this.db.get('sourceSyncDevices',id),entries={...ack.entries};
      for(const f of c.result.files||[]){if(f.status==='conflict'){
        conflict=true;const change=c.changes.find(x=>x.path===f.path),origin=this.db.get('sourceSyncManifests',`${batch.projectId}:${c.repositoryId}`)?.origins?.[f.path]||{},record=this.recordConflict({projectId:batch.projectId,repositoryId:c.repositoryId,path:f.path,syncGeneration:batch.generation,base:change.before,
          sides:[this.side(batch.projectId,c.repositoryId,origin.nodeId||batch.sourceNodeId,change.after,origin),this.side(batch.projectId,c.repositoryId,c.nodeId,f.observed??null,c,f.observed===undefined)],evidencePending:true,batchId:batch.id});
        const key=record.id;
        conflictIds.add(key);continue;
      }entries[f.path]=f.after;}
      this.db.put('sourceSyncDevices',{...ack,entries,revision:['completed','partial_conflict'].includes(c.result.status)?c.manifestRevision:ack.revision,updatedAt:stamp()});
    }
    const blocked=Boolean(failed||stale||batch.status==='blocked');
    this.db.put('sourceSyncBatches',{...batch,conflictIds:[...conflictIds],status:batch.status==='cancelling'?'cancelled':blocked?'blocked':conflict?'partial_conflict':'completed',...(blocked?{sourceInputsReady:false,reason:batch.reason||failed?.result.reason||(stale?'configuration_changed':'target_failed')}:{}),revision:batch.revision+1,updatedAt:stamp()});
    if(batch.kind==='resolution'&&!conflict&&!blocked&&batch.status!=='cancelling'){const c=this.db.get('sourceSyncConflicts',batch.conflictIds[0]);if(c?.generation===batch.conflictGeneration)this.db.put('sourceSyncConflicts',{...c,status:'resolved',resolvedAt:stamp()});}
    if(batch.kind==='resolution'&&(blocked||batch.status==='cancelling')){const c=this.db.get('sourceSyncConflicts',batch.conflictIds[0]);if(c?.generation===batch.conflictGeneration)this.db.put('sourceSyncConflicts',{...c,status:'needs_input',reason:'distribution_incomplete'});}
  }
  prepareResolution(batch){
    const c=this.db.get('sourceSyncConflicts',batch.conflictIds[0]),captures=this.captures(batch,batch.repositoryIds[0]),targets=captures.filter(v=>v.captureRole!=='source');
    if(!c||c.generation!==batch.conflictGeneration){this.db.put('sourceSyncBatches',{...batch,status:'blocked',reason:'conflict_changed'});return;}
    const sides=[];
    for(const side of c.sides){
      if(!side.root||!side.endpointId){this.blockPreparation(batch,'source_endpoint_missing');return;}
      const capture=captures.find(v=>v.endpointId===side.endpointId&&v.root===side.root);
      if(!capture){this.blockPreparation(batch,'source_endpoint_missing');return;}
      sides.push({...side,entry:getEntry(capture.result.manifest.entries,c.path),unknown:false});
    }
    const receiving=[];
    for(const capture of targets){
      const current=getEntry(capture.result.manifest.entries,c.path),prior=c.receiving?.find(r=>r.nodeId===capture.nodeId);
      if(prior&&prior.root!==capture.root){this.blockPreparation(batch,'binding_changed');return;}
      const expected=prior?prior.entry:getEntry(this.db.get('sourceSyncDevices',`${c.projectId}:${c.repositoryId}:${capture.nodeId}`)?.entries||{},c.path);
      const observed=this.side(c.projectId,c.repositoryId,capture.nodeId,current,capture);receiving.push(observed);
      if(!sides.some(s=>s.endpointId?s.endpointId===observed.endpointId:s.nodeId===capture.nodeId)&&!entryEqual(current,expected))sides.push(observed);
    }
    const acceptedCandidate=side=>batch.kind==='resolution'&&c.scopeKind==='directory'&&side.nodeId===batch.proposal.sourceNodeId&&side.root===batch.proposal.sourceRoot&&entryEqual(side.entry,batch.proposal.entry);
    const changed=sides.length!==c.sides.length||sides.some((side,i)=>c.sides[i]?.unknown||!c.sides[i]||!entryEqual(side.entry,c.sides[i].entry)&&!acceptedCandidate(side));
    if(batch.kind==='evidence'||changed){
      if(changed)this.db.put('sourceSyncConflictHistory',{...c,id:`${c.id}:${c.generation}`});
      this.db.put('sourceSyncConflicts',{...c,sides,receiving,evidencePending:false,generation:c.generation+Number(changed),status:'open',proposal:null,attempts:changed?0:c.attempts,staleCount:(c.staleCount||0)+Number(batch.kind==='resolution')});
      this.db.put('sourceSyncBatches',{...batch,status:batch.kind==='evidence'?'evidence_ready':'blocked',reason:changed?'conflict_changed':null});return;
    }
    const canonical=this.db.get('sourceSyncManifests',`${c.projectId}:${c.repositoryId}`),entry=batch.proposal.entry;
    const author=this.db.get('runs',batch.proposal.runId),origin=author?.repositories?.find(r=>r.id===c.repositoryId);
    const entries={...canonical.entries,[c.path]:entry},version={...canonical,entries,origins:{...canonical.origins,[c.path]:origin?{nodeId:author.nodeId,root:origin.localRoot,sourceRunId:author.id}:{nodeId:batch.sourceNodeId}},digest:manifestDigest(entries,canonical.scopePolicy),revision:canonical.revision+1};
    this.db.put('sourceSyncManifests',version);const id=identity(batch.id,version.digest);this.db.put('sourceSyncVersions',{...version,id});
    const sourceInputs=[{repositoryId:c.repositoryId,baseCommit:version.baseCommit,generation:version.generation,manifestRevision:version.revision,manifestHash:version.digest,manifestId:id}];
    for(const capture of targets){const before=getEntry(capture.result.manifest.entries,c.path);if(!entryEqual(before,entry))this.command(batch,batch.bindings.find(b=>b.endpointId===capture.endpointId||!b.endpointId&&b.nodeId===capture.nodeId),'apply',{baseCommit:version.baseCommit,changes:[{path:c.path,before,after:entry}],manifestRevision:version.revision,manifestHash:version.digest});
      else{const ack=this.db.get('sourceSyncDevices',`${c.projectId}:${c.repositoryId}:${capture.nodeId}`);this.db.put('sourceSyncDevices',{...ack,entries:{...ack.entries,[c.path]:entry},revision:version.revision});}}
    this.db.put('sourceSyncConflicts',{...c,status:'resolved_pending_sync',resolutionBatchId:batch.id});
    const sourceInputsReady=targets.every(capture=>[...new Set([...Object.keys(entries),...Object.keys(capture.result.manifest.entries)])].every(path=>path===c.path||entryEqual(getEntry(entries,path),getEntry(capture.result.manifest.entries,path))));
    const next={...batch,status:'applying',sourceInputs,sourceInputsReady};this.db.put('sourceSyncBatches',next);this.finish(next);
  }
  cancel(projectId,id,revision){const b=this.db.get('sourceSyncBatches',id);if(b?.projectId!==projectId||b.revision!==revision)throw syncError('batch_changed');
    const pending=this.db.listSourceSyncCommands({projectId,batchId:id,pending:true}).length>0;
    const next=this.db.put('sourceSyncBatches',{...b,status:pending?'cancelling':'cancelled',revision:b.revision+1});this.audit.observe(next);this.change();return next;}
  status(projectId){const config=this.config(projectId);return {config,watchers:this.records('sourceSyncWatchStates',projectId),batches:this.records('sourceSyncBatches',projectId).slice(-50).map(({fingerprint,bindings,metadataOperations,...b})=>({...b,...(b.pendingMetadata?{pendingMetadataCount:b.pendingMetadata.length,pendingMetadata:b.pendingMetadata.slice(0,20)}:{})})),conflicts:this.records('sourceSyncConflicts',projectId).slice(-100)};}
}
