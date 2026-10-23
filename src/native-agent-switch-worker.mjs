import {realpath} from 'node:fs/promises';
import {relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {registeredNativeSession} from './native-sessions.mjs';
import {nativeSessionProjectIds,managedRunProcessState} from './terminal-resume.mjs';
import {createNativeAgentContext} from './native-agent-context.mjs';

const same=(a,b)=>a?.runtime===b?.runtime&&a?.sessionId===b?.sessionId;
const held=s=>s&&!['released','cancelled'].includes(s.status);
const inside=(a,b)=>{const r=relative(a,b);return !r||r!=='..'&&!r.startsWith('../')&&!isAbsolute(r);};
export const nativeSwitchOverlap=(a,b)=>typeof a==='string'&&typeof b==='string'&&(inside(a,b)||inside(b,a));
/** All launch paths share this barrier; the switch's own prepared lease alone is exempt. */
export function assertNativeSwitchAccess(db,{runtime,sessionId,workspace,claimId}){
 for(const op of db.list('workerNativeAgentSwitches')){
  if(op.stage==='failed')continue;
  const pending=!op.published;
  if(pending&&claimId===op.leaseId)continue;
  if(pending&&(same(op.source,{runtime,sessionId})||nativeSwitchOverlap(op.workspace,workspace)))throw Error('Agent switch holds this working folder');
  if(op.published&&same(op.source,{runtime,sessionId}))throw Error('This is a historical Agent segment');
 }
}

/** Exact persisted native preparation, reusing the ordinary terminal creation and identity checks. */
export function createWorkerNativeAgentSwitch({db,nodeId,data,projectRoot,runtimes,isPaused,sourceBusy,query,check,prepareGrant=async()=>null,makeContext=createNativeAgentContext}){
 const inflight=new Map();
 const view=op=>({operationId:op.id,stage:op.stage,workspace:op.workspace,target:op.target,contextId:op.context?.id,contextHash:op.context?.hash,folderGrant:op.folderGrant||null,error:op.error||null,settled:op.stage==='failed'});
 const save=(op,patch)=>db.put('workerNativeAgentSwitches',{...op,...patch,updatedAt:new Date().toISOString()});
 async function preflight(input,{allowSource=true,claimId=null}={}){
  if(isPaused())throw Error('Remote execution is paused');
  if(!runtimes().some(r=>r.type===input.targetRuntime&&r.available&&r.supported!==false))throw Error('Target Agent is unavailable on this device');
  const source=registeredNativeSession(db,input.source?.runtime,input.source?.sessionId);
  if(!source||source.roleBinding||nativeSessionProjectIds(db,{nodeId,...input.source}).length)throw Error('Source is not an independent Workbench session');
  const workspace=await projectRoot(source.workspace);
  if(workspace!==input.workspace||await realpath(source.workspace)!==workspace)throw Error('Working directory changed');
  if(sourceBusy(input.source))throw Error('Source Agent is still running or its state is unknown');
  if(db.list('runs').some(r=>(!['succeeded','failed','interrupted'].includes(r.status)||managedRunProcessState(r)!=='exited')&&nativeSwitchOverlap(r.workspace,workspace)))throw Error('A managed task still uses this folder');
  for(const s of db.list('terminalSessions'))if(held(s)&&s.id!==claimId&&nativeSwitchOverlap(s.workspace,workspace)){
   if(allowSource&&s.kind==='native-turn'&&same(s,input.source)&&s.status==='active')continue;
   throw Error('Another terminal or task still uses this folder');
  }
  // A synchronization reservation may have no resolved folder yet; do not guess that it cannot overlap.
  if(db.list('sourceSyncReservations').length||db.list('sourceSyncOperations').length||db.list('workerRoleSwitches').some(s=>!s.released))throw Error('Device maintenance is still in progress');
  assertNativeSwitchAccess(db,{...input.source,workspace,claimId});
  return {workspace};
 }
 async function status(op,input){
  if(op.stage==='ready'){
   if(input.commit){if(!same(input.target,op.target)||input.target.entryId!==op.target.entryId)throw Error('Switch commit identity changed');op=save(op,{published:true});}
   return view(op);
  }
  if(op.stage==='failed')return view(op);
  const lease=db.get('terminalSessions',op.leaseId);
  if(!lease)return view(op); // A missing receipt is not proof that a launch never happened.
  const proof=check(lease);
  if(proof.processState!=='released')return view(op);
  const entry=db.get('nativeCatalogEntries',op.leaseId);
  if(lease.exitCode!==0||!entry?.sessionId)return view(save(op,{stage:'failed',error:lease.helloError||'Target Agent did not create a native history'}));
  const context=op.context||await makeContext({db,conversation:{id:op.conversationId,workspace:op.workspace},segments:op.segments,dataDir:data});
  return view(save(op,{stage:'ready',context,target:{runtime:op.targetRuntime,sessionId:entry.sessionId,entryId:entry.id}}));
 }
 async function handle(action,input){
  if(!/^[a-f0-9-]{36}$/.test(input.operationId||''))throw Error('Invalid switch operation');
  let op=db.get('workerNativeAgentSwitches',input.operationId);
  if(op&&(op.conversationId!==input.conversationId||!same(op.source,input.source)||op.targetRuntime!==input.targetRuntime||op.workspace!==input.workspace))throw Error('Switch identity changed');
  if(action==='native_agent_switch_preflight')return preflight(input);
  if(action==='native_agent_switch_status')return op?status(op,input):{stage:'missing',workspace:input.workspace};
  if(action==='native_agent_switch_abort'){
   if(!op)return {stage:'failed',settled:true};const lease=db.get('terminalSessions',op.leaseId);
   if(lease&&check(lease).processState!=='released')throw Error('Target process exit is not confirmed');
   if(op.published)throw Error('Committed switch cannot be aborted');return view(save(op,{stage:'failed',error:'Preparation cancelled'}));
  }
  if(action!=='native_agent_switch_prepare')throw Error('Invalid Agent switch action');
  if(inflight.has(input.operationId))return inflight.get(input.operationId);
  if(op)return status(op,input);
  const promise=(async()=>{
   await preflight(input,{allowSource:false});
   // Recheck after async path resolution before installing the reservation.
   if(db.get('workerNativeAgentSwitches',input.operationId))return status(db.get('workerNativeAgentSwitches',input.operationId),input);
   op=save({id:input.operationId,...input,leaseId:input.operationId,stage:'preparing',published:false},{});
   try{
    op=save(op,{folderGrant:await prepareGrant(op)});
    const prepared={id:op.leaseId,entryId:op.leaseId,nodeId,projectId:`native-tui:${op.leaseId}`,runtime:op.targetRuntime,workspace:op.workspace,title:op.title||'Conversation',allowAll:true,freshSessionId:['claude','grok'].includes(op.targetRuntime)?randomUUID():null};
    await query('native_terminal_prepare',prepared);
    // The launcher uses a no-business-work initialization prompt, not the old request.
    const lease=db.get('terminalSessions',op.leaseId);db.put('terminalSessions',{...lease,nativeSwitchId:op.id});
    op=save(op,{startRequested:true});await query('native_terminal_start',{id:op.leaseId});
    return status(op,input);
   }catch(error){
    const lease=db.get('terminalSessions',op.leaseId);
    if(!lease&&!op.startRequested)return view(save(op,{stage:'failed',error:error.message}));
    // Release only through the existing identity check; this never signals an active or unknown process.
    try{await query('terminal_release',{id:op.leaseId});return view(save(op,{stage:'failed',error:error.message}));}catch{}
    return view(save(op,{error:error.message}));
   }
  })().finally(()=>inflight.delete(input.operationId));inflight.set(input.operationId,promise);return promise;
 }
 return {handle};
}
