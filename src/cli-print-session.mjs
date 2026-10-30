import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { nativeSessionId } from './terminal-resume.mjs';
import { tr } from './i18n.mjs';
import { executionText } from './input-language.mjs';
import { ClaudeContextUsage } from './context-usage.mjs';
import { normalizeRuntimeQuota } from './runtime-quota.mjs';

const MAX_TOOL_OUTPUT = 12000;

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(extractText).filter(Boolean).join('');
  if (!content || typeof content !== 'object') return '';
  if (typeof content.text === 'string') return content.text;
  if (content.content !== undefined) return extractText(content.content);
  if (typeof content.result === 'string') return content.result;
  return '';
}

function boundedToolOutput(content) {
  const text=extractText(content);
  let output;
  if(typeof content==='string'||text)output=text;
  else if(content===undefined||content===null)return {value:undefined,truncated:false};
  else try{output=JSON.stringify(content);}catch{output=String(content);}
  return {value:output.slice(-MAX_TOOL_OUTPUT),truncated:output.length>MAX_TOOL_OUTPUT};
}

function roleRules(roleName, roleInstructions) {
  return executionText('cliPrintSession.you', { p1: roleName ? executionText('cliPrintSession.roleInProjectGroupChat', { roleName }) : executionText('cliPrintSession.executorTask'), p2: roleInstructions || '' });
}

/** print/stream CLI adapter: tools are auto-approved, with no native per-item approval. */
export class CliPrintSession {
  constructor({ cwd, model, mode, emit, roleInstructions = '', roleName = '', effort = null, runtime, env = process.env, resumeSessionId = null, keepAlive = false, inheritInstructions = false, maintenance = false, minimalInstructions=false, instructionMessage='',configurationUpdate='',beforeInput,onProcess }) {
    this.beforeInput=beforeInput;this.onProcess=onProcess;this.inputAttempted=false;
    this.minimalInstructions=minimalInstructions;this.instructionMessage=instructionMessage;
    this.configurationUpdate=configurationUpdate;
    this.maintenance=maintenance;
    this.keepAlive=keepAlive && ['claude','agy'].includes(runtime);
    this.cwd = cwd; this.model = model; this.mode = mode; this.emit = emit;
    this.roleInstructions = roleInstructions; this.roleName = roleName;
    this.effort = effort; this.runtime = runtime; this.env = env;
    this.resumeSessionId = resumeSessionId;
    this.inheritInstructions = inheritInstructions;
    this.stopping = false; this.done = false;
    this.backgroundTasks = new Set(); this.awaitingBackground = false;
    this.lastThinkingAt = 0;
    this.contextTracker = runtime==='claude'?new ClaudeContextUsage():null;
    this.answer = ''; this.textBuffer = ''; this.finalText = ''; this.runtimeError = '';
    this.claudeMessages=new Map();this.claudeMessageAliases=new Map();this.messageId=null;this.bestAnswerId=null;this.messageSerial=0;
  }
  bin() {
    if (this.runtime === 'agy') return process.env.AGY_BIN || 'agy';
    if (this.runtime === 'claude') return process.env.CLAUDE_BIN || 'claude';
    return process.env.GROK_BIN || 'grok';
  }
  args(prompt) {
    if(this.configurationUpdate&&['claude','grok'].includes(this.runtime))prompt=[this.configurationUpdate,prompt].join('\n\n');
    const rules = this.minimalInstructions?this.roleInstructions:roleRules(this.roleName, this.roleInstructions);
    // A maintenance turn is not allowed to inherit an adapter's ordinary auto-approved write tools.
    if(this.maintenance) {
      if(this.runtime!=='grok')throw new Error('Safe maintenance is not yet verified for this adapter.');
      return ['--cwd',this.cwd,'-m',this.model,'--output-format','streaming-messages-json','--include-partial-messages','--rules',rules,
        '--tools','read_file','--permission-mode','dontAsk','--no-subagents','--disable-web-search',
        ...(this.effort?['--reasoning-effort',this.effort]:[]),...(this.resumeSessionId?['--resume',this.resumeSessionId]:[]),'-p',prompt];
    }
    if (this.runtime === 'agy') {
      const args = ['--output-format', 'stream-json', '--model', this.model, '--dangerously-skip-permissions'];
      if (this.effort) args.push('--effort', this.effort);
      args.push('--mode', 'accept-edits');
      if(this.resumeSessionId)args.push('--conversation',this.resumeSessionId);
      if(this.keepAlive)args.push('--input-format','stream-json');
      else args.push('--print', this.minimalInstructions?[this.instructionMessage,prompt].filter(Boolean).join('\n\n'):this.inheritInstructions && this.resumeSessionId ? prompt : `${rules}\n\n${prompt}`);
      return args;
    }
    if (this.runtime === 'claude') {
      // Claude 2.x: -p + stream-json requires --verbose, otherwise it exits with code 1 immediately.
      // A resident process echoes each stdin message when it starts on it (--replay-user-messages); see receive().
      const args = ['-p', ...(this.keepAlive?['--input-format','stream-json','--include-partial-messages','--replay-user-messages']:[prompt]), '--model', this.model, '--output-format', 'stream-json', '--verbose', '--append-system-prompt', rules];
      // After a resume, the role rules most recently saved by the supervisor must still be used, not the prompt snapshot frozen at the first turn.
      args.push('--system-prompt-snapshot','off');
      if(this.resumeSessionId)args.push('--resume',this.resumeSessionId);
      if (this.effort) args.push('--effort', this.effort);
      args.push('--dangerously-skip-permissions');
      return args;
    }
    const args = ['--always-approve', '--no-plan', '--cwd', this.cwd, '-m', this.model, '--output-format', 'streaming-messages-json', '--include-partial-messages', '--rules', rules];
    if (this.effort) args.push('--reasoning-effort', this.effort);
    args.push('--permission-mode', 'bypassPermissions');
    if(this.resumeSessionId)args.push('--resume',this.resumeSessionId);
    args.push('-p', prompt);
    return args;
  }
  /** Claude/Agy keep the process with bidirectional input; Grok keeps using single-turn resume with the specified native ID. */
  reuse(options) {
    if(!this.keepAlive || !this.done || !this.proc || this.proc.killed || this.proc.exitCode!==null || this.proc.signalCode!==null)throw new Error(tr('cliPrintSession.cliProcessCannotBeReused'));
    Object.assign(this,options);this.done=false;this.stopping=false;this.awaitingBackground=false;
    this.answer='';this.textBuffer='';this.finalText='';this.bestAnswer='';this.runtimeError='';this.emittedFinal=false;
    this.claudeMessages.clear();this.claudeMessageAliases.clear();this.messageId=null;this.bestAnswerId=null;this.messageSerial=0;
    this.lastThinkingAt=0;
  }
  async start(prompt) {
    this.inputAttempted=false;
    await this.beforeInput?.();
    if(this.proc && this.keepAlive) {
      this.onProcess?.(this.proc);
      this.emit('status',{status:'running',workspace:this.cwd,nativeSessionId:this.nativeSessionId});
      this.sendTurn(prompt);return;
    }
    this.inputAttempted=true;
    this.proc = spawn(this.bin(), this.args(prompt), { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: this.env,detached:process.platform!=='win32' });
    this.onProcess?.(this.proc);
    this.proc.once('spawn',()=>{if(this.keepAlive)this.sendTurn(prompt);else this.emit('status',{inputDeliveryState:'accepted'});});
    this.proc.stdin.on('error',e=>{if(!this.done&&!this.stopping){this.finish('failed',tr('cliPrintSession.cliInputStreamClosed', { message: e.message }));this.shutdown();}});
    // Grok uses stdin EOF as a user-cancel signal while headless tools are running.
    if (this.runtime !== 'grok' && !this.keepAlive) try { this.proc.stdin.end(); } catch {}
    this.emit('status', { status: 'running', workspace: this.cwd });
    this.proc.on('error', e => {this.inputAttempted=false;this.emit('status',{inputDeliveryState:'not_delivered',queueRejected:true,queueRetryable:false,processSettled:true});this.finish('failed', e.message);});
    this.proc.on('exit', (code, signal) => {
      clearTimeout(this.killTimer);
      if (this.done) return;
      if (this.stopping) this.finish('interrupted');
      else if(this.awaitingBackground||this.backgroundTasks.size)this.finish('failed',this.runtimeError||tr('cliPrintSession.processExited', { p1: code ?? signal }));
      else if (code === 0 && !this.runtimeError) this.finish('succeeded');
      else this.finish('failed', this.runtimeError || tr('cliPrintSession.processExited', { p1: code ?? signal }));
    });
    this.proc.stderr.on('data', bytes => {
      const text = bytes.toString().slice(0, 6000);
      if (!this.runtimeError) {
        const line = text.split('\n').map(s => s.trim()).find(s => /^error:/i.test(s) || /requires --verbose/i.test(s));
        if (line) this.runtimeError = line.replace(/^error:\s*/i, '');
      }
      this.emit('log', { text });
    });
    const lines = createInterface({ input: this.proc.stdout });
    lines.on('line', line => { try { this.receiveLine(line); } catch (e) { this.emit('log', { text: tr('cliPrintSession.eventHandlingError', { message: e.message }) }); } });
  }
  /** Agy uses event:user and Claude uses type:user; the rules are attached to Agy only on the first turn or when the rules change. */
  sendTurn(prompt) {
    if(this.configurationUpdate&&this.runtime==='claude')prompt=[this.configurationUpdate,prompt].join('\n\n');
    const content=this.runtime==='agy'?this.minimalInstructions?[this.instructionMessage,prompt].filter(Boolean).join('\n\n'):!this.inheritInstructions?`${roleRules(this.roleName,this.roleInstructions)}\n\n${prompt}`:prompt:prompt;
    const message=this.runtime==='agy' ? {event:'user',message:{role:'user',content}}
      : {type:'user',session_id:this.nativeSessionId||this.resumeSessionId||'',message:{role:'user',content},parent_tool_use_id:null};
    this.inputAttempted=true;
    // A resident Claude takes this input only when it echoes its uuid; until then what it says answers something it queued
    // first (after a restart, the notice of a background command the old process left), so delivery is confirmed on the echo.
    const echo=this.keepAlive&&this.runtime==='claude';
    if(echo){message.uuid=this.echoUuid=randomUUID();this.echoSession=message.session_id;}
    this.proc.stdin.write(`${JSON.stringify(message)}\n`,error=>{if(!error&&!echo)this.emit('status',{inputDeliveryState:'accepted'});});
  }
  receiveLine(line) {
    if (!line.trim()) return;
    let m; try { m = JSON.parse(line); } catch { this.emit('log', { text: line.slice(0, 6000) }); return; }
    this.receive(m);
  }
  receive(raw) {
    if(this.runtime==='claude'&&raw?.type==='rate_limit_event') {
      if(raw.session_id!==(this.nativeSessionId||this.resumeSessionId))return;
      const sample=normalizeRuntimeQuota('claude',raw);if(sample)this.emit('quota',sample);
      return;
    }
    // Until this turn's echo, a resident Claude is answering something it queued first: that output and its result are not
    // this turn's, so they neither show in it nor end it (otherwise a reply to an old notice ends the turn as "no text" and the
    // real answer that follows is lost). Replays of other messages are never output.
    if(this.keepAlive&&this.runtime==='claude'&&raw?.type==='user'&&raw.isReplay){
      if(this.echoUuid&&raw.uuid===this.echoUuid&&!raw.parent_tool_use_id&&(!this.echoSession||raw.session_id===this.echoSession)){this.echoUuid=null;this.emit('status',{inputDeliveryState:'accepted'});}
      return;
    }
    if(this.echoUuid&&raw?.type!=='system')return;
    if(this.done||this.stopping)return;
    if (!raw || typeof raw !== 'object') return;
    const sessionId = nativeSessionId(raw, this.runtime);
    if (sessionId && !this.nativeSessionId) {
      this.nativeSessionId = sessionId;
      this.emit('status', { nativeSessionId: sessionId });
    }
    const context=this.contextTracker?.receive(raw,this.nativeSessionId||this.resumeSessionId||null);
    if(context)this.emit('context_usage',context);
    const eventPayload = typeof raw.event === 'string' && raw[raw.event] && typeof raw[raw.event] === 'object'
      ? { ...raw[raw.event], type: raw[raw.event].type || raw.event }
      : null;
    const m = raw.event && typeof raw.event === 'object' ? raw.event : eventPayload || raw.params?.update || raw.update || raw;
    // Child streams still expose tool activity, but only the owner can supply the turn's answer or completion.
    const ownerMessage=!raw.parent_tool_use_id&&!m.parent_tool_use_id;
    const type = m.type || m.event || m.sessionUpdate || '';
    if(this.runtime==='claude'&&ownerMessage&&type==='message_start')this.beginClaudeMessage(m.message?.id);
    const usage = m.usage || m.tokenUsage || raw.usage;
    if (usage && typeof usage === 'object') this.emit('usage', { ...usage, source: 'runtime' });
    // The native thinking stream is also evidence of activity; only a throttled signal is reported, and private reasoning content is not recorded and tokens are not estimated.
    if(type==='content_block_delta'&&m.delta?.type==='thinking_delta'&&(!this.lastThinkingAt||Date.now()-this.lastThinkingAt>=15000)) {
      this.lastThinkingAt=Date.now();this.emit('log',{text:tr('cliPrintSession.modelThinkingNativeProgressEvent')});
    }
    // Claude reports the full list of its live background tasks (subagents, background shells) on every change.
    if(ownerMessage&&type==='system'&&m.subtype==='background_tasks_changed'&&Array.isArray(m.tasks)) {
      this.backgroundTasks=new Set(m.tasks.map(t=>t?.task_id).filter(Boolean));
    }
    if (type === 'error' || m.error) {
      // Claude may put auth errors in assistant.message objects; handoff and UI need the actual text.
      const errText = extractText(m.error?.message) || extractText(m.message) || extractText(m.error) || tr('cliPrintSession.runtimeError');
      this.runtimeError = this.runtimeError || errText;
      this.emit('log', { text: errText });
    }
    const delta = m.delta?.text || (m.delta?.type === 'text_delta' ? m.delta.text : '') || m.text_delta || (type === 'content_block_delta' ? extractText(m.delta) : '');
    if (ownerMessage&&delta) this.appendText(delta);
    else if (ownerMessage&&(type === 'assistant' || type === 'agent_message_chunk' || type === 'agent_message')) {
      const text = extractText(m.message?.content || m.content || m.message || m.text);
      if (text) this.appendSnapshot(text,m.message?.id||m.id);
    }
    if (ownerMessage&&!delta && type === 'message' && (m.role === 'assistant' || m.content)) {
      const text = extractText(m.content || m.message);
      if (text) this.appendSnapshot(text,m.message?.id||m.id);
    }
    if (ownerMessage&&(type === 'result' || type === 'completion' || m.subtype === 'success')) {
      const text = typeof m.result === 'string' ? m.result : extractText(m.response || m.result || m.message || m.content);
      if (text?.trim()) this.finalText = text;
      if (m.is_error || m.status==='ERROR') {
        // result/response is partial body text, not the error reason; keep the real diagnostics received earlier.
        this.runtimeError = this.runtimeError || extractText(m.error) || tr('cliPrintSession.runtimeReturnedErrorResultCheck');
        this.emit('log', { text: this.runtimeError });
      } else if(m.status==='SUCCESS' || m.subtype==='success') this.runtimeError='';
      if(this.keepAlive) {
        // Background tasks still run in this process: this reply is only progress, so the Run stays active (slot held, never pooled as idle).
        if(!this.runtimeError&&this.backgroundTasks.size){this.awaitingBackground=true;this.flushText();this.bestAnswer='';this.bestAnswerId=null;this.finalText='';return;}
        this.finish(this.runtimeError?'failed':'succeeded',this.runtimeError||undefined);
        if(this.runtimeError)this.shutdown();
      }
    }
    // Agy 1.2.x reports the tool lifecycle via step_update; a stable ID lets the page merge start and end.
    if(this.runtime==='agy' && type==='step_update' && m.step_type==='tool' && m.tool_info && m.step_index!==undefined && (m.conversation_id||this.nativeSessionId)) {
      const output=boundedToolOutput(m.tool_info.output);
      this.emit('tool',{text:m.tool_name||m.tool_info.name||tr('cliPrintSession.toolCall'),item:{
        id:`agy:${m.conversation_id||this.nativeSessionId}:${m.step_index}`,type:'tool_call',
        name:m.tool_name||m.tool_info.name,arguments:m.tool_info.parameters,output:output.value,...(output.truncated?{outputTruncated:true}:{}),
        status:m.state==='DONE'?'completed':['ERROR','FAILED'].includes(m.state)?'failed':'inProgress'
      }});
    }
    const toolResult=m.tool_result||m.toolResult||(type==='tool_result'||type==='tool_result_delta'?m:null);
    if(toolResult) {
      const id=toolResult.tool_use_id||toolResult.toolUseId||toolResult.call_id||toolResult.id;
      const output=toolResult.output??toolResult.content??toolResult.result??toolResult.delta;
      if(id&&output!==undefined) {
        const isDelta=type==='tool_result_delta'||toolResult.type==='tool_result_delta';
        const bounded=boundedToolOutput(output);
        this.emit('tool',{text:toolResult.name||tr('cliPrintSession.toolResult'),item:{
          id,type:'tool_result',status:isDelta?'inProgress':toolResult.is_error?'failed':'completed',
          is_error:Boolean(toolResult.is_error),[isDelta?'outputDelta':'output']:bounded.value,...(bounded.truncated?{outputTruncated:true}:{})
        }});
      }
    }
    const tool = m.tool_use || m.toolCall || (type === 'tool_use' || type === 'tool_call' || type === 'tool' ? m : null);
    if (tool && (tool.name || tool.title || tool.command || type === 'tool_call')) {
      this.emit('tool', { text: tool.name || tool.title || tool.command || tool.kind || tr('cliPrintSession.working'), item: tool });
    }
    if (Array.isArray(m.message?.content)) {
      for (const block of m.message.content) {
        if (block?.type === 'tool_use' || block?.name) this.emit('tool', { text: block.name || block.type || tr('cliPrintSession.working2'), item: block });
        if(block?.type==='tool_result'&&block.tool_use_id){const output=boundedToolOutput(block.content);this.emit('tool',{text:tr('cliPrintSession.toolResult'),item:{id:block.tool_use_id,type:'tool_result',status:block.is_error?'failed':'completed',is_error:Boolean(block.is_error),output:output.value,...(output.truncated?{outputTruncated:true}:{})}});}
      }
    }
  }
  /** Claude's stream belongs to a native assistant message, not to every snapshot in the turn. */
  beginClaudeMessage(id) {
    this.flushText();this.messageId=this.claudeMessageAliases.get(id)||id||`claude-message-${++this.messageSerial}`;
    if(!this.claudeMessages.has(this.messageId))this.claudeMessages.set(this.messageId,{text:'',complete:false});
  }
  appendText(text) {
    if (!text) return;
    if(this.runtime==='claude'){
      if(!this.messageId)this.beginClaudeMessage();
      const message=this.claudeMessages.get(this.messageId);
      if(message.complete)return; // A late replay cannot extend an already complete message.
      message.text+=text;
    }
    this.answer += text;
    this.textBuffer += text;
    if (!this.textTimer) this.textTimer = setTimeout(() => this.flushText(), 300);
  }
  /** Claude snapshots replace their identified message; other print adapters retain their cumulative-stream contract. */
  appendSnapshot(text,id) {
    if(this.runtime==='claude') {
      if(!text?.trim())return;
      this.flushText();
      if(id&&!this.claudeMessages.has(id)&&this.messageId?.startsWith('claude-message-')&&!this.claudeMessages.get(this.messageId)?.complete)this.claudeMessageAliases.set(id,this.messageId);
      id=this.claudeMessageAliases.get(id)||id;
      // Native IDs distinguish genuinely separate replies even when their wording is identical.
      if(!id){const current=this.claudeMessages.get(this.messageId);id=current&&!current.complete?this.messageId:`claude-message-${++this.messageSerial}`;}
      const known=this.claudeMessages.has(id);
      this.claudeMessages.set(id,{text,complete:true});
      if(!known||!this.messageId)this.messageId=id;
      this.answer=[...this.claudeMessages.values()].map(message=>message.text).join('');
      if(id===this.bestAnswerId||text.length>(this.bestAnswer?.length||0)){this.bestAnswer=text;this.bestAnswerId=id;}
      this.emit('message',{text,phase:'commentary',messageId:id});
      return;
    }
    if (!text || this.answer.endsWith(text) || this.answer.startsWith(text)) return;
    if (text.length > (this.bestAnswer?.length || 0)) this.bestAnswer = text;
    if (text.startsWith(this.answer)) this.appendText(text.slice(this.answer.length));
    else this.appendText(text);
  }
  flushText() { clearTimeout(this.textTimer); this.textTimer = null; if (this.textBuffer) { this.emit('text', { text: this.textBuffer,...(this.runtime==='claude'&&this.messageId?{messageId:this.messageId}:{}) }); this.textBuffer = ''; } }
  approve() { throw new Error(tr('cliPrintSession.runtimeAutoApprovesInPrint')); }
  async stop() {
    if (this.done) return;
    this.stopping = true;
    this.shutdown();
  }
  finish(status, error) {
    if (this.done) return;
    this.flushText();
    // Claude sometimes sends the full body as an assistant message while result only returns "see the body above".
    // Only override the short result when a single body is significantly more complete, to avoid mistaking an ordinary progress message for the final answer.
    const current=this.runtime==='claude'?this.claudeMessages.get(this.messageId):null;
    const completed=this.finalText||(current?.complete?current.text:'');
    const useBest=status==='succeeded'&&this.bestAnswer?.length>500&&this.bestAnswer.length>(completed.length||0)*4;
    const answer=useBest?this.bestAnswer:completed||this.answer;
    const aggregate=!completed&&!useBest;
    if (answer && !this.emittedFinal) {
      this.emit('message', { text: answer, phase: 'final_answer',...(aggregate?{aggregate:true}:{}),...(this.runtime==='claude'&&!aggregate&&this.messageId?{messageId:useBest?this.bestAnswerId:this.messageId}:{}) });
      this.emittedFinal = true;
    }
    this.done = true; this.awaitingBackground = false;
    this.emit('status', { status, ...(error ? { error } : {}) });
  }
  shutdown() {
    if (!this.proc || this.proc.killed || this.proc.exitCode != null) return;
    try { this.proc.stdin.end(); } catch {}
    this.proc.kill('SIGTERM');
    // killed only means the signal was sent; whether to force termination must be decided by the real exit state.
    this.killTimer = setTimeout(() => { if (this.proc && this.proc.exitCode == null && this.proc.signalCode == null) this.proc.kill('SIGKILL'); }, 3000);
    this.killTimer.unref();
  }
}
