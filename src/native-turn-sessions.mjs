import { CodexSession } from './codex.mjs';
import { CliPrintSession } from './cli-print-session.mjs';
import { tr } from './i18n.mjs';

/**
 * Session-page takeover adapters. They extend the shared managed adapters without changing them:
 * no Workbench rules, model, developer instructions or environment overrides are sent, and a resident
 * process survives an interrupted turn. Managed group-chat Runs never construct these classes.
 */
export const NATIVE_KEEPALIVE=new Set(['claude','agy']);

/** Exact resume arguments; print/stream flags only, plus the model and effort the person chose on the Sessions page. Resident Claude/Agy read stream-json turns from stdin. */
export function nativeTurnArgs(runtime,{cwd,sessionId,prompt,keepAlive=false,model=null,effort=null}) {
  if(!sessionId)throw new Error('A takeover turn needs an exact native session ID');
  if(keepAlive&&!NATIVE_KEEPALIVE.has(runtime))throw new Error('This CLI has no resident input mode');
  const chosen=(modelFlag,effortFlag)=>[...(model?[modelFlag,model]:[]),...(effort?[effortFlag,effort]:[])];
  if(runtime==='claude')return [...(keepAlive?['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--include-partial-messages','--resume',sessionId]
    :['-p',prompt,'--output-format','stream-json','--verbose','--resume',sessionId]),...chosen('--model','--effort'),'--dangerously-skip-permissions'];
  if(runtime==='grok')return ['--always-approve','--no-plan','--cwd',cwd,...chosen('-m','--reasoning-effort'),'--output-format','streaming-messages-json','--include-partial-messages','--permission-mode','bypassPermissions','--resume',sessionId,'-p',prompt];
  if(runtime==='agy')return ['--output-format','stream-json','--dangerously-skip-permissions','--mode','accept-edits',...chosen('--model','--effort'),'--conversation',sessionId,...(keepAlive?['--input-format','stream-json']:['--print',prompt])];
  throw new Error('Unsupported CLI');
}

/** Codex App Server: thread/resume once per process, then turn/start on the loaded thread (images as localImage items). */
export class NativeCodexSession extends CodexSession {
  constructor(options){super({...options,effort:options.effort??null});this.hold=false;this.control=options.control||null;}
  async openThread() {
    if(this.threadId)return {id:this.threadId};
    const response=await this.request('thread/resume',{threadId:this.resumeSessionId,cwd:this.cwd,approvalPolicy:'never',sandbox:'workspace-write',...(this.model?{model:this.model}:{})});
    if(response.thread?.id!==this.resumeSessionId)throw new Error(tr('codex.resumedCodexSessionIdDoes'));
    return response.thread;
  }
  /** The chosen model rides on every turn; a compaction control turn starts thread/compact/start instead of a prompt (it completes as an ordinary turn). */
  request(method,params) {
    if(method==='turn/start'&&this.control==='compact')return super.request('thread/compact/start',{threadId:params.threadId}).then(()=>({turn:{id:null}}));
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
  constructor(options){super(options);this.inputImages=options.inputImages||[];this.closing=false;}
  args(prompt){return nativeTurnArgs(this.runtime,{cwd:this.cwd,sessionId:this.resumeSessionId,prompt,keepAlive:this.keepAlive,model:this.model,effort:this.effort});}
  /** Only a completed native result may keep the CLI; broken transport shutdown must still retire it. */
  receive(message){this.receiving=true;try{return super.receive(message);}finally{this.receiving=false;}}
  sendTurn(prompt) {
    const content=this.runtime==='claude'&&this.inputImages?.length?[{type:'text',text:prompt},...this.inputImages.map(image=>({type:'image',source:{type:'base64',media_type:image.mime,data:image.data}}))]:prompt;
    const message=this.runtime==='agy'?{event:'user',message:{role:'user',content}}:{type:'user',session_id:this.nativeSessionId||this.resumeSessionId||'',message:{role:'user',content},parent_tool_use_id:null};
    this.inputAttempted=true;
    this.proc.stdin.write(`${JSON.stringify(message)}\n`,error=>{if(!error)this.emit('status',{inputDeliveryState:'accepted'});});
  }
  /** Resident Claude interrupts only the current turn through the stream-json control channel; others end the process. */
  async stop() {
    if(this.done)return;
    this.stopping=true;
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
