import {readdir,open,realpath,stat,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join,basename,dirname,relative,isAbsolute} from 'node:path';
import {resumeArgs,managedRunProcessState,terminalOwnsProject,nativeSessionProjectIds} from './terminal-resume.mjs';
import {isHistoryPrompt} from '../public/history-prompt.js';

const runtimes=new Set(['codex','claude','grok','agy']);
const idPattern=/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;
const inside=(root,path)=>{const r=relative(root,path);return !r||r!=='..'&&!r.startsWith('../')&&!isAbsolute(r);};

/** A terminal link cannot start a second driver for an occupied history, a project another terminal holds, or a folder a managed run is working in.
 * Two independent native sessions may share a folder (the default folder is shared by design); managed ownership remains exclusive. */
export function assertNativeSessionIdle(db,{runtime,sessionId,workspace,projectId,nodeId,claimId}){
 const overlap=path=>typeof path==='string'&&typeof workspace==='string'&&(inside(path,workspace)||inside(workspace,path));
 // Shared folders are only for independent native sessions, never a managed terminal whose project was rebound elsewhere.
 const independent=s=>['native','native-turn'].includes(s.kind)&&s.projectId?.startsWith('native-tui:')&&!nativeSessionProjectIds(db,{nodeId:s.nodeId,runtime:s.runtime||s.nativeSession?.runtime,sessionId:s.sessionId||s.nativeSession?.id}).length;
 if(db.list('runs').some(r=>r.status==='reconciling'||(!['succeeded','failed','interrupted'].includes(r.status)||managedRunProcessState(r)!=='exited')&&(r.projectId===projectId||overlap(r.workspace)||sessionId&&r.nativeSession?.runtime===runtime&&r.nativeSession?.id===sessionId)))throw Error('This session or folder is still used by a managed CLI; finish it before opening a terminal');
 if(db.list('terminalSessions').some(s=>s.id!==claimId&&(!nodeId||s.nodeId===nodeId)&&!['released','cancelled'].includes(s.status)&&(terminalOwnsProject(db,s,projectId)||overlap(s.workspace)&&(!independent(s)||projectId&&!projectId.startsWith('native-tui:'))||sessionId&&(s.nativeSession?.runtime||s.runtime)===runtime&&(s.nativeSession?.id||s.sessionId)===sessionId)))throw Error('Session is occupied; no second CLI was started');
}

/** Exact registered histories must remain inside the configured vendor directory. */
function historyRoots(runtime,env){
 if(!runtimes.has(runtime))throw Error('Unsupported CLI');
 const home=env.HOME||homedir();
 return {codex:[join(env.CODEX_HOME||join(home,'.codex'),'sessions'),join(env.CODEX_HOME||join(home,'.codex'),'archived_sessions')],claude:[join(env.CLAUDE_CONFIG_DIR||join(home,'.claude'),'projects')],grok:[join(home,'.grok','sessions')],agy:[join(home,'.gemini','antigravity-cli','conversations')]}[runtime];
}

/** Bounded reads avoid loading complete transcripts; partial JSON lines are deliberately discarded. */
async function readWindow(file,root,tail=false,limit=131072){
 if(!inside(await realpath(root),await realpath(file)))throw Error('History outside CLI directory');
 const h=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const info=await h.stat();if(!info.isFile())throw Error('Not a history file');const start=tail?Math.max(0,info.size-limit):0,b=Buffer.alloc(Math.min(info.size,limit));const{bytesRead}=await h.read(b,0,b.length,start);let text=b.subarray(0,bytesRead).toString('utf8');if(start)text=text.slice(text.indexOf('\n')+1);return {text,partial:info.size>limit,modifiedAt:info.mtime.toISOString()};}finally{await h.close();}
}
const jsonLines=text=>text.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
const bodyText=content=>typeof content==='string'?content:Array.isArray(content)?content.map(c=>typeof c?.text==='string'?c.text:'').filter(Boolean).join('\n'):'';
// Claude Code 2.1.303 also records api-request-blob rows carrying the same message bodies; only the conversation rows count.
const claudeMessage=row=>['user','assistant'].includes(row.type)?row.message:null;
const clip=(value,limit)=>{const s=typeof value==='string'?value:value==null?'':JSON.stringify(value);return s.length>limit?`${s.slice(0,limit)}…`:s;};
const toolText=content=>typeof content==='string'?content:Array.isArray(content)?content.map(c=>typeof c?.text==='string'?c.text:typeof c?.output==='string'?c.output:'').filter(Boolean).join('\n'):content==null?'':JSON.stringify(content);
/** Tool inputs keep their shape (paths, commands, edits) with long fields cut, so the page can classify the step without the whole payload. */
const clipInput=value=>{
 if(value&&typeof value==='object'&&!Array.isArray(value)){const out={};for(const [k,v] of Object.entries(value))out[k]=typeof v==='string'?clip(v,4000):v;return JSON.stringify(out).length>16000?{raw:clip(JSON.stringify(out),4000)}:out;}
 return value==null?null:clip(value,4000);
};
// Codex custom "exec" calls carry a script; show the command it runs when it can be read, the script otherwise.
const codexInput=p=>{if(p.type==='local_shell_call')return {command:p.action?.command};if(p.type==='function_call')return p.arguments;const code=typeof p.input==='string'?p.input:'';const cmd=code.match(/exec_command\(\{\s*cmd\s*:\s*(["'`])([\s\S]*?)\1/);return cmd?{command:cmd[2]}:p.input;};
const call=(callId,name,input,at)=>({role:'tool_call',callId:String(callId||''),name:String(name||'tool'),input:clipInput(input),timestamp:at});
const result=(callId,output,failed,at)=>({role:'tool_result',callId:String(callId||''),output:clip(toolText(output),4000),failed:failed===true,timestamp:at});
/** Conversation rows plus the tool calls and results between them; the page pairs them and shows each turn like a page turn. */
function messagesFrom(rows,runtime){return rows.flatMap(row=>{
 const at=row.timestamp||null,out=[],say=(role,content)=>{const text=bodyText(content);if(text)out.push({role,text:text.slice(0,12000),timestamp:at});};
 if(runtime==='claude'){
  // Meta user rows are context Claude Code injects (image descriptions, command caveats), never something the user typed.
  const m=row.isSidechain===true||row.isMeta===true?null:claudeMessage(row);if(!m||!['user','assistant'].includes(m.role))return [];
  say(m.role,m.content);
  for(const b of Array.isArray(m.content)?m.content:[]){if(b?.type==='tool_use')out.push(call(b.id,b.name,b.input,at));else if(b?.type==='tool_result')out.push(result(b.tool_use_id,b.content,b.is_error,at));}
 }else if(runtime==='codex'){
  if(row.type!=='response_item')return [];const p=row.payload||{};
  if(p.type==='message'){if(['user','assistant'].includes(p.role))say(p.role,p.content);}
  else if(['function_call','custom_tool_call','local_shell_call'].includes(p.type))out.push(call(p.call_id||p.id,p.name||(p.type==='local_shell_call'?'shell':p.type),codexInput(p),at));
  else if(['function_call_output','custom_tool_call_output','local_shell_call_output'].includes(p.type))out.push(result(p.call_id,p.output,false,at));
 }else if(runtime==='grok'){
  if(row.type==='tool_result')out.push(result(row.tool_call_id,row.content,false,at));
  else if(['user','assistant'].includes(row.type)){say(row.type,row.content);for(const c of Array.isArray(row.tool_calls)?row.tool_calls:[])out.push(call(c.id,c.name||c.function?.name,c.arguments??c.function?.arguments,at));}
 }
 return out;
});}
export const historyMessages=messagesFrom;

/** Display only explicitly recorded settings from the bounded latest history, never a CLI/account default. */
function sessionConfiguration(rows,runtime){
 const text=value=>typeof value==='string'&&value.trim()&&value.length<=160?value.trim():null;
 // Claude records request usage on each assistant row: the last one is the session's context size when it was written.
 let contextTokens=null,contextAt=null;
 if(runtime==='claude')for(const row of rows.toReversed()){const u=claudeMessage(row)?.role==='assistant'?row.message.usage:null;if(!u||row.parent_tool_use_id||row.parentToolUseId)continue;const parts=[u.input_tokens,u.cache_creation_input_tokens??0,u.cache_read_input_tokens??0];if(parts.every(v=>Number.isSafeInteger(v)&&v>=0)){contextTokens=parts.reduce((a,b)=>a+b,0);contextAt=text(row.timestamp);break;}}
 const withContext=value=>({...value,contextTokens,contextAt});
 for(const row of rows.toReversed()){
  const value=runtime==='codex'&&row.type==='turn_context'?row.payload:runtime==='claude'&&claudeMessage(row)?.role==='assistant'?row.message:runtime==='grok'&&row.type==='assistant'?row:null;
  if(!value||runtime!=='codex'&&!text(value.model))continue;
  const model=text(value.model),effort=text(value.effort??value.reasoning_effort);
  return withContext({model:model?.startsWith('<')?null:model,effort:effort&&/^(?:none|minimal|low|medium|high|xhigh|max|ultra|auto|default)$/.test(effort)?effort:null,observedAt:text(row.timestamp)});
 }
 return withContext({model:null,effort:null,observedAt:null});
}

const fileStamp=info=>info?[info.dev,info.ino,info.birthtimeMs,info.size,info.mtimeMs,info.ctimeMs,info.mode].join(':'):null;
function remember(cache,key,value,limit){cache.delete(key);cache.set(key,value);if(cache.size>limit)cache.delete(cache.keys().next().value);}

/** Consult only an exact ID's index entry/path; missing metadata never triggers a history-directory walk. */
async function registeredFile(runtime,id,env,record){
 if(!record||(record.sessionId||record.nativeSessionId||record.id)!==id||record.runtime&&record.runtime!==runtime)throw Error('Session is not registered with Workbench');
 const roots=historyRoots(runtime,env),paths=[];
 if(runtime==='codex'){
  const home=dirname(roots[0]);
  // Enumerate index filenames only, never sessions/ or archived_sessions/ or transcript rows.
  const indexes=(await readdir(home).catch(e=>{if(e.code==='ENOENT')return [];throw e;})).filter(name=>/^state_\d+\.sqlite$/.test(name)).sort((a,b)=>Number(b.match(/\d+/)[0])-Number(a.match(/\d+/)[0]));
  for(const name of indexes){
   const path=join(home,name);if(!(await lstat(path)).isFile())continue;
   const db=new DatabaseSync(path,{readOnly:true});
   try{const row=db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(id);if(row?.rollout_path&&basename(row.rollout_path).endsWith(`-${id}.jsonl`))paths.push(row.rollout_path);}
   finally{db.close();}
   if(paths.length)break;
  }
 }else if(runtime==='claude'){
  if(typeof record.workspace==='string'&&isAbsolute(record.workspace))paths.push(join(roots[0],record.workspace.replace(/[^a-zA-Z0-9]/g,'-'),`${id}.jsonl`));
 }else if(runtime==='grok'){
  if(typeof record.workspace==='string'&&isAbsolute(record.workspace))paths.push(join(roots[0],encodeURIComponent(record.workspace),id,'chat_history.jsonl'));
  paths.push(join(roots[0],id,'chat_history.jsonl'));
 }
 else for(const ext of ['jsonl','db','pb'])paths.push(join(roots[0],`${id}.${ext}`));
 const files=[];
 for(const path of paths){
  const root=roots.find(root=>inside(root,path));if(!root)throw Error('History outside CLI directory');
  let info;try{info=await lstat(path);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(!info.isFile()||!inside(await realpath(root),await realpath(path)))throw Error('History outside CLI directory');
  files.push({id,path,root,modifiedAt:info.mtime.toISOString()});
 }
 return files.sort((a,b)=>b.modifiedAt.localeCompare(a.modifiedAt))[0]||null;
}

/** Shared by registered history reads and saved terminal/managed resume admission. */
export async function registeredNativeHistoryFile(runtime,id,{env=process.env,record}={}){
 if(!idPattern.test(id||''))throw Error('Invalid native session ID');
 return registeredFile(runtime,id,env,record);
}

/** Worker-side provenance comes from durable Workbench records, never transcript contents or titles. */
export function registeredNativeSession(db,runtime,sessionId){
 const catalog=db.list('nativeCatalogEntries').find(r=>r.runtime===runtime&&r.sessionId===sessionId);
 if(catalog)return {...catalog,sessionId};
 const run=db.list('runs').find(r=>r.nativeSession?.runtime===runtime&&r.nativeSession.id===sessionId);
 if(run)return {runtime,sessionId,workspace:run.workspace,createdAt:run.createdAt};
 const lease=db.list('terminalSessions').find(r=>['native','native-turn'].includes(r.kind)&&(r.runtime||r.nativeSession?.runtime)===runtime&&(r.sessionId||r.nativeSession?.id||r.nativeOptions?.freshId)===sessionId);
 return lease?{runtime,sessionId,workspace:lease.workspace,createdAt:lease.createdAt}:null;
}

async function describeUncached(runtime,file){
 const row={id:file.id,runtime,title:file.id,workspace:null,modifiedAt:file.modifiedAt,previewAvailable:!file.path.endsWith('.db')&&!file.path.endsWith('.pb')};
 if(!row.previewAvailable)return row;
 const lines=jsonLines((await readWindow(file.path,file.root)).text);
 row.workspace=lines.find(x=>x.type==='session_meta')?.payload?.cwd||lines.find(x=>typeof x.cwd==='string')?.cwd||null;
 row.title=messagesFrom(lines,runtime).find(m=>m.role==='user')?.text.replace(/\s+/g,' ').slice(0,100)||file.id;
 if(runtime==='grok'){
  try{row.workspace=JSON.parse((await readWindow(join(dirname(file.path),'prompt_context.json'),file.root)).text).working_directory||row.workspace;}catch{}
  try{const meta=JSON.parse((await readWindow(join(dirname(file.path),'summary.json'),file.root)).text);row.title=meta.generated_title||row.title;}catch{}
 }
 return row;
}

const descriptionCache=new Map();
/** Cache only summaries, checking current file identity, change times and Grok sidecars on every read. */
async function describe(runtime,file){
 const info=await lstat(file.path);if(!info.isFile())throw Error('Not a history file');
 if(!inside(await realpath(file.root),await realpath(file.path)))throw Error('History outside CLI directory');
 const sidecars=runtime==='grok'?await Promise.all(['prompt_context.json','summary.json'].map(async name=>{try{return fileStamp(await lstat(join(dirname(file.path),name)));}catch(error){return error.code;}})):[];
 const key=JSON.stringify([runtime,file.root,file.path]),stamp=JSON.stringify([fileStamp(info),...sidecars]),prior=descriptionCache.get(key);
 if(prior&&prior.stamp===stamp&&Date.now()-prior.at<20000){remember(descriptionCache,key,prior,500);return {...await prior.value};}
 const entry={at:Date.now(),stamp,value:describeUncached(runtime,{...file,modifiedAt:info.mtime.toISOString()})};remember(descriptionCache,key,entry,500);
 try{return {...await entry.value};}catch(error){if(descriptionCache.get(key)===entry)descriptionCache.delete(key);throw error;}
}

const nativeView=(history,{nodeId=null,runtime=history?.runtime,origin='vendor',title=null,createdAt=null,id=history?.id,sessionId=history?.id,status=history?'ready':'missing_history',workspace=null,exactLastScan=null,branchOf=null}={})=>({
 id,...(origin==='dialog'?{entryId:id}:{}),nodeId,runtime,sessionId:sessionId||null,title:title||history?.title||sessionId||id,
 createdAt:createdAt||null,modifiedAt:history?.modifiedAt||createdAt||null,workspace:workspace||history?.workspace||null,origin,status,
 hasHistory:Boolean(history),previewAvailable:Boolean(history?.previewAvailable),canReopen:origin==='dialog'&&status==='draft',canResume:Boolean(history)&&!['active','prepared'].includes(status),exactLastScan,...(branchOf?.sessionId?{branchOf:{sessionId:branchOf.sessionId}}:{}),...(history?.error?{error:history.error}:{})
});

/** Native history remains on its device; every filtered item is matched by an exact native ID. */
export async function listNativeSessions(runtime,{env=process.env,limit=100,scope='all',registry=[],managedSessions=[],adoptedSessions=[],nodeId=null}={}){
 if(!['created','group','all'].includes(scope))throw Error('Invalid native session scope');
 historyRoots(runtime,env);
 const dialogRecords=registry.filter(record=>record?.runtime===runtime),records=scope==='group'?managedSessions:dialogRecords;
 const described=new Map();
 const history=async(id,record)=>{
  if(!idPattern.test(id||''))return null;
  if(!described.has(id)){try{const file=await registeredFile(runtime,id,env,record);described.set(id,file?await describe(runtime,file):null);}catch{described.set(id,{id,runtime,title:id,modifiedAt:null,workspace:null,previewAvailable:false,error:'Registered history could not be read'});}}
  return described.get(id);
 };
 let items=[];
 if(scope==='created'){
  for(const record of records){
   const entryId=record.entryId||record.id;if(typeof entryId!=='string'||!entryId)continue;
   const exact=await history(record.sessionId,record),status=exact?(record.status==='active'||record.status==='prepared'?record.status:'ready'):record.sessionId?(record.status==='active'||record.status==='prepared'||record.status==='draft'?record.status:'awaiting_history'):(record.status||'awaiting_native_id');
   items.push(nativeView(exact,{nodeId,runtime,origin:'dialog',id:entryId,sessionId:record.sessionId,title:record.title,createdAt:record.createdAt,status,workspace:record.workspace,exactLastScan:record.exactLastScan,branchOf:record.branchOf}));
  }
 }else if(scope==='group'){
  for(const record of managedSessions){
   const sessionId=record?.sessionId||record?.id;if(!idPattern.test(sessionId||''))continue;
   const exact=await history(sessionId,record);items.push(nativeView(exact,{nodeId,runtime,origin:'managed',id:sessionId,sessionId,title:record.title,createdAt:record.createdAt,status:exact?'ready':'missing_history',workspace:record.workspace}));
  }
 }else{
  const managedIds=new Set(managedSessions.map(record=>record?.sessionId||record?.id).filter(id=>idPattern.test(id||''))),dialogIds=new Set(dialogRecords.map(record=>record.sessionId).filter(id=>idPattern.test(id||'')));
  for(const record of dialogRecords){const entryId=record.entryId||record.id;if(typeof entryId!=='string'||!entryId)continue;const exact=await history(record.sessionId,record),status=exact?(record.status==='active'||record.status==='prepared'?record.status:'ready'):record.sessionId?(record.status==='active'||record.status==='prepared'||record.status==='draft'?record.status:'awaiting_history'):(record.status||'awaiting_native_id');items.push(nativeView(exact,{nodeId,runtime,origin:'dialog',id:entryId,sessionId:record.sessionId,title:record.title,createdAt:record.createdAt,status,workspace:record.workspace,exactLastScan:record.exactLastScan,branchOf:record.branchOf}));}
  for(const record of adoptedSessions){const id=record.sessionId;if(!idPattern.test(id||'')||managedIds.has(id)||dialogIds.has(id)||record.runtime!==runtime)continue;items.push(nativeView(await history(id,record),{nodeId,runtime,origin:'takeover',id,sessionId:id,workspace:record.workspace,createdAt:record.createdAt}));}
 }
 items.sort((a,b)=>String(b.modifiedAt||b.createdAt||'').localeCompare(String(a.modifiedAt||a.createdAt||'')));
 return {items:items.slice(0,limit),partial:items.length>limit};
}

/**
 * One history page: up to 45 prompts, 768 KB of preview rows and 3 MB of raw history read backwards. Raw Claude histories
 * carry request blobs close to 1 MB that yield no rows, so the read window bounds most pages. The rows travel in a single
 * Worker→Home socket message, which is capped at 1 MB.
 */
export const HISTORY_PAGE=Object.freeze({prompts:45,bytes:786432,window:6291456,lookback:33554432,lookbackChunk:1048576});

/**
 * A page that starts inside a turn (its prompt is on an older page) still shows how long that turn took: look back from
 * the page start for the nearest row that starts a turn and return its time. The look-back reads at most `lookback`
 * bytes. Histories only grow, so the answer for a start offset holds for any later start with no prompt in between:
 * the latest answer per history is kept, and the 30-second refresh of the latest page only reads what was appended.
 */
const lookbacks=new Map();
async function promptBefore(h,runtime,offset,limits,{key,mark}){
 // A cached answer stands while the bytes just before its offset are unchanged (the history was not rewritten).
 // An answer is reused only under the same look-back budget: "not found within it" is an answer too.
 const cached=lookbacks.get(key),intact=Boolean(cached)&&cached.budget===limits.lookback&&cached.mark===await mark(cached.offset),usable=intact&&cached.offset<=offset;
 const found=await scanBack(h,runtime,offset,usable?cached.offset:0,limits);
 // Nothing between the cached start and this one: the turn began where the cached answer says.
 const at=found!==undefined?found:usable?cached.at:null;
 // Older pages read once; only the latest start (or a replacement for a stale entry) is kept for the refreshes.
 if(!intact||offset>=cached.offset){lookbacks.delete(key);lookbacks.set(key,{offset,at,budget:limits.lookback,mark:await mark(offset)});if(lookbacks.size>64)lookbacks.delete(lookbacks.keys().next().value);}
 return at;
}
/** Read backwards from `offset` to `floor` line by line; the time of the nearest turn-starting row, null when the budget ran out, undefined when none lies in range. */
async function scanBack(h,runtime,offset,floor,limits){
 let end=offset,carry=Buffer.alloc(0),scanned=0;
 while(end>floor){
  if(scanned>=limits.lookback)return null;
  const start=Math.max(floor,end-limits.lookbackChunk),chunk=Buffer.alloc(end-start);await h.read(chunk,0,chunk.length,start);scanned+=chunk.length;
  const buffer=carry.length?Buffer.concat([chunk,carry]):chunk;let pos=buffer.length;
  while(pos>0){
   let lineEnd=pos;while(lineEnd>0&&[10,13].includes(buffer[lineEnd-1]))lineEnd--;
   if(!lineEnd){pos=0;break;}
   const lf=buffer.lastIndexOf(10,lineEnd-1);
   if(lf<0&&start>floor){pos=lineEnd;break;} // An incomplete line: finish it with the next, older chunk.
   const rows=messagesFrom(jsonLines(buffer.subarray(lf+1,lineEnd).toString('utf8')),runtime);
   for(let i=rows.length-1;i>=0;i--)if(rows[i].role==='user'&&isHistoryPrompt(rows[i].text))return rows[i].timestamp||null;
   pos=Math.max(0,lf);
  }
  carry=buffer.subarray(0,pos);end=start;
 }
 return undefined;
}

/** Read backwards at line boundaries, pinning the original tail while a live CLI appends.
 * Cursors select offsets only inside this exact vendor file; each page has bounded I/O and wire size. */
async function historyPage(file,runtime,id,cursor,snapshot,limits=HISTORY_PAGE){
 if(!inside(await realpath(file.root),await realpath(file.path)))throw Error('History outside CLI directory');
 const h=await open(file.path,constants.O_RDONLY|constants.O_NOFOLLOW),hash=value=>createHash('sha256').update(value).digest('hex');
 try{
  const info=await h.stat();if(!info.isFile())throw Error('Not a history file');
  const key=hash(JSON.stringify([runtime,id,file.path,info.dev,info.ino,info.birthtimeMs]));
  let prior=null;
  const token=cursor||snapshot;if(cursor&&snapshot)throw Error('Invalid native history cursor');
  if(token){try{if(typeof token!=='string'||token.length>2048)throw Error();prior=JSON.parse(Buffer.from(token,'base64url'));if(!prior||typeof prior!=='object'||Array.isArray(prior))throw Error();}catch{throw Error('Invalid native history cursor');}}
  let size=prior?.size??info.size,end=prior?.end??size;
  if(prior&&(prior.v!==1||prior.key!==key)||!Number.isSafeInteger(size)||!Number.isSafeInteger(end)||size<0||size>info.size||end<0||end>size)throw Error('Native history changed; reopen the session to read it again.');
  const tailAt=async boundary=>{const b=Buffer.alloc(Math.min(256,boundary));await h.read(b,0,b.length,boundary-b.length);return hash(b);};
  let tail=await tailAt(size);
  if(prior&&prior.tail!==tail)throw Error('Native history changed; reopen the session to read it again.');
  // Quiet refresh must verify the previous snapshot, even when its last page had no older cursor.
  if(snapshot){size=info.size;end=size;tail=await tailAt(size);}
  const start=Math.max(0,end-limits.window),buffer=Buffer.alloc(end-start);await h.read(buffer,0,buffer.length,start);
  let pos=buffer.length,next=end,bytes=0,prompts=0;const messages=[];
  while(pos>0){
   let lineEnd=pos;while(lineEnd>0&&[10,13].includes(buffer[lineEnd-1]))lineEnd--;
   if(!lineEnd){next=start;break;}
   const lf=buffer.lastIndexOf(10,lineEnd-1),lineStart=lf+1;
   if(lf<0&&start>0)break; // Retry this incomplete leading line from its end on the next page.
   const found=messagesFrom(jsonLines(buffer.subarray(lineStart,lineEnd).toString('utf8')),runtime).map((m,index)=>({...m,id:`${id}:${start+lineStart}${index?`:${index}`:''}`,offset:start+lineStart}));
   const weight=Buffer.byteLength(JSON.stringify(found));
   // Pages are sized by prompts, not by tool rows, so a turn with many tool calls still reads as one page.
   if(found.length&&(prompts>=limits.prompts||bytes+weight>limits.bytes))break;
   messages.unshift(...found);bytes+=weight;prompts+=found.filter(m=>m.role==='user').length;next=start+lineStart;pos=Math.max(0,lf);
  }
  if(next===end&&end>0)throw Error('A native history record is too large to preview; the original history is unchanged.');
  // The first rows belong to a turn whose prompt is further back when a reply or tool call comes before any prompt.
  const firstPrompt=messages.findIndex(m=>m.role==='user'&&isHistoryPrompt(m.text));
  const midTurn=next>0&&messages.slice(0,firstPrompt<0?messages.length:firstPrompt).some(m=>m.role==='assistant'||m.role==='tool_call');
  const turnStartedAt=midTurn?await promptBefore(h,runtime,next,limits,{key,mark:tailAt}):null;
  const after=await stat(file.path);if(after.dev!==info.dev||after.ino!==info.ino||after.size<size)throw Error('Native history changed; reopen the session to read it again.');
  const encode=offset=>Buffer.from(JSON.stringify({v:1,key,size,end:offset,tail})).toString('base64url');
  return {messages,historyPage:1,historySnapshot:encode(size),hasMore:next>0,nextCursor:next>0?encode(next):null,partial:next>0,...(turnStartedAt?{turnStartedAt}:{}),
   ...(!cursor?{sessionConfiguration:sessionConfiguration(jsonLines(buffer.subarray(start?(buffer.indexOf(10)<0?buffer.length:buffer.indexOf(10)+1):0).toString('utf8')),runtime)}:{})};
 }finally{await h.close();}
}

/** Resume and preview resolve an exact native ID on the selected device, never a filename from the client. */
export async function readNativeSession(runtime,id,{env=process.env,record=null,historyPage:paged=false,cursor=null,snapshot=null,pageLimits=HISTORY_PAGE}={}){
 if(!idPattern.test(id||''))throw Error('Invalid native session ID');
 const file=await registeredFile(runtime,id,env,record);if(!file)throw Error('Registered native session history is unavailable; no external histories were scanned');
 const info=await describe(runtime,file);if(!info.previewAvailable)return {...info,messages:[],notice:'This CLI history format has no text preview. Continue in the native terminal.'};
 if(paged)return {...info,...await historyPage(file,runtime,id,cursor,snapshot,pageLimits)};
 const window=await readWindow(file.path,file.root,true,524288),rows=jsonLines(window.text),messages=messagesFrom(rows,runtime);
 const texts=messages.filter(m=>m.role==='user'||m.role==='assistant'),from=texts.length>80?messages.indexOf(texts.at(-80)):0;
 return {...info,messages:messages.slice(from),sessionConfiguration:sessionConfiguration(rows,runtime),partial:window.partial||texts.length>80};
}

/** Native defaults stay intact unless the user explicitly opts into unrestricted execution. */
export function nativeTuiArgs(runtime,{id,freshId=null,allowAll=false}={}){
 if(!runtimes.has(runtime)||typeof allowAll!=='boolean')throw Error('Invalid CLI or permission mode');
 if(id&&freshId)throw Error('A native session cannot resume and create at the same time');
 if(freshId&&!idPattern.test(freshId))throw Error('Invalid exact fresh session ID');
 const fresh=freshId?{claude:['--session-id',freshId],grok:['--session-id',freshId]}[runtime]:[];
 if(freshId&&!fresh)throw Error('This CLI does not support an exact fresh session ID');
 return [...(id?resumeArgs(runtime,id):fresh),...(allowAll?{codex:['--dangerously-bypass-approvals-and-sandbox'],claude:['--dangerously-skip-permissions'],grok:['--always-approve','--permission-mode','bypassPermissions'],agy:['--dangerously-skip-permissions']}[runtime]:[])];
}
