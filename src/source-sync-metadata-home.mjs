import {contentHash,syncError,validateEntry,entryEqual,manifestDigest,SOURCE_SYNC_LIMITS} from './source-sync-manifest.mjs';
import {absent,contentEqual,decideMetadata,identityEqual,metadataDigest,validateMetadata,validateMetadataCapture} from './source-sync-metadata.mjs';
const stamp=()=>new Date().toISOString();
const key=(b,r,p)=>contentHash(JSON.stringify([b.projectId,r,b.generation,p]));
/** Metadata records are separate from hash manifests. Existing batches, receipts and reservations remain authoritative. */
export class SourceSyncMetadata {
  constructor(sync){this.sync=sync;this.db=sync.db;}
  commands(b,action){return this.db.listSourceSyncCommands({batchId:b.id,...(action?{action}:{})});}
  configure(b){for(const repositoryId of b.repositoryIds){
    const id=`${b.projectId}:${repositoryId}`,old=this.db.get('sourceSyncManifests',id);
    // A compatibility manifest supplies conflict scope information, never file metadata masquerading as hash entries.
    this.db.put('sourceSyncManifests',{id,projectId:b.projectId,repositoryId,generation:b.generation,revision:0,baseCommit:null,scopeKind:'directory',scopePolicy:b.bindings.find(x=>x.repositoryId===repositoryId).scopePolicy,entries:{},digest:manifestDigest({}),origins:{}});
    const captures=this.sync.captures(b,repositoryId);
    for(const c of captures)this.db.put('sourceSyncMetadataScopes',{id:`${b.projectId}:${repositoryId}:${b.generation}:${c.nodeId}`,projectId:b.projectId,repositoryId,generation:b.generation,nodeId:c.nodeId,rootIdentity:c.result.manifest.rootIdentity});
    for(const path of new Set([...this.db.metadataBaselines(b.projectId,repositoryId).map(x=>x.path),...Object.keys(old?.entries||{}),...Object.keys(captures[0].result.manifest.entries).filter(p=>captures[1].result.manifest.entries[p])]))this.db.put('sourceSyncMetadataBaselines',{id:key(b,repositoryId,path),projectId:b.projectId,repositoryId,generation:b.generation,path,pending:true,revision:0});
  }}
  validate(c,result){
    if(c.action==='capture'){if(result.status!=='completed')throw syncError('invalid_receipt');for(const s of [result.base,result.manifest])validateMetadataCapture(s,c);return;}
    if(!Array.isArray(result.files)||!['completed','partial_conflict'].includes(result.status))throw syncError('invalid_receipt');
    const expected=['read','stage'].includes(c.action)?c.paths:c.action==='apply'?c.changes:[];
    if(result.files.length!==expected.length||new Set(result.files.map(f=>f.path)).size!==result.files.length)throw syncError('invalid_receipt');
    for(const item of expected){const f=result.files.find(f=>f.path===item.path);if(!f)throw syncError('invalid_receipt');
      if(['read','stage'].includes(c.action)){validateMetadata(f.observed);validateEntry(f.entry);if(!identityEqual(f.observed,item.expected)||c.action==='stage'&&!entryEqual(f.entry,item.entry)||Boolean(f.entry)!==f.observed.exists||f.entry&&f.entry.size!==f.observed.size)throw syncError('invalid_receipt');}
      else if(f.status!=='conflict'){validateMetadata(f.observed);if(f.status!=='applied'||!entryEqual(f.after,item.after)||Boolean(item.after)!==f.observed.exists||item.after&&item.after.size!==f.observed.size)throw syncError('invalid_receipt');}
    }
  }
  baseline(b,op,endpoints){const id=key(b,op.repositoryId,op.path),old=this.db.get('sourceSyncMetadataBaselines',id);this.db.put('sourceSyncMetadataBaselines',{id,projectId:b.projectId,repositoryId:op.repositoryId,generation:b.generation,bindingRevision:b.configRevision,path:op.path,endpoints,revision:(old?.revision||0)+1,lastOperationId:contentHash(JSON.stringify([b.id,op.repositoryId,op.path])),acknowledgedAt:stamp()});}
  prepare(b){
    if(b.kind==='preview'){this.db.put('sourceSyncBatches',{...b,status:'preview_ready'});return;}
    for(const c of this.commands(b,'capture')){const scope=this.db.get('sourceSyncMetadataScopes',`${b.projectId}:${c.repositoryId}:${b.generation}:${c.nodeId}`);if(!scope||scope.rootIdentity!==c.result.manifest.rootIdentity){this.sync.blockPreparation(b,'binding_changed');return;}}
    if(['resolution','evidence'].includes(b.kind)){this.prepareResolution(b);return;}
    const operations=[],pending=[];const conflictIds=new Set(b.conflictIds);
    for(const repositoryId of b.repositoryIds){const captures=this.sync.captures(b,repositoryId),[a,bnode]=b.nodeIds;
      const snapshots=Object.fromEntries(captures.map(c=>[c.nodeId,c.result.manifest]));
      try{metadataDigest({...snapshots[a].entries,...snapshots[bnode].entries},captures[0].scopePolicy);}catch(e){this.sync.blockPreparation(b,e.code||'invalid_manifest');return;}
      const baselines=this.db.metadataBaselines(b.projectId,repositoryId,b.generation),baselineMap=new Map(baselines.map(x=>[x.path,x]));
      const conflicts=this.db.listProject('sourceSyncConflicts',b.projectId).filter(c=>c.repositoryId===repositoryId&&c.syncGeneration===b.generation&&!['resolved','cancelled'].includes(c.status));
      for(const path of new Set([...baselines.map(v=>v.path),...Object.keys(snapshots[a].entries),...Object.keys(snapshots[bnode].entries)])){
        const op={repositoryId,path,observed:{[a]:snapshots[a].entries[path]||absent(),[bnode]:snapshots[bnode].entries[path]||absent()}};
        // Exclusion (including oversize and unavailable traversal) is never evidence of deletion.
        if(captures.some(c=>c.result.manifest.excluded.some(e=>path===e.path||path.startsWith(e.path.replace(/\/$/,'')+'/')))){pending.push({repositoryId,path,reason:'source_scope_changed'});continue;}
        const conflict=conflicts.find(c=>c.path===path);if(conflict){conflictIds.add(conflict.id);continue;}
        const base=baselineMap.get(path),decision=base?.pending?'baseline_required':decideMetadata(base?{a:base.endpoints[a],b:base.endpoints[bnode]}:null,{a:op.observed[a],b:op.observed[bnode]});
        if(decision==='baseline_required'){pending.push({repositoryId,path,reason:'metadata_baseline_required'});if(!base)this.db.put('sourceSyncMetadataBaselines',{id:key(b,repositoryId,path),projectId:b.projectId,repositoryId,generation:b.generation,path,pending:true,revision:0});continue;}
        if(decision==='unchanged')continue;
        if(decision==='absent'){this.baseline(b,op,op.observed);continue;}
        op.decision=decision;op.source=decision==='a'?a:decision==='b'?bnode:null;op.target=op.source===a?bnode:a;operations.push(op);
      }
    }
    const readBytes=operations.reduce((n,o)=>n+(o.source?o.observed[o.source].size||0:Object.values(o.observed).reduce((sum,m)=>sum+(m.size||0),0)),0);if(readBytes>SOURCE_SYNC_LIMITS.batchBytes){this.sync.blockPreparation(b,'batch_too_large');return;}
    const next={...b,metadataOperations:operations,pendingMetadata:pending,conflictIds:[...conflictIds],status:'reading'};this.db.put('sourceSyncBatches',next);
    for(const binding of b.bindings){const paths=operations.filter(o=>o.repositoryId===binding.repositoryId&&(o.source?o.source===binding.nodeId:true)&&o.observed[binding.nodeId].exists).map(o=>({path:o.path,expected:o.observed[binding.nodeId],compare:!o.source}));if(paths.length)this.sync.command(b,binding,'read',{paths});}
    this.advance(next);
  }
  prepareResolution(b){
    const c=this.db.get('sourceSyncConflicts',b.conflictIds[0]);if(!c||c.generation!==b.conflictGeneration){this.sync.blockPreparation(b,'conflict_changed');return;}
    const captures=this.sync.captures(b,c.repositoryId),observed=Object.fromEntries(captures.map(x=>[x.nodeId,x.result.manifest.entries[c.path]||absent()]));
    if(captures.some(x=>x.result.manifest.excluded.some(e=>c.path===e.path||c.path.startsWith(e.path.replace(/\/$/,'')+'/')))){this.sync.blockPreparation(b,'source_scope_changed');return;}
    const op={repositoryId:c.repositoryId,path:c.path,observed,decision:'resolution'};
    const next=this.db.put('sourceSyncBatches',{...b,status:'reading',metadataOperations:[op],pendingMetadata:[]});
    for(const binding of b.bindings)if(observed[binding.nodeId]?.exists)this.sync.command(b,binding,'read',{paths:[{path:c.path,expected:observed[binding.nodeId],compare:true}]});
    this.advance(next);
  }
  advance(b){
    if(['blocked','cancelled','cancelling'].includes(b.status))return;
    if(['reading','staging'].includes(b.status)){
      const reads=this.commands(b,'read');if(reads.some(c=>!c.result))return;
      if(reads.some(c=>c.result.status!=='completed'))return;
      const read=(o,nodeId)=>reads.find(c=>c.repositoryId===o.repositoryId&&c.nodeId===nodeId)?.result.files.find(f=>f.path===o.path)?.entry||null;
      if(b.status==='reading'){
        let staged=false;
        for(const binding of b.bindings){const paths=b.metadataOperations.filter(o=>o.repositoryId===binding.repositoryId&&!o.source&&o.observed[binding.nodeId].exists&&(o.decision==='resolution'||!contentEqual(read(o,b.nodeIds[0]),read(o,b.nodeIds[1])))).map(o=>({path:o.path,expected:o.observed[binding.nodeId],entry:read(o,binding.nodeId)}));
          if(paths.length){const original=reads.find(c=>c.repositoryId===binding.repositoryId&&c.nodeId===binding.nodeId);this.sync.command(b,binding,'stage',{paths,readCommandId:original.id});staged=true;}
        }
        if(staged){this.db.put('sourceSyncBatches',{...b,status:'staging'});return;}
      }else if(this.commands(b,'stage').some(c=>c.result?.status!=='completed'))return;
      const conflicts=new Set(b.conflictIds),changes=new Map();
      for(const op of b.metadataOperations){
        if(op.decision==='resolution'){
          const c=this.db.get('sourceSyncConflicts',b.conflictIds[0]);
          const sides=b.nodeIds.map(n=>this.sync.side(b.projectId,op.repositoryId,n,read(op,n),b.bindings.find(x=>x.nodeId===n&&x.repositoryId===op.repositoryId)));
          const candidate=s=>b.kind==='resolution'&&s.nodeId===b.proposal.sourceNodeId&&s.root===b.proposal.sourceRoot&&entryEqual(s.entry,b.proposal.entry);
          const changed=sides.some(s=>!candidate(s)&&!entryEqual(s.entry,c.sides.find(old=>old.nodeId===s.nodeId&&old.root===s.root)?.entry));
          if(changed||b.kind==='evidence'){
            const updated=this.sync.recordConflict({...c,sides,receiving:sides,batchId:b.id});this.db.put('sourceSyncConflicts',{...updated,status:'needs_input',reason:'conflict_changed'});this.db.put('sourceSyncBatches',{...b,status:b.kind==='evidence'?'evidence_ready':'blocked',reason:'conflict_changed'});return;
          }
          if(!sides.some(candidate)){this.sync.blockPreparation(b,'candidate_changed');return;}
          for(const side of sides)if(!entryEqual(side.entry,b.proposal.entry))changes.set(`${op.repositoryId}:${side.nodeId}`,[{path:op.path,before:op.observed[side.nodeId],after:b.proposal.entry}]);
          continue;
        }
        if(!op.source){const [a,other]=b.nodeIds,left=read(op,a),right=read(op,other);
          if(contentEqual(left,right)){this.baseline(b,op,op.observed);continue;}
          const sides=b.nodeIds.map(n=>this.sync.side(b.projectId,op.repositoryId,n,read(op,n),b.bindings.find(x=>x.nodeId===n&&x.repositoryId===op.repositoryId)));
          const c=this.sync.recordConflict({projectId:b.projectId,repositoryId:op.repositoryId,path:op.path,syncGeneration:b.generation,base:null,sides,receiving:sides,batchId:b.id,detection:'metadata'});
          this.db.put('sourceSyncConflicts',{...c,status:'needs_input',reason:'metadata_conflict'});conflicts.add(c.id);continue;
        }
        const group=`${op.repositoryId}:${op.target}`;if(!changes.has(group))changes.set(group,[]);changes.get(group).push({path:op.path,before:op.observed[op.target],after:read(op,op.source)});
      }
      for(const binding of b.bindings){const group=changes.get(`${binding.repositoryId}:${binding.nodeId}`);if(group?.length){if(group.reduce((n,c)=>n+(c.after?.size||0),0)>SOURCE_SYNC_LIMITS.batchBytes){this.sync.blockPreparation(b,'batch_too_large');return;}this.sync.command(b,binding,'apply',{changes:group});}}
      b=this.db.put('sourceSyncBatches',{...b,status:'applying',conflictIds:[...conflicts]});
    }
    if(b.status==='applying'){
      const applies=this.commands(b,'apply');if(applies.some(c=>!c.result))return;
      const incomplete=[];
      for(const op of b.metadataOperations){
        const results=applies.filter(c=>c.repositoryId===op.repositoryId).flatMap(c=>(c.result.files||[]).filter(f=>f.path===op.path).map(f=>({...f,nodeId:c.nodeId})));
        if(results.some(f=>f.status==='conflict')){incomplete.push({repositoryId:op.repositoryId,path:op.path,reason:'target_changed'});continue;}
        if(results.length||op.decision==='resolution')this.baseline(b,op,{...op.observed,...Object.fromEntries(results.map(f=>[f.nodeId,f.observed]))});
      }
      if(b.kind==='resolution'){
        const c=this.db.get('sourceSyncConflicts',b.conflictIds[0]);if(c?.generation===b.conflictGeneration)this.db.put('sourceSyncConflicts',{...c,status:incomplete.length?'needs_input':'resolved',...(incomplete.length?{reason:'distribution_incomplete'}:{resolvedAt:stamp()})});
        if(!incomplete.length)b={...b,conflictIds:[]};
      }
      b=this.db.put('sourceSyncBatches',{...b,status:'cleaning',pendingMetadata:[...b.pendingMetadata,...incomplete]});
      for(const binding of b.bindings)this.sync.command(b,binding,'cleanup',{journalCommands:applies.filter(c=>c.nodeId===binding.nodeId&&c.repositoryId===binding.repositoryId).map(c=>c.id)});
    }
    // Home deletes only this batch's transient storage after every receiver's confirmation and private cleanup ACK.
  }
}
