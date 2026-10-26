import {contentHash,syncError,validateSourcePath,SOURCE_SYNC_LIMITS} from './source-sync-manifest.mjs';
const now=()=>new Date().toISOString();
const terminal=new Set(['completed','partial_conflict','blocked','cancelled']);
/** Human-authorized initialization uses the ordinary batch/receipt pipeline, one bounded batch per job. */
export class SourceSyncInitialization {
  constructor(home){this.home=home;this.db=home.db;this.sync=home.sync;}
  config(projectId,repositoryId){const c=this.sync.config(projectId);if(!c.enabled||c.detection!=='metadata'||!c.repositoryIds.includes(repositoryId))throw syncError('invalid_scope');return c;}
  pending(projectId,repositoryId,{after='',limit=50}={}){
    const c=this.config(projectId,repositoryId);limit=Math.max(1,Math.min(100,Number(limit)||50));
    const items=this.rows(projectId,repositoryId,c.generation,after,limit+1);
    return {generation:c.generation,revision:c.revision,items:items.slice(0,limit),next:items.length>limit?items[limit-1].path:null};
  }
  rows(projectId,repositoryId,generation,after='',limit=100,cutoff=Number.MAX_SAFE_INTEGER){return this.db.db.prepare("SELECT data FROM records WHERE kind='sourceSyncMetadataBaselines' AND json_extract(data,'$.projectId')=? AND json_extract(data,'$.repositoryId')=? AND json_extract(data,'$.generation')=? AND json_extract(data,'$.pending')=1 AND json_extract(data,'$.path')>? AND rowid<=? ORDER BY json_extract(data,'$.path') LIMIT ?").all(projectId,repositoryId,generation,after,cutoff,limit).map(r=>JSON.parse(r.data));}
  start(projectId,input){return this.db.transaction(()=>{
    const c=this.config(projectId,input.repositoryId);
    if(input.confirmed!==true||!['verify','overwrite'].includes(input.mode)||input.revision!==c.revision||!/^[-\w]{1,100}$/.test(input.requestId||''))throw syncError('confirmation_required');
    if(input.mode==='overwrite'&&!c.nodeIds.includes(input.sourceNodeId))throw syncError('invalid_scope');
    if(input.all!==true&&(!Array.isArray(input.paths)||!input.paths.length||input.paths.length>SOURCE_SYNC_LIMITS.paths))throw syncError('invalid_scope');
    const paths=input.all===true?null:[...new Set(input.paths)].sort();for(const p of paths||[])validateSourcePath(p,c.bindings.find(b=>b.repositoryId===input.repositoryId).scopePolicy);
    const id=contentHash(JSON.stringify([projectId,'initialize',input.requestId])),fingerprint=contentHash(JSON.stringify(input)),prior=this.db.get('sourceSyncInitializations',id);
    if(prior){if(prior.fingerprint!==fingerprint)throw syncError('request_conflict');return prior;}
    if(this.db.db.prepare("SELECT 1 FROM records WHERE kind='sourceSyncInitializations' AND json_extract(data,'$.projectId')=? AND json_extract(data,'$.generation')=? AND json_extract(data,'$.status') IN ('running','paused') LIMIT 1").get(projectId,c.generation))throw syncError('sync_busy');
    const job={id,projectId,repositoryId:input.repositoryId,generation:c.generation,configRevision:c.revision,mode:input.mode,sourceNodeId:input.sourceNodeId||c.nodeIds[0],paths,cutoff:this.db.db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM records WHERE kind='sourceSyncMetadataBaselines' AND json_extract(data,'$.projectId')=? AND json_extract(data,'$.repositoryId')=? AND json_extract(data,'$.generation')=?").get(projectId,input.repositoryId,c.generation).n,fingerprint,status:'running',cursor:'',processed:0,attempt:0,createdAt:now()};
    this.db.put('sourceSyncInitializations',job);this.home.change();return job;
  });}
  resume(projectId,id){const j=this.db.get('sourceSyncInitializations',id);if(j?.projectId!==projectId||j.status!=='paused')throw syncError('batch_changed');if(this.config(projectId,j.repositoryId).generation!==j.generation)throw syncError('configuration_changed');const b=this.db.get('sourceSyncBatches',j.batchId);if(b&&!b.metadataCleanedAt)throw syncError('sync_busy');return this.db.put('sourceSyncInitializations',{...j,status:'running',batchId:null,attempt:j.attempt+1,reason:null});}
  tick(){
    const jobs=this.db.db.prepare("SELECT data FROM records WHERE kind='sourceSyncInitializations' AND json_extract(data,'$.status')='running' AND id>? ORDER BY id LIMIT 8").all(this.cursor||'').map(r=>JSON.parse(r.data));this.cursor=jobs.at(-1)?.id||'';
    for(let j of jobs){
      const c=this.sync.config(j.projectId);if(!c.enabled||c.generation!==j.generation){this.db.put('sourceSyncInitializations',{...j,status:'paused',reason:'configuration_changed'});continue;}
      if(j.batchId){const b=this.db.get('sourceSyncBatches',j.batchId);if(!terminal.has(b?.status))continue;
        if(!b.metadataCleanedAt){if(['blocked','cancelled'].includes(b.status))this.db.put('sourceSyncInitializations',{...j,status:'paused',reason:'recovery_required'});continue;}
        if(['blocked','cancelled'].includes(b.status)||b.pendingMetadata?.length){this.db.put('sourceSyncInitializations',{...j,status:'paused',reason:b.reason||'target_changed'});continue;}
        j=this.db.put('sourceSyncInitializations',{...j,cursor:j.batchEnd,processed:j.processed+j.batchCount,batchId:null});
      }
      if(this.db.listSourceSyncBatches({projectId:j.projectId}).length)continue;
      let rows=this.rows(j.projectId,j.repositoryId,j.generation,j.cursor,100,j.cutoff);
      // Cursor pages are bounded even when only a sparse selection was authorized.
      const pageEnd=rows.at(-1)?.path;rows=rows.filter(r=>!j.paths||j.paths.includes(r.path));
      if(!rows.length){if(pageEnd){this.db.put('sourceSyncInitializations',{...j,cursor:pageEnd});continue;}this.db.put('sourceSyncInitializations',{...j,status:'completed',finishedAt:now()});continue;}
      let bytes=0;const paths=[];for(const r of rows){const n=Object.values(r.endpoints||{}).reduce((s,m)=>s+(m.size||0),0);if(paths.length&&bytes+n>SOURCE_SYNC_LIMITS.batchBytes)break;paths.push(r.path);bytes+=n;}
      this.db.transaction(()=>{const b=this.sync.createBatch(j.projectId,{requestId:contentHash(JSON.stringify([j.id,j.cursor,j.attempt])),nodeIds:c.nodeIds,repositoryIds:[j.repositoryId]},'initialize');
      this.db.put('sourceSyncBatches',{...b,initialization:{jobId:j.id,mode:j.mode,sourceNodeId:j.sourceNodeId,paths}});
      this.db.put('sourceSyncInitializations',{...j,batchId:b.id,batchEnd:paths.at(-1),batchCount:paths.length});});
    }
  }
}
