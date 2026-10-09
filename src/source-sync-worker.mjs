import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {open,writeFile,lstat,realpath,rename,link,unlink,chmod,mkdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {contentHash,syncError,entryEqual,manifestDigest,SOURCE_SYNC_LIMITS} from './source-sync-manifest.mjs';
import {sourceFilePath,readSourceFile,readSourceBlob,captureSourceSnapshot,captureGitBase} from './source-sync-files.mjs';

const exec=promisify(execFile),now=()=>new Date().toISOString();
const exists=async path=>{try{return await lstat(path);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const head=async root=>(await exec('git',['rev-parse','HEAD'],{cwd:root,timeout:10000})).stdout.trim();
const signature=(command,root)=>contentHash(JSON.stringify({command,root}));

/** Recovery names are local state, not source artifacts; preserve existing per-repository exclusions. */
async function excludeRecoveryFiles(root) {
  const common=await realpath(resolve(root,(await exec('git',['rev-parse','--git-common-dir'],{cwd:root,timeout:10000})).stdout.trim()));
  const info=join(common,'info');await mkdir(info,{recursive:true});if(await realpath(info)!==info)throw syncError('unsafe_recovery_file');
  const file=await open(join(info,'exclude'),constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
  try{const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>1024*1024)throw syncError('unsafe_recovery_file');
    const text=await file.readFile('utf8');if(!text.split(/\r?\n/).includes('.wb-source-sync-*')){await file.write('\n.wb-source-sync-*\n');await file.sync();}
  }finally{await file.close();}
}

/** Private siblings stay on the target filesystem so displacement is recoverable after a crash. */
async function privateEntry(path) {
  const s=await exists(path);if(!s)return null;
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>SOURCE_SYNC_LIMITS.fileBytes)throw syncError('unsafe_recovery_file');
  const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const bytes=await f.readFile();return {hash:contentHash(bytes),size:bytes.length,executable:Boolean(s.mode&0o111)};}finally{await f.close();}
}

/** Recover an interrupted promotion only from exact saved evidence; unknown writers never lose their copy. */
async function recoverFile(db,journal,root) {
  if(journal.status==='applied'||journal.status==='unchanged')return journal;
  const targetPath=join(root,journal.path);
  if(await realpath(dirname(targetPath))!==dirname(targetPath))throw syncError('unsafe_file',journal.path);
  const target=await exists(targetPath);
  // A crash can leave our temporary name linked to the installed inode. Only remove that exact private alias.
  if(target?.isFile()&&target.nlink===2)for(const privatePath of [journal.tempPath,journal.backupPath]){
    const alias=await exists(privatePath);
    if(alias?.isFile()&&!alias.isSymbolicLink()&&alias.ino===target.ino&&alias.dev===target.dev){await unlink(privatePath);break;}
  }
  const current=(await readSourceFile(root,journal.path)).entry,backup=await privateEntry(journal.backupPath);
  if(entryEqual(current,journal.after)&&(journal.before===null||backup&&entryEqual(backup,journal.before)))
    return db.put('sourceSyncJournals',{...journal,status:'applied',reconciled:true,updatedAt:now()});
  if(backup){
    // Restore only into an absent path; link is no-clobber, unlike an overwriting rename.
    if(current===null&&journal.before!==null){const target=await sourceFilePath(root,journal.path,{createParents:true});try{await link(journal.backupPath,target.path);await unlink(journal.backupPath);}catch(e){if(e.code!=='EEXIST')throw e;}}
    return db.put('sourceSyncJournals',{...journal,status:'conflict',reason:'recovery_requires_review',updatedAt:now()});
  }
  if(entryEqual(current,journal.before))return journal;
  return db.put('sourceSyncJournals',{...journal,status:'conflict',reason:'target_changed',observed:current,updatedAt:now()});
}

/** Apply a fixed batch with per-file journaling, backups and no-clobber final installation. */
export async function applySourceChanges({command,root,changes,db,blobRoot,cancelled=()=>false}) {
  root=await realpath(root);
  if(!/^[a-zA-Z0-9:_-]{1,160}$/.test(command.id||'')||!Array.isArray(changes)||changes.length>SOURCE_SYNC_LIMITS.paths)throw syncError('invalid_command');
  const previous=Object.fromEntries(changes.map(c=>[c.path,c.before])),next=Object.fromEntries(changes.map(c=>[c.path,c.after]));
  if(Object.keys(next).length!==changes.length)throw syncError('duplicate_path');manifestDigest(previous);manifestDigest(next);
  if(changes.reduce((n,c)=>n+(c.after?.size||0),0)>SOURCE_SYNC_LIMITS.batchBytes)throw syncError('batch_too_large');
  if(await head(root)!==command.baseCommit)throw syncError('git_baseline_mismatch');
  await excludeRecoveryFiles(root);
  const fingerprint=signature(command,root),files=[];
  for(const change of changes){
    const id=`${command.id}:${contentHash(change.path)}`;let journal=db.get('sourceSyncJournals',id);
    if(journal&&journal.fingerprint!==fingerprint)throw syncError('command_conflict');
    if(journal){journal=await recoverFile(db,journal,root);if(['applied','unchanged','conflict'].includes(journal.status)){files.push(journal);continue;}}
    if(cancelled()){if(journal)db.put('sourceSyncJournals',{...journal,status:'cancelled',updatedAt:now()});return {status:'cancelled',files};}
    if(await head(root)!==command.baseCommit)throw syncError('git_baseline_mismatch');
    const current=await readSourceFile(root,change.path);
    const target=await sourceFilePath(root,change.path,{createParents:true});
    const key=contentHash(id),backupPath=join(dirname(target.path),`.wb-source-sync-${key}.old`),tempPath=join(dirname(target.path),`.wb-source-sync-${key}.new`);
    const base={id,commandId:command.id,projectId:command.projectId,repositoryId:command.repositoryId,generation:command.generation,fingerprint,
      path:change.path,before:change.before,after:change.after,backupPath,tempPath,updatedAt:now()};
    if(entryEqual(current.entry,change.after)){files.push(db.put('sourceSyncJournals',{...base,status:'unchanged'}));continue;}
    if(!entryEqual(current.entry,change.before)){files.push(db.put('sourceSyncJournals',{...base,status:'conflict',reason:'target_changed',observed:current.entry}));continue;}
    if(change.after){const bytes=await readSourceBlob(blobRoot,change.after.hash);if(bytes.length!==change.after.size)throw syncError('blob_corrupt');
      const old=await privateEntry(tempPath);
      if(old&&!entryEqual(old,change.after))throw syncError('unsafe_recovery_file');
      if(!old){await writeFile(tempPath,bytes,{flag:'wx',mode:change.after.executable?0o700:0o600});await chmod(tempPath,change.after.executable?0o755:0o644);}
    }
    journal=db.put('sourceSyncJournals',{...base,status:'prepared'});
    if(cancelled()){db.put('sourceSyncJournals',{...journal,status:'cancelled',updatedAt:now()});return {status:'cancelled',files};}
    const fresh=await readSourceFile(root,change.path);
    if(!entryEqual(fresh.entry,change.before)){files.push(db.put('sourceSyncJournals',{...journal,status:'conflict',reason:'target_changed',observed:fresh.entry}));continue;}
    await sourceFilePath(root,change.path,{createParents:true});
    if(change.before!==null){
      if(await exists(backupPath))throw syncError('unsafe_recovery_file');
      await rename(target.path,backupPath);
      const displaced=await privateEntry(backupPath);
      if(!entryEqual(displaced,change.before)){files.push(await recoverFile(db,journal,root));continue;}
    }
    if(change.after){
      try{await sourceFilePath(root,change.path,{createParents:true});await link(tempPath,target.path);await unlink(tempPath);}
      catch(e){if(e.code!=='EEXIST')throw e;files.push(db.put('sourceSyncJournals',{...journal,status:'conflict',reason:'target_changed'}));continue;}
    }
    const observed=(await readSourceFile(root,change.path)).entry;
    if(!entryEqual(observed,change.after)){files.push(db.put('sourceSyncJournals',{...journal,status:'conflict',reason:'target_changed',observed}));continue;}
    files.push(db.put('sourceSyncJournals',{...journal,status:'applied',updatedAt:now()}));
  }
  return {status:files.some(f=>f.status==='conflict')?'partial_conflict':'completed',files};
}

/** Local reservations fence managed launches, even if Home reconnects with stale scheduling state. */
export class SourceSyncWorker {
  constructor({db,resolveBinding,blobRoot,activeRuns=()=>[],takeoverState=()=>false,paused=()=>false}) {
    Object.assign(this,{db,resolveBinding,blobRoot,activeRuns,takeoverState,paused});this.running=new Set();
  }
  canStart(projectId) {return !this.db.get('sourceSyncReservations',projectId);}
  async execute(command) {
    const fingerprint=contentHash(JSON.stringify(command)),old=this.db.get('sourceSyncCommands',command.id);
    if(old&&old.fingerprint!==fingerprint)throw syncError('command_conflict');
    if(old?.result&&['completed','partial_conflict','cancelled','blocked'].includes(old.result.status))return old.result;
    if(this.running.has(command.id))return {status:'reconciling'};
    this.db.put('sourceSyncCommands',{id:command.id,projectId:command.projectId,command,fingerprint,status:'pending'});
    if(this.paused()&&!this.db.get('sourceSyncReservations',command.projectId))return {status:'blocked',reason:'paused'};
    if(this.takeoverState(command.projectId)||this.activeRuns().some(r=>(r.projectId==='*'||r.projectId===command.projectId)&&!['succeeded','failed','interrupted'].includes(r.status)))return {status:'waiting_idle'};
    const held=this.db.get('sourceSyncReservations',command.projectId);if(held&&held.commandId!==command.id)return {status:'waiting_idle'};
    this.running.add(command.id);this.db.put('sourceSyncReservations',{id:command.projectId,commandId:command.id,repositoryId:command.repositoryId});
    try{
      const binding=await this.resolveBinding(command);
      if(!binding||binding.generation!==command.generation)throw syncError('binding_changed');
      let result;
      if(command.action==='capture'&&this.db.get('sourceSyncCancellations',command.id))result={status:'cancelled',files:[]};
      else if(command.action==='capture'){
        const options={root:binding.root,repositoryId:command.repositoryId,generation:command.generation,blobRoot:this.blobRoot,expectedHead:command.baseCommit};
        const base=await captureGitBase(options),manifest=await captureSourceSnapshot({...options,base});result={status:'completed',base,manifest};
      }else if(command.action==='apply')result=await applySourceChanges({command,root:binding.root,changes:command.changes,db:this.db,blobRoot:this.blobRoot,
        cancelled:()=>this.paused()||this.db.get('sourceSyncCancellations',command.id)});
      else throw syncError('invalid_sync_action');
      this.db.transaction(()=>{
        this.db.put('sourceSyncCommands',{...this.db.get('sourceSyncCommands',command.id),status:result.status,result});
        this.db.put('sourceSyncReceipts',{id:command.id,projectId:command.projectId,generation:command.generation,fingerprint,result,createdAt:now()});
        this.db.remove('sourceSyncReservations',command.projectId);
      });return result;
    }catch(error){
      const uncertain=this.db.list('sourceSyncJournals').some(j=>j.commandId===command.id&&j.status==='prepared');
      const result={status:uncertain?'reconciling':'blocked',reason:error.code||'apply_failed'};
      this.db.transaction(()=>{
        this.db.put('sourceSyncCommands',{...this.db.get('sourceSyncCommands',command.id),status:result.status,...(!uncertain?{result}:{})});
        if(!uncertain){this.db.put('sourceSyncReceipts',{id:command.id,projectId:command.projectId,generation:command.generation,fingerprint,result,createdAt:now()});this.db.remove('sourceSyncReservations',command.projectId);}
      });return result;
    }finally{this.running.delete(command.id);}
  }
  async reconcile(commandId) {const record=this.db.get('sourceSyncCommands',commandId);if(!record)throw syncError('unknown_command');return this.execute(record.command);}
  receiptBatch() {return this.db.list('sourceSyncReceipts').slice(0,64);}
}
