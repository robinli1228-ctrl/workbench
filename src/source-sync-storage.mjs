import {mkdir,unlink,rename,open} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {randomUUID,createHash} from 'node:crypto';
import {join} from 'node:path';
import {contentHash,validateEntry,SOURCE_SYNC_LIMITS,syncError} from './source-sync-manifest.mjs';
import {readSourceBlob} from './source-sync-files.mjs';

/** Immutable project-local blob storage; reserve quota before consuming a stream, never prune conflict evidence. */
export class SourceSyncStorage {
  constructor({root,db}){Object.assign(this,{root,db});this.writes=new Map();}
  directory(projectId){if(typeof projectId!=='string'||!projectId)throw syncError('project_missing');return join(this.root,contentHash(projectId));}
  async has(projectId,entry){validateEntry(entry);if(!this.db.get('sourceSyncBlobs',`${projectId}:${entry.hash}`))return false;
    try{return (await this.read(projectId,entry.hash)).length===entry.size;}catch{return false;}}
  read(projectId,hash){return readSourceBlob(this.directory(projectId),hash);}
  async receive(projectId,entry,stream){
    validateEntry(entry);if(!entry)throw syncError('invalid_entry');
    const key=`${projectId}:${entry.hash}`;
    while(this.writes.has(key))await this.writes.get(key);
    let release;this.writes.set(key,new Promise(resolve=>{release=resolve;}));let temporary,reserved=false;
    try {
      if(await this.has(projectId,entry)){stream.resume();return {hash:entry.hash,reused:true};}
      this.db.transaction(()=>{const usage=this.db.get('sourceSyncBlobUsage',projectId)||{id:projectId,projectId,bytes:0};
        if(usage.bytes+entry.size>SOURCE_SYNC_LIMITS.projectBytes)throw syncError('storage_full');
        this.db.put('sourceSyncBlobUsage',{...usage,bytes:usage.bytes+entry.size});reserved=true;
      });
      const directory=this.directory(projectId);await mkdir(directory,{recursive:true,mode:0o700});temporary=join(directory,`.upload-${randomUUID()}`);
      let size=0;const digest=createHash('sha256');
      const check=new Transform({transform(chunk,encoding,done){size+=chunk.length;if(size>entry.size)return done(syncError('blob_corrupt'));digest.update(chunk);done(null,chunk);}});
      await pipeline(stream,check,createWriteStream(temporary,{flags:'wx',mode:0o600}));
      if(size!==entry.size||digest.digest('hex')!==entry.hash)throw syncError('blob_corrupt');
      const file=await open(temporary,'r');try{await file.sync();}finally{await file.close();}
      await rename(temporary,join(directory,entry.hash));temporary=null;
      this.db.put('sourceSyncBlobs',{id:key,projectId,hash:entry.hash,size:entry.size});reserved=false;
      return {hash:entry.hash,reused:false};
    }finally{
      if(temporary)await unlink(temporary).catch(()=>{});
      if(reserved){const u=this.db.get('sourceSyncBlobUsage',projectId);this.db.put('sourceSyncBlobUsage',{...u,bytes:Math.max(0,u.bytes-entry.size)});}
      this.writes.delete(key);
      release();
    }
  }
}
