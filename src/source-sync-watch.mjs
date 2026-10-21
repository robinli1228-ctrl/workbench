import {watch} from 'node:fs';
import {dirname,join,relative} from 'node:path';
import {randomUUID} from 'node:crypto';
import {captureDirectorySnapshot} from './source-sync-files.mjs';
import {excludedSourcePath,entryEqual,manifestDigest,syncError} from './source-sync-manifest.mjs';

const key=c=>`${c.projectId}:${c.repositoryId}:${c.generation}`;
export const RETRY_BASE_MS=30000,RETRY_MAX_MS=10*60000;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

/** Directory events drive observation. The periodic sweeps are only a backstop for lost events, so a scope whose
 * watchers are all installed sweeps rarely; a degraded scope (watcher limit or errors) keeps the close cadence. */
export const OBSERVATION_INTERVALS=Object.freeze({
  watching:Object.freeze({metadata:5*60000,fullHash:60*60000}),
  degraded:Object.freeze({metadata:30000,fullHash:5*60000}),
});

/** Background observation persists notices; the existing SourceSync queue transfers files without a browser. */
export class SourceSyncWatch {
  constructor({db,send,resolveBinding,blocked=()=>false,busy=()=>false,clock=Date.now,intervals=OBSERVATION_INTERVALS,maxWatches=4096,pause:wait=pause,scopePause={idle:250,busy:1000,max:5000}}){
    Object.assign(this,{db,send,resolveBinding,blocked,busy,clock,intervals,maxWatches,pause:wait,scopePause});this.watches=new Map();this.hints=new Map();this.failures=new Map();this.checked=new Map();this.fullChecked=new Map();this.observations=new Map();this.epochs=new Map();this.retryAt=new Map();this.sent=new Map();this.degraded=new Map();this.running=false;this.closed=false;
  }
  /** Until the first complete installation proves every directory is watched, treat the scope as unwatched. */
  cadence(id){return this.intervals[this.degraded.get(id)===false?'watching':'degraded'];}
  async configure(config){
    if(!config||typeof config.version!=='string'||!Array.isArray(config.scopes)||config.scopes.length>480)throw syncError('invalid_watch_config');
    for(const scope of config.scopes){if(scope.scopeKind!=='directory')throw syncError('invalid_watch_config');await this.resolveBinding(scope);}
    const previous=this.db.get('sourceSyncWatchConfig','main')?.scopes||[];
    for(const scope of previous)if(!config.scopes.some(s=>key(s)===key(scope)&&JSON.stringify(s)===JSON.stringify(scope))){const id=key(scope);this.invalidate(id);for(const w of this.watches.get(id)?.values()||[])w.close();this.watches.delete(id);this.hints.delete(id);this.checked.delete(id);this.retryAt.delete(id);this.degraded.delete(id);}
    this.db.put('sourceSyncWatchConfig',{...config,id:'main'});
    const current=new Set(config.scopes.map(key));for(const [id,group] of this.watches)if(!current.has(id)){for(const w of group.values())w.close();this.watches.delete(id);}
    for(const record of this.db.list('sourceSyncWatchNotices'))if(!current.has(record.id))this.db.remove('sourceSyncWatchNotices',record.id);
    this.send({type:'source_sync_watch_ack',version:config.version});
  }
  /** Unknown/structural events require traversal; known file changes retain their exact paths. */
  hint(id,path=null){const t=this.clock(),prior=this.hints.get(id),paths=prior?.paths||new Set();if(path)paths.add(path);this.hints.set(id,{first:prior?.first??t,last:t,paths,unknown:Boolean(prior?.unknown||!path)});}
  /** Cache lifetime is process/config/listener-bound, not a durable authority on file content. */
  invalidate(id){this.observations.delete(id);this.fullChecked.delete(id);this.epochs.set(id,(this.epochs.get(id)||0)+1);}
  /** Reuse the completed walk's eligible directories, including empty ones; excluded trees never enter the watch set. */
  install(scope,entries,directories=new Map()){
    const id=key(scope),dirs=new Set([scope.root,...directories.keys()]);
    for(const path of Object.keys(entries)){let dir=dirname(join(scope.root,path));while(dir!==scope.root&&dir.startsWith(scope.root+'/')){dirs.add(dir);dir=dirname(dir);}}
    let group=this.watches.get(id);if(!group){group=new Map();this.watches.set(id,group);}
    for(const [dir,w] of group)if(!dirs.has(dir)||w.directoryIdentity!==directories.get(dir)){w.close();group.delete(dir);}
    let degraded=false;
    for(const dir of dirs){if(group.has(dir))continue;if(group.size>=this.maxWatches){degraded=true;break;}
      try{const w=watch(dir,{persistent:false},(event,file)=>{const path=file?relative(scope.root,join(dir,String(file))):'';
        if(path.split('/').at(-1)==='.gitignore'){this.invalidate(id);this.hint(id);}
        else if(!path||path==='.workbench'||path==='.workbench/docs'||!excludedSourcePath(path,scope.scopePolicy))this.hint(id,event==='change'&&path?path:null);
      });w.directoryIdentity=directories.get(dir);w.on('error',()=>{w.close();if(group.get(dir)!==w)return;group.delete(dir);this.degraded.set(id,true);this.invalidate(id);this.hint(id);});group.set(dir,w);}catch{degraded=true;}
    }
    return degraded;
  }
  async tick(force=false){
    if(this.running||this.closed)return;this.running=true;
    let periodicScans=0,pauseSpent=0;
    try{for(const scope of this.db.get('sourceSyncWatchConfig','main')?.scopes||[]){
      const id=key(scope),t=this.clock(),last=this.checked.get(id),hint=this.hints.get(id);
      const cadence=this.cadence(id),full=this.fullChecked.get(id),fullHash=force||full===undefined||t-full>=cadence.fullHash,metadataDue=last===undefined||t-last>=cadence.metadata;
      if(!force&&t<(this.retryAt.get(id)||0))continue;
      if(!fullHash&&!metadataDue&&(!hint||t-hint.last<500&&t-hint.first<2000))continue;
      if(this.blocked(scope.projectId))continue;
      const epoch=this.epochs.get(id)||0;
      const cancelled=()=>this.closed||(this.epochs.get(id)||0)!==epoch;
      const current=()=>!this.closed&&(this.epochs.get(id)||0)===epoch&&this.db.get('sourceSyncWatchConfig','main')?.scopes.some(s=>key(s)===id&&JSON.stringify(s)===JSON.stringify(scope));
      const periodic=!force&&last!==undefined&&!hint&&(fullHash||metadataDue);
      if(periodic&&periodicScans&&pauseSpent<this.scopePause.max){const requested=this.busy(scope.projectId)?this.scopePause.busy:this.scopePause.idle,wait=Math.min(requested,this.scopePause.max-pauseSpent);if(wait>0){await this.pause(wait);pauseSpent+=wait;}if(!current())continue;}
      // Events that arrive during the bounded inter-scope pause are covered by the scan about to start. Later events
      // remain in the map and trigger another observation, so the pacing gap cannot lose a change.
      this.hints.delete(id);
      try{
        const binding=await this.resolveBinding(scope),old=this.db.get('sourceSyncWatchStates',id);
        const observation={...this.observations.get(id),fullHash,metrics:{}};
        const manifest=await captureDirectorySnapshot({...scope,root:binding.root,baselineEntries:old?.entries||{},background:true,busy:()=>this.busy(scope.projectId),observation,
          cancelled,
          ...(!fullHash&&!metadataDue&&!hint?.unknown?{changedPaths:[...hint.paths]}:{})});
        if(this.closed)break;
        // Configuration changed during the asynchronous scan: discard the old generation's observation.
        if(!current())continue;
        this.observations.set(id,observation);this.retryAt.delete(id);this.failures.delete(id);
        if(fullHash){this.fullChecked.set(id,this.clock());this.checked.set(id,this.clock());}else if(metadataDue)this.checked.set(id,this.clock());
        const degraded=this.install({...scope,root:binding.root},manifest.entries,observation.directories);this.degraded.set(id,degraded);const state={id,projectId:scope.projectId,repositoryId:scope.repositoryId,generation:scope.generation,entries:manifest.entries,digest:manifest.digest,checkedAt:new Date().toISOString(),status:degraded?'reconciling':'watching'};
        this.db.transaction(()=>{
          this.db.put('sourceSyncWatchStates',state);
          if(old?.digest!==manifest.digest)this.db.put('sourceSyncWatchNotices',{id,noticeId:randomUUID(),projectId:scope.projectId,repositoryId:scope.repositoryId,generation:scope.generation,digest:manifest.digest,observedAt:state.checkedAt});
        });
        this.send({type:'source_sync_watch_status',...state,entries:undefined});
        if(periodic)periodicScans++;
      }catch(e){if(!current())continue;
        // A persistent failure (a link that stays, a folder that stays unreadable) retries at 30 s, 1 min, 2 min … 10 min, not every 30 s.
        // The observation cache stays: a failed scan never publishes into it, so the next success still reuses unchanged files.
        const failures=(this.failures.get(id)||0)+1;this.failures.set(id,failures);this.retryAt.set(id,this.clock()+Math.min(RETRY_BASE_MS*2**(failures-1),RETRY_MAX_MS));const state={id,projectId:scope.projectId,repositoryId:scope.repositoryId,generation:scope.generation,status:'blocked',error:e.code||'scan_failed',...(e.limit?{limit:e.limit}:{}),checkedAt:new Date().toISOString()};this.db.put('sourceSyncWatchStates',{...this.db.get('sourceSyncWatchStates',id),...state});this.send({type:'source_sync_watch_status',...state});}
    }this.flush();}finally{this.running=false;}
  }
  flush(){for(const notice of this.db.list('sourceSyncWatchNotices')){const sent=this.sent.get(notice.noticeId);if(sent!==undefined&&this.clock()-sent<5000)continue;this.send({type:'source_sync_dirty',...notice});this.sent.set(notice.noticeId,this.clock());}}
  acknowledge(noticeId){for(const n of this.db.list('sourceSyncWatchNotices'))if(n.noticeId===noticeId)this.db.remove('sourceSyncWatchNotices',n.id);this.sent.delete(noticeId);}
  /** Verified receipts advance observation hashes; other edits remain detectable without timestamp arbitration. */
  received(command,result){
    if(command.scopeKind!=='directory'||command.action!=='apply')return;const id=key(command),old=this.db.get('sourceSyncWatchStates',id);if(!old?.entries)return;
    const entries={...old.entries};for(const file of result.files||[]){if(!['applied','unchanged'].includes(file.status))continue;const change=command.changes.find(c=>c.path===file.path);if(change&&(entryEqual(entries[file.path]||null,change.before)||entryEqual(entries[file.path]||null,change.after))){if(change.after)entries[file.path]=change.after;else delete entries[file.path];}}
    this.db.put('sourceSyncWatchStates',{...old,entries,digest:manifestDigest(entries,command.scopePolicy)});
    // A verified apply changes only these paths. Fence any in-flight scan without restarting the full-hash clock.
    const observation=this.observations.get(id);if(observation){const cache=new Map(observation.cache);for(const file of result.files||[])cache.delete(file.path);this.observations.set(id,{...observation,cache,snapshot:{...observation.snapshot,entries}});}
    this.epochs.set(id,(this.epochs.get(id)||0)+1);this.hint(id);
  }
  close(){this.closed=true;for(const group of this.watches.values())for(const w of group.values())w.close();this.watches.clear();}
}
