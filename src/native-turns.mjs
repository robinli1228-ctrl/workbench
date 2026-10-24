import {randomUUID,createHash} from 'node:crypto';
import {giteeRepository} from './repository.mjs';
import {traditionalInput} from './input-language.mjs';

/**
 * Takeover turns: the user continues one exact native CLI session from the Sessions page.
 * Home records each turn with its process events; the Worker resumes the same native ID in its original folder
 * and keeps one resident CLI per taken-over session where the CLI has a resident input mode.
 * No Task/Run, role rules, platform prompt or wb context is created or injected; the one addition is the short page
 * instructions (see PAGE_INSTRUCTIONS), sent once per session and version.
 */
export const NATIVE_TURN_RUNTIMES=['codex','claude','grok','agy'];
/** Resident processes: Codex app-server (thread/resume once, then turn/start), Claude and Agy stream-json input. Grok resumes per turn. */
export const NATIVE_RESIDENT_RUNTIMES=new Set(['codex','claude','agy']);
/** Images reach the model only where the adapter has a native image input. */
export const NATIVE_IMAGE_RUNTIMES=new Set(['codex','claude']);
export const NATIVE_IDLE_MS=30*60*1000;
/** How long a Worker keeps its turns running after losing Home (a tunnel blip), and how much longer Home waits before it gives up on them. */
export const NATIVE_RECONNECT_GRACE_MS=3*60*1000,NATIVE_DISCONNECT_EXPIRE_MS=NATIVE_RECONNECT_GRACE_MS+60*1000;
const idPattern=/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;
export const turnIdPattern=/^[a-zA-Z0-9-]{8,100}$/;
const ACTIVE=new Set(['queued','starting','running','waiting_user']);
const MAX_TEXT=60000,MAX_PROMPT=12000,MAX_EVENTS=400,MAX_EVENT_TEXT=8000;
const MAX_EVENT_BYTES=128*1024,MAX_ITEM_BYTES=24*1024;
const now=()=>new Date().toISOString();
const sessionKey=(nodeId,runtime,sessionId)=>`${nodeId}/${runtime}/${sessionId}`;
/** Queue position: the order the user dragged to, otherwise the time it was sent. */
const queueRank=turn=>Number.isFinite(turn.queueRank)?turn.queueRank:(Date.parse(turn.createdAt)||0);
/** Control turns: a compaction request, or the slash command that changes a resident Claude's model or effort in place. */
const CONTROLS=new Set(['compact','model','effort']);
/**
 * Page instructions, delivered like a group chat's role instructions: once per native session and version, as a block in
 * front of the first prompt this page sends (the page hides system-reminder blocks), never again until the text changes.
 * A nudge, not a rule: the page shows the model's questions as cards, so prefer asking to guessing.
 */
export const PAGE_INSTRUCTIONS='This session is now also driven from a Workbench page, which shows AskUserQuestion / request_user_input as a card with options and a free-text field. When a requirement is unclear or a choice belongs to the user, prefer asking with that tool over guessing or listing the options as plain text. Keep questions short, with a few options and the recommended one marked.';
export const PAGE_INSTRUCTIONS_VERSION=createHash('sha256').update(PAGE_INSTRUCTIONS).digest('hex').slice(0,16);
const PAGE_INSTRUCTION_RUNTIMES=new Set(['claude','codex']);
/** The prompt a CLI receives: the page instructions block (when this turn carries it), then the person's words. */
export const withPageInstructions=(prompt,instructions)=>instructions?.text?`<system-reminder>\nWorkbench page instructions, version ${instructions.version}:\n${instructions.text}\n</system-reminder>\n\n${prompt}`:prompt;
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
 // Replayed acceptance may arrive after disconnect expiry; record only this monotonic fact, never reopen a terminal turn.
 if(ended)return event.kind==='status'&&event.inputDeliveryState==='accepted'&&turn.inputDeliveryState!=='accepted'?{...turn,inputDeliveryState:'accepted',updatedAt:now()}:turn;
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
 // The CLI's question to the user waits on the turn (not in its event list) until the page answers or the CLI withdraws it.
 if(event.kind==='question'&&event.id&&Array.isArray(event.questions)&&event.questions.length){next.question={id:String(event.id),questions:event.questions.slice(0,8),askedAt:now()};next.status='waiting_user';next.phase='waiting';}
 if(event.kind==='question_resolved'){if(next.question&&(!event.id||next.question.id===String(event.id))){delete next.question;if(next.status==='waiting_user')next.status='running';if(next.phase==='waiting')next.phase='working';}}
 if(event.kind==='tool'&&event.item){push('tool',{text:clip(String(event.text||'')),item:boundedItem(event.item)});next.phase=['completed','failed'].includes(event.item.status)?'working':'tool';next.toolName=String(event.item.name||event.item.command||event.item.tool||event.item.title||event.item.type||event.text||'').slice(0,200);}
 // Subagents and background shells of the turn sit on it (not in its event list): start on Home's clock, as the turn's own time is,
 // the run time measured on the device; later events of one task fill in what it is doing now and how it ended.
 if(event.kind==='task'&&event.task?.id){
  const tk=event.task,id=String(tk.id).slice(0,80),tasks=[...(next.tasks||[])],i=tasks.findIndex(x=>x.id===id),str=(v,n)=>typeof v==='string'?v.slice(0,n):undefined;
  // One carried over from an earlier turn keeps its device-measured age, so its time counts from when it really started.
  if(i<0&&tk.status==='running'&&['agent','shell'].includes(tk.kind))tasks.push({id,kind:tk.kind,description:str(tk.description,200)||'',agentType:str(tk.agentType,80)||'',status:'running',
   startedAt:tk.earlier&&Number.isFinite(tk.elapsedMs)&&tk.elapsedMs>=0?new Date(Date.now()-tk.elapsedMs).toISOString():now(),...(tk.earlier===true?{earlier:true}:{})});
  else if(i>=0&&tasks[i].status==='running'){const x={...tasks[i]};
   if(typeof tk.activity==='string')x.activity=str(tk.activity,200);if(Number.isFinite(tk.toolUses))x.toolUses=tk.toolUses;
   if(['completed','failed','stopped'].includes(tk.status)){x.status=tk.status;x.endedAt=now();if(Number.isFinite(tk.durationMs)&&tk.durationMs>=0)x.durationMs=tk.durationMs;}
   tasks[i]=x;}
  // At most 20 rows; finished ones leave first (oldest first), a running one only if all are running.
  while(tasks.length>20){const j=tasks.findIndex(x=>x.status!=='running');tasks.splice(j<0?0:j,1);}
  next.tasks=tasks;
 }
 if(event.kind==='log'&&typeof event.text==='string'){push('log',{text:clip(event.text)});if(event.thinking)next.phase='thinking';}
 if(event.kind==='status'){
  // Input acceptance is independent of the task outcome; a later failure cannot undo delivery.
  if(next.inputDeliveryState!=='accepted'&&['accepted','not_delivered'].includes(event.inputDeliveryState))next.inputDeliveryState=event.inputDeliveryState;
  if(next.runtime==='claude'&&next.inputDeliveryState==='not_delivered'&&['refused','discarded'].includes(event.inputRejection))next.inputRejection=event.inputRejection;
  if(event.status&&!(turn.status==='stopping'&&ACTIVE.has(event.status)))next.status=event.status;
  if(event.status==='starting')next.phase='starting';
  if(event.status==='running'&&!next.phase)next.phase='thinking';
  if(event.status==='waiting_user')next.phase='waiting';
  if(event.status&&event.status!=='waiting_user'&&next.question)delete next.question;
  if(event.resident!==undefined)next.resident=Boolean(event.resident);
  if(event.error){next.error=String(event.error).slice(0,2000);push('error',{text:next.error});}
  if(['succeeded','failed','interrupted'].includes(next.status)){next.endedAt=next.endedAt||now();next.phase=null;
   // A parent ending is not evidence that its background child completed or stopped. Freeze the observation, not the outcome.
   if(next.tasks?.some(x=>x.status==='running'))next.tasks=next.tasks.map(x=>x.status==='running'?{...x,status:'unknown',endedAt:next.endedAt}:x);}
 }
 let bytes=2;next.events=[];for(let i=events.length-1;i>=0;i--){const size=Buffer.byteLength(JSON.stringify(events[i]))+1;if(bytes+size>MAX_EVENT_BYTES)break;bytes+=size;next.events.unshift(events[i]);}return next;
}

export function nativeTurnView(turn){
 const {prompt,text,status,error,id,runtime,sessionId,nodeId,createdAt,endedAt,clientTurnId,events,phase,toolName,attachments,resident,control,contextUsage,steer,queueRank,withdrawn,question,disconnectedAt,tasks}=turn;
 return {id,clientTurnId,nodeId,runtime,sessionId,prompt,text:text||'',status,phase:phase||null,toolName:toolName||null,error:error||null,createdAt,endedAt:endedAt||null,events:events||[],
  attachments:(attachments||[]).map(({id,name,mime,size})=>({id,name,mime,size})),resident:Boolean(resident),control:control||null,contextUsage:contextUsage||null,steer:Boolean(steer),...(Number.isFinite(queueRank)?{queueRank}:{}),...(withdrawn?{withdrawn:true}:{}),...(question?{question}:{}),...(disconnectedAt?{disconnectedAt}:{}),...(tasks?.length?{tasks}:{})};
}

/** Home side: validation, idempotent creation, occupancy checks, attachment binding and event intake. */
export class NativeTurnsHome{
 constructor({db,send,online,change,assertIdle,attachments=null,leases=null,gitCredential=null}){Object.assign(this,{db,send,online,change,assertIdle,attachments,leases,gitCredential});db.db.exec("CREATE INDEX IF NOT EXISTS native_turn_session ON records(json_extract(data,'$.nodeId'),json_extract(data,'$.runtime'),json_extract(data,'$.sessionId')) WHERE kind='nativeTurns'; CREATE INDEX IF NOT EXISTS native_turn_client ON records(json_extract(data,'$.clientTurnId')) WHERE kind='nativeTurns';");
  // Sidebar reads must not parse finished turns' event bodies on every workspace refresh.
  db.db.exec("CREATE INDEX IF NOT EXISTS native_turn_active ON records(id) WHERE kind='nativeTurns' AND json_extract(data,'$.status') IN ('starting','running','stopping')");
 }
 static owner(nodeId){return `native:${nodeId}`;}
 list(nodeId,runtime,sessionId){let bytes=0;return nativeTurnRows(this.db,{nodeId,runtime,sessionId}).map(t=>{let view=nativeTurnView(t);bytes+=Buffer.byteLength(JSON.stringify(view));if(bytes>2*1024*1024)view={...view,events:[],text:view.text.slice(-4000),truncated:true};return view;}).reverse();}
 active(nodeId,runtime,sessionId){return nativeTurnRows(this.db,{nodeId,runtime,sessionId,active:true,limit:1})[0];}
 process(nodeId,runtime,sessionId){const p=this.db.get('nativeTakeovers',sessionKey(nodeId,runtime,sessionId));return this.leases&&p?.leaseId?this.leases.held(p.leaseId):p?.status==='open';}
 /** A finished turn is not permission to reuse an exiting process; only its matching lease closure releases the queue. */
 waitsForExit(nodeId,runtime,sessionId){const p=this.db.get('nativeTakeovers',sessionKey(nodeId,runtime,sessionId));return p?.status==='retiring'&&this.process(nodeId,runtime,sessionId);}
 /** Model and effort chosen on the Sessions page for this native session; they ride on every turn message. */
 settings(nodeId,runtime,sessionId){const s=this.db.get('nativeSessionSettings',nativeSettingsKey(nodeId,runtime,sessionId));return {model:s?.model||null,effort:s?.effort||null,hostingAccountId:s?.hostingAccountId||null,repoUrl:s?.repoUrl||null,updatedAt:s?.updatedAt||null};}
 /**
  * One field per call. Claude applies a change in place through a /model or /effort turn; Codex and Grok take it on the next
  * turn; a resident Agy must restart, so its takeover is released and the next message starts it with the new flags.
  */
 saveSettings(nodeId,worker,body){
  const {runtime,sessionId}=body||{};
  this.assertExecutable?.({nodeId,runtime,sessionId});
  if(!NATIVE_TURN_RUNTIMES.includes(runtime))throw Error('Unsupported CLI');
  if(!idPattern.test(sessionId||''))throw Error('Invalid native session ID');
  const field='model' in body?'model':'effort' in body?'effort':'hostingAccountId' in body?'hostingAccountId':null;if(!field)throw Error('Nothing to change');
  const value=body[field]===null||body[field]===''?null:String(body[field]);
  if(field==='hostingAccountId'){
   // The account must exist and match the repository's host; the URL is remembered so a turn can resolve the credential.
   const repoUrl=typeof body.repoUrl==='string'&&body.repoUrl.trim()?body.repoUrl.trim().slice(0,300):null;
   if(value!==null){const account=this.db.get('hostingAccounts',value);if(!account)throw Error('Hosting account not found');if(!repoUrl)throw Error('The repository remote URL is unknown; refresh the Git card first');const remote=giteeRepository(repoUrl);if(!remote||remote.provider!==account.provider)throw Error('The account provider does not match the repository host');}
   const key=nativeSettingsKey(nodeId,runtime,sessionId),current=this.db.get('nativeSessionSettings',key)||{};
   const saved=this.db.put('nativeSessionSettings',{...current,id:key,nodeId,runtime,sessionId,hostingAccountId:value,repoUrl:value?repoUrl:current.repoUrl||repoUrl,updatedAt:now()});
   this.change();return {...this.settings(nodeId,runtime,sessionId),applied:'next_turn',updatedAt:saved.updatedAt};
  }
  if(value!==null&&(field==='model'?!modelPattern.test(value):!EFFORTS.has(value)))throw Error(field==='model'?'Invalid model':'Invalid reasoning effort');
  const runtimeInfo=(worker?.runtimes||[]).find(r=>r.type===runtime),models=runtimeInfo?.models||[];
  if(value!==null&&field==='model'&&models.length&&!models.some(m=>m.id===value))throw Error('Model is not available on this device');
  // A stale browser must not restart a busy resident CLI or save a setting that admission rejects.
  if(this.active(nodeId,runtime,sessionId))throw Error('This session is still replying; wait or stop it first');
  return this.db.transaction(()=>{
  const key=nativeSettingsKey(nodeId,runtime,sessionId),current=this.db.get('nativeSessionSettings',key)||{};
  const saved=this.db.put('nativeSessionSettings',{...current,id:key,nodeId,runtime,sessionId,[field]:value,updatedAt:now()});
  let applied='next_turn';
  if(this.process(nodeId,runtime,sessionId)){
   if(runtime==='claude'&&value!==null){this.create(nodeId,worker,{runtime,sessionId,clientTurnId:randomUUID(),text:`/${field} ${value}`,control:field});applied='in_place';}
   else if(runtime==='agy'){this.release(nodeId,{runtime,sessionId});applied='restart';}
  }
  this.change();return {model:saved.model||null,effort:saved.effort||null,updatedAt:saved.updatedAt,applied};
  });
 }
 create(nodeId,worker,body,{gitCredential=null}={}){
  const {runtime,sessionId,clientTurnId,attachmentIds=[]}=body||{};let {text='',control=null}=body||{};
  this.assertExecutable?.({nodeId,runtime,sessionId});
  if(!NATIVE_TURN_RUNTIMES.includes(runtime))throw Error('Unsupported CLI');
  if(!idPattern.test(sessionId||''))throw Error('Invalid native session ID');
  if(!turnIdPattern.test(clientTurnId||''))throw Error('Invalid takeover message ID');
  if(control!==null&&!CONTROLS.has(control))throw Error('Unsupported control');
  if(control==='compact'){if(!['claude','codex'].includes(runtime))throw Error('This CLI cannot compact its context here');text=runtime==='claude'?'/compact':'';if(attachmentIds?.length)throw Error('A compaction carries no attachments');}
  else if(typeof text!=='string'||(!text.trim()&&!attachmentIds?.length))throw Error('Enter a message');
  if(text.length>MAX_PROMPT)throw Error('Message is too long for a takeover turn');
  const prior=nativeTurnRows(this.db,{clientTurnId,limit:1})[0];
  if(prior){if(prior.nodeId!==nodeId||prior.runtime!==runtime||prior.sessionId!==sessionId||prior.prompt!==text||(prior.control||null)!==control||JSON.stringify((prior.attachments||[]).map(a=>a.id))!==JSON.stringify(attachmentIds||[]))throw Error('Takeover message ID was already used');return nativeTurnView(prior);}
  const items=attachmentIds?.length?this.attachments.resolve(NativeTurnsHome.owner(nodeId),attachmentIds):[];
  if(items.some(item=>item.mime.startsWith('image/'))&&!NATIVE_IMAGE_RUNTIMES.has(runtime))throw Error('This CLI cannot receive images in a takeover; send files or use iTerm');
  if(worker?.capabilities?.nativeTurns!==3)throw Error('Upgrade this Worker to take over native sessions');
  if(!this.online(nodeId))throw Error('Device offline or not connected');
  const turn={id:randomUUID(),clientTurnId,nodeId,runtime,sessionId,prompt:text,text:'',events:[],attachments:items,status:'waiting',phase:null,createdAt:now(),updatedAt:now(),...(control?{control}:{})};
  // A message sent while the session is replying waits in Home's queue, like a queued group-chat message; it starts when the reply ends.
  if(this.active(nodeId,runtime,sessionId)||this.waitsForExit(nodeId,runtime,sessionId)||this.waiting(nodeId,runtime,sessionId).length||this.queueState(nodeId,runtime,sessionId).paused){this.db.put('nativeTurns',turn);this.change();void this.pump(nodeId,runtime,sessionId);return nativeTurnView(turn);}
  return nativeTurnView(this.dispatch(turn,{gitCredential}));
 }
 /** Reserve the resident process and hand the turn to the Worker; the only place a turn leaves the queue. */
 dispatch(turn,{gitCredential=null}={}){
  const {nodeId,runtime,sessionId}=turn,key=sessionKey(nodeId,runtime,sessionId),previous=this.db.get('nativeTakeovers',key);
  this.assertExecutable?.({nodeId,runtime,sessionId});
  const lease=this.leases?.reserve({nodeId,runtime,sessionId,previous});
  if(!this.leases)this.assertIdle({runtime,sessionId});
  const handoff=turn.control?null:this.handoffFor?.({nodeId,runtime,sessionId});
  const started={...turn,status:'queued',phase:'queued',updatedAt:now(),...(handoff?{handoffId:handoff.id}:{})};
  this.db.put('nativeTurns',started);
  this.db.put('nativeTakeovers',{id:key,nodeId,runtime,sessionId,status:'open',...(lease?{leaseId:lease.leaseId}:{}),updatedAt:now()});
  const settings=this.settings(nodeId,runtime,sessionId);
  // The first page turn of a session (or the first after the instructions changed) carries them; a control turn never does.
  const delivered=this.db.get('nativePageInstructions',key)?.version===PAGE_INSTRUCTIONS_VERSION;
  // An older Worker would drop them unseen; it gets none, and nothing is marked delivered.
  const capable=this.db.get('workers',nodeId)?.capabilities?.nativePageInstructions===1;
  const instructions=capable&&!delivered&&!turn.control&&PAGE_INSTRUCTION_RUNTIMES.has(runtime)?{version:PAGE_INSTRUCTIONS_VERSION,text:PAGE_INSTRUCTIONS}:null;
  if(instructions)this.db.put('nativeTurns',{...started,instructionsVersion:instructions.version});
  this.send(nodeId,{type:'native_turn',id:turn.id,runtime,sessionId,prompt:turn.prompt,...(instructions?{instructions}:{}),...(handoff?{handoff}:{}),attachments:turn.attachments||[],...(settings.model?{model:settings.model}:{}),...(settings.effort?{effort:settings.effort}:{}),...(turn.control?{control:turn.control}:{}),...(gitCredential?{gitCredential}:{}),...(lease||{})});
  this.change();return started;
 }
 /** Queued turns of one session: a steered message first, then in the order the user arranged (by default, the order they were sent). */
 waiting(nodeId,runtime,sessionId){
  return this.db.db.prepare("SELECT data FROM records WHERE kind='nativeTurns' AND json_extract(data,'$.nodeId')=? AND json_extract(data,'$.runtime')=? AND json_extract(data,'$.sessionId')=? AND json_extract(data,'$.status')='waiting' ORDER BY rowid").all(nodeId,runtime,sessionId).map(r=>JSON.parse(r.data))
   .sort((a,b)=>Number(Boolean(b.steer))-Number(Boolean(a.steer))||String(a.steerAt||'').localeCompare(String(b.steerAt||''))||queueRank(a)-queueRank(b));
 }
 /** A paused queue keeps its messages after the reply ends; it only exists while something waits, so an emptied queue un-pauses itself. */
 queueState(nodeId,runtime,sessionId){
  const key=sessionKey(nodeId,runtime,sessionId),stored=this.db.get('nativeQueues',key);if(!stored?.paused)return {paused:false};
  if(!this.waiting(nodeId,runtime,sessionId).length){this.db.remove('nativeQueues',key);return {paused:false};}
  return {paused:true};
 }
 /** Pause or resume a session's queue, or store the order the user dragged its waiting messages into. */
 setQueue(nodeId,body){
  const {runtime,sessionId,paused,order}=body||{};
  if(!NATIVE_TURN_RUNTIMES.includes(runtime))throw Error('Unsupported CLI');
  if(!idPattern.test(sessionId||''))throw Error('Invalid native session ID');
  if(typeof paused!=='boolean'&&!Array.isArray(order))throw Error('Nothing to change');
  this.db.transaction(()=>{
   if(Array.isArray(order)){
    // The order must name exactly the messages still waiting (a steered one already goes first); a stale page refreshes instead.
    const waiting=this.waiting(nodeId,runtime,sessionId).filter(t=>!t.steer),ids=new Set(waiting.map(t=>t.id));
    if(order.length!==ids.size||new Set(order).size!==order.length||order.some(id=>!ids.has(id)))throw Error('The queue changed; refresh and try again');
    const base=Math.min(...waiting.map(queueRank));
    order.forEach((id,i)=>{const t=waiting.find(x=>x.id===id);this.db.put('nativeTurns',{...t,queueRank:base+i/1000,updatedAt:now()});});
   }
   if(typeof paused==='boolean'){const key=sessionKey(nodeId,runtime,sessionId);
    if(paused&&this.waiting(nodeId,runtime,sessionId).length)this.db.put('nativeQueues',{id:key,nodeId,runtime,sessionId,paused:true,updatedAt:now()});else this.db.remove('nativeQueues',key);}
  });
  this.change();if(!this.queueState(nodeId,runtime,sessionId).paused)void this.pump(nodeId,runtime,sessionId);
  return {queue:this.queueState(nodeId,runtime,sessionId),items:this.waiting(nodeId,runtime,sessionId).map(nativeTurnView)};
 }
 /** When the session is idle, start the next queued turn; the Git credential is resolved only now, never stored with the queue. */
 async pump(nodeId,runtime,sessionId){
  while(this.online(nodeId)&&!this.active(nodeId,runtime,sessionId)&&!this.waitsForExit(nodeId,runtime,sessionId)){
   const next=this.waiting(nodeId,runtime,sessionId)[0];if(!next)return;
   if(!next.steer&&this.queueState(nodeId,runtime,sessionId).paused)return;
   try{
    const credential=next.control||!this.gitCredential?null:await this.gitCredential(this.settings(nodeId,runtime,sessionId));
    const fresh=this.db.get('nativeTurns',next.id);
    if(!this.online(nodeId)||this.active(nodeId,runtime,sessionId)||this.waitsForExit(nodeId,runtime,sessionId))return;
    if(!fresh||fresh.status!=='waiting'||this.waiting(nodeId,runtime,sessionId)[0]?.id!==next.id)continue;
    this.dispatch(fresh,{gitCredential:credential});return;
   }catch(error){
    const fresh=this.db.get('nativeTurns',next.id);
    // A cancelled or concurrently dispatched message must not be resurrected by a late credential error.
    if(fresh?.status==='waiting'){this.db.put('nativeTurns',{...fresh,status:'failed',error:error.message,endedAt:now(),updatedAt:now()});this.change();}
   }
  }
 }
 /** Steer: this queued message goes first and the current reply is interrupted so it starts at once. */
 steer(nodeId,id){
  const turn=this.db.get('nativeTurns',id);if(!turn||turn.nodeId!==nodeId)throw Error('Takeover turn not found');
  if(turn.status!=='waiting')return nativeTurnView(turn);
  this.db.put('nativeTurns',{...turn,steer:true,steerAt:now(),updatedAt:now()});
  const active=this.active(turn.nodeId,turn.runtime,turn.sessionId);
  if(active&&ACTIVE.has(active.status))this.stop(nodeId,active.id);else{this.change();void this.pump(turn.nodeId,turn.runtime,turn.sessionId);}
  return nativeTurnView(this.db.get('nativeTurns',id));
 }
 cancelWaiting(nodeId,runtime,sessionId,reason){
  let changed=false;
  for(const t of this.waiting(nodeId,runtime,sessionId)){this.db.put('nativeTurns',{...t,status:'cancelled',error:reason||null,endedAt:now(),updatedAt:now()});changed=true;}
  return changed;
 }
 /** Workers download only the attachments bound to an unfinished turn. */
 attachmentFor(turnId,attachmentId){const turn=this.db.get('nativeTurns',turnId);if(!turn||!(ACTIVE.has(turn.status)||turn.status==='stopping')||!turn.attachments?.some(a=>a.id===attachmentId))throw Error('Attachment does not belong to an unfinished takeover turn');return {owner:NativeTurnsHome.owner(turn.nodeId),id:attachmentId};}
 stop(nodeId,id){
  const turn=this.db.get('nativeTurns',id);if(!turn||turn.nodeId!==nodeId)throw Error('Takeover turn not found');
  if(turn.status==='waiting'){this.db.put('nativeTurns',{...turn,status:'cancelled',withdrawn:true,endedAt:now(),updatedAt:now()});this.change();return nativeTurnView(this.db.get('nativeTurns',id));}
  if(!ACTIVE.has(turn.status))return nativeTurnView(turn);
  this.db.put('nativeTurns',{...turn,status:'stopping',updatedAt:now()});this.send(nodeId,{type:'native_turn_stop',id});this.change();return nativeTurnView(this.db.get('nativeTurns',id));
 }
 /** The page's answer to the CLI's question: forwarded to the Worker, the card leaves the page at once, the CLI's own resolution clears the record. */
 answer(nodeId,id,body){
  const turn=this.db.get('nativeTurns',id);if(!turn||turn.nodeId!==nodeId)throw Error('Takeover turn not found');
  const q=turn.question;if(!q||q.answered||!ACTIVE.has(turn.status))throw Error('This question is no longer waiting for an answer');
  if(body?.questionId&&String(body.questionId)!==q.id)throw Error('This question is no longer waiting for an answer');
  const skip=body?.skip===true,answers={};
  if(!skip){const given=body?.answers;if(!given||typeof given!=='object'||Array.isArray(given))throw Error('Enter an answer');
   for(const question of q.questions){const value=[].concat(given[question.id]??[]).filter(v=>typeof v==='string').map(v=>v.trim().slice(0,4000)).filter(Boolean);if(value.length)answers[question.id]=value.slice(0,8);}
   if(!Object.keys(answers).length)throw Error('Enter an answer');}
  if(!this.online(nodeId))throw Error('Device offline or not connected');
  this.send(nodeId,{type:'native_turn_answer',id,questionId:q.id,answers,skip});
  this.db.put('nativeTurns',{...turn,question:{...q,answered:true,answers,skip},updatedAt:now()});this.change();
  return nativeTurnView(this.db.get('nativeTurns',id));
 }
 /** Delete or edit a queued message: it leaves the queue only while still waiting, so a message that has just started is never interrupted. */
 withdraw(nodeId,id){
  const turn=this.db.get('nativeTurns',id);if(!turn||turn.nodeId!==nodeId)throw Error('Takeover turn not found');
  if(turn.status!=='waiting')throw Error('This message has already been sent');
  this.db.put('nativeTurns',{...turn,status:'cancelled',withdrawn:true,endedAt:now(),updatedAt:now()});this.queueState(turn.nodeId,turn.runtime,turn.sessionId);this.change();
  return nativeTurnView(this.db.get('nativeTurns',id));
 }
 /** Ending takeover closes the resident CLI; an unfinished turn is stopped first by the Worker. */
 release(nodeId,{runtime,sessionId}={}){
  if(!NATIVE_TURN_RUNTIMES.includes(runtime)||!idPattern.test(sessionId||''))throw Error('Invalid native session');
  const key=sessionKey(nodeId,runtime,sessionId),current=this.db.get('nativeTakeovers',key);
  this.cancelWaiting(nodeId,runtime,sessionId,'Takeover ended before this message was sent');
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
  if(m.type==='native_takeover_closed'){const key=sessionKey(nodeId,m.runtime,m.sessionId),current=this.db.get('nativeTakeovers',key);if(!current||this.leases&&current.leaseId!==m.leaseId||current.status==='closed')return true;
   // The CLI process going away (finished, idled out, crashed) is not the end of the queue: the next message, or a paused queue
   // once resumed, starts a fresh process. Only ending the takeover or losing the device (status 'closing') drops the queue, and
   // those paths cancelled it themselves.
   const resumeQueue=current.status!=='closing';
   this.leases?.closed(nodeId,m);this.db.put('nativeTakeovers',{...current,status:'closed',reason:m.reason||null,updatedAt:now()});this.change();if(resumeQueue)void this.pump(nodeId,m.runtime,m.sessionId);return true;}
  if(m.type==='native_takeover_lease'){this.leases?.update(nodeId,m);this.change();return true;}
  const turn=this.db.get('nativeTurns',m.id);if(!turn||turn.nodeId!==nodeId)return false;
  const next=applyNativeTurnEvent(turn,m.event);if(next!==turn)this.db.put('nativeTurns',next);
  if(next.handoffId&&next.inputDeliveryState==='accepted')this.db.put('nativeHandoffDeliveries',{id:`${nodeId}/${next.handoffId}/${turn.sessionId}`,nodeId,runtime:turn.runtime,sessionId:turn.sessionId,handoffId:next.handoffId,deliveredAt:now()});
  // Only explicit input acceptance proves delivery: interruption can also happen before any input is sent.
  if(next.instructionsVersion===PAGE_INSTRUCTIONS_VERSION&&next.inputDeliveryState==='accepted'&&turn.inputDeliveryState!=='accepted'){const key=sessionKey(nodeId,turn.runtime,turn.sessionId);this.db.put('nativePageInstructions',{id:key,nodeId,runtime:turn.runtime,sessionId:turn.sessionId,version:next.instructionsVersion,deliveredAt:now()});}
  if(next.status!==turn.status){if(!ACTIVE.has(next.status)&&next.status!=='stopping'){
   const key=sessionKey(nodeId,turn.runtime,turn.sessionId),current=this.db.get('nativeTakeovers',key);
   if(this.leases&&m.event.resident===false&&current?.status==='open'&&this.process(nodeId,turn.runtime,turn.sessionId)){
    // The process is retiring however the turn ended; queued messages wait for its exit and then start a fresh process.
    this.db.put('nativeTakeovers',{...current,status:'retiring',updatedAt:now()});
   }
   // One failed reply never drops the queue. Two in a row that failed before the CLI produced anything mean the process
   // cannot start (login expired, binary gone): the rest would fail the same way one by one, so they are cancelled with the reason.
   // An explicit per-input rejection is not a startup failure; a later input can still be accepted.
   const silent=t=>t.status==='failed'&&!(t.runtime==='claude'&&t.inputDeliveryState==='not_delivered'&&['refused','discarded'].includes(t.inputRejection))&&!(t.events||[]).some(e=>['message','text','tool'].includes(e.type));
   if(silent(next)){const previous=nativeTurnRows(this.db,{nodeId,runtime:turn.runtime,sessionId:turn.sessionId,limit:10}).find(t=>t.id!==turn.id&&t.endedAt&&t.status!=='cancelled');
    if(previous&&silent(previous))this.cancelWaiting(nodeId,turn.runtime,turn.sessionId,`The CLI did not start twice in a row${next.error?` (${next.error})`:''}; queued messages were not sent`);}
   void this.pump(nodeId,turn.runtime,turn.sessionId);
  }this.change();}
  return true;
 }
 /** After a Home restart no Worker connection carries an unfinished turn any more. */
 recover(){for(const t of this.db.db.prepare("SELECT data FROM records WHERE kind='nativeTurns' AND json_extract(data,'$.status')='waiting'").all().map(r=>JSON.parse(r.data)))this.db.put('nativeTurns',{...t,status:'cancelled',error:'Home restarted before this message was sent',endedAt:now(),updatedAt:now()});for(const t of nativeTurnRows(this.db,{active:true,limit:-1}))this.db.put('nativeTurns',{...t,status:this.leases?'stopping':'interrupted',phase:null,error:'Home restarted; awaiting process verification',...(!this.leases?{endedAt:now()}:{})});for(const p of this.db.list('nativeTakeovers'))if(p.status==='open')this.db.put('nativeTakeovers',{...p,status:this.leases?'closing':'closed',reason:'home_restart'});}
 /**
  * A lost Worker connection no longer ends its turns at once: the Worker keeps them running for NATIVE_RECONNECT_GRACE_MS and
  * buffers their events, so a tunnel blip costs nothing. Turns and queued messages are marked disconnected for the page; if
  * the Worker is not back within NATIVE_DISCONNECT_EXPIRE_MS they end as they used to.
  */
 disconnected(nodeId,{expireMs=NATIVE_DISCONNECT_EXPIRE_MS}={}){
  let changed=false;const at=now();
  for(const t of nativeTurnRows(this.db,{nodeId,active:true,limit:-1}))if(!t.disconnectedAt){this.db.put('nativeTurns',{...t,disconnectedAt:at});changed=true;}
  for(const t of this.db.db.prepare("SELECT data FROM records WHERE kind='nativeTurns' AND json_extract(data,'$.nodeId')=? AND json_extract(data,'$.status')='waiting'").all(nodeId).map(r=>JSON.parse(r.data)))if(!t.disconnectedAt){this.db.put('nativeTurns',{...t,disconnectedAt:at});changed=true;}
  this.expiry??=new Map();clearTimeout(this.expiry.get(nodeId));
  const timer=setTimeout(()=>{this.expiry.delete(nodeId);this.expireDisconnected(nodeId);},expireMs);timer.unref?.();this.expiry.set(nodeId,timer);
  if(changed)this.change();
 }
 /** The Worker is back and names the turns it still runs: the others ended while it was away; queued messages are sent again. */
 reconnected(nodeId,turnIds=[]){
  clearTimeout(this.expiry?.get(nodeId));this.expiry?.delete(nodeId);
  const alive=new Set(turnIds.map(String)),sessions=new Map();let changed=false;
  for(const t of nativeTurnRows(this.db,{nodeId,active:true,limit:-1})){
   if(!t.disconnectedAt)continue;
   const {disconnectedAt,...rest}=t;
   if(alive.has(t.id))this.db.put('nativeTurns',rest);
   else this.db.put('nativeTurns',{...rest,status:this.leases?'stopping':'interrupted',phase:null,error:'Device reconnected without this turn',...(!this.leases?{endedAt:now()}:{})});
   changed=true;
  }
  for(const t of this.db.db.prepare("SELECT data FROM records WHERE kind='nativeTurns' AND json_extract(data,'$.nodeId')=? AND json_extract(data,'$.status')='waiting'").all(nodeId).map(r=>JSON.parse(r.data))){
   if(t.disconnectedAt){const {disconnectedAt,...rest}=t;this.db.put('nativeTurns',rest);changed=true;}
   sessions.set(sessionKey(nodeId,t.runtime,t.sessionId),t);
  }
  if(changed)this.change();
  for(const t of sessions.values())void this.pump(nodeId,t.runtime,t.sessionId);
 }
 /** The Worker did not come back in time: unsent messages are cancelled and running turns end, as a disconnect always did. */
 expireDisconnected(nodeId){
  let changed=false;for(const t of this.db.db.prepare("SELECT data FROM records WHERE kind='nativeTurns' AND json_extract(data,'$.nodeId')=? AND json_extract(data,'$.status')='waiting'").all(nodeId).map(r=>JSON.parse(r.data))){this.db.put('nativeTurns',{...t,status:'cancelled',error:'Device disconnected before this message was sent',endedAt:now(),updatedAt:now()});changed=true;}
  for(const t of nativeTurnRows(this.db,{nodeId,active:true,limit:-1})){this.db.put('nativeTurns',{...t,status:this.leases?'stopping':'interrupted',phase:null,error:'Device disconnected; awaiting process verification',...(!this.leases?{endedAt:now()}:{})});changed=true;}
  for(const p of this.db.list('nativeTakeovers'))if(p.nodeId===nodeId&&p.status==='open'){this.db.put('nativeTakeovers',{...p,status:this.leases?'closing':'closed',reason:'disconnected'});changed=true;}
  if(changed)this.change();
 }
}

const alive=session=>Boolean(session?.proc&&session.proc.exitCode===null&&session.proc.signalCode===null&&!session.proc.killed);

/** Worker side: one resident CLI per taken-over session (where supported), exact resume in the history's original folder. */
export class NativeTurnRunner{
 constructor({send,createSession,resolveSession,canStart,prepareInputs=async()=>({files:[],images:[]}),cleanup=null,idleMs=NATIVE_IDLE_MS,leases=null,onQuota=()=>{}}){Object.assign(this,{send,createSession,resolveSession,canStart,prepareInputs,cleanup,idleMs,leases,onQuota});this.turns=new Map();this.resident=new Map();this.closing=new Map();this.outbox=null;this.graceTimer=null;}
 /** Messages to Home go out at once while connected and wait in order while Home is away (see suspend/resume). */
 post(m){
  if(!this.outbox)return this.send(m);
  // A full buffer sheds the oldest text, log and tool reports first; status events (how a turn ended) are always kept.
  if(this.outbox.length>=20000){const i=this.outbox.findIndex(x=>x.type==='native_turn_event'&&x.event?.kind!=='status');if(i>=0)this.outbox.splice(i,1);}
  this.outbox.push(m);
 }
 /** Turn ids this Worker still runs, or whose reports still wait in the buffer; sent with the next registration so Home can
  * tell a kept turn from a lost one, and a turn that ended during the blip is settled by its own buffered status, not as lost. */
 activeIds(){const ids=new Set(this.turns.keys());for(const m of this.outbox||[])if(m.type==='native_turn_event'&&m.id)ids.add(m.id);return [...ids];}
 /**
  * Home went away: keep the CLIs running and buffer what they report. A connection blip on a lossy tunnel then costs nothing.
  * If Home is not back within graceMs the turns end as a disconnect always ended them, and the buffered events tell Home so.
  */
 suspend({graceMs=NATIVE_RECONNECT_GRACE_MS}={}){if(this.outbox)return;this.outbox=[];this.graceTimer=setTimeout(()=>{this.graceTimer=null;void this.stopAll();},graceMs);this.graceTimer.unref?.();}
 /** Home is back and this Worker is registered: deliver what happened meanwhile, in order. */
 resume(){clearTimeout(this.graceTimer);this.graceTimer=null;const queued=this.outbox||[];this.outbox=null;for(const m of queued)this.send(m);}
 /** CLI slots: each resident process counts once, plus per-turn processes that are not resident. */
 get size(){return this.resident.size+[...this.turns.values()].filter(t=>!t.resident).length;}
 holds(runtime,sessionId){return this.resident.has(`${runtime}/${sessionId}`)||[...this.turns.values()].some(t=>t.key===`${runtime}/${sessionId}`);}
 event(id,event){this.post({type:'native_turn_event',id,event:{...event,...(typeof event.text==='string'?{text:event.text.slice(-MAX_TEXT)}:{}),...(event.item?{item:boundedItem(event.item)}:{})}});}
 /** A production lease remains occupied until its exact process tree has exited. */
 close(key,reason){const entry=this.resident.get(key);if(!entry)return this.closing.get(key);clearTimeout(entry.timer);entry.closing=true;
  const finish=()=>{if(this.resident.get(key)===entry)this.resident.delete(key);for(const state of this.turns.values())if(state.key===key&&state.session===entry.session)state.finish?.('interrupted');const [runtime,sessionId]=key.split('/');this.post({type:'native_takeover_closed',runtime,sessionId,reason,...(entry.message?.leaseId?{leaseId:entry.message.leaseId}:{})});};
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
   this.event(m.id,{kind:'status',status:status==='mismatch'?'failed':status,...(error?{error}:{}),resident:Boolean(entry&&entry.session===state.session&&!entry.closing&&alive(entry.session)&&(!this.leases||entry.session.done))});};
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
   const {files=[],images=[],env=null,handoffText=null}=await this.prepareInputs(m,workspace);
   if(state.stopRequested)return end('interrupted');
   if(images.length&&!NATIVE_IMAGE_RUNTIMES.has(m.runtime))throw Error('This CLI cannot receive images in a takeover; send files or use iTerm');
   const others=files.filter(f=>!(m.runtime==='codex'&&f.mime?.startsWith('image/'))&&!(m.runtime==='claude'&&f.mime?.startsWith('image/')));
   const body=[m.prompt,others.length?`Attached files for this message (local paths):\n${others.map(f=>`- ${f.name}: ${f.path}`).join('\n')}`:''].filter(Boolean).join('\n\n');
   const prompt=withPageInstructions(!m.control&&handoffText?`<system-reminder>\nWorkbench Agent handoff:\n${handoffText.replaceAll('<','\\u003c')}\n</system-reminder>\n\n${body}`:body,m.control?null:m.instructions);
   const emit=(type,p={})=>{
    if(type==='quota')return this.onQuota(m.runtime,p,state.session?.quotaIdentity);
    if(ended)return;
    if(type==='status'&&p.nativeSessionId&&p.nativeSessionId!==m.sessionId){void state.session?.stop();return end('mismatch','The CLI resumed a different native session; stopped');}
    // Delivery receipts need not carry a status; forward them before settling a terminal event.
    if(type==='status'&&['accepted','not_delivered'].includes(p.inputDeliveryState))this.event(m.id,{kind:'status',inputDeliveryState:p.inputDeliveryState,...(['refused','discarded'].includes(p.inputRejection)?{inputRejection:p.inputRejection}:{})});
    if(type==='status'&&p.status==='reconciling'){this.event(m.id,{kind:'status',status:'stopping',error:p.error});if(this.leases)void this.close(key,'unconfirmed');return;}
    if(type==='status'&&['succeeded','failed','interrupted'].includes(p.status))return end(p.status,p.error);
    if(type==='status'&&p.status)this.event(m.id,{kind:'status',status:p.status});
    else if(type==='tool'&&p.item)this.event(m.id,{kind:'tool',text:p.text,item:p.item});
    else if(type==='message'&&typeof p.text==='string')this.event(m.id,{kind:'message',text:p.text,phase:p.phase||null});
    else if(type==='text'&&typeof p.text==='string')this.event(m.id,{kind:'text',text:p.text});
    else if(type==='log'&&typeof p.text==='string')this.event(m.id,{kind:'log',text:p.text.slice(0,4000),thinking:/think|\u601d\u8003/i.test(p.text)});
    else if(type==='context_usage'&&p&&typeof p==='object')this.event(m.id,{kind:'context_usage',sample:p});
    else if(type==='question'&&p.id&&Array.isArray(p.questions))this.event(m.id,{kind:'question',id:String(p.id),questions:p.questions});
    else if(type==='question_resolved')this.event(m.id,{kind:'question_resolved',id:p.id==null?null:String(p.id)});
    else if(type==='task'&&p.id)this.event(m.id,{kind:'task',task:p});
   };
   // Model/effort from the Sessions page: flags at spawn for Claude/Agy (Claude later changes them in place), per turn for Codex and Grok.
   const resident=NATIVE_RESIDENT_RUNTIMES.has(m.runtime),inputs={attachments:files,inputImages:images,model:typeof m.model==='string'&&m.model?m.model:null,effort:typeof m.effort==='string'&&m.effort?m.effort:null,control:m.control||null,...(env?{env}:{})};
   if(existing&&alive(existing.session)){clearTimeout(existing.timer);existing.busy=m.id;state.session=existing.session;state.resident=true;existing.session.reuse({emit,...inputs});}
   else{
    if(existing){await this.close(key,'exited');throw Error('The previous CLI exited; retry after its lease is returned');}
    state.session=this.createSession({runtime:m.runtime,cwd:workspace,resumeSessionId:m.sessionId,emit,keepAlive:resident,onProcess:proc=>this.leases?.started(m,proc),beforeInput:()=>this.leases?.validate(m),...inputs});
    if(resident){this.resident.set(key,{session:state.session,busy:m.id,timer:null,message:m});state.resident=true;}
   }
   this.event(m.id,{kind:'status',status:'starting',resident:state.resident});
   // Like group-chat runs: the CLI receives the prose in Traditional Chinese; Home keeps what the user typed, the page shows Simplified.
   await state.session.start(m.control?prompt:traditionalInput(prompt));
   if(state.stopRequested)await state.session.stop();
  }catch(error){end('failed',error.message);}
 }
 /** Stop interrupts the current turn; a resident process stays for the next message where the CLI supports it. */
 async stop(id){const state=this.turns.get(id);if(!state)return;state.stopRequested=true;if(state.session)await state.session.stop();}
 /** The page's answer reaches the session that asked; a stale answer is reported on the turn instead of being dropped silently. */
 answer(id,{questionId=null,answers={},skip=false}={}){
  const state=this.turns.get(id);
  try{if(!state?.session||typeof state.session.answerQuestion!=='function')throw Error('This question is no longer waiting for an answer');state.session.answerQuestion({id:questionId,answers,skip});}
  catch(error){this.event(id,{kind:'log',text:error.message});this.event(id,{kind:'question_resolved',id:questionId});}
 }
 release(runtime,sessionId){const key=`${runtime}/${sessionId}`;for(const [id,state] of this.turns)if(state.key===key)void this.stop(id);return this.close(key,'released');}
 async stopAll(){const active=[...this.turns.entries()];for(const [id]of active)void this.stop(id);await Promise.all([...this.resident.keys()].map(key=>this.close(key,'disconnected')));if(this.leases)await Promise.allSettled(active.filter(([,s])=>!s.resident&&s.acquired).map(([,s])=>this.leases.retire(s.message,s.session)));}
}
