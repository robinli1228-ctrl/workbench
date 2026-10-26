import {unlinkSync} from 'node:fs';
import {mkdir,unlink,rename,open,rm} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {randomUUID,createHash} from 'node:crypto';
import {join} from 'node:path';
import {contentHash,validateEntry,SOURCE_SYNC_LIMITS,syncError,syncLimitError} from './source-sync-manifest.mjs';
import {readSourceBlob} from './source-sync-files.mjs';

/** Immutable project-local blob storage; reserve quota before consuming a stream, never prune conflict evidence. */
export class SourceSyncStorage {
  constructor({root,db,namespace='',writes=new Map()}){Object.assign(this,{root,db,namespace,writes});}
  scoped(namespace){if(!/^[a-f0-9]{64}$/.test(namespace))throw syncError('invalid_command');return new SourceSyncStorage({root:this.root,db:this.db,namespace,writes:this.writes});}
  key(projectId,hash){return `${projectId}:${this.namespace?this.namespace+':':''}${hash}`;}
  async cleanup(projectId){
    if(!this.namespace)throw syncError('invalid_command');
    const rows=this.db.db.prepare("SELECT data FROM records WHERE kind='sourceSyncBlobs' AND json_extract(data,'$.projectId')=? AND json_extract(data,'$.namespace')=?").all(projectId,this.namespace).map(r=>JSON.parse(r.data));
    if([...this.writes.keys()].some(id=>id.startsWith(`${projectId}:${this.namespace}:`)))throw syncError('sync_busy');
    for(const row of rows){if(this.writes.has(row.id))throw syncError('sync_busy');await unlink(join(this.directory(projectId),row.hash)).catch(e=>{if(e.code!=='ENOENT')throw e;});this.db.transaction(()=>{this.db.remove('sourceSyncBlobs',row.id);const usage=this.db.get('sourceSyncBlobUsage',projectId);if(usage)this.db.put('sourceSyncBlobUsage',{...usage,bytes:Math.max(0,usage.bytes-row.size)});});}
    await rm(this.directory(projectId),{recursive:true,force:true});
  }
  /** Synchronous reference check + unlink in one transaction: no writer can add a reference between them. */
  releaseConflictCopies(conflict){
    if(this.namespace||conflict.detection!=='metadata'||conflict.status!=='resolved')return false;
    const projectId=conflict.projectId,hashes=[...new Set([conflict.base,...(conflict.sides||[]).map(s=>s.entry),...(conflict.receiving||[]).map(s=>s.entry),conflict.proposal?.entry].filter(Boolean).map(e=>e.hash))];
    return this.db.transaction(()=>{
      const current=this.db.get('sourceSyncConflicts',conflict.id),batch=this.db.get('sourceSyncBatches',current?.resolutionBatchId);
      if(current?.generation!==conflict.generation||current.status!=='resolved'||!batch?.metadataCleanedAt)return false;
      let retained=false;
      for(const hash of hashes){
        const id=this.key(projectId,hash);if(this.writes.has(id)){retained=true;continue;}
        // JSON trees are searched inside indexed project/kind rows, never loaded as full manifests in JS.
        const references=['sourceSyncManifests','sourceSyncVersions','sourceSyncDevices','sourceSyncCandidates','sourceSyncConflictHistory','sourceSyncUploads'];
        const has=(kind,extra='',args=[])=>Boolean(this.db.db.prepare(`SELECT 1 FROM records r WHERE r.kind=? AND json_extract(r.data,'$.projectId')=? ${extra} AND EXISTS(SELECT 1 FROM json_tree(r.data) j WHERE j.key='hash' AND j.value=?) LIMIT 1`).get(kind,projectId,...args,hash));
        const pendingReceipt=kind=>has(kind,"AND NOT EXISTS(SELECT 1 FROM records c JOIN records b ON b.kind='sourceSyncBatches' AND b.id=json_extract(c.data,'$.batchId') WHERE c.kind='sourceSyncCommands' AND c.id=r.id AND json_extract(c.data,'$.detection')='metadata' AND json_extract(b.data,'$.metadataCleanedAt') IS NOT NULL)");
        if(references.some(k=>has(k))||pendingReceipt('sourceSyncUploadReceipts')||has('sourceSyncConflicts',"AND r.id!=? AND json_extract(r.data,'$.copiesReleasedAt') IS NULL AND NOT (json_extract(r.data,'$.detection')='metadata' AND json_extract(r.data,'$.status')='resolved' AND EXISTS(SELECT 1 FROM records b WHERE b.kind='sourceSyncBatches' AND b.id=json_extract(r.data,'$.resolutionBatchId') AND json_extract(b.data,'$.metadataCleanedAt') IS NOT NULL))",[conflict.id])||has('sourceSyncBatches',"AND (COALESCE(json_extract(r.data,'$.detection'),'')!='metadata' OR json_extract(r.data,'$.metadataCleanedAt') IS NULL)")||has('sourceSyncCommands',"AND (COALESCE(json_extract(r.data,'$.detection'),'')!='metadata' OR json_extract(r.data,'$.result') IS NULL OR json_extract(r.data,'$.status')='reconciling' OR EXISTS(SELECT 1 FROM records b WHERE b.kind='sourceSyncBatches' AND b.id=json_extract(r.data,'$.batchId') AND json_extract(b.data,'$.metadataCleanedAt') IS NULL))")){retained=true;continue;}
        const row=this.db.get('sourceSyncBlobs',id);if(!row)continue;
        try{unlinkSync(join(this.directory(projectId),hash));}catch(e){if(e.code!=='ENOENT')throw e;}
        this.db.remove('sourceSyncBlobs',id);const usage=this.db.get('sourceSyncBlobUsage',projectId);if(usage)this.db.put('sourceSyncBlobUsage',{...usage,bytes:Math.max(0,usage.bytes-row.size)});
      }
      if(!retained)this.db.put('sourceSyncConflicts',{...current,copiesReleasedAt:new Date().toISOString()});return !retained;
    });
  }
  directory(projectId){if(typeof projectId!=='string'||!projectId)throw syncError('project_missing');return this.namespace?join(this.root,contentHash(projectId),'metadata',this.namespace):join(this.root,contentHash(projectId));}
  async has(projectId,entry){validateEntry(entry);if(!this.db.get('sourceSyncBlobs',this.key(projectId,entry.hash)))return false;
    try{return (await this.read(projectId,entry.hash)).length===entry.size;}catch{return false;}}
  read(projectId,hash){return readSourceBlob(this.directory(projectId),hash);}
  async receive(projectId,entry,stream){
    validateEntry(entry);if(!entry)throw syncError('invalid_entry');
    const key=this.key(projectId,entry.hash);
    while(this.writes.has(key))await this.writes.get(key);
    let release;this.writes.set(key,new Promise(resolve=>{release=resolve;}));let temporary,reserved=false;
    try {
      if(await this.has(projectId,entry)){stream.resume();return {hash:entry.hash,reused:true};}
      this.db.transaction(()=>{const usage=this.db.get('sourceSyncBlobUsage',projectId)||{id:projectId,projectId,bytes:0};
        // A durable reservation also replaces a stale row after interrupted GC or upload; quota is charged once.
        const prior=this.db.get('sourceSyncBlobs',key);if(prior)usage.bytes=Math.max(0,usage.bytes-prior.size);
        if(usage.bytes+entry.size>SOURCE_SYNC_LIMITS.projectBytes)throw syncLimitError('storage_full','project',SOURCE_SYNC_LIMITS.projectBytes,usage.bytes+entry.size);
        this.db.put('sourceSyncBlobUsage',{...usage,bytes:usage.bytes+entry.size});this.db.put('sourceSyncBlobs',{id:key,projectId,hash:entry.hash,size:entry.size,...(this.namespace?{namespace:this.namespace}:{}),reserved:true});reserved=true;
      });
      const directory=this.directory(projectId);await mkdir(directory,{recursive:true,mode:0o700});temporary=join(directory,`.upload-${randomUUID()}`);
      let size=0;const digest=createHash('sha256');
      const check=new Transform({transform(chunk,encoding,done){size+=chunk.length;if(size>entry.size)return done(syncError('blob_corrupt'));digest.update(chunk);done(null,chunk);}});
      await pipeline(stream,check,createWriteStream(temporary,{flags:'wx',mode:0o600}));
      if(size!==entry.size||digest.digest('hex')!==entry.hash)throw syncError('blob_corrupt');
      const file=await open(temporary,'r');try{await file.sync();}finally{await file.close();}
      await rename(temporary,join(directory,entry.hash));temporary=null;
      this.db.put('sourceSyncBlobs',{id:key,projectId,hash:entry.hash,size:entry.size,...(this.namespace?{namespace:this.namespace}:{})});reserved=false;
      return {hash:entry.hash,reused:false};
    }finally{
      if(temporary)await unlink(temporary).catch(()=>{});
      if(reserved){this.db.remove('sourceSyncBlobs',key);const u=this.db.get('sourceSyncBlobUsage',projectId);this.db.put('sourceSyncBlobUsage',{...u,bytes:Math.max(0,u.bytes-entry.size)});}
      this.writes.delete(key);
      release();
    }
  }
}
