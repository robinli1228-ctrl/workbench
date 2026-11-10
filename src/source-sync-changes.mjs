import {lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {contentHash,sortedEntries,manifestDelta,applyManifestDelta} from './source-sync-manifest.mjs';

// Files a device changed since it last synchronized, listed while the sync panel is open. Nothing here is stored. Home
// sends the device's last synchronized list as a change against a list the Worker already has: the copy Home sent before
// (both keep it in memory), else the baseline the Worker holds from its last capture. A small folder may get the whole
// list instead. The Worker compares the list with the observation it already keeps and returns the first few hundred
// differences with their size and modification time.

export const CHANGE_LIST_LIMIT=200;
// One query stays far below the 1 MiB device message limit and takes seconds on a slow link; a node query that times
// out marks the link as stalled, so a larger change is not sent and the panel says the list is not available yet.
export const CHANGE_REQUEST_ENTRIES=1500;
const KEPT_LISTS=64,DELETION_CHECKS=2000;

/** The synchronized list without removal markers, so a change against it rebuilds exactly the same list. */
export function syncedList(entries){const live={};for(const [path,entry] of Object.entries(entries||{}))if(entry)live[path]=entry;return live;}
export const listHash=entries=>contentHash(JSON.stringify(sortedEntries(entries)));
const deltaSize=delta=>Object.keys(delta.changed).length+delta.removed.length;

const same=(a,b)=>!a||!b?!a===!b:a.hash===b.hash&&a.size===b.size&&Boolean(a.executable)===Boolean(b.executable);

/** Paths whose observed state differs from the synchronized one, in path order. */
export function changedFiles(observed,synced){
  const items=[];
  for(const path of new Set([...Object.keys(observed||{}),...Object.keys(synced||{})])){
    const now=observed?.[path]||null,before=synced?.[path]||null;
    if(same(now,before))continue;
    items.push({path,change:!before?'added':!now?'deleted':'modified',size:now?.size??null,previousSize:before?.size??null});
  }
  return items.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}

/**
 * Home side: the request for one scope, or null when every way of sending it would be too large. `sent` is the copy this
 * Worker was last sent (Home memory); `held` is {hash, entries} of the baseline the Worker holds from its last capture.
 */
export function scopeRequest(scope,entries,{sent=null,held=null}={}){
  const live=syncedList(entries),hash=listHash(live),base={repositoryId:scope.repositoryId,generation:scope.generation,hash},list={hash,entries:live};
  if(sent){const delta=sent.hash===hash?{changed:{},removed:[]}:manifestDelta(sent.entries,live);if(deltaSize(delta)<=CHANGE_REQUEST_ENTRIES)return {request:{...base,from:sent.hash,delta},list};}
  if(held?.entries){const delta=manifestDelta(held.entries,live);if(deltaSize(delta)<=CHANGE_REQUEST_ENTRIES)return {request:{...base,held:held.hash,delta},list};}
  if(Object.keys(live).length<=CHANGE_REQUEST_ENTRIES)return {request:{...base,entries:live},list};
  return {request:null,list};
}

/** Worker side: one copy of the last list per scope, in memory only; a lost or different copy asks Home again. */
export class ChangeLists {
  constructor({db}){this.db=db;this.lists=new Map();}
  async changes({projectId,scopes,limit=CHANGE_LIST_LIMIT}={}){
    if(typeof projectId!=='string'||!Array.isArray(scopes)||scopes.length>480)throw new Error('Invalid change list request.');
    const results=[];
    for(const scope of scopes){
      const id=`${projectId}:${scope.repositoryId}:${scope.generation}`,memory=this.lists.get(id);
      let synced=null;
      try{
        if(scope.entries&&typeof scope.entries==='object')synced=scope.entries;
        else if(scope.from&&memory?.hash===scope.from)synced=applyManifestDelta(memory.entries,scope.delta);
        else if(scope.held){const held=this.db.get('sourceSyncBaselines',`${projectId}:${scope.repositoryId}`);if(held?.hash===scope.held)synced=applyManifestDelta(held.entries,scope.delta);}
      }catch{synced=null;}
      this.lists.delete(id);
      if(!synced||listHash(synced)!==scope.hash){results.push({repositoryId:scope.repositoryId,status:'need_list'});continue;}
      this.lists.set(id,{hash:scope.hash,entries:synced});
      while(this.lists.size>KEPT_LISTS)this.lists.delete(this.lists.keys().next().value);
      const state=this.db.get('sourceSyncWatchStates',id);
      // A failed scan keeps the previous observation in the record; it is not a current answer.
      if(state?.status==='blocked'){results.push({repositoryId:scope.repositoryId,status:'blocked',...(state.error?{error:state.error}:{})});continue;}
      if(!state?.entries){results.push({repositoryId:scope.repositoryId,status:'not_observed'});continue;}
      const root=(this.db.get('sourceSyncWatchConfig','main')?.scopes||[]).find(s=>`${s.projectId}:${s.repositoryId}:${s.generation}`===id)?.root||null;
      let all=changedFiles(state.entries,synced);
      // A path this device leaves out of its scope (it became a link, or its folder a nested repository) is missing from the
      // observation but still on disk: it is not a deletion, and sync keeps this device's copy.
      if(root){
        const deleted=all.filter(item=>item.change==='deleted').slice(0,DELETION_CHECKS),present=new Set();
        await Promise.all(deleted.map(async item=>{try{await lstat(join(root,item.path));present.add(item.path);}catch{}}));
        if(present.size)all=all.filter(item=>!present.has(item.path));
      }
      const items=all.slice(0,Math.min(Math.max(Number(limit)||CHANGE_LIST_LIMIT,1),CHANGE_LIST_LIMIT));
      if(root)await Promise.all(items.filter(item=>item.change!=='deleted').map(async item=>{try{item.modifiedAt=(await lstat(join(root,item.path))).mtime.toISOString();}catch{}}));
      results.push({repositoryId:scope.repositoryId,status:'ok',observedAt:state.checkedAt||null,total:all.length,items});
    }
    return results;
  }
}
