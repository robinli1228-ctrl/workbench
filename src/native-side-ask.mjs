import {randomUUID} from 'node:crypto';
import {open,readFile,writeFile,unlink,rm,mkdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {NativeCliSession,NativeCodexSession} from './native-turn-sessions.mjs';
import {readNativeSession,registeredNativeHistoryFile,registeredNativeSession,historyMessages} from './native-sessions.mjs';
import {isHistoryPrompt} from '../public/history-prompt.js';

/**
 * Side questions on the Sessions page: a short read-only conversation beside a session that never reaches it.
 * - Claude: a temporary session file holding the parent's last 10 turns (pictures left out), resumed one print turn per
 *   question in plan mode, deleted when the side question closes.
 * - Codex: thread/fork with a read-only sandbox, resumed per question, thread/delete when it closes.
 * Nothing is kept: a side question closes when the page clears it, after an hour without use, two hours after it began,
 * when the main session has a newer prompt (the next question starts a fresh one), and on every Worker start. The record
 * below only names the temporary files and threads so they can be removed; it holds no question or answer.
 */
export const SIDE_ASK_RUNTIMES=new Set(['claude','codex']);
export const SIDE_ASK_LIMITS=Object.freeze({turns:10,idleMs:60*60*1000,maxAgeMs:2*60*60*1000,scanBytes:64*1048576,chunk:4*1048576});
const CHAIN=new Set(['user','assistant','attachment','system']);
const IMAGE_NOTE='[A picture from the main session is left out of side questions.]';
const SIDE_ID=/^[a-f0-9-]{36}$/;

/** Lines of `path` from the `turns`-th last prompt to the end, read backwards in chunks (a long history is never read whole). */
async function tailFromPrompt(path,{turns,scanBytes,chunk}){
 const h=await open(path,'r');
 try{
  const size=(await h.stat()).size;let end=size,carry=Buffer.alloc(0),scanned=0;const lines=[];let prompts=0;
  while(end>0&&scanned<scanBytes){
   const start=Math.max(0,end-chunk),part=Buffer.alloc(end-start);await h.read(part,0,part.length,start);scanned+=part.length;
   const buffer=carry.length?Buffer.concat([part,carry]):part;let pos=buffer.length;
   while(pos>0){
    let lineEnd=pos;while(lineEnd>0&&[10,13].includes(buffer[lineEnd-1]))lineEnd--;
    if(!lineEnd){pos=0;break;}
    const lf=buffer.lastIndexOf(10,lineEnd-1);
    if(lf<0&&start>0){pos=lineEnd;break;}
    const text=buffer.subarray(lf+1,lineEnd).toString('utf8');let row=null;try{row=JSON.parse(text);}catch{}
    if(row){lines.unshift(row);if(row.type==='user'&&!row.isSidechain&&historyMessages([row],'claude').some(m=>m.role==='user'&&isHistoryPrompt(m.text))&&++prompts>=turns)return lines;}
    pos=Math.max(0,lf);
   }
   carry=buffer.subarray(0,pos);end=start;
  }
  return lines;
 }finally{await h.close();}
}

const stripPictures=content=>Array.isArray(content)?content.map(part=>{
 if(part?.type==='image')return {type:'text',text:IMAGE_NOTE};
 if(part?.type==='tool_result'&&Array.isArray(part.content))return {...part,content:part.content.map(inner=>inner?.type==='image'?{type:'text',text:IMAGE_NOTE}:inner)};
 return part;
}):content;

/**
 * A Claude session file holding the parent's last `turns` turns, for a side question. Only conversation rows are copied
 * (request logs and metadata are not), pictures become a one-line note, and a last turn whose tool call has no result yet
 * (the main session is still working) is left out, so the API never sees a dangling tool call.
 */
export async function trimClaudeSession({parentPath,tempPath,tempId,limits=SIDE_ASK_LIMITS}){
 const rows=(await tailFromPrompt(parentPath,limits)).filter(row=>CHAIN.has(row.type)&&!row.isSidechain);
 const firstPrompt=rows.findIndex(row=>row.type==='user'&&historyMessages([row],'claude').some(m=>m.role==='user'&&isHistoryPrompt(m.text)));
 let kept=firstPrompt<0?[]:rows.slice(firstPrompt);
 const calls=new Set(),results=new Set();
 for(const row of kept)for(const part of Array.isArray(row.message?.content)?row.message.content:[]){if(part?.type==='tool_use')calls.add(part.id);if(part?.type==='tool_result')results.add(part.tool_use_id);}
 if([...calls].some(id=>!results.has(id))){
  // The newest turn is still running in the main session: leave it out.
  let last=-1;kept.forEach((row,i)=>{if(row.type==='user'&&historyMessages([row],'claude').some(m=>m.role==='user'&&isHistoryPrompt(m.text)))last=i;});
  if(last>=0)kept=kept.slice(0,last);
 }
 if(!kept.length)throw Error('The main session has no complete turn to ask about yet');
 const lines=kept.map((row,i)=>{const {toolUseResult,...rest}=row;const next={...rest,sessionId:tempId,...(i===0?{parentUuid:null}:{})};if(next.message)next.message={...next.message,content:stripPictures(next.message.content)};return JSON.stringify(next);});
 await writeFile(tempPath,lines.join('\n')+'\n',{flag:'wx',mode:0o600});
 return {rows:kept.length,prompts:kept.filter(row=>row.type==='user'&&historyMessages([row],'claude').some(m=>m.role==='user'&&isHistoryPrompt(m.text))).length};
}

/** One read-only Claude print turn on the temporary session: plan mode lets it read files and answer, never change them. */
export class SideClaudeSession extends NativeCliSession{
 args(prompt){return ['-p',prompt,'--output-format','stream-json','--verbose','--resume',this.resumeSessionId,'--permission-mode','plan',...(this.model?['--model',this.model]:[])];}
}

/** Codex: fork the parent once (read-only sandbox, no approvals), then resume the fork for every later question. */
export class SideCodexSession extends NativeCodexSession{
 constructor(options){super(options);this.forkFrom=options.forkFrom||null;this.questionsSupported=false;}
 launchArgs(){return super.launchArgs().filter((arg,i,all)=>!(arg==='features.default_mode_request_user_input=true'||all[i+1]==='features.default_mode_request_user_input=true'));}
 async openThread(){
  if(this.threadId)return {id:this.threadId};
  const options={cwd:this.cwd,approvalPolicy:'never',sandbox:'read-only',...(this.model?{model:this.model}:{})};
  const response=this.forkFrom?await this.request('thread/fork',{threadId:this.forkFrom,...options}):await this.request('thread/resume',{threadId:this.resumeSessionId,...options});
  if(!response?.thread?.id||this.forkFrom&&response.thread.id===this.forkFrom)throw Error('Codex did not open a separate thread for the side question');
  return response.thread;
 }
}

/** Remove a Codex fork through its own API, so its session index never points at a missing file. */
export async function deleteCodexThread(threadId,options={}){
 // The fork's own app-server may still be shutting down; its writer lock clears within a moment.
 for(let attempt=0;;attempt++){try{return await deleteCodexThreadOnce(threadId,options);}catch(error){if(attempt>=4||!/active writer/i.test(error.message))throw error;await new Promise(resolve=>setTimeout(resolve,1000));}}
}
async function deleteCodexThreadOnce(threadId,{bin=process.env.CODEX_BIN||'codex',cwd=process.cwd(),env=process.env,timeoutMs=20000}={}){
 const proc=spawn(bin,['app-server','--listen','stdio://'],{cwd,env,stdio:['pipe','pipe','ignore'],detached:process.platform!=='win32'});
 const kill=()=>{try{process.kill(-proc.pid,'SIGTERM');}catch{try{proc.kill('SIGTERM');}catch{}}};
 const timer=setTimeout(kill,timeoutMs);timer.unref?.();
 let id=0;const pending=new Map();
 const request=(method,params)=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});proc.stdin.write(`${JSON.stringify({id:n,method,params})}\n`);});
 createInterface({input:proc.stdout}).on('line',line=>{let m;try{m=JSON.parse(line);}catch{return;}const p=m.id!==undefined&&!m.method?pending.get(m.id):null;if(!p)return;pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);});
 const dead=message=>{for(const p of pending.values())p.reject(Error(message));pending.clear();};
 proc.on('exit',()=>dead('Codex exited'));proc.on('error',e=>dead(e.message));proc.stdin.on('error',e=>dead(e.message));
 try{await request('initialize',{clientInfo:{name:'agent_collaboration_worker',version:'0.3.0'}});proc.stdin.write(`${JSON.stringify({method:'initialized'})}\n`);await request('thread/delete',{threadId});return true;}
 finally{clearTimeout(timer);kill();}
}

/** The newest prompt of a session: a side question whose parent moved on starts over. */
async function latestPrompt(runtime,sessionId,record,env){
 const page=await readNativeSession(runtime,sessionId,{env,record,historyPage:true});
 const prompt=[...page.messages].reverse().find(m=>m.role==='user'&&isHistoryPrompt(m.text));
 return {id:prompt?.id||null,workspace:page.workspace||null};
}

/** Worker side: one side question at a time per side id; events go to Home, which only keeps them in memory. */
export class SideAsks{
 constructor({db,send,canStart=()=>{},receiveFiles=async()=>[],data,env=process.env,limits=SIDE_ASK_LIMITS,createClaude=o=>new SideClaudeSession(o),createCodex=o=>new SideCodexSession(o),deleteThread=deleteCodexThread,parentState=latestPrompt,historyFile=registeredNativeHistoryFile,clock=Date.now}){
  Object.assign(this,{db,send,canStart,receiveFiles,data,env,limits,createClaude,createCodex,deleteThread,parentState,historyFile,clock});this.running=new Map();this.closing=new Map();
 }
 get size(){return this.running.size;}
 record(sideId){return this.db.get('sideAsks',sideId);}
 event(sideId,questionId,event){this.send({type:'side_ask_event',sideId,questionId,event});}
 /** Keep failed deletions discoverable by the next sweep, including after a Worker restart. */
 async cleanup(sideId){
  const r=this.record(sideId);if(!r)return true;
  this.db.put('sideAsks',{...r,cleanupPending:true});
  try{
   if(r.tempPath)await unlink(r.tempPath).catch(e=>{if(e.code!=='ENOENT')throw e;});
   if(r.forkId)await this.deleteThread(r.forkId,{cwd:r.cwd,env:this.env});
   this.db.remove('sideAsks',sideId);return true;
  }catch(e){console.error('Side question cleanup:',e.message);return false;}
 }
 /** Closing owns preparation too: wait for its final file/thread identity before removing it. */
 async close(sideId,reason='closed',{notify=false}={}){
  if(this.closing.has(sideId))return this.closing.get(sideId);
  // A question still being answered is stopped first, and its process given a moment to exit: Codex refuses to delete a
  // thread another app-server still writes.
  const running=this.running.get(sideId);
  if(running)running.closing=true;
  const cleanup=(async()=>{
   await running?.prepared;
   if(running){const proc=running.session?.proc;try{running.session?.stop?.();running.session?.close?.();}catch{}
    if(proc&&proc.exitCode===null&&!proc.signalCode)await new Promise(resolve=>{const t=setTimeout(resolve,5000);t.unref?.();proc.once('exit',()=>{clearTimeout(t);resolve();});});}
   await this.cleanup(sideId);
   if(notify)this.send({type:'side_ask_closed',sideId,reason});
  })();
  this.closing.set(sideId,cleanup);
  try{await cleanup;}finally{this.closing.delete(sideId);}
 }
 /** Close what has gone quiet for an hour or began two hours ago; on Worker start everything left over. */
 async sweep({all=false}={}){
  const now=this.clock();
  for(const r of this.db.list('sideAsks')){
   if(this.running.has(r.id))continue;
   const reason=all?'restart':r.cleanupPending?'cleanup_retry':now-Date.parse(r.lastUsedAt||r.createdAt)>=this.limits.idleMs?'idle':now-Date.parse(r.createdAt)>=this.limits.maxAgeMs?'expired':null;
   if(reason)await this.close(r.id,reason,{notify:true});
  }
 }
 async ask(m){
  const {sideId,questionId,runtime,sessionId}=m;
  const fail=error=>{this.event(sideId,questionId,{kind:'status',status:'failed',error:error.message||String(error)});};
  let state=null,prepared;
  try{
   if(!SIDE_ID.test(sideId||'')||!SIDE_ID.test(questionId||''))throw Error('Invalid side question');
   if(!SIDE_ASK_RUNTIMES.has(runtime))throw Error('Side questions work with Claude and Codex sessions');
   if(this.running.get(sideId)?.questionId===questionId)return;
   if(this.running.has(sideId)||this.closing.has(sideId))throw Error('The previous side question is still being answered');
   this.canStart(m);
   // Reserve before the first asynchronous read; a duplicate must never release this request's slot.
   state={questionId,closing:false,session:null,prepared:new Promise(resolve=>{prepared=resolve;})};this.running.set(sideId,state);
   const record=m.record||registeredNativeSession(this.db,runtime,sessionId);
   const parent=await this.parentState(runtime,sessionId,record,this.env);
   if(state.closing)return;
   if(!parent.workspace)throw Error('The main session has no working folder yet');
   let r=this.record(sideId);
   // The main session has a newer prompt than the one this side question started from (or this Worker restarted and lost
   // the temporary session): start a fresh side session and say so.
   if(r&&(r.cleanupPending||r.parentPromptId!==parent.id||r.sessionId!==sessionId)){
    if(!await this.cleanup(sideId))throw Error('The previous side question could not be cleaned up; try again shortly');
    if(state.closing)return;r=null;this.event(sideId,questionId,{kind:'restarted'});
   }
   else if(!r&&m.followUp)this.event(sideId,questionId,{kind:'restarted'});
   if(!r){
    r={id:sideId,runtime,sessionId,cwd:parent.workspace,parentPromptId:parent.id,createdAt:new Date(this.clock()).toISOString()};
    if(runtime==='claude'){
     const file=await this.historyFile(runtime,sessionId,{env:this.env,record});if(!file)throw Error('The main session history is unavailable');
     if(state.closing)return;
     r.tempId=randomUUID();r.tempPath=join(dirname(file.path),`${r.tempId}.jsonl`);
     this.db.put('sideAsks',r);
     const trimmed=await trimClaudeSession({parentPath:file.path,tempPath:r.tempPath,tempId:r.tempId,limits:this.limits});
     if(state.closing)return;
     this.event(sideId,questionId,{kind:'scope',turns:trimmed.prompts});
    }else this.db.put('sideAsks',r);
   }
   const files=await this.receiveFiles(m);
   if(state.closing)return;
   const others=files.filter(f=>runtime!=='codex'||!f.mime?.startsWith('image/'));
   const prompt=[m.prompt||'',others.length?`Attached files for this message (local paths):\n${others.map(f=>`- ${f.name}: ${f.path}`).join('\n')}`:''].filter(Boolean).join('\n\n');
   let ended=false;
   const end=async(status,error)=>{
    if(ended)return;ended=true;if(this.running.get(sideId)===state)this.running.delete(sideId);
    const current=this.record(sideId);if(current)this.db.put('sideAsks',{...current,lastUsedAt:new Date(this.clock()).toISOString()});
    if(m.questionDir)await rm(m.questionDir,{recursive:true,force:true}).catch(()=>{});
    this.event(sideId,questionId,{kind:'status',status:state.closing?'interrupted':status,...(error?{error}:{})});
   };
   const emit=(type,p={})=>{
    if(ended)return;
    if(type==='status'&&p.threadId&&runtime==='codex'){const current=this.record(sideId);if(current&&!current.forkId&&p.threadId!==sessionId)this.db.put('sideAsks',{...current,forkId:p.threadId});}
    if(type==='status'&&['succeeded','failed','interrupted','reconciling'].includes(p.status))return void end(p.status==='reconciling'?'failed':p.status,p.error);
    if(type==='status'&&p.status)this.event(sideId,questionId,{kind:'status',status:p.status});
    else if(type==='message'&&typeof p.text==='string')this.event(sideId,questionId,{kind:'message',text:p.text,phase:p.phase||null});
    else if(type==='text'&&typeof p.text==='string')this.event(sideId,questionId,{kind:'text',text:p.text});
    else if(type==='tool'&&p.item)this.event(sideId,questionId,{kind:'tool',text:p.text,item:p.item});
    else if(type==='context_usage'&&p&&typeof p==='object')this.event(sideId,questionId,{kind:'context_usage',sample:p});
   };
   const current=this.record(sideId);
   const beforeInput=()=>{if(state.closing)throw Error('The side question was closed before its input was sent');};
   state.session=runtime==='claude'
    ?this.createClaude({runtime:'claude',cwd:current.cwd,resumeSessionId:current.tempId,emit,beforeInput,keepAlive:false,model:m.model||null,env:this.env})
    :this.createCodex({cwd:current.cwd,writableRoots:[],attachments:files,emit,beforeInput,resumeSessionId:current.forkId||null,forkFrom:current.forkId?null:sessionId,keepAlive:false,model:m.model||null,env:this.env});
   this.event(sideId,questionId,{kind:'status',status:'running'});
   await state.session.start(prompt);
  }catch(error){if(state)state.closing=true;fail(error);}
  finally{
   if(state){
    if(!state.session&&this.running.get(sideId)===state)this.running.delete(sideId);
    prepared();
    if(state.closing)await this.close(sideId);
    if(!state.session&&m.questionDir)await rm(m.questionDir,{recursive:true,force:true}).catch(()=>{});
   }
  }
 }
}
