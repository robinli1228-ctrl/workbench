import { CodexSession } from './codex.mjs';
import { CliPrintSession } from './cli-print-session.mjs';
import { tr } from './i18n.mjs';
import { randomUUID } from 'node:crypto';

/**
 * Session-page takeover adapters. They extend the shared managed adapters without changing them:
 * only explicitly selected model/settings are added (the page instructions travel in the first prompt, see native-turns.mjs); a resident
 * process survives an interrupted turn. Managed group-chat Runs never construct these classes.
 */
export const NATIVE_KEEPALIVE=new Set(['claude','agy']);

/** Exact resume arguments; print/stream flags only, plus the model and effort the person chose on the Sessions page. Resident Claude/Agy read stream-json turns from stdin. */
export function nativeTurnArgs(runtime,{cwd,sessionId,prompt,keepAlive=false,model=null,effort=null}) {
  if(!sessionId)throw new Error('A takeover turn needs an exact native session ID');
  if(keepAlive&&!NATIVE_KEEPALIVE.has(runtime))throw new Error('This CLI has no resident input mode');
  const chosen=(modelFlag,effortFlag)=>[...(model?[modelFlag,model]:[]),...(effort?[effortFlag,effort]:[])];
  // A resident Claude answers permission prompts over stdio: every tool is still allowed by the bypass mode, but AskUserQuestion
  // (which only exists with a prompt host) reaches the page as a question card. A one-shot turn cannot answer, so it keeps bypassing.
  if(runtime==='claude')return keepAlive?['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--include-partial-messages','--resume',sessionId,...chosen('--model','--effort'),'--permission-mode','bypassPermissions','--permission-prompt-tool','stdio','--replay-user-messages']
    :['-p',prompt,'--output-format','stream-json','--verbose','--resume',sessionId,...chosen('--model','--effort'),'--dangerously-skip-permissions'];
  if(runtime==='grok')return ['--always-approve','--no-plan','--cwd',cwd,...chosen('-m','--reasoning-effort'),'--output-format','streaming-messages-json','--include-partial-messages','--permission-mode','bypassPermissions','--resume',sessionId,'-p',prompt];
  if(runtime==='agy')return ['--output-format','stream-json','--dangerously-skip-permissions','--mode','accept-edits',...chosen('--model','--effort'),'--conversation',sessionId,...(keepAlive?['--input-format','stream-json']:['--print',prompt])];
  throw new Error('Unsupported CLI');
}

/** Codex App Server: thread/resume once per process, then turn/start on the loaded thread (images as localImage items). */
export class NativeCodexSession extends CodexSession {
  constructor(options){super({...options,effort:options.effort??null});this.hold=false;this.control=options.control||null;this.questionsSupported=true;}
  /** request_user_input is off in Codex's default mode unless the client opts in; the page answers it, so a takeover does. */
  launchArgs(){return this.questionsSupported?['-c','features.default_mode_request_user_input=true',...super.launchArgs()]:super.launchArgs();}
  async openThread() {
    if(this.threadId)return {id:this.threadId};
    const response=await this.request('thread/resume',{threadId:this.resumeSessionId,cwd:this.cwd,approvalPolicy:'never',sandbox:'workspace-write',...(this.model?{model:this.model}:{})});
    if(response.thread?.id!==this.resumeSessionId)throw new Error(tr('codex.resumedCodexSessionIdDoes'));
    return response.thread;
  }
  /** The chosen model rides on every turn; a compaction control turn starts thread/compact/start instead of a prompt (it completes as an ordinary turn). */
  request(method,params) {
    if(method==='initialize')params={...params,capabilities:{...(params?.capabilities||{}),experimentalApi:true}};
    // A turn/started notification may precede the empty compaction acknowledgement.
    if(method==='turn/start'&&this.control==='compact')return super.request('thread/compact/start',{threadId:params.threadId}).then(result=>({turn:{id:result?.turn?.id??this.turnId}}));
    if(method==='turn/start'&&this.model)params={...params,model:this.model};
    return super.request(method,params);
  }
  receive(m) {
    // An interrupted resident turn keeps the app-server; the base adapter would otherwise shut it down.
    this.hold=this.keepAlive&&m?.method==='turn/completed'&&m.params?.turn?.status==='interrupted';
    try{super.receive(m);}finally{this.hold=false;}
  }
  shutdown(){if(this.hold)return;super.shutdown();}
  close(){this.hold=false;super.shutdown();}
}

/** Claude/Agy resident stream-json input, Grok one process per turn. Claude gets images as base64 content blocks. */
export class NativeCliSession extends CliPrintSession {
  constructor(options){super(options);this.inputImages=options.inputImages||[];this.closing=false;this.question=null;this.initialized=false;this.awaitingEcho=false;}
  args(prompt){return nativeTurnArgs(this.runtime,{cwd:this.cwd,sessionId:this.resumeSessionId,prompt,keepAlive:this.keepAlive,model:this.model,effort:this.effort});}
  get questionsSupported(){return this.keepAlive&&this.runtime==='claude';}
  /** Only a completed native result may keep the CLI; broken transport shutdown must still retire it. */
  receive(message){
    if(message?.type==='rate_limit_event')return super.receive(message);
    if(this.questionsSupported&&message&&typeof message==='object'){
      if(message.type==='control_response')return;
      if(message.type==='control_request')return this.control(message);
      if(message.type==='control_cancel_request'){if(this.question?.requestId===message.request_id){const {id}=this.question;this.question=null;this.emit('question_resolved',{id});if(!this.done&&!this.stopping)this.emit('status',{status:'running'});}return;}
    }
    if(this.keepAlive&&this.runtime==='claude'&&message&&typeof message==='object'){
      // The live background-task list is kept between turns too, so a later turn knows what is still running.
      if(message.type==='system'&&message.subtype==='background_tasks_changed'&&Array.isArray(message.tasks))this.backgroundTasks=new Set(message.tasks.map(t=>t?.task_id).filter(Boolean));
      if(!this.done&&!this.awaitingEcho&&message.type==='system'&&String(message.subtype||'').startsWith('task_')&&!message.parent_tool_use_id)this.task(message);
      // A rejected queued input has no replay. Only its own negative receipt may settle it without an echo.
      if(this.awaitingEcho&&!this.done&&!this.stopping&&message.type==='command_lifecycle'&&!message.parent_tool_use_id&&message.command_uuid===this.inputUuid&&message.session_id===this.inputSessionId&&['refused','discarded'].includes(message.state)){
        this.awaitingEcho=false;
        this.emit('status',{inputDeliveryState:'not_delivered',inputRejection:message.state});
        // Discard means the session is ending: retire its process through the existing exit/lease path, never reuse it.
        if(message.state==='discarded')this.close();
        return this.finish('failed',`Input not delivered: Claude ${message.state} this message before its echo`);
      }
      // Claude echoes a stdin message (--replay-user-messages) when it starts on it. Until this turn's echo, what it says
      // answers something else it queued first (a background task's completion notice): that output and its result are not
      // this turn's, so they neither show in it nor end it.
      if(message.type==='user'&&message.isReplay){
        if(this.awaitingEcho&&message.uuid===this.inputUuid&&!message.parent_tool_use_id&&message.session_id===this.inputSessionId){this.awaitingEcho=false;this.emit('status',{inputDeliveryState:'accepted'});}
        return;
      }
      if(this.awaitingEcho&&!this.stopping&&message.type!=='system')return;
    }
    // Native Claude interrupts a turn without killing its resident process; only its owner's result confirms that boundary.
    if(!this.done&&this.stopping&&!this.closing&&this.keepAlive&&this.runtime==='claude'&&message?.type==='result'&&!message.parent_tool_use_id)return this.finish('interrupted');
    this.receiving=true;try{return super.receive(message);}finally{this.receiving=false;}
  }
  /** A subagent or background shell of this turn for the page: start, what it is doing now (at most every 5s), end. An end
   * without a start here (a task of an earlier, killed process) is not reported. */
  task(m){
    const id=m.task_id;if(!id)return;const tasks=this.tasks||=new Map(),known=tasks.get(id),now=Date.now();
    if(m.subtype==='task_started'){tasks.set(id,{at:now,shown:0});return this.emit('task',{id,status:'running',kind:m.task_type==='local_bash'?'shell':'agent',description:String(m.description||'').slice(0,200),agentType:String(m.subagent_type||'').slice(0,80)});}
    if(!known)return;
    if(m.subtype==='task_progress'){if(now-known.shown<5000)return;known.shown=now;return this.emit('task',{id,status:'running',activity:String(m.description||'').slice(0,200),toolUses:Number.isFinite(m.usage?.tool_uses)?m.usage.tool_uses:undefined});}
    const status=m.subtype==='task_notification'?m.status:m.subtype==='task_updated'?m.patch?.status:null;
    if(!status||['pending','running'].includes(status))return;
    tasks.delete(id);this.emit('task',{id,status:['completed','failed'].includes(status)?status:'stopped',durationMs:now-known.at});
  }
  /** Claude's stdio permission host: AskUserQuestion becomes a question for the page; every other prompt is allowed as the bypass mode would. */
  control(message){
    const {request_id:requestId,request={}}=message,reply=response=>this.write({type:'control_response',response:{subtype:'success',request_id:requestId,response}});
    if(request.subtype!=='can_use_tool')return this.write({type:'control_response',response:{subtype:'error',request_id:requestId,error:'Unsupported control request'}});
    if(request.tool_name!=='AskUserQuestion'||!Array.isArray(request.input?.questions)||!request.input.questions.length)return reply({behavior:'allow',updatedInput:request.input});
    const id=requestId,questions=request.input.questions.map((q,i)=>({id:`q${i+1}`,header:String(q.header||'').slice(0,40),question:String(q.question||'').slice(0,2000),multiSelect:q.multiSelect===true,allowOther:true,
      options:(Array.isArray(q.options)?q.options:[]).slice(0,8).map(o=>({label:String(o?.label||'').slice(0,200),description:String(o?.description||'').slice(0,600)}))}));
    this.question={id,requestId,input:request.input,questions};
    this.emit('question',{id,questions});this.emit('status',{status:'waiting_user'});
  }
  write(message){try{this.proc?.stdin?.write(`${JSON.stringify(message)}\n`);}catch{}}
  /** Answers go back as the tool's updatedInput ("question" -> "label, label" or the typed text); skip denies with a reason so the turn carries on. */
  answerQuestion({id,answers={},skip=false}={}){
    const q=this.question;if(!q||(id&&q.id!==id))throw new Error('This question is no longer waiting for an answer');
    this.question=null;
    if(skip)this.write({type:'control_response',response:{subtype:'success',request_id:q.requestId,response:{behavior:'deny',message:'The user skipped these questions. Continue without the answers, using your best judgement.'}}});
    else{const map={};q.questions.forEach((question,i)=>{const given=[].concat(answers[question.id]??answers[String(i)]??[]).map(String).filter(Boolean);if(given.length)map[q.input.questions[i].question]=given.join(', ');});
      this.write({type:'control_response',response:{subtype:'success',request_id:q.requestId,response:{behavior:'allow',updatedInput:{...q.input,answers:map}}}});}
    this.emit('question_resolved',{id:q.id});if(!this.done&&!this.stopping)this.emit('status',{status:'running'});
  }
  sendTurn(prompt) {
    // The SDK handshake precedes the first message of a session that hosts permission prompts.
    if(this.questionsSupported&&!this.initialized){this.initialized=true;this.write({type:'control_request',request_id:`init-${Date.now()}`,request:{subtype:'initialize'}});}
    const content=this.runtime==='claude'&&this.inputImages?.length?[{type:'text',text:prompt},...this.inputImages.map(image=>({type:'image',source:{type:'base64',media_type:image.mime,data:image.data}}))]:prompt;
    const message=this.runtime==='agy'?{event:'user',message:{role:'user',content}}:{type:'user',session_id:this.nativeSessionId||this.resumeSessionId||'',message:{role:'user',content},parent_tool_use_id:null};
    this.inputAttempted=true;
    // A prompt waits for its own echo before output counts as its own; a slash command is handled locally and not echoed.
    this.awaitingEcho=this.keepAlive&&this.runtime==='claude'&&!String(prompt).trimStart().startsWith('/');
    // Queued background notices are replayed too; UUID identity, not text, binds even repeated prompts to this input.
    if(this.awaitingEcho)message.uuid=this.inputUuid=randomUUID();else this.inputUuid=null;
    this.inputSessionId=message.session_id;
    // Process-wide backgroundTasks still gates completion; this map only owns the current turn's visible tasks.
    this.tasks=new Map();
    const needsEcho=this.awaitingEcho;
    this.proc.stdin.write(`${JSON.stringify(message)}\n`,error=>{if(!error&&!needsEcho)this.emit('status',{inputDeliveryState:'accepted'});});
  }
  /** Resident Claude interrupts only the current turn through the stream-json control channel; others end the process. */
  async stop() {
    if(this.done)return;
    this.stopping=true;
    if(this.question){const q=this.question;this.question=null;this.write({type:'control_response',response:{subtype:'success',request_id:q.requestId,response:{behavior:'deny',message:'Interrupted by the user.'}}});this.emit('question_resolved',{id:q.id});}
    if(this.keepAlive&&this.runtime==='claude'&&this.proc?.stdin?.writable){
      try{this.proc.stdin.write(`${JSON.stringify({type:'control_request',request_id:`interrupt-${Date.now()}`,request:{subtype:'interrupt'}})}\n`);}catch{}
      clearTimeout(this.interruptTimer);this.interruptTimer=setTimeout(()=>{if(!this.done)this.close();},10000);this.interruptTimer.unref?.();
      return;
    }
    this.close();
  }
  finish(status,error){clearTimeout(this.interruptTimer);if(this.keepAlive&&this.stopping&&status!=='interrupted')return super.finish('interrupted');return super.finish(status,error);}
  /** After a finished resident turn (including an error result) the process stays; only close() or a live failure ends it. */
  shutdown(){if(this.keepAlive&&this.done&&!this.closing&&this.receiving)return;super.shutdown();}
  close(){this.closing=true;super.shutdown();}
}

export function createNativeSession({runtime,cwd,resumeSessionId,emit,keepAlive,attachments=[],inputImages=[],env=process.env,onProcess,beforeInput,model=null,effort=null,control=null}) {
  if(runtime==='codex')return new NativeCodexSession({cwd,writableRoots:[cwd],attachments,emit,resumeSessionId,env,keepAlive,onProcess,beforeInput,model,effort,control});
  return new NativeCliSession({cwd,runtime,emit,resumeSessionId,env,keepAlive,inputImages,onProcess,beforeInput,model,effort});
}
