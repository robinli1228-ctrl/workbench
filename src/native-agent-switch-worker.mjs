import {realpath} from 'node:fs/promises';
import {relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {registeredNativeSession} from './native-sessions.mjs';
import {nativeSessionProjectIds,managedRunProcessState,idleNativeDriver} from './terminal-resume.mjs';
import {createNativeAgentContext} from './native-agent-context.mjs';

const same=(a,b)=>a?.runtime===b?.runtime&&a?.sessionId===b?.sessionId;
// A target CLI that has not created its session by then (a login prompt, a limited account) is stopped and the switch fails.
export const NATIVE_SWITCH_PREPARE_MS=5*60000;
const held=s=>s&&!['released','cancelled'].includes(s.status);
const inside=(a,b)=>{const r=relative(a,b);return !r||r!=='..'&&!r.startsWith('../')&&!isAbsolute(r);};
export const nativeSwitchOverlap=(a,b)=>typeof a==='string'&&typeof b==='string'&&(inside(a,b)||inside(b,a));
/** Model completion is not process idleness: retained background tasks and descendants must also be settled. */
export function nativeAgentSourceBusy({db,runner,source,sideBusy=false,inspect=idleNativeDriver}){
 const key=`${source.runtime}/${source.sessionId}`,resident=runner.resident.get(key);
 const leases=db.list('terminalSessions').filter(s=>s.kind==='native-turn'&&same(s,source)&&held(s));
 if(sideBusy||[...runner.turns.values()].some(t=>t.key===key))return true;
 if(resident&&(resident.busy||resident.closing||resident.session.done!==true||resident.session.backgroundTasks?.size||resident.session.awaitingBackground))return true;
 if(leases.some(s=>!resident||resident.message.leaseId!==s.id||!inspect(s)))return true;
 return Boolean(resident&&!leases.length);
}
/** Binary vendor histories may omit cwd; only our committed creation receipt can supply that missing fact. */
export function nativeAgentSessionWorkspace(db,{runtime,sessionId,historyWorkspace}){
 const op=db.list('workerNativeAgentSwitches').find(s=>s.published&&same(s.target,{runtime,sessionId}));
 if(!op)return historyWorkspace||null;
 const entry=db.get('nativeCatalogEntries',op.target.entryId);
 if(!same(entry,{runtime,sessionId})||entry.workspace!==op.workspace||historyWorkspace&&historyWorkspace!==op.workspace)throw Error('Successor working directory changed');
 return op.workspace;
}
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
export function createWorkerNativeAgentSwitch({db,nodeId,data,projectRoot,runtimes,isDisconnected,sourceBusy,query,check,releaseIdle=async()=>{},prepareGrant=async()=>null,cancelGrant=()=>{},makeContext=createNativeAgentContext,prepareMs=NATIVE_SWITCH_PREPARE_MS,sideAsking=()=>false,sweepMs=60000}){
 const inflight=new Map();
 /** Stops only the target's own verified processes, through the ordinary terminal stop. */
 const stopTarget=op=>query('terminal_stop',{id:op.leaseId,nodeId,projectId:`native-tui:${op.leaseId}`});
 // Status checks (Home polls, the deadline timer, a reconnect) and a cancel run one at a time per switch: each reads the
 // saved state afresh, so none can save over what another just settled.
 const queues=new Map();
 const serial=(id,fn)=>{const run=(queues.get(id)||Promise.resolve()).catch(()=>{}).then(fn);queues.set(id,run);void run.finally(()=>{if(queues.get(id)===run)queues.delete(id);}).catch(()=>{});return run;};
 const current=op=>db.get('workerNativeAgentSwitches',op.id)||op;
 // The deadline is checked every minute for every started switch, also after a Worker restart or a start that timed out.
 const sweep=setInterval(()=>{for(const op of db.list('workerNativeAgentSwitches'))if(op.startRequested&&!['ready','failed'].includes(op.stage)&&!inflight.has(op.id))void status(op,{}).catch(()=>{});},sweepMs);sweep.unref?.();
 const view=op=>({operationId:op.id,stage:op.stage,workspace:op.workspace,target:op.target,contextId:op.context?.id,contextHash:op.context?.hash,folderGrant:op.folderGrant||null,error:op.error||null,settled:op.stage==='failed'});
 const save=(op,patch)=>db.put('workerNativeAgentSwitches',{...op,...patch,updatedAt:new Date().toISOString()});
 const fail=(op,error)=>{if(op.grantAttempted)cancelGrant(op);return save(op,{stage:'failed',error});};
 async function preflight(input,{allowSource=true,claimId=null}={}){
  if(isDisconnected())throw Error('This device is not connected to Home');
  if(!runtimes().some(r=>r.type===input.targetRuntime&&r.available&&r.supported!==false))throw Error('Target Agent is unavailable on this device');
  const source=registeredNativeSession(db,input.source?.runtime,input.source?.sessionId);
  if(!source||source.roleBinding||nativeSessionProjectIds(db,{nodeId,...input.source}).length)throw Error('Source is not an independent Workbench session');
  const workspace=await projectRoot(source.workspace);
  if(workspace!==input.workspace||await realpath(source.workspace)!==workspace)throw Error('Working directory changed');
  if(sideAsking(input.source))throw Error('Close the side question about this session before switching Agent');
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
 function status(op,input){return serial(op.id,()=>checkStatus(current(op),input));}
 async function checkStatus(op,input){
  if(op.stage==='ready'){
   if(input.commit){if(!same(input.target,op.target)||input.target.entryId!==op.target.entryId)throw Error('Switch commit identity changed');op=save(op,{published:true});}
   return view(op);
  }
  if(op.stage==='failed')return view(op);
  const lease=db.get('terminalSessions',op.leaseId);
  // A switch from before deadlines were recorded counts from its last update.
  const late=!inflight.has(op.id)&&Date.now()-Date.parse(op.startRequestedAt||op.updatedAt||0)>=prepareMs,timedOut=`Target Agent did not start within ${Math.round(prepareMs/60000)} minutes; it was stopped`;
  if(!lease){
   // After restart no preparation can continue; the persisted start marker distinguishes an unstarted intent from an unknown launch.
   if(!inflight.has(op.id)&&!op.startRequested)return view(fail(op,'Preparation interrupted before target launch'));
   // No lease means no process was registered for it, so nothing is left running once its deadline has passed.
   return view(late?fail(op,timedOut):op);
  }
  let stopped=false,exitedFirst=false;
  if(check(lease).processState!=='released'){
   if(!late)return view(op);
   // A target that had already exited when its deadline passed still counts; one that only exits because it was stopped does not.
   exitedFirst=Number.isInteger(db.get('terminalSessions',op.leaseId)?.exitCode);
   try{await stopTarget(op);stopped=true;}catch(error){return view(save(current(op),{error:error.message}));}
  }
  const exited=db.get('terminalSessions',op.leaseId)||lease,entry=db.get('nativeCatalogEntries',op.leaseId);
  if(stopped&&!exitedFirst)return view(fail(op,timedOut));
  if(exited.exitCode!==0||!entry?.sessionId)return view(fail(op,exited.helloError||'Target Agent did not create a native history'));
  const context=op.context||await makeContext({db,conversation:{id:op.conversationId,workspace:op.workspace},segments:op.segments,recentMessages:op.recentMessages||[],dataDir:data});
  return view(save(op,{stage:'ready',context,target:{runtime:op.targetRuntime,sessionId:entry.sessionId,entryId:entry.id}}));
 }
 async function handle(action,input){
  if(!/^[a-f0-9-]{36}$/.test(input.operationId||''))throw Error('Invalid switch operation');
  let op=db.get('workerNativeAgentSwitches',input.operationId);
  if(op&&(op.conversationId!==input.conversationId||!same(op.source,input.source)||op.targetRuntime!==input.targetRuntime||op.workspace!==input.workspace))throw Error('Switch identity changed');
  if(action==='native_agent_switch_preflight')return preflight(input);
  if(action==='native_agent_switch_release'){await preflight(input);await releaseIdle(input.source);return {released:true};}
  if(action==='native_agent_switch_status')return op?status(op,input):{stage:'missing',workspace:input.workspace};
  if(action==='native_agent_switch_abort'){
   if(!op)return view(save({id:input.operationId,...input,stage:'failed',published:false},{error:'Preparation cancelled before receipt'}));
   return serial(op.id,async()=>{op=current(op);const lease=db.get('terminalSessions',op.leaseId);
    if(op.published)throw Error('Committed switch cannot be aborted');
    // One that already failed keeps its own reason.
    if(op.stage==='failed')return view(op);
    // A person's cancel stops a target that is still starting; a plain abort never signals a process.
    if(lease&&check(lease).processState!=='released'){if(!input.stop)throw Error('Target process exit is not confirmed');await stopTarget(op);}
    return view(fail(current(op),'Preparation cancelled'));});
  }
  if(action!=='native_agent_switch_prepare')throw Error('Invalid Agent switch action');
  if(inflight.has(input.operationId))return inflight.get(input.operationId);
  if(op)return status(op,input);
  if(db.get('terminalSessions',input.operationId)||db.get('nativeCatalogEntries',input.operationId))throw Error('Switch ID is already owned by another native session');
  // Persist before any await: even a rejected second preflight must have a terminal, replay-safe receipt.
  op=save({id:input.operationId,...input,leaseId:input.operationId,stage:'checking',published:false},{});
  const promise=(async()=>{
   try{
    await preflight(input,{allowSource:false,claimId:op.leaseId});
    if(db.get('workerNativeAgentSwitches',op.id)?.stage==='failed')return view(db.get('workerNativeAgentSwitches',op.id));
    op=save(op,{stage:'preparing'});
    op=save(op,{grantAttempted:true});const folderGrant=await prepareGrant(op);
    if(db.get('workerNativeAgentSwitches',op.id)?.stage==='failed')return view(db.get('workerNativeAgentSwitches',op.id));
    op=save(op,{folderGrant});
    const prepared={id:op.leaseId,entryId:op.leaseId,nodeId,projectId:`native-tui:${op.leaseId}`,runtime:op.targetRuntime,workspace:op.workspace,title:op.title||'Conversation',allowAll:true,freshSessionId:['claude','grok'].includes(op.targetRuntime)?randomUUID():null};
    await query('native_terminal_prepare',prepared);
    if(db.get('workerNativeAgentSwitches',op.id)?.stage==='failed'){await query('terminal_release',{id:op.leaseId});return view(db.get('workerNativeAgentSwitches',op.id));}
    // The launcher uses a no-business-work initialization prompt, not the old request.
    const lease=db.get('terminalSessions',op.leaseId);db.put('terminalSessions',{...lease,nativeSwitchId:op.id});
    op=save(op,{startRequested:true,startRequestedAt:new Date().toISOString()});await query('native_terminal_start',{id:op.leaseId});
    return status(op,input);
   }catch(error){
    const lease=db.get('terminalSessions',op.leaseId);op=current(op);
    if(['ready','failed'].includes(op.stage))return view(op);
    if(!lease&&!op.startRequested)return view(fail(op,error.message));
    // Release only through the existing identity check; this never signals an active or unknown process.
    try{await query('terminal_release',{id:op.leaseId});op=current(op);return view(['ready','failed'].includes(op.stage)?op:fail(op,error.message));}catch{}
    return view(save(current(op),{error:error.message}));
   }
  })().finally(()=>inflight.delete(input.operationId));inflight.set(input.operationId,promise);return promise;
 }
 return {handle};
}
