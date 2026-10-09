import {contentHash,entryEqual,manifestDigest,syncError} from './source-sync-manifest.mjs';
import {captureSourceSnapshot,readSourceBlob,saveSourceBlob} from './source-sync-files.mjs';
import {applySourceChanges} from './source-sync-worker.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
/** Only platform-assigned conflict identity is inherited by the owner's continuation, never by peer calls. */
export function sourceConflictContext(value={}) {
  return Object.fromEntries(['sourceConflictId','sourceConflictGeneration','sourceConflictAssignmentId','sourceConflictPeerId','sourceConflictAssignmentRequestId','sourceSessionKey'].filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]]));
}

/** Freeze the completed batch's version, never whatever canonical happens to be current later. */
export function freezeSourceInputs(db,batchId,nodeId,projectId) {
  const batch=db.get('sourceSyncBatches',batchId);
  if(batch?.projectId!==projectId||batch.status!=='completed'||batch.sourceInputsReady===false||!(batch.sourceInputNodeIds||batch.nodeIds).includes(nodeId)||!batch.sourceInputs?.length)throw syncError('source_input_not_ready');
  return structuredClone(batch.sourceInputs);
}

export function sourceInputWaitReason(db,task,nodeId) {
  if(!task.sourceInputs?.length)return null;
  if(db.get('workers',nodeId)?.capabilities?.sourceSync!==1)return 'worker_unsupported';
  const config=db.get('sourceSyncConfigs',task.projectId);
  if(!config?.enabled||task.sourceInputs.some(v=>v.generation!==config.generation))return 'configuration_changed';
  if(db.listProject('sourceSyncCommands',task.projectId).some(c=>c.nodeId===nodeId&&c.action==='apply'&&!c.result))return 'sync_busy';
  return null;
}

/** Only a newly created isolated worktree is writable here; existing/shared directories must already match. */
export async function prepareSourceInputs({run,repositories,db,blobRoot,readManifest,fetchBlob,freshIsolated=false}) {
  const receipts=[];
  for(const input of run.sourceInputs||[]){
    const repo=repositories.find(r=>r.id===input.repositoryId);if(!repo?.localRoot)throw syncError('binding_missing');
    const version=await readManifest(input);
    if(version.projectId!==run.projectId||version.repositoryId!==input.repositoryId||version.baseCommit!==input.baseCommit||version.generation!==input.generation
      ||version.revision!==input.manifestRevision||manifestDigest(version.entries)!==input.manifestHash)throw syncError('source_input_changed');
    const before=await captureSourceSnapshot({root:repo.localRoot,repositoryId:repo.id,expectedHead:input.baseCommit});
    const changes=[];for(const path of new Set([...Object.keys(before.entries),...Object.keys(version.entries)])){
      const old=Object.hasOwn(before.entries,path)?before.entries[path]:null,next=Object.hasOwn(version.entries,path)?version.entries[path]:null;
      if(!entryEqual(old,next))changes.push({path,before:old,after:next});
    }
    if(changes.length&&!freshIsolated)throw syncError('source_input_changed');
    for(const change of changes)if(change.after){let bytes;try{bytes=await readSourceBlob(blobRoot,change.after.hash);}catch{
      if(!fetchBlob)throw syncError('blob_missing');bytes=await fetchBlob(input,change.after.hash);if(contentHash(bytes)!==change.after.hash)throw syncError('blob_corrupt');await saveSourceBlob(blobRoot,bytes);
    }if(bytes.length!==change.after.size)throw syncError('blob_corrupt');}
    if(changes.length){const command={id:`input-${contentHash(run.id+':'+repo.id)}`,projectId:run.projectId,repositoryId:repo.id,generation:input.generation,baseCommit:input.baseCommit,changes};
      const applied=await applySourceChanges({command,root:repo.localRoot,changes,db,blobRoot});if(applied.status!=='completed')throw syncError('source_input_changed');}
    const observed=await captureSourceSnapshot({root:repo.localRoot,repositoryId:repo.id,expectedHead:input.baseCommit});
    // Explicit tombstones and omitted never-existing paths compare semantically, not by object shape.
    for(const path of new Set([...Object.keys(observed.entries),...Object.keys(version.entries)]))if(!entryEqual(Object.hasOwn(observed.entries,path)?observed.entries[path]:null,Object.hasOwn(version.entries,path)?version.entries[path]:null))throw syncError('source_input_changed');
    receipts.push({...input,verified:true});
  }
  return receipts;
}

/** A dirty review is unchanged only when its exact overlay still matches and no excluded dirty paths exist. */
export async function sourceOverlayUnchanged(options) {
  await prepareSourceInputs({...options,freshIsolated:false});
  for(const input of options.run.sourceInputs||[]){const repo=options.repositories.find(r=>r.id===input.repositoryId),version=await options.readManifest(input);
    const paths=[];for(const args of [['diff','--name-only','-z','HEAD'],['ls-files','--others','--exclude-standard','-z']])paths.push(...(await exec('git',args,{cwd:repo.localRoot,timeout:10000,maxBuffer:8*1024*1024})).stdout.split('\0').filter(Boolean));
    if(paths.some(path=>!Object.hasOwn(version.entries,path)))return false;
  }
  return true;
}
