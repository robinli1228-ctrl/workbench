import { spawn } from 'node:child_process';
import { mkdtemp, rm, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { tr, isMessage } from './i18n.mjs';
import { executionText } from './input-language.mjs';

export const defaultOrganizerPrompt = () => tr('conversationOrganizer.youOnlyOrganizeConversationSpecified');

/** New source text is provided in bounded contiguous segments; no workspace paths or wb execution credentials are accepted. */
export function organizerInput(snapshot) {
  const simplify=message=>({id:message.id,author:message.senderName||message.sender||tr('conversationOrganizer.unknown'),roleId:message.roleId||null,time:message.createdAt,
    text:String(message.text||''),range:message.range||null,attachments:message.attachments||[]});
  const delta=snapshot.delta.map(simplify),recent=snapshot.recent.map(simplify),deltaIds=new Set(delta.map(item=>item.id));
  const input=JSON.stringify({previous:snapshot.prior?{goal:snapshot.prior.goal,constraints:snapshot.prior.constraints,openItems:snapshot.prior.openItems,
    recentSummary:snapshot.prior.recentSummary,roleSummaries:snapshot.prior.roleSummaries,coveredThroughMessageId:snapshot.prior.coveredThroughMessageId,partialThrough:snapshot.prior.partialThrough||null}:null,
    roleSessions:snapshot.roleSessions||[],newMessages:delta,recentWindowIds:recent.map(item=>item.id),
    recentMessages:recent.filter(item=>!deltaIds.has(item.id)),coveredThroughMessageId:snapshot.lastMessageId});
  if(input.length>20000)throw new Error(tr('conversationOrganizer.messagesOrganizeExceedPerBatch'));
  return input;
}

/**
 * The prompt goes in on stdin (Claude, Codex) or a private file (Grok), so other users of the machine cannot read the
 * material from the process list; Agy only takes it as an argument. Nothing of the run is meant to be kept: Claude saves
 * no session, Codex runs ephemeral, and what Grok and Agy save is removed afterwards (see forgetRun).
 */
export function command(config,prompt) {
  const {runtime,model,effort}=config;
  if(!model || !['claude','grok','agy','codex'].includes(runtime))throw new Error(tr('conversationOrganizer.conversationOrganizerModelNotConfigured'));
  if(runtime==='claude')return {bin:process.env.CLAUDE_BIN||'claude',stdin:prompt,args:['-p','--model',model,'--output-format','json','--tools','','--restricted','--no-session-persistence',...(effort?['--effort',effort]:[])]};
  // Grok documents headless input as an argument or --prompt-file, so it reads a 0600 file in the private run folder.
  if(runtime==='grok')return {bin:process.env.GROK_BIN||'grok',stdin:null,promptFile:join(config.cwd,'prompt.txt'),args:['--cwd',config.cwd,'--prompt-file',join(config.cwd,'prompt.txt'),'-m',model,'--output-format','json','--tools','',...(effort?['--reasoning-effort',effort]:[])]};
  if(runtime==='agy')return {bin:process.env.AGY_BIN||'agy',stdin:null,args:['--print',prompt,'--model',model,'--output-format','json','--mode','plan','--sandbox',...(effort?['--effort',effort]:[])]};
  return {bin:process.env.CODEX_BIN||'codex',stdin:prompt,args:['exec','--json','--sandbox','read-only','--ephemeral','--skip-git-repo-check','--ignore-user-config','--ignore-rules','-m',model,
    ...(effort?['-c',`model_reasoning_effort=${effort}`]:[]),'-']};
}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Remove what a CLI saved for this one-off run: only paths derived from its own temporary folder or its returned session ID. */
export async function forgetRun(runtime,cwd,out,env=process.env) {
  const home=env.HOME||homedir(),folders=[...new Set([cwd,await realpath(cwd).catch(()=>cwd)])];
  const paths=[];
  // Even without a saved session Claude creates an (empty) project folder named after the working folder.
  if(runtime==='claude')for(const folder of folders)paths.push(join(env.CLAUDE_CONFIG_DIR||join(home,'.claude'),'projects',folder.replace(/[^A-Za-z0-9]/g,'-')));
  if(runtime==='grok')for(const folder of folders)paths.push(join(home,'.grok','sessions',encodeURIComponent(folder)));
  if(runtime==='agy'){
    let id=null;try{id=JSON.parse(out).conversation_id;}catch{}
    if(typeof id==='string'&&UUID.test(id)){const root=join(home,'.gemini','antigravity-cli');paths.push(join(root,'brain',id),join(root,'conversations',`${id}.db`),join(root,'annotations',`${id}.pbtxt`),join(root,'presence',`${id}.lock`));}
  }
  await Promise.all(paths.map(path=>rm(path,{recursive:true,force:true}).catch(()=>{})));
  return paths;
}

function resultText(raw,runtime) {
  if(runtime==='codex') {
    const events=raw.split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
    return events.filter(event=>event.type==='item.completed'&&event.item?.type==='agent_message').map(event=>event.item.text).at(-1)||'';
  }
  const parsed=JSON.parse(raw);
  const value=parsed.structured_output||parsed.result||parsed.text||parsed.response||parsed.output||parsed;
  return typeof value==='string'?value:JSON.stringify(value);
}

export function parseOrganizerResult(raw,runtime) {
  const text=resultText(raw,runtime).trim();
  const body=text.startsWith('```')?text.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim():text;
  return JSON.parse(body);
}

/** Real work may preempt background organizing, but capacity is released only after the child process has exited. */
export async function preemptOrganizers(controllers) {
  const active=[...controllers];
  for(const controller of active)controller.abort(tr('conversationOrganizer.conversationOrganizingYieldedWorkTask'));
  await Promise.all(active.map(controller=>controller.finished));
}

/** A short-lived non-interactive process; no bridge and no working-role session, and after a timeout it waits for the process to exit before returning the slot. */
export async function runOrganizer({snapshot,config,dataRoot,timeoutMs=120000,signal=null}) {
  const input=organizerInput(snapshot);
  const cwd=await mkdtemp(join(resolve(dataRoot),'summary-'));
  const instructions=!config.prompt||isMessage(config.prompt.trim(),'conversationOrganizer.youOnlyOrganizeConversationSpecified')?executionText('conversationOrganizer.youOnlyOrganizeConversationSpecified'):config.prompt;
  const prompt=executionText('conversationOrganizer.belowMaterialOrganizeNeverExecute', { p1: instructions, input, p3: JSON.stringify(snapshot.lastMessageId) });
  return runModelPrompt({prompt,config,cwd,timeoutMs,signal});
}

/** One prompt to a tool-less model in an empty temporary folder; the answer must be JSON. Also used by memory organizing. */
export async function runModelPrompt({prompt,config,cwd,dataRoot,timeoutMs=120000,signal=null}) {
  if(!cwd)cwd=await mkdtemp(join(resolve(dataRoot),'summary-'));
  const {bin,args,stdin,promptFile}=command({...config,cwd},prompt);
  if(promptFile)await writeFile(promptFile,prompt,{mode:0o600});
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('WB_')&&!['WORKER_TOKEN','API_TOKEN'].includes(key)));
  let out='';
  try {
    return await new Promise((resolve,reject)=>{
      const proc=spawn(bin,args,{cwd,env,stdio:[stdin===null?'ignore':'pipe','pipe','pipe']});
      if(stdin!==null){proc.stdin.on('error',()=>{});proc.stdin.end(stdin);}
      let err='',timedOut=false,killTimer;
      const onAbort=()=>{proc.kill('SIGTERM');killTimer??=setTimeout(()=>proc.kill('SIGKILL'),3000);killTimer.unref();};
      if(signal?.aborted)onAbort();else signal?.addEventListener('abort',onAbort,{once:true});
      const timer=setTimeout(()=>{timedOut=true;onAbort();},timeoutMs);
      proc.stdout.on('data',bytes=>{out+=bytes.toString();if(out.length>1000000)proc.kill('SIGTERM');});
      proc.stderr.on('data',bytes=>{err=(err+bytes.toString()).slice(-3000);});
      proc.on('error',error=>{clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',onAbort);reject(error);});
      proc.on('close',code=>{
        clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',onAbort);
        if(signal?.aborted)return reject(new Error(typeof signal.reason==='string'?signal.reason:tr('conversationOrganizer.conversationOrganizingStopped')));
        if(timedOut)return reject(new Error(tr('conversationOrganizer.conversationOrganizerModelTimedOut')));
        if(code!==0) {
          let reason=err.slice(-500);
          try { reason=JSON.parse(out).result||reason; } catch {}
          return reject(new Error(tr('conversationOrganizer.conversationOrganizerModelExitedWith', { code, p2: String(reason).slice(-500) })));
        }
        try { resolve(parseOrganizerResult(out,config.runtime)); }
        catch(error) { reject(new Error(tr('conversationOrganizer.conversationOrganizerReturnedNoValid', { message: error.message }))); }
      });
    });
  } finally { await forgetRun(config.runtime,cwd,out,env);await rm(cwd,{recursive:true,force:true}); }
}
