import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { nativeSessionId } from './terminal-resume.mjs';
import { tr } from './i18n.mjs';

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(extractText).filter(Boolean).join('');
  if (!content || typeof content !== 'object') return '';
  if (typeof content.text === 'string') return content.text;
  if (content.content !== undefined) return extractText(content.content);
  if (typeof content.result === 'string') return content.result;
  return '';
}

function roleRules(roleName, roleInstructions) {
  return tr('cliPrintSession.you', { p1: roleName ? tr('cliPrintSession.roleInProjectGroupChat', { roleName }) : tr('cliPrintSession.executorTask'), p2: roleInstructions || '' });
}

/** print/stream CLI adapter: tools are auto-approved, with no native per-item approval. */
export class CliPrintSession {
  constructor({ cwd, model, mode, emit, roleInstructions = '', roleName = '', effort = null, runtime, env = process.env, resumeSessionId = null, keepAlive = false, inheritInstructions = false, maintenance = false, minimalInstructions=false, instructionMessage='',configurationUpdate='' }) {
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
    this.lastThinkingAt = 0;
    this.answer = ''; this.textBuffer = ''; this.finalText = ''; this.runtimeError = '';
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
      const args = ['-p', ...(this.keepAlive?['--input-format','stream-json','--include-partial-messages']:[prompt]), '--model', this.model, '--output-format', 'stream-json', '--verbose', '--append-system-prompt', rules];
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
    Object.assign(this,options);this.done=false;this.stopping=false;
    this.answer='';this.textBuffer='';this.finalText='';this.bestAnswer='';this.runtimeError='';this.emittedFinal=false;
    this.lastThinkingAt=0;
  }
  async start(prompt) {
    if(this.proc && this.keepAlive) {
      this.emit('status',{status:'running',workspace:this.cwd,nativeSessionId:this.nativeSessionId});
      this.sendTurn(prompt);return;
    }
    this.proc = spawn(this.bin(), this.args(prompt), { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: this.env });
    this.proc.stdin.on('error',e=>{if(!this.done){this.finish('failed',tr('cliPrintSession.cliInputStreamClosed', { message: e.message }));this.shutdown();}});
    // Grok uses stdin EOF as a user-cancel signal while headless tools are running.
    if (this.runtime !== 'grok' && !this.keepAlive) try { this.proc.stdin.end(); } catch {}
    this.emit('status', { status: 'running', workspace: this.cwd });
    this.proc.on('error', e => this.finish('failed', e.message));
    this.proc.on('exit', (code, signal) => {
      if (this.done) return;
      if (this.stopping) this.finish('interrupted');
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
    if(this.keepAlive)this.sendTurn(prompt);
  }
  /** Agy uses event:user and Claude uses type:user; the rules are attached to Agy only on the first turn or when the rules change. */
  sendTurn(prompt) {
    if(this.configurationUpdate&&this.runtime==='claude')prompt=[this.configurationUpdate,prompt].join('\n\n');
    const content=this.runtime==='agy'?this.minimalInstructions?[this.instructionMessage,prompt].filter(Boolean).join('\n\n'):!this.inheritInstructions?`${roleRules(this.roleName,this.roleInstructions)}\n\n${prompt}`:prompt:prompt;
    const message=this.runtime==='agy' ? {event:'user',message:{role:'user',content}}
      : {type:'user',session_id:this.nativeSessionId||this.resumeSessionId||'',message:{role:'user',content},parent_tool_use_id:null};
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }
  receiveLine(line) {
    if (!line.trim()) return;
    let m; try { m = JSON.parse(line); } catch { this.emit('log', { text: line.slice(0, 6000) }); return; }
    this.receive(m);
  }
  receive(raw) {
    if(this.done)return;
    if (!raw || typeof raw !== 'object') return;
    const sessionId = nativeSessionId(raw, this.runtime);
    if (sessionId && !this.nativeSessionId) {
      this.nativeSessionId = sessionId;
      this.emit('status', { nativeSessionId: sessionId });
    }
    const eventPayload = typeof raw.event === 'string' && raw[raw.event] && typeof raw[raw.event] === 'object'
      ? { ...raw[raw.event], type: raw[raw.event].type || raw.event }
      : null;
    const m = raw.event && typeof raw.event === 'object' ? raw.event : eventPayload || raw.params?.update || raw.update || raw;
    const type = m.type || m.event || m.sessionUpdate || '';
    const usage = m.usage || m.tokenUsage || raw.usage;
    if (usage && typeof usage === 'object') this.emit('usage', { ...usage, source: 'runtime' });
    // The native thinking stream is also evidence of activity; only a throttled signal is reported, and private reasoning content is not recorded and tokens are not estimated.
    if(type==='content_block_delta'&&m.delta?.type==='thinking_delta'&&(!this.lastThinkingAt||Date.now()-this.lastThinkingAt>=15000)) {
      this.lastThinkingAt=Date.now();this.emit('log',{text:tr('cliPrintSession.modelThinkingNativeProgressEvent')});
    }
    if (type === 'error' || m.error) {
      const errText = m.error?.message || m.message || extractText(m.error) || tr('cliPrintSession.runtimeError');
      this.runtimeError = this.runtimeError || errText;
      this.emit('log', { text: errText });
    }
    const delta = m.delta?.text || (m.delta?.type === 'text_delta' ? m.delta.text : '') || m.text_delta || (type === 'content_block_delta' ? extractText(m.delta) : '');
    if (delta) this.appendText(delta);
    else if (type === 'assistant' || type === 'agent_message_chunk' || type === 'agent_message') {
      const text = extractText(m.message?.content || m.content || m.message || m.text);
      if (text) this.appendSnapshot(text);
    }
    if (!delta && type === 'message' && (m.role === 'assistant' || m.content)) {
      const text = extractText(m.content || m.message);
      if (text) this.appendSnapshot(text);
    }
    if (type === 'result' || type === 'completion' || m.subtype === 'success') {
      const text = typeof m.result === 'string' ? m.result : extractText(m.response || m.result || m.message || m.content);
      if (text) this.finalText = text;
      if (m.is_error || m.status==='ERROR') {
        // result/response is partial body text, not the error reason; keep the real diagnostics received earlier.
        this.runtimeError = this.runtimeError || extractText(m.error) || tr('cliPrintSession.runtimeReturnedErrorResultCheck');
        this.emit('log', { text: this.runtimeError });
      } else if(m.status==='SUCCESS' || m.subtype==='success') this.runtimeError='';
      if(this.keepAlive) {
        this.finish(this.runtimeError?'failed':'succeeded',this.runtimeError||undefined);
        if(this.runtimeError)this.shutdown();
      }
    }
    // Agy 1.2.x reports the tool lifecycle via step_update; a stable ID lets the page merge start and end.
    if(this.runtime==='agy' && type==='step_update' && m.step_type==='tool' && m.tool_info && m.step_index!==undefined) {
      this.emit('tool',{text:m.tool_name||m.tool_info.name||tr('cliPrintSession.toolCall'),item:{
        id:`agy:${m.conversation_id||this.nativeSessionId}:${m.step_index}`,type:'tool_call',
        name:m.tool_name||m.tool_info.name,arguments:m.tool_info.parameters,output:m.tool_info.output,
        status:m.state==='DONE'?'completed':['ERROR','FAILED'].includes(m.state)?'failed':'inProgress'
      }});
    }
    const tool = m.tool_use || m.toolCall || (type === 'tool_use' || type === 'tool_call' || type === 'tool' ? m : null);
    if (tool && (tool.name || tool.title || tool.command || type === 'tool_call')) {
      this.emit('tool', { text: tool.name || tool.title || tool.command || tool.kind || tr('cliPrintSession.working'), item: tool });
    }
    if (Array.isArray(m.message?.content)) {
      for (const block of m.message.content) {
        if (block?.type === 'tool_use' || block?.name) this.emit('tool', { text: block.name || block.type || tr('cliPrintSession.working2'), item: block });
        if(block?.type==='tool_result'&&block.tool_use_id)this.emit('tool',{text:tr('cliPrintSession.toolResult'),item:{id:block.tool_use_id,status:block.is_error?'failed':'completed',is_error:Boolean(block.is_error)}});
      }
    }
  }
  appendText(text) {
    if (!text) return;
    this.answer += text;
    this.textBuffer += text;
    if (!this.textTimer) this.textTimer = setTimeout(() => this.flushText(), 300);
  }
  /** Some CLIs resend a cumulative snapshot after the deltas; only the newly appearing suffix of the snapshot is appended. */
  appendSnapshot(text) {
    if (!text || this.answer.endsWith(text) || this.answer.startsWith(text)) return;
    if (text.length > (this.bestAnswer?.length || 0)) this.bestAnswer = text;
    if (text.startsWith(this.answer)) this.appendText(text.slice(this.answer.length));
    else this.appendText(text);
  }
  flushText() { clearTimeout(this.textTimer); this.textTimer = null; if (this.textBuffer) { this.emit('text', { text: this.textBuffer }); this.textBuffer = ''; } }
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
    const answer = this.bestAnswer?.length > 500 && this.bestAnswer.length > (this.finalText?.length || 0) * 4
      ? this.bestAnswer : this.finalText || this.answer;
    if (answer && !this.emittedFinal) {
      this.emit('message', { text: answer, phase: 'final_answer' });
      this.emittedFinal = true;
    }
    this.done = true; clearTimeout(this.killTimer);
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
