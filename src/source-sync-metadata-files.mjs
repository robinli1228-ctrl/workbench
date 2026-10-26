import {constants} from 'node:fs';
import {open,lstat,rename,link,unlink,realpath,rm} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {contentHash,syncError,SOURCE_SYNC_LIMITS} from './source-sync-manifest.mjs';
import {readSourceMetadata,readSourceFile,readSourceBlob,saveSourceBlob,sourceFilePath} from './source-sync-files.mjs';
import {identityEqual,statMetadata,absent} from './source-sync-metadata.mjs';
const stamp=()=>new Date().toISOString();
const info=async path=>{try{return await lstat(path,{bigint:true});}catch(e){if(e.code==='ENOENT')return null;throw e;}};
export function metadataBlobRoot(root,command){if(!/^[a-f0-9]{64}$/.test(command.batchId||''))throw syncError('invalid_command');return join(root,'metadata',command.batchId);}
async function named(path){const s=await info(path);if(!s)return absent();if(!s.isFile()||s.nlink!==1n)throw syncError('unsafe_recovery_file');return statMetadata(s);}
const inodeEqual=(a,b)=>a?.exists&&b?.exists&&a.dev===b.dev&&a.ino===b.ino;
// Rename/link change ctime, but may not change content attributes. Use saved inode plus size/mtime/mode only after our rename.
const movedEqual=(a,b)=>inodeEqual(a,b)&&['mtimeNs','size','mode'].every(k=>a[k]===b[k]);
export async function readMetadataFiles(command,root,blobRoot){
  const files=[];let bytes=0;
  for(const item of command.paths){const before=await readSourceMetadata(root,item.path,command.scopePolicy);if(!identityEqual(before,item.expected))throw syncError('source_busy',item.path);
    if(!before.exists){files.push({path:item.path,observed:before,entry:null});continue;}
    const captured=await readSourceFile(root,item.path,command.scopePolicy),after=await readSourceMetadata(root,item.path,command.scopePolicy);
    if(!identityEqual(before,after)||!captured.entry)throw syncError('source_busy',item.path);
    bytes+=captured.bytes.length;if(bytes>SOURCE_SYNC_LIMITS.batchBytes)throw syncError('batch_too_large');
    await saveSourceBlob(blobRoot,captured.bytes);files.push({path:item.path,observed:after,entry:captured.entry});
  }
  return {status:'completed',files};
}
/** Read receipts prove the source is still the captured inode after upload, not just before reading. */
export async function confirmMetadataRead(command,root,result){if(command.rootIdentity){const s=await lstat(root,{bigint:true});if(!s.isDirectory()||`${s.dev}:${s.ino}`!==command.rootIdentity)throw syncError('binding_changed');}for(const f of result.files||[])if(!identityEqual(f.observed,await readSourceMetadata(root,f.path,command.scopePolicy)))throw syncError('source_busy',f.path);}
export async function applyMetadataChanges({command,root,db,blobRoot,cancelled=()=>false}){
  root=await realpath(root);const files=[];
  for(const change of command.changes){
    const id=`${command.id}:${contentHash(change.path)}`,fingerprint=contentHash(JSON.stringify(command));let j=db.get('sourceSyncJournals',id);
    if(j&&j.fingerprint!==fingerprint)throw syncError('command_conflict');
    if(j&&['applied','conflict'].includes(j.status)){files.push(j);continue;}
    // Recover only our saved extra link before the general safe-path check rejects a hard-linked leaf.
    if(j?.status==='prepared'&&j.temp?.exists){const targetPath=join(root,change.path);
      if(await realpath(dirname(targetPath))!==dirname(targetPath))throw syncError('unsafe_file');
      const current=await info(targetPath),alias=await info(j.tempPath);
      if(current?.nlink===2n&&alias?.nlink===2n&&current.ino===alias.ino&&current.dev===alias.dev&&movedEqual(statMetadata(current),j.temp))await unlink(j.tempPath);
    }
    const target=await sourceFilePath(root,change.path,{policy:command.scopePolicy,createParents:true});
    if(await realpath(dirname(target.path))!==dirname(target.path))throw syncError('unsafe_file');
    const key=contentHash(id),tempPath=join(dirname(target.path),`.wb-source-sync-${key}.new`),backupPath=join(dirname(target.path),`.wb-source-sync-${key}.old`);
    const save=patch=>db.put('sourceSyncJournals',{...j,...patch,updatedAt:stamp()});
    if(!j){const observed=await readSourceMetadata(root,change.path,command.scopePolicy);
      j={id,commandId:command.id,batchId:command.batchId,projectId:command.projectId,repositoryId:command.repositoryId,generation:command.generation,detection:'metadata',root,path:change.path,before:change.before,after:change.after,tempPath,backupPath,fingerprint};
      if(!identityEqual(observed,change.before)){files.push(save({status:'conflict',observed,reason:'target_changed'}));continue;}
      // Record ownership before creating either private sibling. A crash cannot orphan an unrecorded backup.
      j=save({status:'preparing'});
    }
    if(j.status==='preparing'){
      if(cancelled())return {status:'cancelled',files};
      if(change.after){
        // Never overwrite a pre-existing private path; interrupted preparation is verified against transferred bytes.
        const bytes=await readSourceBlob(blobRoot,change.after.hash);if(bytes.length!==change.after.size)throw syncError('blob_corrupt');
        let file;try{file=await open(tempPath,'wx',change.after.executable?0o755:0o644);await file.writeFile(bytes);await file.sync();}catch(e){if(e.code!=='EEXIST')throw e;const old=await open(tempPath,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=await old.stat();if(!s.isFile()||s.nlink!==1||s.size!==change.after.size)throw syncError('unsafe_recovery_file');if(contentHash(await old.readFile())!==change.after.hash)throw syncError('unsafe_recovery_file');}finally{await old.close();}}finally{await file?.close();}
      }
      j=save({status:'prepared',temp:change.after?await named(tempPath):absent()});
    }
    let current=await readSourceMetadata(root,change.path,command.scopePolicy),backup=await named(backupPath);
    if((change.after?movedEqual(current,j.temp):!current.exists)&&(!change.before.exists||movedEqual(backup,change.before))){const directory=await open(dirname(target.path),'r');try{await directory.sync();}finally{await directory.close();}files.push(save({status:'applied',observed:current}));continue;}
    if(cancelled())return {status:'cancelled',files};
    // An already displaced exact preimage may be completed after restart; any other writer wins over sync.
    if(!backup.exists){
      if(!identityEqual(current,change.before)){files.push(save({status:'conflict',observed:current,reason:'target_changed'}));continue;}
      await sourceFilePath(root,change.path,{policy:command.scopePolicy});
      if(change.before.exists){await rename(target.path,backupPath);backup=await named(backupPath);
        if(!movedEqual(backup,change.before)){
          // Restore the displaced external writer only if the target is still absent. Never overwrite a new name.
          try{await link(backupPath,target.path);await unlink(backupPath);}catch(e){if(e.code!=='EEXIST')throw e;}
          files.push(save({status:'conflict',reason:'target_changed'}));continue;
        }
      }
    }else if(current.exists||!movedEqual(backup,change.before)){files.push(save({status:'conflict',observed:current,reason:'recovery_requires_review'}));continue;}
    if(change.after){
      if(!movedEqual(await named(tempPath),j.temp))throw syncError('unsafe_recovery_file');
      try{await sourceFilePath(root,change.path,{policy:command.scopePolicy});await link(tempPath,target.path);await unlink(tempPath);}catch(e){if(e.code!=='EEXIST')throw e;files.push(save({status:'conflict',reason:'target_changed'}));continue;}
    }
    current=await readSourceMetadata(root,change.path,command.scopePolicy);
    if(change.after?!movedEqual(current,j.temp):current.exists){files.push(save({status:'conflict',observed:current,reason:'target_changed'}));continue;}
    // Persist directory operations before acknowledging the actual destination attributes.
    const directory=await open(dirname(target.path),'r');try{await directory.sync();}finally{await directory.close();}
    files.push(save({status:'applied',observed:current}));
  }
  return {status:files.some(f=>f.status==='conflict')?'partial_conflict':'completed',files};
}
export async function cleanupMetadataFiles(command,db,blobRoot){
  for(const id of command.journalCommands||[])for(const j of db.db.prepare("SELECT data FROM records WHERE kind='sourceSyncJournals' AND json_extract(data,'$.commandId')=?").all(id).map(r=>JSON.parse(r.data)).filter(j=>j.projectId===command.projectId&&j.batchId===command.batchId&&j.detection==='metadata')){
    // Conflicts and uncertain journals retain their preimages for manual recovery.
    if(j.status!=='applied')continue;
    if(await realpath(dirname(j.backupPath))!==dirname(j.backupPath))throw syncError('unsafe_recovery_file');
    for(const [path,expected] of [[j.backupPath,j.before],[j.tempPath,j.temp]]){const actual=await named(path);if(!actual.exists)continue;if(!movedEqual(actual,expected))throw syncError('unsafe_recovery_file');await unlink(path);}
  }
  await rm(blobRoot,{recursive:true,force:true});return {status:'completed',files:[]};
}
