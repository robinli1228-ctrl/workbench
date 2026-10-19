import {randomUUID} from 'node:crypto';

/**
 * Takeover turns: the user continues one exact native CLI session from the Sessions page.
 * Home records each turn with its process events; the Worker resumes the same native ID in its original folder
 * and keeps one resident CLI per taken-over session where the CLI has a resident input mode.
 * No Task/Run, role rules, platform prompt or wb context is created or injected.
 */
export const NATIVE_TURN_RUNTIMES=['codex','claude','grok','agy'];
/** Resident processes: Codex app-server (thread/resume once, then turn/start), Claude and Agy stream-json input. Grok resumes per turn. */
export const NATIVE_RESIDENT_RUNTIMES=new Set(['codex','claude','agy']);
/** Images reach the model only where the adapter has a native image input. */
export const NATIVE_IMAGE_RUNTIMES=new Set(['codex','claude']);
export const NATIVE_IDLE_MS=30*60*1000;
const idPattern=/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;
export const turnIdPattern=/^[a-zA-Z0-9-]{8,100}$/;
const ACTIVE=new Set(['queued','starting','running','waiting_user']);
const MAX_TEXT=60000,MAX_PROMPT=12000,MAX_EVENTS=400,MAX_EVENT_TEXT=8000;
const MAX_EVENT_BYTES=128*1024,MAX_ITEM_BYTES=24*1024;
const now=()=>new Date().toISOString();
const sessionKey=(nodeId,runtime,sessionId)=>`${nodeId}/${runtime}/${sessionId}`;
/** Control turns: a compaction request, or the slash command that changes a resident Claude's model or effort in place. */
const CONTROLS=new Set(['compact','model','effort']);
const EFFORTS=new Set(['none','minimal','low','medium','high','xhigh','max','ultra','auto','default']);
const modelPattern=/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,79}$/;
export function nativeSettingsKey(nodeId,runtime,sessionId){return `settings:${sessionKey(nodeId,runtime,sessionId)}`;}
const clip=value=>typeof value==='string'&&value.length>MAX_EVENT_TEXT?`${value.slice(0,MAX_EVENT_TEXT)}…`:value;
/** Tool snapshots are bounded field by field; the page renders them with the group-chat live-scene projection. */
function boundedItem(item){if(!item||typeof item!=='object')return item;const next={};for(const[rawKey,value]of Object.entries(item).slice(0,16)){const key=rawKey.slice(0,80);let bounded=value;if(typeof value==='string')bounded=clip(value);else if(value&&typeof value==='object'){const json=JSON.stringify(value);bounded=json.length>MAX_EVENT_TEXT?clip(json):value;}if(Buffer.byteLength(JSON.stringify({...next,[key]:bounded}))>MAX_ITEM_BYTES){next.outputTruncated=true;continue;}next[key]=bounded;}return next;}

/** Filter indexed records before parsing history bodies; polling one session never materializes other sessions. */
export function nativeTurnRows(db,{nodeId,runtime,sessionId,clientTurnId,active=false,limit=50}={}){
 const clauses=["kind='nativeTurns'"],params=[];
 for(const [key,value]of Object.entries({nodeId,runtime,sessionId,clientTurnId}))if(value!==undefined){clauses.push(`json_extract(data,'$.${key}')=?`);params.push(value);}
 if(active)clauses.push("json_extract(data,'$.status') IN ('queued','starting','running','waiting_user','stopping')");
 return db.db.prepare(`SELECT data FROM records WHERE ${clauses.join(' AND ')} ORDER BY rowid DESC LIMIT ?`).all(...params,limit).map(r=>JSON.parse(r.data));
}

/** Pure reducer shared by Home and tests: ordered process events plus a reply text and coarse phase. */
export function applyNativeTurnEvent(turn,event){
 if(!turn||!event)return turn;
 const ended=!ACTIVE.has(turn.status)&&turn.status!=='stopping';
 if(ended&&event.kind!=='status')return turn;
 const next={...turn,updatedAt:now()},events=[...(turn.events||[])];
 const push=(type,payload)=>{const prior=events.at(-1);
  // Adjacent text deltas are merged into one event, so long replies stay within the bounded event list.
  if(type==='text'&&prior?.type==='text')events[events.length-1]={...prior,payload:{text:(prior.payload.text+payload.text).slice(-MAX_EVENT_TEXT)}};
  else events.push({seq:(prior?.seq||0)+1,type,payload,createdAt:now()});
  if(events.length>MAX_EVENTS)events.splice(0,events.length-MAX_EVENTS);};
 if(event.kind==='text'&&typeof event.text==='string'){next.live=((next.live||'')+event.text).slice(-MAX_TEXT);push('text',{text:event.text});next.phase='replying';}
 if(event.kind==='message'&&typeof event.text==='string'){next.parts=[...(next.parts||[]),event.text.slice(-MAX_TEXT)].slice(-20);while(next.parts.length>1&&next.parts.join('\n\n').length>MAX_TEXT)next.parts.shift();next.live='';push('message',{text:clip(event.text),phase:event.phase||null});next.phase='replying';}
 if(['text','message'].includes(event.kind))next.text=[...(next.parts||[]),next.live].filter(Boolean).join('\n\n').slice(-MAX_TEXT);
 // The latest context snapshot of the native session is kept on the turn, not in its event list.
 if(event.kind==='context_usage'&&event.sample&&typeof event.sample==='object')next.contextUsage={...event.sample};
 if(event.kind==='tool'&&event.item){push('tool',{text:clip(String(event.text||'')),item:boundedItem(event.item)});next.phase=['completed','failed'].includes(event.item.status)?'working':'tool';next.toolName=String(event.item.name||event.item.command||event.item.tool||event.item.title||event.item.type||event.text||'').slice(0,200);}
 if(event.kind==='log'&&typeof event.text==='string'){push('log',{text:clip(event.text)});if(event.thinking)next.phase='thinking';}
 if(event.kind==='status'){
  if(ended)return turn;
  if(event.status&&!(turn.status==='stopping'&&ACTIVE.has(event.status)))next.status=event.status;
  if(event.status==='starting')next.phase='starting';
  if(event.status==='running'&&!next.phase)next.phase='thinking';
  if(event.status==='waiting_user')next.phase='waiting';
  if(event.resident!==undefined)next.resident=Boolean(event.resident);
  if(event.error){next.error=String(event.error).slice(0,2000);push('error',{text:next.error});}
  if(['succeeded','failed','interrupted'].includes(next.status)){next.endedAt=next.endedAt||now();next.phase=null;}
 }
 let bytes=2;next.events=[];for(let i=events.length-1;i>=0;i--){const size=Buffer.byteLength(JSON.stringify(events[i]))+1;if(bytes+size>MAX_EVENT_BYTES)break;bytes+=size;next.events.unshift(events[i]);}return next;
}

export function nativeTurnView(turn){
 const {prompt,text,status,error,id,runtime,sessionId,nodeId,createdAt,endedAt,clientTurnId,events,phase,toolName,attachments,resident,control,contextUsage}=turn;
 return {id,clientTurnId,nodeId,runtime,sessionId,prompt,text:text||'',status,phase:phase||null,toolName:toolName||null,error:error||null,createdAt,endedAt:endedAt||null,events:events||[],
  attachments:(attachments||[]).map(({id,name,mime,size})=>({id,name,mime,size})),resident:Boolean(resident),control:control||null,contextUsage:contextUsage||null};
}

/** Home side: validation, idempotent creation, occupancy checks, attachment binding and event intake. */
export class NativeTurnsHome{
 constructor({db,send,online,change,assertIdle,attachments=null,leases=null}){Object.assign(this,{db,send,online,change,assertIdle,attachments,leases});db.db.exec("CREATE INDEX IF NOT EXISTS native_turn_session ON records(json_extract(data,'$.nodeId'),json_extract(data,'$.runtime'),json_extract(data,'$.sessionId')) WHERE kind='nativeTurns'; CREATE INDEX IF NOT EXISTS native_turn_client ON records(json_extract(data,'$.clientTurnId')) WHERE kind='nativeTurns';");
  // Sidebar reads must not parse finished turns' event bodies on every workspace refresh.
  db.db.exec("CREATE INDEX IF NOT EXISTS native_turn_active ON records(id) WHERE kind='nativeTurns' AND json_extract(data,'$.status') IN ('starting','running','stopping')");
 }
 static owner(nodeId){return `native:${nodeId}`;}
 list(nodeId,runtime,sessionId){let bytes=0;return nativeTurnRows(this.db,{nodeId,runtime,sessionId}).map(t=>{let view=nativeTurnView(t);bytes+=Buffer.byteLength(JSON.stringify(view));if(bytes>2*1024*1024)view={...view,events:[],text:view.text.slice(-4000),truncated:true};return view;}).reverse();}
 active(nodeId,runtime,sessionId){return nativeTurnRows(this.db,{nodeId,runtime,sessionId,active:true,limit:1})[0];}
 process(nodeId,runtime,sessionId){const p=this.db.get('nativeTakeovers',sessionKey(nodeId,runtime,sessionId));return this.leases&&p?.leaseId?this.leases.held(p.leaseId):p?.status==='open';}
 /** Model and effort chosen on the Sessions page for this native session; they ride on every turn message. */
 settings(nodeId,runtime,sessionId){const s=this.db.get('nativeSessionSettings',nativeSettingsKey(nodeId,runtime,sessionId));return {model:s?.model||null,effort:s?.effort||null,updatedAt:s?.updatedAt||null};}
 /**
  * One field per call. Claude applies a change in place through a /model or /effort turn; Codex and Grok take it on the next
  * turn; a resident Agy must restart, so its takeover is released and the next message starts it with the new flags.
  */
 saveSettings(nodeId,worker,body){
  const {runtime,sessionId}=body||{};
  if(!NATIVE_TURN_RUNTIMES.includes(runtime))throw Error('Unsupported CLI');
  if(!idPattern.test(sessionId||''))throw Error('Invalid native session ID');
  const field='model' in body?'model':'effort' in body?'effort':null;if(!field)throw Error('Nothing to change');
  const value=body[field]===null||body[field]===''?null:String(body[field]);
  if(value!==null&&(field==='model'?!modelPattern.test(value):!EFFORTS.has(value)))throw Error(field==='model'?'Invalid model':'Invalid reasoning effort');
  const runtimeInfo=(worker?.runtimes||[]).find(r=>r.type===runtime),models=runtimeInfo?.models||[];
  if(value!==null&&field==='model'&&models.length&&!models.some(m=>m.id===value))throw Error('Model is not available on this device');
  const key=nativeSettingsKey(nodeId,runtime,sessionId),current=this.db.get('nativeSessionSettings',key)||{};
  const saved=this.db.put('nativeSessionSettings',{...current,id:key,nodeId,runtime,sessionId,[field]:value,updatedAt:now()});
  let applied='next_turn';
  if(this.process(nodeId,runtime,sessionId)){
   if(runtime==='claude'&&value!==null){this.create(nodeId,worker,{runtime,sessionId,clientTurnId:randomUUID(),text:`/${field} ${value}`,control:field});applied='in_place';}
   else if(runtime==='agy'){this.release(nodeId,{runtime,sessionId});applied='restart';}
  }
  this.change();return {model:saved.model||null,effort:saved.effort||null,updatedAt:saved.updatedAt,applied};
 }
 create(nodeId,worker,body){
  const {runtime,sessionId,clientTurnId,attachmentIds=[]}=body||{};let {text='',control=null}=body||{};
  if(!NATIVE_TURN_RUNTIMES.includes(runtime))throw Error('Unsupported CLI');
  if(!idPattern.test(sessionId||''))throw Error('Invalid native session ID');
  if(!turnIdPattern.test(clientTurnId||''))throw Error('Invalid takeover message ID');
  if(control!==null&&!CONTROLS.has(control))throw Error('Unsupported control');
  if(control==='compact'){if(!['claude','codex'].includes(runtime))throw Error('This CLI cannot compact its context here');text=runtime==='claude'?'/compact':'';if(attachmentIds?.length)throw Error('A compaction carries no attachments');}
  else if(typeof text!=='string'||(!text.trim()&&!attachmentIds?.length))throw Error('Enter a message');
  if(text.length>MAX_PROMPT)throw Error('Message is too long for a takeover turn');
  const prior=nativeTurnRows(this.db,{clientTurnId,limit:1})[0];
  if(prior){if(prior.nodeId!==nodeId||prior.runtime!==runtime||prior.sessionId!==sessionId||prior.prompt!==text||JSON.stringify((prior.attachments||[]).map(a=>a.id))!==JSON.stringify(attachmentIds||[]))throw Error('Takeover message ID was already used');return nativeTurnView(prior);}
  const items=attachmentIds?.length?this.attachments.resolve(NativeTurnsHome.owner(nodeId),attachmentIds):[];
  if(items.some(item=>item.mime.startsWith('image/'))&&!NATIVE_IMAGE_RUNTIMES.has(runtime))throw Error('This CLI cannot receive images in a takeover; send files or use iTerm');
  if(worker?.capabilities?.nativeTurns!==3)throw Error('Upgrade this Worker to take over native sessions');
  if(!this.online(nodeId))throw Error('Device offline or not connected');
  if(this.active(nodeId,runtime,sessionId))throw Error('This session is still replying; wait or stop it first');
  const previous=this.db.get('nativeTakeovers',sessionKey(nodeId,runtime,sessionId));
  const lease=this.leases?.reserve({nodeId,runtime,sessionId,previous});
  if(!this.leases)this.assertIdle({runtime,sessionId});
  const turn={id:randomUUID(),clientTurnId,nodeId,runtime,sessionId,prompt:text,text:'',events:[],attachments:items,status:'queued',phase:'queued',createdAt:now(),updatedAt:now(),...(control?{control}:{})};
  this.db.put('nativeTurns',turn);
  this.db.put('nativeTakeovers',{id:sessionKey(nodeId,runtime,sessionId),nodeId,runtime,sessionId,status:'open',...(lease?{leaseId:lease.leaseId}:{}),updatedAt:now()});
  const settings=this.settings(nodeId,runtime,sessionId);
  this.send(nodeId,{type:'native_turn',id:turn.id,runtime,sessionId,prompt:text,attachments:items,...(settings.model?{model:settings.model}:{}),...(settings.effort?{effort:settings.effort}:{}),...(control?{control}:{}),...(lease||{})});
  this.change();return nativeTurnView(turn);
 }
 /** Workers download only the attachments bound to an unfinished turn. */
 attachmentFor(turnId,attachmentId){const turn=this.db.get('nativeTurns',turnId);if(!turn||!(ACTIVE.has(turn.status)||turn.status==='stopping')||!turn.attachments?.some(a=>a.id===attachmentId))throw Error('Attachment does not belong to an unfinished takeover turn');return {owner:NativeTurnsHome.owner(turn.nodeId),id:attachmentId};}
 stop(nodeId,id){
  const turn=this.db.get('nativeTurns',id);if(!turn||turn.nodeId!==nodeId)throw Error('Takeover turn not found');
  if(!ACTIVE.has(turn.status))return nativeTurnView(turn);
  this.db.put('nativeTurns',{...turn,status:'stopping',updatedAt:now()});this.send(nodeId,{type:'native_turn_stop',id});this.change();return nativeTurnView(this.db.get('nativeTurns',id));
 }
 /** Ending takeover closes the resident CLI; an unfinished turn is stopped first by the Worker. */
 release(nodeId,{runtime,sessionId}={}){
  if(!NATIVE_TURN_RUNTIMES.includes(runtime)||!idPattern.test(sessionId||''))throw Error('Invalid native session');
  const key=sessionKey(nodeId,runtime,sessionId),current=this.db.get('nativeTakeovers',key);
  if(this.leases){
   if(!current||!this.process(nodeId,runtime,sessionId))return {released:true};
   this.db.put('nativeTakeovers',{...current,status:'closing',updatedAt:now()});
   this.leases.stopping(current.leaseId);
   if(this.online(nodeId))this.send(nodeId,{type:'native_takeover_release',runtime,sessionId,leaseId:current.leaseId});
   this.change();return {released:false,pending:true};
  }
  if(current)this.db.put('nativeTakeovers',{...current,status:'closed',reason:'released',updatedAt:now()});
  if(this.online(nodeId))this.send(nodeId,{type:'native_takeover_release',runtime,sessionId});
  this.change();return {released:true};
 }
 receive(nodeId,m){
  if(m.type==='native_takeover_closed'){const key=sessionKey(nodeId,m.runtime,m.sessionId),current=this.db.get('nativeTakeovers',key);if(current&&(!this.leases||current.leaseId===m.leaseId)){this.leases?.closed(nodeId,m);this.db.put('nativeTakeovers',{...current,status:'closed',reason:m.reason||null,updatedAt:now()});this.change();}return true;}
  if(m.type==='native_takeover_lease'){this.leases?.update(nodeId,m);this.change();return true;}
  const turn=this.db.get('nativeTurns',m.id);if(!turn||turn.nodeId!==nodeId)return false;
  const next=applyNativeTurnEvent(turn,m.event);if(next!==turn)this.db.put('nativeTurns',next);if(next.status!==turn.status)this.change();return true;
 }
 /** After a Home restart no Worker connection carries an unfinished turn any more. */
 recover(){for(const t of nativeTurnRows(this.db,{active:true,limit:-1}))this.db.put('nativeTurns',{...t,status:this.leases?'stopping':'interrupted',phase:null,error:'Home restarted; awaiting process verification',...(!this.leases?{endedAt:now()}:{})});for(const p of this.db.list('nativeTakeovers'))if(p.status==='open')this.db.put('nativeTakeovers',{...p,status:this.leases?'closing':'closed',reason:'home_restart'});}
 /** A lost Worker connection ends its turns and resident processes: the Worker closes them on disconnect. */
 disconnected(nodeId){
  let changed=false;for(const t of nativeTurnRows(this.db,{nodeId,active:true,limit:-1})){this.db.put('nativeTurns',{...t,status:this.leases?'stopping':'interrupted',phase:null,error:'Device disconnected; awaiting process verification',...(!this.leases?{endedAt:now()}:{})});changed=true;}
  for(const p of this.db.list('nativeTakeovers'))if(p.nodeId===nodeId&&p.status==='open'){this.db.put('nativeTakeovers',{...p,status:this.leases?'closing':'closed',reason:'disconnected'});changed=true;}
  if(changed)this.change();
 }
}

const alive=session=>Boolean(session?.proc&&session.proc.exitCode===null&&session.proc.signalCode===null&&!session.proc.killed);

/** Worker side: one resident CLI per taken-over session (where supported), exact resume in the history's original folder. */
export class NativeTurnRunner{
 constructor({send,createSession,resolveSession,canStart,prepareInputs=async()=>({files:[],images:[]}),cleanup=null,idleMs=NATIVE_IDLE_MS,leases=null}){Object.assign(this,{send,createSession,resolveSession,canStart,prepareInputs,cleanup,idleMs,leases});this.turns=new Map();this.resident=new Map();this.closing=new Map();}
 /** CLI slots: each resident process counts once, plus per-turn processes that are not resident. */
 get size(){return this.resident.size+[...this.turns.values()].filter(t=>!t.resident).length;}
 holds(runtime,sessionId){return this.resident.has(`${runtime}/${sessionId}`)||[...this.turns.values()].some(t=>t.key===`${runtime}/${sessionId}`);}
 event(id,event){this.send({type:'native_turn_event',id,event:{...event,...(typeof event.text==='string'?{text:event.text.slice(-MAX_TEXT)}:{}),...(event.item?{item:boundedItem(event.item)}:{})}});}
 /** A production lease remains occupied until its exact process tree has exited. */
 close(key,reason){const entry=this.resident.get(key);if(!entry)return this.closing.get(key);clearTimeout(entry.timer);entry.closing=true;
  const finish=()=>{if(this.resident.get(key)===entry)this.resident.delete(key);for(const state of this.turns.values())if(state.key===key&&state.session===entry.session)state.finish?.('interrupted');const [runtime,sessionId]=key.split('/');this.send({type:'native_takeover_closed',runtime,sessionId,reason,...(entry.message?.leaseId?{leaseId:entry.message.leaseId}:{})});};
  if(!this.leases){if(typeof entry.session.close==='function')entry.session.close();else entry.session.shutdown?.();finish();return;}
  if(this.closing.has(key))return this.closing.get(key);
  const pending=this.leases.retire(entry.message,entry.session).then(finish).catch(error=>{this.event(entry.busy,{kind:'status',status:'stopping',error:error.message});}).finally(()=>this.closing.delete(key));this.closing.set(key,pending);return pending;
 }
 idle(key){const entry=this.resident.get(key);if(!entry)return;clearTimeout(entry.timer);entry.timer=setTimeout(()=>this.close(key,'idle'),this.idleMs);entry.timer.unref?.();}
 async start(m){
  if(this.turns.has(m.id))return;
  const key=`${m.runtime}/${m.sessionId}`,existing=this.resident.get(key),state={stopRequested:false,session:null,key,resident:Boolean(existing),message:m,acquired:false};this.turns.set(m.id,state);
  let ended=false;
  const end=(status,error)=>{if(ended)return;ended=true;this.turns.delete(m.id);void Promise.resolve().then(()=>this.cleanup?.(m.id)).catch(()=>{});
   const entry=this.resident.get(key);
   if(entry&&entry.session===state.session){if(alive(entry.session)&&status!=='mismatch'&&(!this.leases||entry.session.done)){entry.busy=null;this.idle(key);}else this.close(key,status==='mismatch'?'mismatch':'exited');}
   else if(!state.resident){if(this.leases){if(state.acquired)void this.leases.retire(m,state.session).catch(()=>{});else this.leases.rejected?.(m);}else state.session?.shutdown?.();}
   this.event(m.id,{kind:'status',status:status==='mismatch'?'failed':status,...(error?{error}:{}),resident:this.resident.has(key)});};
  state.finish=end;
  try{
   if(!NATIVE_TURN_RUNTIMES.includes(m.runtime)||!idPattern.test(m.sessionId||''))throw Error('Invalid native session');
   if(existing?.busy||existing?.closing||[...this.turns.entries()].some(([id,t])=>id!==m.id&&t.key===key))throw Error('This session is still replying; wait or stop it first');
   this.canStart?.(m,{reusing:Boolean(existing)});
   this.leases?.reserve(m,{reusing:Boolean(existing)});
   state.acquired=true;
   const {workspace}=await this.resolveSession(m.runtime,m.sessionId,{reusing:Boolean(existing),message:m});
   if(!workspace)throw Error('The original working folder of this session is unknown; continue it in iTerm');
   if(state.stopRequested)return end('interrupted');
   this.leases?.validate(m);
   this.event(m.id,{kind:'status',status:'starting'});
   const {files=[],images=[]}=await this.prepareInputs(m,workspace);
   if(state.stopRequested)return end('interrupted');
   if(images.length&&!NATIVE_IMAGE_RUNTIMES.has(m.runtime))throw Error('This CLI cannot receive images in a takeover; send files or use iTerm');
   const others=files.filter(f=>!(m.runtime==='codex'&&f.mime?.startsWith('image/'))&&!(m.runtime==='claude'&&f.mime?.startsWith('image/')));
   const prompt=[m.prompt,others.length?`Attached files for this message (local paths):\n${others.map(f=>`- ${f.name}: ${f.path}`).join('\n')}`:''].filter(Boolean).join('\n\n');
   const emit=(type,p={})=>{
    if(ended)return;
    if(type==='status'&&p.nativeSessionId&&p.nativeSessionId!==m.sessionId){void state.session?.stop();return end('mismatch','The CLI resumed a different native session; stopped');}
    if(type==='status'&&p.status==='reconciling'){this.event(m.id,{kind:'status',status:'stopping',error:p.error});if(this.leases)void this.close(key,'unconfirmed');return;}
    if(type==='status'&&['succeeded','failed','interrupted'].includes(p.status))return end(p.status,p.error);
    if(type==='status'&&p.status)this.event(m.id,{kind:'status',status:p.status});
    else if(type==='tool'&&p.item)this.event(m.id,{kind:'tool',text:p.text,item:p.item});
    else if(type==='message'&&typeof p.text==='string')this.event(m.id,{kind:'message',text:p.text,phase:p.phase||null});
    else if(type==='text'&&typeof p.text==='string')this.event(m.id,{kind:'text',text:p.text});
    else if(type==='log'&&typeof p.text==='string')this.event(m.id,{kind:'log',text:p.text.slice(0,4000),thinking:/think|\u601d\u8003/i.test(p.text)});
    else if(type==='context_usage'&&p&&typeof p==='object')this.event(m.id,{kind:'context_usage',sample:p});
   };
   // Model/effort from the Sessions page: flags at spawn for Claude/Agy (Claude later changes them in place), per turn for Codex and Grok.
   const resident=NATIVE_RESIDENT_RUNTIMES.has(m.runtime),inputs={attachments:files,inputImages:images,model:typeof m.model==='string'&&m.model?m.model:null,effort:typeof m.effort==='string'&&m.effort?m.effort:null,control:m.control||null};
   if(existing&&alive(existing.session)){clearTimeout(existing.timer);existing.busy=m.id;state.session=existing.session;state.resident=true;existing.session.reuse({emit,...inputs});}
   else{
    if(existing){await this.close(key,'exited');throw Error('The previous CLI exited; retry after its lease is returned');}
    state.session=this.createSession({runtime:m.runtime,cwd:workspace,resumeSessionId:m.sessionId,emit,keepAlive:resident,onProcess:proc=>this.leases?.started(m,proc),beforeInput:()=>this.leases?.validate(m),...inputs});
    if(resident){this.resident.set(key,{session:state.session,busy:m.id,timer:null,message:m});state.resident=true;}
   }
   this.event(m.id,{kind:'status',status:'starting',resident:state.resident});
   await state.session.start(prompt);
   if(state.stopRequested)await state.session.stop();
  }catch(error){end('failed',error.message);}
 }
 /** Stop interrupts the current turn; a resident process stays for the next message where the CLI supports it. */
 async stop(id){const state=this.turns.get(id);if(!state)return;state.stopRequested=true;if(state.session)await state.session.stop();}
 release(runtime,sessionId){const key=`${runtime}/${sessionId}`;for(const [id,state] of this.turns)if(state.key===key)void this.stop(id);return this.close(key,'released');}
 async stopAll(){const active=[...this.turns.entries()];for(const [id]of active)void this.stop(id);await Promise.all([...this.resident.keys()].map(key=>this.close(key,'disconnected')));if(this.leases)await Promise.allSettled(active.filter(([,s])=>!s.resident&&s.acquired).map(([,s])=>this.leases.retire(s.message,s.session)));}
}
