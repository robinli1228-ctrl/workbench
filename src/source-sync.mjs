import {randomBytes} from 'node:crypto';
import {SOURCE_SYNC_CAPTURE_POLICY,contentHash,manifestDigest,compareEntry,entryEqual,syncError} from './source-sync-manifest.mjs';

const stamp=()=>new Date().toISOString(),done=new Set(['completed','partial_conflict','blocked','cancelled','preview_ready','evidence_ready']);
const getEntry=(entries,path)=>Object.hasOwn(entries,path)?entries[path]:null;
const identity=(...parts)=>contentHash(JSON.stringify(parts));

/** Home owns metadata only; no filesystem or model operation runs inside its SQLite transactions. */
export class SourceSync {
  constructor({db,online=()=>false,change=()=>{}}){Object.assign(this,{db,online,change});}
  config(projectId){return this.db.get('sourceSyncConfigs',projectId)||{id:projectId,projectId,enabled:false,revision:0,generation:0};}
  /** A source is a workspace endpoint, not just a device; isolated outputs remain distinct from registered receivers. */
  side(projectId,repositoryId,nodeId,entry,origin={},unknown=false){
    const command=origin.commandId?this.db.get('sourceSyncCommands',origin.commandId)||origin:origin;
    const sourceRunId=command.sourceRunId||null,root=command.root||this.db.get('repositoryWorkspaces',`${repositoryId}:${nodeId}`)?.localRoot;
    return {nodeId,entry,root,sourceRunId,endpointId:identity(repositoryId,nodeId,root,sourceRunId),originCommandId:command.id||origin.commandId||null,...(unknown?{unknown:true}:{})};
  }
  /** Freeze each actual receiving folder from its capture or latest acknowledged physical version. */
  receiving(batch,captures,path){
    return batch.nodeIds.map(nodeId=>{
      const binding=this.db.get('repositoryWorkspaces',`${batch.repositoryIds[0]}:${nodeId}`);
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
    if(prior)this.db.put('sourceSyncConflictHistory',{...prior,id:`${id}:${prior.generation}`});
    return this.db.put('sourceSyncConflicts',{...prior,...input,id,generation:(prior?.generation||0)+1,status:'open',proposal:null,createdAt:stamp()});
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
      nodeIds,targetNodeIds,sourceInputNodeIds:targetNodeIds,repositoryIds:[conflict.repositoryId],bindings,conflictIds:[conflict.id],conflictGeneration:conflict.generation,proposal,createdAt:stamp()});
  }
  records(kind,projectId){return this.db.listProject?this.db.listProject(kind,projectId):this.db.list(kind).filter(x=>x.projectId===projectId);}
  bindings(projectId,repositoryIds,nodeIds){
    if(!this.db.get('projects',projectId))throw syncError('project_missing');
    if(!Array.isArray(repositoryIds)||!repositoryIds.length||repositoryIds.length>30||new Set(repositoryIds).size!==repositoryIds.length
      ||!Array.isArray(nodeIds)||nodeIds.length<2||nodeIds.length>16||new Set(nodeIds).size!==nodeIds.length)throw syncError('invalid_scope');
    return repositoryIds.flatMap(repositoryId=>nodeIds.map(nodeId=>{
      const repo=this.db.get('repositories',repositoryId),binding=this.db.get('repositoryWorkspaces',`${repositoryId}:${nodeId}`),worker=this.db.get('workers',nodeId);
      if(repo?.projectId!==projectId||binding?.projectId!==projectId||!binding.localRoot)throw syncError('binding_missing');
      if(worker?.capabilities?.sourceSync!==1)throw syncError('worker_unsupported',nodeId);
      return {repositoryId,nodeId,root:binding.localRoot,repoUrl:repo.repoUrl};
    }));
  }
  /** Preview scans without touching project files; activation references this exact reviewed scope. */
  preview(projectId,input){return this.createBatch(projectId,input,'preview');}
  configure(projectId,input){return this.db.transaction(()=>{
    const old=this.config(projectId);if(input.revision!==old.revision||typeof input.enabled!=='boolean')throw syncError('configuration_changed');
    if(this.records('sourceSyncBatches',projectId).some(b=>b.kind!=='preview'&&!done.has(b.status)))throw syncError('sync_busy');
    if(this.records('sourceSyncCommands',projectId).some(c=>!c.result))throw syncError('sync_busy');
    if(!input.enabled){
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
    const bindings=this.bindings(projectId,batch.repositoryIds,batch.nodeIds);
    if(identity(bindings)!==identity(batch.bindings))throw syncError('binding_changed');
    const config=this.db.put('sourceSyncConfigs',{id:projectId,projectId,enabled:true,revision:old.revision+1,generation:batch.generation,repositoryIds:batch.repositoryIds,nodeIds:batch.nodeIds,bindings,updatedAt:stamp()});
    for(const repositoryId of batch.repositoryIds){const captures=this.captures(batch,repositoryId),base=captures[0].result.base;
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
    const config=this.config(projectId),bindings=this.bindings(projectId,input.repositoryIds,input.nodeIds);
    if(actor.kind==='agent'){
      const run=this.db.get('runs',actor.runId);if(run?.projectId!==projectId||run.nodeId!==input.sourceNodeId||run.roleId!==actor.roleId||['succeeded','failed','interrupted'].includes(run.status))throw syncError('source_run_changed');
      for(const binding of bindings.filter(b=>b.nodeId===input.sourceNodeId)){const repo=run.repositories?.find(r=>r.id===binding.repositoryId);if(!repo?.localRoot)throw syncError('binding_missing');
        if(repo.localRoot!==binding.root){binding.root=repo.localRoot;binding.readOnlyExport=true;binding.sourceRunId=run.id;binding.sourceBaseManifestId=run.sourceInputs?.find(v=>v.repositoryId===repo.id)?.manifestId||null;}}
    }
    const fingerprint=identity({kind,input,actor}),id=identity(projectId,kind,input.requestId),old=this.db.get('sourceSyncBatches',id);
    if(old){if(old.fingerprint!==fingerprint)throw syncError('request_conflict');return old;}
    const generation=kind==='preview'?config.generation+1:config.generation;
    const batch={id,projectId,kind,fingerprint,generation,configRevision:config.revision,revision:1,status:'queued',sourceNodeId:input.sourceNodeId||input.nodeIds[0],
      nodeIds:input.nodeIds,repositoryIds:input.repositoryIds,bindings,actor,createdAt:stamp(),conflictIds:[]};
    batch.sourceInputNodeIds=input.nodeIds.filter(nodeId=>!bindings.some(b=>b.nodeId===nodeId&&b.readOnlyExport));
    this.db.put('sourceSyncBatches',batch);this.change();return batch;
  });}
  command(batch,binding,action,extra={}){
    const id=identity(batch.id,binding.repositoryId,binding.nodeId,action,...(binding.endpointId?[binding.endpointId]:[])),prior=this.db.get('sourceSyncCommands',id);if(prior)return prior;
    return this.db.put('sourceSyncCommands',{id,projectId:batch.projectId,batchId:batch.id,repositoryId:binding.repositoryId,nodeId:binding.nodeId,
      generation:batch.generation,action,root:binding.root,repoUrl:binding.repoUrl,...(binding.sourceRunId?{sourceRunId:binding.sourceRunId}:{}),...(binding.endpointId?{endpointId:binding.endpointId,captureRole:binding.captureRole}:{}),secret:randomBytes(32).toString('hex'),status:'queued',...extra});
  }
  captures(batch,repositoryId){return this.records('sourceSyncCommands',batch.projectId).filter(c=>c.batchId===batch.id&&c.repositoryId===repositoryId&&c.action==='capture');}
  /** Returns persistent commands; connection code supplies resend timing and node authentication. */
  schedule(){
    if(this.db.get('settings','main')?.paused)return [];
    const batches=this.db.list('sourceSyncBatches');
    for(const batch of batches.filter(b=>b.status==='queued')){
      if(batches.some(b=>b.id!==batch.id&&b.projectId===batch.projectId&&!done.has(b.status)&&b.status!=='queued'))continue;
      if(this.records('sourceSyncCommands',batch.projectId).some(c=>c.batchId!==batch.id&&!c.result))continue;
      if(batch.kind!=='preview'&&(!this.config(batch.projectId).enabled||this.config(batch.projectId).generation!==batch.generation)){
        this.db.put('sourceSyncBatches',{...batch,status:'blocked',reason:'configuration_changed'});continue;
      }
      for(const binding of batch.bindings){const canonical=this.db.get('sourceSyncManifests',`${batch.projectId}:${binding.repositoryId}`);
        this.command(batch,binding,'capture',{baseCommit:batch.kind==='preview'?null:canonical?.baseCommit});}
      this.db.put('sourceSyncBatches',{...batch,status:'capturing'});batch.status='capturing';
    }
    return this.db.list('sourceSyncCommands').filter(c=>!c.result&&this.online(c.nodeId)&&(!done.has(this.db.get('sourceSyncBatches',c.batchId)?.status)||this.db.get('sourceSyncBatches',c.batchId)?.status==='blocked'));
  }
  acceptReceipt(nodeId,receipt){return this.db.transaction(()=>{
    const command=this.db.get('sourceSyncCommands',receipt.commandId);
    if(!command||command.nodeId!==nodeId)throw syncError('receipt_owner_mismatch');
    const batch=this.db.get('sourceSyncBatches',command.batchId);if(!batch||batch.status==='cancelled')return {discarded:true};
    if(command.result)return command.result;
    const result=receipt.result;if(!result||typeof result.status!=='string')throw syncError('invalid_receipt');
    if(['waiting_idle','waiting_device','reconciling'].includes(result.status)){this.db.put('sourceSyncCommands',{...command,status:result.status,lastResult:result});return result;}
    if(result.status==='blocked'||result.status==='cancelled'){
      this.db.put('sourceSyncCommands',{...command,result,status:result.status});
      if(batch.status==='cancelling')this.finish(batch);
      else if(command.action==='capture')this.blockPreparation(batch,result.reason||result.status);
      else{const blocked=this.db.put('sourceSyncBatches',{...batch,status:'blocked',reason:result.reason||result.status});this.finish(blocked);}this.change();return result;
    }
    if(command.action==='capture'){
      if([result.base,result.manifest].some(s=>s?.capturePolicy!==SOURCE_SYNC_CAPTURE_POLICY))throw syncError('snapshot_policy_unsupported');
      for(const s of [result.base,result.manifest])if(!s||!/^[a-f0-9]{40,64}$/.test(s.baseCommit||'')||manifestDigest(s.entries)!==s.digest)throw syncError('invalid_manifest');
      if(result.base.baseCommit!==result.manifest.baseCommit||command.baseCommit&&result.base.baseCommit!==command.baseCommit)throw syncError('git_baseline_mismatch');
    }else{
      if(!Array.isArray(result.files)||!['completed','partial_conflict'].includes(result.status))throw syncError('invalid_receipt');
      for(const change of command.changes){const f=result.files.find(f=>f.path===change.path);
        if(!f||!['applied','unchanged','conflict'].includes(f.status)||f.status!=='conflict'&&!entryEqual(f.after,change.after))throw syncError('invalid_receipt');}
    }
    this.db.put('sourceSyncCommands',{...command,status:result.status,result,receivedAt:stamp()});
    if(batch.status==='cancelling'){this.finish(batch);this.change();return result;}
    if(command.action==='capture'){
      const captures=this.records('sourceSyncCommands',batch.projectId).filter(c=>c.batchId===batch.id&&c.action==='capture');
      if(captures.every(c=>c.result?.status==='completed'))this.prepare(batch);
    }else this.finish(batch);
    this.change();return result;
  });}
  /** Failed preflight preserves exact candidate evidence and releases the conflict from its distribution-only state. */
  blockPreparation(batch,reason,details={}){
    this.db.put('sourceSyncBatches',{...batch,status:'blocked',reason,...details});
    if(['resolution','evidence'].includes(batch.kind)){
      const conflict=this.db.get('sourceSyncConflicts',batch.conflictIds[0]);
      if(conflict?.generation===batch.conflictGeneration)this.db.put('sourceSyncConflicts',{...conflict,status:'needs_input',reason});
    }
  }
  prepare(batch){
    for(const repositoryId of batch.repositoryIds){const captures=this.captures(batch,repositoryId);
      if(captures.some(c=>[c.result.base,c.result.manifest].some(s=>s?.capturePolicy!==SOURCE_SYNC_CAPTURE_POLICY))){this.blockPreparation(batch,'snapshot_policy_unsupported');return;}
      if(new Set(captures.map(c=>`${c.result.base.baseCommit}:${c.result.base.digest}`)).size!==1){this.blockPreparation(batch,'git_baseline_mismatch');return;}}
    if(batch.kind==='preview'){this.db.put('sourceSyncBatches',{...batch,status:'preview_ready',revision:batch.revision+1});return;}
    // A path leaving the eligible scope is not proof of deletion. Fence all repositories before changing canonical state.
    for(const repositoryId of batch.repositoryIds){
      const canonical=this.db.get('sourceSyncManifests',`${batch.projectId}:${repositoryId}`);
      const captures=this.captures(batch,repositoryId),offered=captures.flatMap(c=>Object.entries(c.result.manifest.entries).filter(([,entry])=>entry).map(([path])=>path));
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
      for(const c of captures){let ack=this.db.get('sourceSyncDevices',`${id}:${c.nodeId}`);if(!ack||ack.generation!==batch.generation)throw syncError('baseline_missing');
        const binding=batch.bindings.find(b=>b.nodeId===c.nodeId&&b.repositoryId===repositoryId);
        if(binding.readOnlyExport){const sourceBase=binding.sourceBaseManifestId?this.db.get('sourceSyncVersions',binding.sourceBaseManifestId):c.result.base;if(!sourceBase)throw syncError('baseline_missing');ack={...ack,entries:sourceBase.entries};}
        for(const path of new Set([...Object.keys(ack.entries),...Object.keys(c.result.manifest.entries),...Object.keys(entries)])){
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
      const updated={...canonical,entries,origins,digest:manifestDigest(entries),revision:canonical.revision+Number(manifestDigest(entries)!==canonical.digest)};
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
        if(changes.length)this.command(batch,batch.bindings.find(b=>b.repositoryId===repositoryId&&b.nodeId===c.nodeId),'apply',{baseCommit:canonical.baseCommit,changes,manifestRevision:updated.revision,manifestHash:updated.digest});
      }
    }
    const next={...batch,status:'applying',sourceInputs,conflictIds:[...conflicts],revision:batch.revision+1};this.db.put('sourceSyncBatches',next);this.finish(next);
  }
  finish(batch){
    if(batch.status==='cancelling'&&this.records('sourceSyncCommands',batch.projectId).some(c=>c.batchId===batch.id&&!c.result))return;
    const commands=this.records('sourceSyncCommands',batch.projectId).filter(c=>c.batchId===batch.id&&c.action==='apply');if(commands.some(c=>!c.result))return;
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
    const changed=sides.length!==c.sides.length||sides.some((side,i)=>c.sides[i]?.unknown||!c.sides[i]||!entryEqual(side.entry,c.sides[i].entry));
    if(batch.kind==='evidence'||changed){
      if(changed)this.db.put('sourceSyncConflictHistory',{...c,id:`${c.id}:${c.generation}`});
      this.db.put('sourceSyncConflicts',{...c,sides,receiving,evidencePending:false,generation:c.generation+Number(changed),status:'open',proposal:null,attempts:changed?0:c.attempts,staleCount:(c.staleCount||0)+Number(batch.kind==='resolution')});
      this.db.put('sourceSyncBatches',{...batch,status:batch.kind==='evidence'?'evidence_ready':'blocked',reason:changed?'conflict_changed':null});return;
    }
    const canonical=this.db.get('sourceSyncManifests',`${c.projectId}:${c.repositoryId}`),entry=batch.proposal.entry;
    const author=this.db.get('runs',batch.proposal.runId),origin=author?.repositories?.find(r=>r.id===c.repositoryId);
    const entries={...canonical.entries,[c.path]:entry},version={...canonical,entries,origins:{...canonical.origins,[c.path]:origin?{nodeId:author.nodeId,root:origin.localRoot,sourceRunId:author.id}:{nodeId:batch.sourceNodeId}},digest:manifestDigest(entries),revision:canonical.revision+1};
    this.db.put('sourceSyncManifests',version);const id=identity(batch.id,version.digest);this.db.put('sourceSyncVersions',{...version,id});
    const sourceInputs=[{repositoryId:c.repositoryId,baseCommit:version.baseCommit,generation:version.generation,manifestRevision:version.revision,manifestHash:version.digest,manifestId:id}];
    for(const capture of targets){const before=getEntry(capture.result.manifest.entries,c.path);if(!entryEqual(before,entry))this.command(batch,batch.bindings.find(b=>b.endpointId===capture.endpointId||!b.endpointId&&b.nodeId===capture.nodeId),'apply',{baseCommit:version.baseCommit,changes:[{path:c.path,before,after:entry}],manifestRevision:version.revision,manifestHash:version.digest});
      else{const ack=this.db.get('sourceSyncDevices',`${c.projectId}:${c.repositoryId}:${capture.nodeId}`);this.db.put('sourceSyncDevices',{...ack,entries:{...ack.entries,[c.path]:entry},revision:version.revision});}}
    this.db.put('sourceSyncConflicts',{...c,status:'resolved_pending_sync',resolutionBatchId:batch.id});
    const sourceInputsReady=targets.every(capture=>[...new Set([...Object.keys(entries),...Object.keys(capture.result.manifest.entries)])].every(path=>path===c.path||entryEqual(getEntry(entries,path),getEntry(capture.result.manifest.entries,path))));
    const next={...batch,status:'applying',sourceInputs,sourceInputsReady};this.db.put('sourceSyncBatches',next);this.finish(next);
  }
  cancel(projectId,id,revision){const b=this.db.get('sourceSyncBatches',id);if(b?.projectId!==projectId||b.revision!==revision)throw syncError('batch_changed');
    const pending=this.records('sourceSyncCommands',projectId).some(c=>c.batchId===id&&!c.result);
    const next=this.db.put('sourceSyncBatches',{...b,status:pending?'cancelling':'cancelled',revision:b.revision+1});this.change();return next;}
  status(projectId){const config=this.config(projectId);return {config,batches:this.records('sourceSyncBatches',projectId).slice(-50).map(({fingerprint,bindings,...b})=>b),conflicts:this.records('sourceSyncConflicts',projectId).slice(-100)};}
}
