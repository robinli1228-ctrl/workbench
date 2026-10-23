import { mkdir, open, rename, unlink, readFile, realpath, rm } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { NativeTurnRunner } from './native-turns.mjs';
import { createNativeSession } from './native-turn-sessions.mjs';
import { readNativeSession, registeredNativeSession, assertNativeSessionIdle } from './native-sessions.mjs';
import { runtimeGitEnvironment, nativeGitConfigKey } from './hosting.mjs';
import { nativeTerminalProject, projectTerminalLock, terminalProcessIdentity, processIdentityKey, checkTerminalSession, stopTerminalSession } from './terminal-resume.mjs';

const LIMIT=20*1024*1024,COUNT=6,uuid=/^[a-f0-9-]{36}$/;

/** Takeover attachments are verified from Home into the Worker's own data folder, never into the user's session folder. */
export async function receiveTurnFiles({items=[],turnId,root,home,token,fetchImpl=fetch,route=`/api/agent/native-turns/${turnId}`}) {
  if(!items.length)return [];
  if(!uuid.test(turnId)||items.length>COUNT)throw new Error('Invalid takeover attachments');
  const directory=join(root,turnId);await mkdir(directory,{recursive:true,mode:0o700});
  const received=[];
  for(const item of items){
    if(!uuid.test(item.id)||!Number.isSafeInteger(item.size)||item.size<1||item.size>LIMIT||!/^[a-f0-9]{64}$/.test(item.sha256||'')||typeof item.name!=='string')throw new Error('Invalid takeover attachment');
    const response=await fetchImpl(new URL(`${route}/${item.id}`,home),{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(60000)});
    if(!response.ok)throw new Error(`Attachment download failed: ${item.name} (${response.status})`);
    const chunks=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>item.size||size>LIMIT)throw new Error('Attachment download exceeds its declared size');chunks.push(chunk);}
    const bytes=Buffer.concat(chunks);
    if(bytes.length!==item.size||createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw new Error('Attachment verification failed');
    const extension=/\.[A-Za-z0-9]{1,16}$/.exec(item.name)?.[0]||'';
    const path=join(directory,`${item.id}${extension}`),temp=join(directory,`${randomUUID()}.part`),handle=await open(temp,'wx',0o600);
    try{await handle.writeFile(bytes);await handle.close();await rename(temp,path);}catch(error){await handle.close().catch(()=>{});await unlink(temp).catch(()=>{});throw error;}
    received.push({id:item.id,name:item.name,mime:item.mime,size:item.size,path:await realpath(path)});
  }
  return received;
}

/** The Worker's only takeover entry: worker.mjs passes its state accessors and routes four message types here. */
export function createWorkerNativeTurns({db,send,data,homeHttp,token,projectRoot,isPaused,runtimes,capacity,occupiedSlots,nodeId,changed=()=>{},trim=async()=>{}}) {
  const dbPath=join(data,'worker.sqlite'),retiring=new Map(),observed=new WeakSet();let runner;
  const held=s=>s&&!['released','cancelled'].includes(s.status);
  const report=s=>{send({type:'native_takeover_lease',leaseId:s.id,runtime:s.runtime,sessionId:s.sessionId,projectId:s.projectId,workspace:s.workspace,status:s.status});changed();};
  const closed=s=>{send({type:'native_takeover_closed',leaseId:s.id,runtime:s.runtime,sessionId:s.sessionId,reason:'exited'});changed();};
  const leases={
    rejected(m){if(m.leaseId&&!db.get('terminalSessions',m.leaseId))queueMicrotask(()=>closed({id:m.leaseId,runtime:m.runtime,sessionId:m.sessionId}));},
    reserve(m,{reusing}){
      if(!uuid.test(m.leaseId||''))throw Error('Upgrade Home to reserve a native takeover lease');
      const prior=db.get('terminalSessions',m.leaseId);
      if(prior){if(!reusing||!held(prior)||prior.status==='stopping'||prior.runtime!==m.runtime||prior.sessionId!==m.sessionId||prior.nodeId!==nodeId)throw Error('Takeover lease is no longer reusable');return;}
      const owner=nativeTerminalProject(db,{nodeId,runtime:m.runtime,sessionId:m.sessionId,managedProjectIds:m.managedProjectIds||[]}),projectId=owner||m.projectId||`native-tui:${m.leaseId}`;
      assertNativeSessionIdle(db,{nodeId,runtime:m.runtime,sessionId:m.sessionId,projectId});
      const lock=projectTerminalLock(db,projectId,nodeId);if(lock)throw Error('This project already has a terminal takeover');
      db.put('terminalSessions',{id:m.leaseId,kind:'native-turn',nodeId,runtime:m.runtime,sessionId:m.sessionId,projectId,nativeSession:{runtime:m.runtime,id:m.sessionId},status:'preparing',createdAt:new Date().toISOString()});changed();
    },
    validate(m){
      const s=db.get('terminalSessions',m.leaseId);
      if(isPaused()||!held(s)||s.status==='stopping')throw Error('Takeover was stopped before input delivery');
      assertNativeSessionIdle(db,{nodeId,runtime:m.runtime,sessionId:m.sessionId,workspace:s.workspace,projectId:s.projectId,claimId:s.id});
      if(db.list('workerRoleSwitches').some(op=>op.projectId===s.projectId&&!op.released)||db.get('sourceSyncReservations',s.projectId)||db.list('sourceSyncOperations').some(op=>op.projectId===s.projectId||op.projectId==='*'))throw Error('Project maintenance holds the working folder');
    },
    started(m,proc){
      const s=db.get('terminalSessions',m.leaseId);if(!s||!proc?.pid)return;
      const identity=processIdentityKey(terminalProcessIdentity(proc.pid));
      db.put('terminalSessions',{...s,status:'active',childPid:proc.pid,childIdentity:identity,startedAt:s.startedAt||new Date().toISOString()});
      if(!identity){proc.kill('SIGTERM');throw Error('Unable to verify the takeover process identity');}
      report(db.get('terminalSessions',s.id));
      if(!observed.has(proc)){observed.add(proc);proc.once('exit',()=>{void runner.close(`${m.runtime}/${m.sessionId}`,'exited');});}
    },
    retire(m,session){
      if(!m?.leaseId)return Promise.resolve();
      if(retiring.has(m.leaseId))return retiring.get(m.leaseId);
      const s=db.get('terminalSessions',m.leaseId);
      if(!s){closed({id:m.leaseId,runtime:m.runtime,sessionId:m.sessionId});return Promise.resolve();}
      const pending=(async()=>{
        // Saved identities allow the existing return path to stop only this CLI and its verified children.
        const result=await stopTerminalSession(db,{id:s.id,nodeId,projectId:s.projectId},dbPath);
        if(!result.released)throw Error('Takeover process exit is not confirmed');
        session?.close?.();closed(s);
      })().finally(()=>retiring.delete(m.leaseId));retiring.set(m.leaseId,pending);return pending;
    }
  };
  runner=new NativeTurnRunner({
    send,leases,
    canStart:(m,{reusing})=>{
      if(isPaused())throw Error('Remote execution is paused');
      if(!runtimes().some(r=>r.type===m.runtime&&r.available&&r.supported!==false))throw Error('CLI is not available on this device');
      if(!reusing&&occupiedSlots()>=capacity())throw Error('Device CLI capacity is full');
    },
    prepareInputs:async m=>{
      let handoffText=null;
      if(m.handoff&&!m.control){const op=db.get('workerNativeAgentSwitches',m.handoff.switchId);
        if(!op?.published||op.target?.runtime!==m.runtime||op.target?.sessionId!==m.sessionId||op.context?.id!==m.handoff.id||op.context?.hash!==m.handoff.hash)throw Error('Agent handoff does not match this session');
        handoffText=op.context.excerpt;}
      const files=await receiveTurnFiles({items:m.attachments||[],turnId:m.id,root:join(data,'native-turn-files'),home:homeHttp,token});
      const images=m.runtime==='claude'?await Promise.all(files.filter(f=>f.mime.startsWith('image/')).map(async f=>({mime:f.mime,data:(await readFile(f.path)).toString('base64')}))):[];
      // One private gitconfig per session, rewritten every turn: a resident CLI picks up a newly bound account without restarting.
      const credential=m.gitCredential?.token?m.gitCredential:null;
      const env=await runtimeGitEnvironment({directory:join(data,'git-auth'),key:nativeGitConfigKey(m.runtime,m.sessionId),repositories:credential?[{id:'session',repoUrl:credential.repoUrl}]:[],credentials:credential?{session:credential}:{}});
      return {files,images,env,handoffText};
    },
    resolveSession:async(runtime,sessionId,{message:m})=>{
      const history=await readNativeSession(runtime,sessionId,{record:m.record||registeredNativeSession(db,runtime,sessionId)});if(!history.workspace)return {workspace:null};
      const workspace=await projectRoot(history.workspace),projects=[];
      const inside=(a,b)=>{const r=relative(a,b);return !r||r!=='..'&&!r.startsWith('../')&&!isAbsolute(r);};
      for(const binding of m.bindings||[]){const root=await realpath(binding.localRoot).catch(()=>null);if(root&&(inside(root,workspace)||inside(workspace,root)))projects.push(binding.projectId);}
      const owner=nativeTerminalProject(db,{nodeId,runtime,sessionId,folderProjectIds:projects,managedProjectIds:m.managedProjectIds||[]});
      const s=db.get('terminalSessions',m.leaseId);if(!held(s)||s.status==='stopping')throw Error('Takeover was released during preparation');
      db.put('terminalSessions',{...s,workspace,projectId:owner||s.projectId});leases.validate(m);report(db.get('terminalSessions',s.id));
      await trim();return {workspace};
    },
    cleanup:id=>uuid.test(id)?rm(join(data,'native-turn-files',id),{recursive:true,force:true}):null,
    createSession:options=>createNativeSession(options)
  });
  /** Preparing leases belong to this Runner until preparation settles; generic terminal expiry must not revoke them. */
  runner.check=binding=>{
    const s=db.get('terminalSessions',binding.id);
    if(s?.kind==='native-turn'&&runner.holds(s.runtime,s.sessionId)&&!s.childPid)return {id:s.id,status:s.status,processState:'prepared',checkedAt:new Date().toISOString()};
    const result=checkTerminalSession(db,binding,dbPath,{automatic:true});if(s?.kind==='native-turn'&&result.processState==='released')closed(s);return result;
  };
  /** Restart recovery uses the durable process proof before admitting new input; lost receipts retain the shared lease. */
  runner.recover=async()=>{for(const s of db.list('terminalSessions'))if(s.kind==='native-turn'&&held(s)){try{await leases.retire({leaseId:s.id,runtime:s.runtime,sessionId:s.sessionId});}catch(error){db.put('terminalSessions',{...s,status:'stopping',processError:error.message});}}};
  runner.releaseLease=async(runtime,sessionId,leaseId)=>{
    await runner.release(runtime,sessionId);
    const s=db.get('terminalSessions',leaseId);
    if(s?.kind==='native-turn'&&s.runtime===runtime&&s.sessionId===sessionId&&!runner.holds(runtime,sessionId))await leases.retire({leaseId,runtime,sessionId});
  };
  return runner;
}
