import {SOURCE_SYNC_LIMITS,syncError,syncLimitError} from './source-sync-manifest.mjs';

/** Inventories describe a whole scope; only peers on the legacy contract retain the old scope-size limit. */
export function checkInventorySize(entries,boundedTransfers=false){
  if(!boundedTransfers&&Object.keys(entries).length>SOURCE_SYNC_LIMITS.paths)throw syncLimitError('manifest_too_large','files',SOURCE_SYNC_LIMITS.paths,Object.keys(entries).length);
}

/** Preserve order while bounding each durable transfer command, including empty-file writes and deletions. */
export function splitSourceItems(items,sizeOf){
  const parts=[];let part=[],bytes=0;
  for(const item of items){const size=sizeOf(item);
    if(!Number.isSafeInteger(size)||size<0)throw syncError('invalid_command');
    if(size>SOURCE_SYNC_LIMITS.batchBytes)throw syncLimitError('batch_too_large','batch',SOURCE_SYNC_LIMITS.batchBytes,size,item.path);
    if(part.length&&(part.length>=SOURCE_SYNC_LIMITS.paths||bytes+size>SOURCE_SYNC_LIMITS.batchBytes)){parts.push(part);part=[];bytes=0;}
    part.push(item);bytes+=size;
  }
  if(part.length)parts.push(part);return parts;
}

/** A scope/device can now have several read receipts; index by file rather than choosing its first command. */
export function metadataReadLookup(commands){
  const key=(repositoryId,nodeId,path)=>JSON.stringify([repositoryId,nodeId,path]),entries=new Map();
  for(const c of commands)for(const f of c.result?.files||[])entries.set(key(c.repositoryId,c.nodeId,f.path),f.entry);
  return (repositoryId,nodeId,path)=>entries.get(key(repositoryId,nodeId,path))||null;
}
