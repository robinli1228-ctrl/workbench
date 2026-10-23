import {randomUUID} from 'node:crypto';
import {nativeSessionProjectIds} from './terminal-resume.mjs';

const stamp=()=>new Date().toISOString();
const uuid=/^[a-f0-9-]{36}$/;
const runtimes=new Set(['claude','codex','grok','agy']);
const same=(a,b)=>a.runtime===b.runtime&&a.sessionId===b.sessionId;
const finished=op=>['committed','failed'].includes(op.stage);

/** A conversation changes executor only after an exact, persisted Worker preparation has settled. */
export class NativeAgentSwitches{
 constructor({db,online,workerQuery,turns,sideAsks,change,sessionRecord}){
  Object.assign(this,{db,online,workerQuery,turns,sideAsks,change,sessionRecord});this.inflight=new Map();
 }
 conversation(identity){return this.db.list('nativeConversations').find(c=>c.nodeId===identity.nodeId&&c.segments.some(s=>same(s,identity)));}
 /** Historical segments stay readable but cannot acquire another writer through a legacy endpoint. */
 assertExecutable(identity){
  const c=this.conversation(identity);if(!c)return;
  if(c.pendingSwitchId)throw Error('Agent switch is in progress; wait for it to finish');
  if(!same(c.segments.find(s=>s.id===c.currentSegmentId),identity))throw Error('This is a historical Agent segment; use the current Agent');
 }
 assertIdle(nodeId,source){
  if(this.db.get('settings','main')?.paused)throw Error('Remote execution is paused');
  if(this.turns.active(nodeId,source.runtime,source.sessionId)||this.turns.waiting(nodeId,source.runtime,source.sessionId).length||this.sideAsks?.busy(nodeId,source.runtime,source.sessionId))throw Error('Finish replies, questions and queued messages before switching Agent');
  if(nativeSessionProjectIds(this.db,{nodeId,...source}).length)throw Error('Use the group role controls to switch this Agent');
 }
 view(op){return {operation:{id:op.id,stage:op.stage,error:op.error||null},conversation:this.db.get('nativeConversations',op.conversationId)};}
 update(op,patch){const next=this.db.put('nativeAgentSwitches',{...op,...patch,updatedAt:stamp()});this.change();return next;}
 async begin(nodeId,input={}){
  const {source,targetRuntime,operationId,expectedRevision}=input;
  if(!uuid.test(operationId||'')||!source||!runtimes.has(source.runtime)||typeof source.sessionId!=='string'||!source.sessionId||!runtimes.has(targetRuntime)||source.runtime===targetRuntime||!Number.isSafeInteger(expectedRevision))throw Error('Invalid Agent switch');
  const fingerprint=JSON.stringify({nodeId,source:{runtime:source.runtime,sessionId:source.sessionId,entryId:source.entryId||null},targetRuntime,expectedRevision});
  const prior=this.db.get('nativeAgentSwitches',operationId);
  if(prior){if(prior.fingerprint!==fingerprint)throw Error('Switch ID was already used with changed input');return finished(prior)?this.view(prior):this.get(nodeId,operationId);}
  const worker=this.db.get('workers',nodeId);
  if(!this.online(nodeId))throw Error('Device is offline');
  if(worker?.capabilities?.nativeAgentSwitch!==1)throw Error('Upgrade this Worker to switch Agent');
  if(!worker.runtimes?.some(r=>r.type===targetRuntime&&r.available&&r.supported!==false))throw Error('Target Agent is unavailable on this device');
  const record=this.sessionRecord?.(nodeId,source.runtime,source.sessionId)||this.db.list('nativeCatalogEntries').find(r=>r.nodeId===nodeId&&same(r,source));
  if(!record?.workspace||source.entryId&&source.entryId!==record.id)throw Error('Session is not registered with Workbench');
  if(record.roleBinding)throw Error('Use the group role controls to switch this Agent');
  this.assertExecutable({nodeId,...source});this.assertIdle(nodeId,source);
  let c=this.conversation({nodeId,...source});
  if((c?.revision||0)!==expectedRevision)throw Error('Conversation revision changed; refresh before switching');
  if(!c){const segment={id:randomUUID(),runtime:source.runtime,sessionId:source.sessionId,entryId:record.id||null,createdAt:record.createdAt||stamp()};c={id:randomUUID(),nodeId,workspace:record.workspace,title:record.title||'',revision:0,currentSegmentId:segment.id,segments:[segment]};}
  const op={id:operationId,nodeId,fingerprint,conversationId:c.id,revision:c.revision,source:{runtime:source.runtime,sessionId:source.sessionId,entryId:record.id||null},targetRuntime,workspace:c.workspace,title:c.title,stage:'preflight',createdAt:stamp()};
  // No await before reservation: two browser windows cannot both begin a successor.
  this.db.transaction(()=>{this.db.put('nativeConversations',{...c,pendingSwitchId:op.id});this.db.put('nativeAgentSwitches',op);});
  return this.get(nodeId,operationId);
 }
 async get(nodeId,id){
  const op=this.db.get('nativeAgentSwitches',id);if(!op||op.nodeId!==nodeId)throw Error('Agent switch not found');
  if(this.inflight.has(id))return this.inflight.get(id);
  if(finished(op)){if(op.stage==='committed'&&!op.published&&this.online(nodeId))await this.publish(op);return this.view(this.db.get('nativeAgentSwitches',id));}
  if(!this.online(nodeId))return this.view(op);
  const promise=this.advance(op).finally(()=>this.inflight.delete(id));this.inflight.set(id,promise);return promise;
 }
 payload(op){const c=this.db.get('nativeConversations',op.conversationId);return {operationId:op.id,conversationId:c.id,revision:op.revision,source:op.source,...op.source,targetRuntime:op.targetRuntime,workspace:c.workspace,title:c.title,segments:c.segments};}
 async query(op,action,extra={}){return this.workerQuery({nodeId:op.nodeId},`native_agent_switch_${action}`,{...this.payload(op),...extra},30000);}
 async advance(op){
  try{
   this.assertIdle(op.nodeId,op.source);
   if(op.stage==='preflight'){
    const result=await this.query(op,'preflight');
    if(result.workspace!==op.workspace)throw Error('Working directory changed');
    op=this.update(op,{stage:'releasing_idle'});
   }
   if(op.stage==='releasing_idle'){
    this.assertIdle(op.nodeId,op.source);
    if(this.turns.process(op.nodeId,op.source.runtime,op.source.sessionId)){
     // Preflight verified that this is an idle, page-owned process. The existing release owns its children.
     this.turns.release(op.nodeId,op.source);return this.view(op);
    }
    op=this.update(op,{stage:'preparing'});
    const result=await this.query(op,'prepare');return await this.accept(op,result);
   }
   // After a lost response/restart only query the saved preparation; never start a second one.
   return await this.accept(op,await this.query(op,'status'));
  }catch(error){
   op=this.db.get('nativeAgentSwitches',op.id);
   if(op.stage==='committed')return this.view(op);
   if(op.stage==='preflight'){
    this.db.transaction(()=>{this.update(op,{stage:'failed',error:error.message});const c=this.db.get('nativeConversations',op.conversationId);this.db.put('nativeConversations',{...c,pendingSwitchId:null});});
   }else this.update(op,{stage:'reconciling',error:error.message});
   return this.view(this.db.get('nativeAgentSwitches',op.id));
  }
 }
 async accept(op,result){
  if(result.stage==='failed'&&result.settled===true){
   this.db.transaction(()=>{this.update(op,{stage:'failed',error:result.error||'Target preparation failed'});const c=this.db.get('nativeConversations',op.conversationId);this.db.put('nativeConversations',{...c,pendingSwitchId:null});});
  }else if(result.stage==='ready'){
   const c=this.db.get('nativeConversations',op.conversationId),target=result.target;
   if(c.revision!==op.revision||c.pendingSwitchId!==op.id||result.workspace!==c.workspace||target?.runtime!==op.targetRuntime||!target.sessionId||!target.entryId)throw Error('Target preparation does not match the conversation');
   this.assertIdle(op.nodeId,op.source);
   const segment={id:randomUUID(),...target,createdAt:stamp(),switchId:op.id,contextId:result.contextId||op.id,contextHash:result.contextHash};
   this.db.transaction(()=>{
    this.db.put('nativeConversations',{...c,revision:c.revision+1,currentSegmentId:segment.id,segments:[...c.segments,segment],pendingSwitchId:null});
    this.db.put('nativeCatalogEntries',{id:target.entryId,nodeId:op.nodeId,...target,workspace:c.workspace,title:c.title,origin:'dialog',status:'ready',hasHistory:true,previewAvailable:true,createdAt:segment.createdAt});
    if(result.folderGrant){const scope=`native:${target.entryId}`,grant=result.folderGrant;if(grant.nodeId!==op.nodeId||grant.root!==c.workspace||grant.scope!==scope)throw Error('Target folder grant changed');this.db.put('folderGrants',{id:`${op.nodeId}:${scope}`,nodeId:op.nodeId,scope,status:'active',grant});}
    this.update(op,{stage:'committed',target,contextId:segment.contextId,error:null});
   });
   await this.publish(this.db.get('nativeAgentSwitches',op.id));
  }
  return this.view(this.db.get('nativeAgentSwitches',op.id));
 }
 /** Publishing retries only the acknowledgement, never creation, after a Home/Worker disconnect. */
 async publish(op){try{await this.query(op,'status',{commit:true,target:op.target});this.update(op,{published:true});}catch(error){this.update(op,{published:false,error:error.message});}}
 decorateCatalog(nodeId,items){const conversations=this.db.list('nativeConversations').filter(c=>c.nodeId===nodeId);return items.map(item=>{
  const c=conversations.find(c=>c.segments.some(s=>same(s,{runtime:item.runtime,sessionId:item.sessionId||item.id})));return c?{...item,conversationBinding:c}:item;
 });}
 /** Delivery is per target segment, not per prompt text or source runtime. */
 handoffFor(identity){const c=this.conversation(identity),s=c?.segments.find(s=>s.id===c.currentSegmentId);
  return s?.contextId&&same(s,identity)&&!this.db.get('nativeHandoffDeliveries',`${identity.nodeId}/${s.contextId}/${s.sessionId}`)?{id:s.contextId,hash:s.contextHash,switchId:s.switchId}:null;}
 /** Recovery preserves uncertainty; the next scoped status request reconciles through the Worker. */
 recover(){for(const op of this.db.list('nativeAgentSwitches'))if(op.stage==='preparing')this.update(op,{stage:'reconciling'});}
}
