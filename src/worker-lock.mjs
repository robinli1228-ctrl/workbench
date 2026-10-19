import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,renameSync,unlinkSync,realpathSync,lstatSync,linkSync} from 'node:fs';
import {join,basename} from 'node:path';
import {terminalProcessIdentity} from './terminal-resume.mjs';
import {tr} from './i18n.mjs';

const fault=(code,key)=>Object.assign(new Error(tr(key)),{code});
const unknown=()=>fault('worker_lock_unknown','worker.lockIdentityUnknown');
const busy=()=>fault('worker_lock_busy','worker.dataDirectoryAlreadyHasWorker');

/** Missing files are distinct from unreadable, malformed or redirected ownership records. */
function readLock(path){
  try{if(!lstatSync(path).isFile())throw unknown();return readFileSync(path,'utf8');}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}

/** Publish complete bytes without overwriting an intervening owner or leaving a half-written live receipt. */
function publishReceipt(path,bytes,instanceId){
  const temp=`${path}.tmp-${instanceId}`;
  try{writeFileSync(temp,bytes,{flag:'wx',mode:0o600});linkSync(temp,path);}
  finally{try{unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')throw error;}}
}

/** Legacy records can exclude an unrelated executable, but an ambiguous interpreter is never proof of vacancy. */
export function workerLockOwnerState(pid,owner,directory,actual){
  if(!Number.isSafeInteger(pid)||pid<1)return 'unknown';
  if(owner&&!(owner.version===1&&owner.pid===pid&&typeof owner.start==='string'&&owner.start&&
    Number.isInteger(owner.uid)&&owner.dataDirectory===directory&&typeof owner.instanceId==='string'&&owner.instanceId))return 'unknown';
  if(actual?.unknown)return 'unknown';
  if(!actual||actual.zombie)return 'stale';
  if(owner){
    if(actual.start!==owner.start)return 'stale';
    return actual.pid===pid&&actual.uid===owner.uid?'active':'unknown';
  }
  const command=actual.command||'',executable=basename(command.match(/^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/)?.slice(1).find(Boolean)||'');
  if(!executable||/worker\.(?:m?js)(?:\s|$)/i.test(command)||
    /^(?:node(?:js)?|python[\d.]*|bash|sh|zsh|dash|fish|env|perl|ruby|java|powershell|pwsh|cmd)(?:\.exe)?$/i.test(executable))return 'unknown';
  return 'stale';
}

/** Hold a dedicated SQLite write reservation for the whole Worker lifetime. OS locks survive neither process death nor reboot. */
export function acquireWorkerLock(dataDirectory){
  const directory=realpathSync(dataDirectory),lockFile=join(directory,'worker.lock'),ownerFile=join(directory,'worker.lock.owner.json');
  const gateFile=join(directory,'worker-lock.sqlite');
  // Never replace/remove the gate inode: doing so would split the kernel mutex between contenders.
  try{if(!lstatSync(gateFile).isFile())throw unknown();}catch(error){if(error.code!=='ENOENT')throw error;}
  const gate=new DatabaseSync(gateFile);let held=false;
  const unlock=()=>{try{if(held)gate.exec('ROLLBACK');}finally{held=false;gate.close();}};
  try{
    gate.exec('PRAGMA busy_timeout=0');
    try{gate.exec('BEGIN IMMEDIATE');held=true;}catch(error){if(error.errcode===5||error.errcode===6)throw busy();throw error;}
    const self=terminalProcessIdentity(process.pid);
    if(!self||self.unknown||!self.start||!Number.isInteger(self.uid))throw unknown();
    const old=readLock(lockFile),oldOwner=readLock(ownerFile);
    if(old!==null){
      let owner=null;
      if(oldOwner!==null){try{owner=JSON.parse(oldOwner);}catch{throw unknown();}if(!owner||typeof owner!=='object')throw unknown();}
      const pid=Number(old.trim()),state=workerLockOwnerState(pid,owner,directory,terminalProcessIdentity(pid));
      if(state==='active')throw busy();
      if(state!=='stale')throw unknown();
    }else if(oldOwner!==null){
      // A crash during publication may leave only metadata. Do not guess if its claimed owner is still live.
      let owner;try{owner=JSON.parse(oldOwner);}catch{throw unknown();}
      if(!owner||workerLockOwnerState(owner.pid,owner,directory,terminalProcessIdentity(owner.pid))!=='stale')throw unknown();
    }
    const instanceId=randomUUID(),record={version:1,pid:process.pid,uid:self.uid,start:self.start,dataDirectory:directory,instanceId};
    // Preserve confirmed stale evidence; never clear a directory, touch business SQLite, or signal its recorded PID.
    if(readLock(lockFile)!==old||readLock(ownerFile)!==oldOwner)throw unknown();
    if(old!==null)renameSync(lockFile,`${lockFile}.stale-${instanceId}`);
    if(oldOwner!==null)renameSync(ownerFile,`${ownerFile}.stale-${instanceId}`);
    const ownerBytes=JSON.stringify(record)+'\n',pidBytes=String(process.pid);
    // Metadata first: a crash before the PID publication remains conservatively identifiable on the next start.
    publishReceipt(ownerFile,ownerBytes,instanceId);
    publishReceipt(lockFile,pidBytes,instanceId);
    let released=false;
    const release=()=>{
      if(released)return;released=true;process.removeListener('exit',onExit);
      try{
        // Both receipts must still be ours; a delayed exit must never unlink a successor's ownership.
        if(readLock(ownerFile)===ownerBytes&&readLock(lockFile)===pidBytes){unlinkSync(lockFile);unlinkSync(ownerFile);}
      }finally{unlock();}
    };
    const onExit=()=>{try{release();}catch{/* Preserve uncertain receipts; the OS still releases the gate on exit. */}};
    process.on('exit',onExit);
    return {record,release};
  }catch(error){unlock();throw error;}
}
