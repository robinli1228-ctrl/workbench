import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { tr } from './i18n.mjs';
import { executionText } from './input-language.mjs';
import { contextSample } from './context-usage.mjs';
import { codexPermissionOptions } from './role-permissions.mjs';

const git = promisify(execFile);
const MAX_TOOL_OUTPUT = 12000;

function boundedToolOutput(value) {
  if(typeof value!=='string')return {value,truncated:false};
  return {value:value.slice(-MAX_TOOL_OUTPUT),truncated:value.length>MAX_TOOL_OUTPUT};
}

const PRIVATE_OR_MESSAGE_ITEMS=new Set(['agentMessage','reasoning','userMessage','plan','contextCompaction']);

function isToolItem(item) {
  if(!item?.id||PRIVATE_OR_MESSAGE_ITEMS.has(item.type))return false;
  return ['commandExecution','fileChange','mcpToolCall','dynamicToolCall','webSearch','imageView'].includes(item.type)
    || /(?:ToolCall|Execution)$/i.test(item.type||'') || Boolean(item.command||item.tool||item.server||Array.isArray(item.changes));
}

function toolOutputText(value) {
  if(typeof value==='string')return value;
  if(Array.isArray(value))return value.map(toolOutputText).filter(Boolean).join('\n');
  if(value&&typeof value==='object') {
    const parts=[typeof value.text==='string'?value.text:'',value.content!==undefined?toolOutputText(value.content):'',
      value.structuredContent!==undefined?toolOutputText(value.structuredContent):'',value.output!==undefined?toolOutputText(value.output):''];
    const unique=[...new Set(parts.filter(Boolean))];
    if(unique.length)return unique.join('\n');
  }
  if(value===undefined||value===null)return '';
  try{return JSON.stringify(value);}catch{return String(value);}
}

function completedToolSnapshot(item) {
  const snapshot={...item};let field,raw;
  if(Object.hasOwn(snapshot,'result')){raw=snapshot.result;delete snapshot.result;field='output';}
  else for(const candidate of ['aggregatedOutput','output','results'])if(Object.hasOwn(snapshot,candidate)){field=candidate;raw=snapshot[candidate];break;}
  if(field&&raw!==undefined&&raw!==null){const output=boundedToolOutput(toolOutputText(raw));snapshot[field]=output.value;if(output.truncated)snapshot.outputTruncated=true;}
  return snapshot;
}

/** The Git metadata of a worktree lives outside the working directory; only the metadata of bound repositories is opened up, for fetch/commit. */
async function gitMetadataRoots(roots) {
  const metadata = await Promise.all([...new Set(roots)].map(async cwd => {
    try {
      const { stdout } = await git('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { cwd, timeout: 5000 });
      return stdout.trim().split('\n').filter(Boolean);
    } catch (error) {
      if (error.code === 128 || error.code === 'ENOENT') return []; // the project container directory need not be a Git repository.
      throw error;
    }
  }));
  return [...new Set(metadata.flat())];
}

/** A managed role may briefly reuse the App Server, rebinding instructions and events every turn; stdio exposes no control port. */
export class CodexSession {
  constructor({ cwd, writableRoots = [], attachments = [], model, mode, emit, roleInstructions = '', roleName = '', effort = 'low', autoApprove = true, env = process.env, resumeSessionId = null, keepAlive = false, maintenance = false,minimalInstructions=false,configurationUpdate='',beforeInput,onProcess,permissionScope=null,toolRoots=[] }) {
    this.beforeInput=beforeInput;this.onProcess=onProcess;this.inputAttempted=false;
    this.minimalInstructions=minimalInstructions;
    this.configurationUpdate=configurationUpdate;
    this.keepAlive=keepAlive;
    this.attachments = attachments;
    this.cwd = cwd; this.model = model; this.mode = maintenance ? 'read-only' : 'workspace-write'; this.emit = emit;
    this.roleInstructions = roleInstructions; this.roleName = roleName;
    this.writableRoots = writableRoots;
    // A frozen role scope replaces the legacy sandbox; approval scope routes escalation requests to the human instead of auto-accepting.
    this.permissionScope = maintenance ? null : permissionScope; this.toolRoots = toolRoots;
    this.effort = effort; this.autoApprove = this.permissionScope !== 'device-approval'; this.env = env;
    this.resumeSessionId = resumeSessionId;
    this.nextId = 0; this.pending = new Map(); this.approvals = new Map();
    this.stopping = false; this.done = false;
    this.items = new Map(); this.toolOutputBuffers = new Map(); this.textBuffer = '';
  }
  /** After the turn has completed and the Worker has cleaned up the old bridge, rebind the events and instructions of the new Run. */
  reuse(options) {
    if(!this.done || !this.proc || this.proc.killed || this.proc.exitCode!==null || this.proc.signalCode!==null)throw new Error(tr('codex.codexProcessCannotBeReused'));
    Object.assign(this,options);this.done=false;this.stopping=false;this.turnId=null;
    // Logical review mode must not disable WB receipt writes on reuse; match fresh business admission and keep maintenance read-only.
    this.mode=options.maintenance?'read-only':'workspace-write';
    this.items.clear();
    for(const state of this.toolOutputBuffers.values())clearTimeout(state.timer);
    this.toolOutputBuffers.clear();this.textBuffer='';
  }
  async start(prompt) {
    this.inputAttempted=false;
    if(this.proc)this.onProcess?.(this.proc);
    if(!this.proc) {
    this.proc = spawn(process.env.CODEX_BIN || 'codex', this.launchArgs(), { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: this.env,detached:process.platform!=='win32' });
    this.onProcess?.(this.proc);
    this.proc.on('error', e => this.transportError(e));
    this.proc.stdin.on('error', e => this.transportError(e));
    this.proc.on('exit', (code, signal) => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(tr('codex.codexAppServerHasExited'))); }
      this.pending.clear();
      if (!this.done) this.finish(!this.turnId ? (this.stopping ? 'interrupted' : 'failed') : 'reconciling', this.turnId ? tr('codex.appServerExitedUnexpectedlyTool') : tr('codex.appServerExited', { p1: code ?? signal }));
    });
    this.proc.stderr.on('data', bytes => this.emit('log', { text: bytes.toString().slice(0, 6000) }));
    const lines = createInterface({ input: this.proc.stdout });
    lines.on('line', line => { try { this.receive(JSON.parse(line)); } catch (e) { this.emit('log', { text: tr('codex.eventHandlingError', { message: e.message }) }); } });
    await this.request('initialize', { clientInfo: { name: 'agent_collaboration_worker', version: '0.3.0' } });
    this.write({ method: 'initialized' });
    }
    if (this.stopping) return this.shutdown();
    const response = await this.openThread();
    this.threadId = response.id;
    await this.applyConfigurationUpdate();
    this.emit('status', { status: 'running', threadId: this.threadId, nativeSessionId: this.threadId, workspace: this.cwd });
    if (this.stopping) return this.shutdown();
    let result;
    try {
      await this.beforeInput?.();
      this.inputAttempted=true;
      result = await this.request('turn/start', { threadId: this.threadId, input: [{ type: 'text', text: prompt }, ...this.attachments.filter(a => a.mime.startsWith('image/')).map(a => ({type:'localImage',path:a.path}))], ...(this.effort ? { effort: this.effort } : {}) });
    } catch(error) {
      // turn/started may arrive before the RPC reply; a tool state that is already out of control must not be overwritten by an ordinary Worker start failure.
      if(this.turnId){
        if(!this.done)this.finish('reconciling',tr('codex.codexTurnHasStartedBut', { message: error.message }));
        this.shutdown();return;
      }
      throw error;
    }
    this.turnId = result.turn.id;
    this.emit('status',{inputDeliveryState:'accepted'});
    if (this.stopping) await this.stop();
  }
  /** Append the operator-approved update at developer authority; an RPC acknowledgement is delivery, not a model verification round. */
  async applyConfigurationUpdate() {
    if(!this.configurationUpdate)return;
    await this.request('thread/inject_items',{threadId:this.threadId,items:[{type:'message',role:'developer',content:[{type:'input_text',text:this.configurationUpdate}]}]});
    this.emit('status',{configurationEventState:'delivered'});
  }
  /** All turns reuse the ordinary launch arguments; permissions and external tools are not switched by discussion purpose. */
  launchArgs() {
    const args=['app-server','--listen','stdio://','--disable','multi_agent'];
    return args;
  }
  /** Each turn loads history by exact ID and updates that turn's tool environment and role rules. */
  async openThread() {
    // Loaded-thread resume ignores environment overrides. Retain the process and native ID, but release this idle subscription before reloading.
    if(this.minimalInstructions&&this.threadId)await this.request('thread/unsubscribe',{threadId:this.threadId});
    const writableRoots = [...new Set([...this.writableRoots, ...await gitMetadataRoots([this.cwd, ...this.writableRoots])])];
    const scoped = this.permissionScope ? codexPermissionOptions(this.permissionScope, { toolRoots: this.toolRoots, writeRoots: writableRoots }) : null;
    if (this.permissionScope && !scoped) throw new Error(`Unsupported permission scope: ${this.permissionScope}`);
    const options = {
      cwd: this.cwd, model: this.model, approvalPolicy: scoped ? scoped.approvalPolicy : this.autoApprove ? 'never' : 'untrusted',
      ...(scoped ? (scoped.sandbox ? { sandbox: scoped.sandbox } : {}) : { sandbox: this.mode }),
      // Git sync and cross-device wb communication need network access; the workspace write boundary is kept and re-applied on resume.
      config: { ...Object.fromEntries(['GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT', 'WB_TURN_CONTEXT', 'WB_PROJECT_ROOT', 'WB_KNOWLEDGE', 'WB_WORKSPACE', 'WB_RUN_ID', 'WB_ROLE_SESSION_ID', 'WB_CONVERSATION_ID', 'WB_REQUEST_ID', 'WB_ROLE', 'WB_HOP', 'WB_HOME', 'WB_MODE', 'WB_BRIDGE', 'WB_CLI', 'WB_REPOSITORIES', 'WB_SOURCE_SYNC']
        .filter(key => typeof this.env[key] === 'string').map(key => [`shell_environment_policy.set.${key}`, this.env[key]])), ...(scoped ? scoped.config : { 'sandbox_workspace_write.writable_roots':writableRoots, 'sandbox_workspace_write.network_access':true }) },
      developerInstructions: this.minimalInstructions?this.roleInstructions:executionText('codex.you', { p1: this.roleName ? executionText('codex.roleInProjectGroupChat', { roleName: this.roleName }) : executionText('codex.executorTask'), p2: this.roleInstructions || '' })
    };
    const response = await this.request(this.resumeSessionId?'thread/resume':'thread/start',this.resumeSessionId?{threadId:this.resumeSessionId,...options}:options);
    if(this.resumeSessionId && response.thread?.id!==this.resumeSessionId)throw new Error(tr('codex.resumedCodexSessionIdDoes'));
    return response.thread;
  }
  /** The pipe may close after the writable check; neither a synchronous failure nor an asynchronous EPIPE may crash the whole Worker. */
  write(value) {
    const input=this.proc?.stdin;
    if(!input?.writable || input.destroyed || input.writableEnded)return false;
    try {input.write(`${JSON.stringify(value)}\n`);return true;}
    catch(error){this.transportError(error);return false;}
  }
  transportError(error) {
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}
    this.pending.clear();
    if(!this.done)this.finish(this.turnId?'reconciling':'failed',tr('codex.codexCommunicationWasInterrupted', { message: error.message }));
    this.shutdown();
  }
  request(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(tr('codex.codexTimedOut', { method }))); }, 45000);
      this.pending.set(id, { resolve, reject, timer });
      if(!this.write({ id, method, params })) {clearTimeout(timer);this.pending.delete(id);reject(new Error(tr('codex.codexInputConnectionClosed')));}
    });
  }
  /** Native permission requests are held for a single manual decision; unknown server requests are rejected to avoid waiting indefinitely. */
  receive(m) {
    if (m.id !== undefined && !m.method) {
      const p = this.pending.get(m.id); if (!p) return;
      clearTimeout(p.timer); this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return;
    }
    if (m.id !== undefined && m.method) {
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(m.method)) {
        if (this.autoApprove) {
          this.write({ id: m.id, result: { decision: 'accept' } });
          this.emit('log', { text: tr('codex.autoApproved', { p1: m.method.includes('fileChange') ? tr('codex.fileChange') : tr('codex.command') }) });
          return;
        }
        const id = String(m.id);
        const expiresAt = new Date(Date.now() + 300000).toISOString();
        const timer = setTimeout(() => this.approve(id, 'decline'), 300000);
        this.approvals.set(id, { rpcId: m.id, timer });
        this.emit('approval', { id, method: m.method, params: { ...m.params, item: this.items.get(m.params.itemId) || null }, expiresAt });
        this.emit('status', { status: 'waiting_user' });
      } else {
        this.write({ id: m.id, error: { code: -32601, message: tr('codex.interactionNotImplementedOnCurrent') } });
        this.emit('log', { text: tr('codex.unsupportedInteractionWasRejected', { method: m.method }) });
      }
      return;
    }
    const p = m.params || {};
    if(this.done)return;
    if (m.method === 'item/agentMessage/delta') {
      this.textBuffer += p.delta || '';
      if (!this.textTimer) this.textTimer = setTimeout(() => this.flushText(), 300);
    }
    if (m.method === 'item/started' && p.item?.id) this.items.set(p.item.id, p.item);
    if (m.method === 'item/completed' && p.item?.type === 'agentMessage') { this.flushText(); this.emit('message', { text: p.item.text, phase: p.item.phase || 'final_answer' }); }
    if (m.method === 'item/started' && isToolItem(p.item)) this.emit('tool', { text: p.item.command || p.item.tool || p.item.type || tr('codex.working'), item: p.item });
    if(m.method==='item/commandExecution/outputDelta' && p.itemId && typeof p.delta==='string')this.queueToolOutput(p.itemId,p.delta);
    // Save the completion state; file write attribution and tool logs must not rely on the intent of a single call alone.
    if (m.method === 'item/completed' && p.item?.type==='fileChange') this.emit('tool', {text:p.item.type,item:p.item});
    if(m.method==='item/completed'&&p.item?.type==='commandExecution'){
      this.flushToolOutput(p.item.id);this.items.set(p.item.id,p.item);
      const output=boundedToolOutput(p.item.aggregatedOutput);
      this.emit('tool',{text:p.item.type,item:{...p.item,aggregatedOutput:output.value,...(output.truncated?{outputTruncated:true}:{})}});
    }
    if(m.method==='item/completed'&&isToolItem(p.item)&&!['commandExecution','fileChange'].includes(p.item.type)){
      this.items.set(p.item.id,p.item);
      this.emit('tool',{text:p.item.tool||p.item.type,item:completedToolSnapshot(p.item)});
    }
    if (m.method === 'thread/tokenUsage/updated') {
      this.emit('usage', { ...(p.tokenUsage?.total || p.tokenUsage || p), source: 'runtime', modelContextWindow: p.tokenUsage?.modelContextWindow });
      this.emit('context_usage',contextSample({usedTokens:p.tokenUsage?.last?.inputTokens,limitTokens:p.tokenUsage?.modelContextWindow,model:this.model,sessionId:p.threadId||this.threadId||this.resumeSessionId||null}));
    }
    if(m.method==='item/completed'&&p.item?.type==='contextCompaction')this.emit('context_usage',contextSample({usedTokens:null,model:this.model,sessionId:p.threadId||this.threadId||this.resumeSessionId||null,state:'compacted'}));
    if (m.method === 'turn/started') {this.turnId = p.turn?.id;this.emit('status',{inputDeliveryState:'accepted'});}
    if (m.method === 'turn/completed') {
      const status = p.turn?.status;
      this.finish(status === 'completed' ? 'succeeded' : status === 'interrupted' ? 'interrupted' : 'failed', p.turn?.error?.message);
      if(!this.keepAlive || status!=='completed')this.shutdown();
    }
    if (m.method === 'error') this.emit('log', { text: p.error?.message || tr('codex.runtimeError') });
  }
  approve(id, decision) {
    const a = this.approvals.get(id); if (!a) throw new Error(tr('codex.approvalRequestDoesNotExist'));
    clearTimeout(a.timer); this.approvals.delete(id);
    this.write({ id: a.rpcId, result: { decision: decision === 'accept' ? 'accept' : 'decline' } });
    this.emit('approval_resolved', { id, status: decision === 'accept' ? 'accepted' : 'declined' });
    if (!this.done && !this.stopping) this.emit('status', { status: 'running' });
  }
  async stop() {
    if (this.done) return;
    this.stopping = true;
    for (const id of [...this.approvals.keys()]) this.approve(id, 'decline');
    if (this.threadId && this.turnId) {
      try { await this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }); }
      catch (e) { this.emit('log', { text: e.message }); }
    } else this.shutdown();
    if (!this.done) {
      this.stopTimer = setTimeout(() => { if (!this.done) this.emit('status', { status: 'reconciling', error: tr('codex.noRuntimeStopConfirmationReceived') }); }, 15000);
      this.stopTimer.unref();
    }
  }
  finish(status, error) {
    if (this.done) return;
    this.flushText();
    for(const id of [...this.toolOutputBuffers.keys()])this.flushToolOutput(id);
    this.done = true; clearTimeout(this.stopTimer);
    for (const a of this.approvals.values()) clearTimeout(a.timer);
    this.approvals.clear(); this.emit('status', { status, ...(status === 'reconciling' ? { controlLost: true } : {}), ...(error ? { error } : {}) });
  }
  flushText() { clearTimeout(this.textTimer); this.textTimer = null; if (this.textBuffer) { this.emit('text', { text: this.textBuffer }); this.textBuffer = ''; } }
  /** Coalesce noisy command chunks while retaining a stable tool ID; completion later replaces this delta view with its full snapshot. */
  queueToolOutput(id, delta) {
    const current=this.toolOutputBuffers.get(id)||{text:'',timer:null,outputTruncated:false};
    const output=boundedToolOutput(current.text+delta);
    current.text=output.value;current.outputTruncated||=output.truncated;
    if(!current.timer)current.timer=setTimeout(()=>this.flushToolOutput(id),300);
    this.toolOutputBuffers.set(id,current);
  }
  flushToolOutput(id) {
    const state=this.toolOutputBuffers.get(id);if(!state)return;
    clearTimeout(state.timer);this.toolOutputBuffers.delete(id);
    if(!state.text)return;
    const base=this.items.get(id)||{};
    this.emit('tool',{text:base.command||base.type||tr('codex.working'),item:{id,type:base.type||'commandExecution',status:base.status||'inProgress',...(base.command?{command:base.command}:{}),outputDelta:state.text,...(state.outputTruncated?{outputTruncated:true}:{})}});
  }
  /** Only wind down the process held by this Adapter; if it refuses to exit, force-kill after a bounded wait so it does not occupy a Worker slot indefinitely. */
  shutdown() {
    const proc=this.proc;
    if(!proc || proc.exitCode!==null || proc.signalCode!==null)return;
    if(!proc.killed){try{proc.stdin.end();}catch{}proc.kill('SIGTERM');}
    if(!this.killTimer){
      this.killTimer=setTimeout(()=>{if(proc.exitCode===null && proc.signalCode===null)proc.kill('SIGKILL');},3000);
      this.killTimer.unref();
      proc.once('exit',()=>{clearTimeout(this.killTimer);this.killTimer=null;});
    }
  }
}
