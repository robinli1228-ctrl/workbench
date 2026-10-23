import { userInfo, homedir } from 'node:os';
import { readdir, stat, access, realpath, readlink, readFile } from 'node:fs/promises';
import { constants, readFileSync } from 'node:fs';
import { join, resolve, delimiter, relative, isAbsolute, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Store } from './store.mjs';
import { tr } from './i18n.mjs';
import {syncError} from './source-sync-manifest.mjs';
import { terminalPermissionArgs } from './role-permissions.mjs';

const sessionPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const closed = new Set(['released', 'cancelled']);
export const TERMINAL_PREPARATION_TTL_MS = 5 * 60 * 1000;

/** Only accept the CLI's session fields; an arbitrary tool call id is never treated as a session. */
export function nativeSessionId(raw, runtime) {
  const id = runtime === 'agy'
    ? raw.conversationId || raw.conversation_id || raw.session_id || raw.sessionId
    : runtime === 'codex' ? raw.thread_id || raw.session_id || raw.sessionId
    : raw.session_id || raw.sessionId;
  return typeof id === 'string' && sessionPattern.test(id) ? id : null;
}

/** A scoped role keeps its frozen scope in a terminal; an unsupported or approval scope refuses the entry instead of falling back. */
export function scopedTerminalArgs(runtime,permissionScope,toolRoots=[]) {
  try { return terminalPermissionArgs(runtime,permissionScope,{toolRoots}); }
  catch(error) { throw new Error(tr(error.message,{scope:permissionScope})); }
}

/** Use an explicit native ID; never last, continue, or fork. */
export function resumeArgs(runtime, id) {
  if (!sessionPattern.test(id || '')) throw new Error(tr('terminalResume.validNativeSessionIdMissing'));
  const option = { codex:'resume', claude:'--resume', grok:'--resume', agy:'--conversation' }[runtime];
  if (!option) throw new Error(tr('terminalResume.cliDoesNotSupportResume'));
  return [option, id];
}

/** Headless first turn of a session opened on the Sessions page: the TUI's session and permission flags plus the CLI's print mode with JSON output, so the new native ID can be read from stdout. */
export function nativeHelloArgs(runtime, tuiArgs, prompt = 'Hi') {
  if (runtime === 'codex') return ['exec', '--json', '--skip-git-repo-check', ...tuiArgs, prompt];
  if (runtime === 'claude') return ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...tuiArgs];
  if (runtime === 'grok') return [...tuiArgs, '--output-format', 'streaming-messages-json', '-p', prompt];
  if (runtime === 'agy') return [...tuiArgs, '--output-format', 'stream-json', '--print', prompt];
  throw new Error(tr('terminalResume.cliDoesNotSupportResume'));
}

/** Start an interactive CLI with the saved role settings; never continue, fork or reference an old native ID. */
export function freshTerminalArgs({runtime,model,effort,instructions='',workspace,permissionScope,toolRoots=[]}) {
  if(typeof model!=='string'||!model||typeof instructions!=='string'||(effort&&typeof effort!=='string'))throw new Error(tr('roleTerminal.unconfigured'));
  const scoped=scopedTerminalArgs(runtime,permissionScope,toolRoots);
  if(runtime==='codex'&&scoped)return ['--model',model,...scoped,'-c',`developer_instructions=${JSON.stringify(instructions)}`,...(effort?['-c',`model_reasoning_effort=${JSON.stringify(effort)}`]:[])];
  if(runtime==='codex')return ['--model',model,'--sandbox','workspace-write','--ask-for-approval','never','-c',`developer_instructions=${JSON.stringify(instructions)}`,'-c','sandbox_workspace_write.network_access=true',...(effort?['-c',`model_reasoning_effort=${JSON.stringify(effort)}`]:[])];
  if(runtime==='claude')return ['--model',model,'--append-system-prompt',instructions,'--dangerously-skip-permissions',...(effort?['--effort',effort]:[])];
  if(runtime==='grok')return ['--cwd',workspace,'-m',model,'--rules',instructions,'--always-approve','--no-plan','--permission-mode','bypassPermissions',...(effort?['--reasoning-effort',effort]:[])];
  if(runtime==='agy')return ['--model',model,'--mode','accept-edits','--dangerously-skip-permissions',...(effort?['--effort',effort]:[]),...(instructions?['--prompt-interactive',instructions]:[])];
  throw new Error(tr('terminalResume.cliDoesNotSupportResume'));
}

/** Resolve missing device identity only from the original session, never from a role's mutable current device. */
function nativeSessionOwnership(db,{nodeId,runtime,sessionId}) {
  const projects=new Set(),unknown=new Set();
  if(!sessionId||!runtime||!nodeId)return {projects,unknown};
  const sessions=db.list('roleSessions'),byId=new Map(sessions.map(s=>[s.id,s]));
  for(const session of sessions)if(session.runtime===runtime&&session.nativeSessionId===sessionId&&session.projectId){if(session.nodeId===nodeId)projects.add(session.projectId);else if(!session.nodeId)unknown.add(session.projectId);}
  for(const run of db.list('runs'))if(run.nativeSession?.runtime===runtime&&run.nativeSession.id===sessionId&&run.projectId){
    const saved=byId.get(run.roleSessionId),device=run.nodeId||(saved?.projectId===run.projectId?saved.nodeId:null);
    if(device===nodeId)projects.add(run.projectId);else if(!device)unknown.add(run.projectId);
  }
  return {projects,unknown};
}

/** Native identity is device/runtime scoped; moving project folders does not transfer historical ownership. */
export function nativeSessionProjectIds(db,identity) {
  const {projects,unknown}=nativeSessionOwnership(db,identity);
  if(unknown.size)throw Error('Native session device ownership is unknown; check the original role session');
  return [...projects];
}

/** Resolve exact native ownership first; conflicting folders or identities must never fall back to standalone. */
export function nativeTerminalProject(db,{nodeId,runtime,sessionId,folderProjectIds=[],managedProjectIds=[]}) {
  const exact=new Set([...nativeSessionProjectIds(db,{nodeId,runtime,sessionId}),...(sessionId?managedProjectIds:[])]);
  const folders=new Set(folderProjectIds.filter(Boolean));
  if(exact.size>1||folders.size>1)throw Error('Native session ownership is ambiguous; open it from the owning role instead');
  const owner=[...exact][0],folder=[...folders][0];
  if(owner&&folder&&owner!==folder)throw Error('Native session and folder belong to different group chats');
  return owner||folder||null;
}

/** Keep unreturned leases, including legacy standalone claims that actually own a group's native session. */
export function terminalOwnsProject(db,session,projectId) {
  if(!projectId||closed.has(session.status))return false;
  if(session.projectId===projectId)return true;
  if(!['native','native-turn'].includes(session.kind))return false;
  const {projects,unknown}=nativeSessionOwnership(db,{nodeId:session.nodeId,runtime:session.runtime||session.nativeSession?.runtime,sessionId:session.sessionId||session.nativeSession?.id});
  return projects.has(projectId)||unknown.has(projectId);
}

/** Take over the whole project's execution window on this node, avoiding concurrent use of the shared directory and deliveries. */
export function projectTerminalLock(db, projectId, nodeId) {
  return db.list('terminalSessions').find(s => s.nodeId === nodeId && terminalOwnsProject(db,s,projectId)) || null;
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}

/** A PID alone can be reused; capture the owner and start identity without exposing process arguments. */
export function terminalProcessIdentity(pid) {
  if(!Number.isInteger(pid)||pid<1)return null;
  try{
    const line=execFileSync('ps',['-p',String(pid),'-o','pid=,ppid=,uid=,pgid=,lstart=,stat=,command='],{encoding:'utf8',timeout:3000,maxBuffer:128000,env:{...process.env,LC_ALL:'C'},stdio:['ignore','pipe','ignore']}).trim();
    const m=line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+([\s\S]*)$/);
    if(!m)throw new Error('ps');
    let start=m[5];
    if(process.platform==='linux'){const stat=readFileSync(`/proc/${pid}/stat`,'utf8');start=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()+':'+stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];}
    return {pid:Number(m[1]),ppid:Number(m[2]),uid:Number(m[3]),pgid:Number(m[4]),start,zombie:m[6].startsWith('Z'),command:m[7]};
  }catch{return processAlive(pid)?{pid,unknown:true}:null;}
}

const inside=(root,path)=>{const r=relative(root,path);return !r||r!=='..'&&!r.startsWith('../')&&!isAbsolute(r);};
const historyRoots=({runtime,home,env={}})=>({
  codex:[join(env.CODEX_HOME||join(home,'.codex'),'sessions'),join(env.CODEX_HOME||join(home,'.codex'),'archived_sessions')],
  claude:[join(env.CLAUDE_CONFIG_DIR||join(home,'.claude'),'projects')],grok:[join(home,'.grok','sessions')],agy:[join(home,'.gemini','antigravity-cli','conversations')]
})[runtime]||[];

/** Resolve an open vendor history path to its native ID without using cwd, timestamps or newest-file guesses. */
async function nativeIdFromOpenPath(session,path){
  path=String(path||'').replace(/ \(deleted\)$/,'');if(!isAbsolute(path))return null;
  let file;try{file=await realpath(path);}catch{return null;}
  let allowed=false;for(const root of historyRoots(session)){try{if(inside(await realpath(root),file)){allowed=true;break;}}catch{}}
  if(!allowed)return null;
  const id=session.runtime==='codex'?basename(file).match(/-([a-f0-9]{8}-[a-f0-9-]{27})\.jsonl$/i)?.[1]
    :session.runtime==='grok'&&basename(file)==='chat_history.jsonl'?basename(dirname(file))
    :['claude','agy'].includes(session.runtime)&&/\.(jsonl|db|pb)$/.test(file)?basename(file).replace(/\.(jsonl|db|pb)$/,''):null;
  return typeof id==='string'&&sessionPattern.test(id)?id:null;
}

/** Inspect only the original child and its same-user descendants; unrelated CLIs cannot contribute files. */
function exactProcessTree(rootIdentity){
  const current=terminalProcessIdentity(rootIdentity?.pid);if(!sameProcess(current,rootIdentity)||current.zombie)return [];
  const found=new Map([[current.pid,current]]);let rows=[];
  try{rows=execFileSync('ps',['-axo','pid=,ppid=,uid='],{encoding:'utf8',timeout:3000,maxBuffer:1024*1024,env:{...process.env,LC_ALL:'C'},stdio:['ignore','pipe','ignore']}).trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number));}catch{return [current];}
  let changed=true;while(changed&&found.size<128){changed=false;for(const [pid,ppid,uid] of rows){if(found.has(pid)||!found.has(ppid)||uid!==current.uid)continue;const child=terminalProcessIdentity(pid);if(child&&!child.unknown&&!child.zombie&&child.ppid===ppid&&child.uid===uid){found.set(pid,child);changed=true;}}}
  return [...found.values()];
}

const driverProcess=(runtime,process,index)=>index===0||new RegExp(`(?:^|[/\\s])${runtime==='agy'?'agy':runtime}(?:\\.js)?(?:\\s|$)`,'i').test(process.command||'');
async function openFiles(processes,session){
  const pids=processes.filter((process,index)=>driverProcess(session.runtime,process,index)).map(process=>process.pid);
  if(process.platform==='linux'){
    const files=[];for(const pid of pids){for(const name of await readdir(`/proc/${pid}/fd`).catch(()=>[])){const info=await readFile(`/proc/${pid}/fdinfo/${name}`,'utf8').catch(()=>''),flags=info.match(/^flags:\s*([0-7]+)/m)?.[1];if(!flags||!(parseInt(flags,8)&3))continue;const path=await readlink(`/proc/${pid}/fd/${name}`).catch(()=>null);if(path)files.push(path);}}return files;
  }
  if(!pids.length)return [];
  try{const files=[];let mode='';for(const line of execFileSync('lsof',['-Fpfan','-p',pids.join(',')],{encoding:'utf8',timeout:3000,maxBuffer:1024*1024,stdio:['ignore','pipe','ignore']}).split('\n')){if(line.startsWith('f'))mode='';else if(line.startsWith('a'))mode=line.slice(1);else if(line.startsWith('n/')&&/[wu]/.test(mode))files.push(line.slice(1));}return files;}catch{return [];}
}

/** Observe an unsupported fresh-ID CLI for exact opened history files; ambiguity leaves the entry unbound. */
export function startNativeSessionObservation(session,rootIdentity,{intervalMs=2000}={}){
  const ids=new Set();let pending=Promise.resolve(),closed=false;
  const sample=()=>{pending=pending.then(async()=>{for(const path of await openFiles(exactProcessTree(rootIdentity),session)){const id=await nativeIdFromOpenPath(session,path);if(id)ids.add(id);}}).catch(()=>{});return pending;};
  void sample();const burst=[50,200,500,1000].map(delay=>{const timer=setTimeout(()=>void sample(),delay);timer.unref();return timer;}),timer=setInterval(()=>void sample(),Math.max(25,intervalMs));timer.unref();
  return {async finish(){if(!closed){closed=true;for(const item of burst)clearTimeout(item);clearInterval(timer);await sample();}else await pending;return ids.size===1?[...ids]:[];}};
}
const processKey=p=>p&&!p.unknown?{pid:p.pid,uid:p.uid,start:p.start}:null;
const sameProcess=(actual,expected)=>!!actual&&!actual.unknown&&actual.pid===expected?.pid&&actual.uid===expected.uid&&actual.start===expected.start;
export {processKey as processIdentityKey,sameProcess as sameProcessIdentity};

/** A recycled PID is not occupancy. Legacy executable clues can exclude a foreign process, never authorize stopping it. */
export function recordedProcessState(pid,expected,session={}) {
  if(!Number.isInteger(pid)||pid<1||!processAlive(pid))return 'exited';
  const current=terminalProcessIdentity(pid);
  if(!current||current.zombie)return 'exited';
  if(current.unknown)return 'unknown';
  if(expected) {
    if(expected.pid!==pid||!Number.isInteger(expected.uid)||typeof expected.start!=='string'||!expected.start)return 'unknown';
    if(current.start!==expected.start)return 'exited';
    return sameProcess(current,expected)?'active':'unknown';
  }
  const runtime=['codex','claude','grok','agy'].includes(session?.runtime)?session.runtime:null;
  const binary=typeof session?.binary==='string'&&session.binary?basename(session.binary):null;
  if(!runtime&&!binary||!current.command)return 'unknown';
  const executable=basename(current.command.match(/^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/)?.slice(1).find(Boolean)||'');
  const escaped=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  if([runtime,binary].filter(Boolean).some(name=>new RegExp(`(?:^|[/\\\\\\s])${escaped(name)}(?:\\.js)?(?:\\s|$)`,'i').test(current.command)))return 'unknown';
  // Generic launchers may hide the CLI executable; missing startup proof remains a safe wait.
  if(!executable||/^(?:node(?:js)?|python[\d.]*|bash|sh|zsh|dash|fish|env|perl|ruby|java|powershell|pwsh|cmd)(?:\.exe)?$/i.test(executable))return 'unknown';
  return 'exited';
}

/** Check driver and saved tool children together; finished model output does not prove process retirement. */
export function managedRunProcessState(run) {
  const states=[recordedProcessState(run?.pid,run?.processIdentity,run?.nativeSession),
    ...(run?.driverStopProcesses||[]).filter(proof=>proof.pid!==run.pid).map(proof=>recordedProcessState(proof.pid,proof))];
  return states.includes('active')?'active':states.includes('unknown')?'unknown':'exited';
}

function updateNativeCatalog(db,session,fields){
  if(session?.kind!=='native'||!session.catalogEntryId)return null;
  const current=db.get('nativeCatalogEntries',session.catalogEntryId);if(!current)return null;
  return db.put('nativeCatalogEntries',{...current,...fields,modifiedAt:new Date().toISOString()});
}
function releasedCatalogState(session,checkedAt){
  const launched=Boolean(session?.pid||session?.childPid||session?.startedAt);
  if(!launched)return session?.nativeSession?.id?{status:'ready'}:{status:'draft'};
  if(session?.nativeSession?.id)return {sessionId:session.nativeSession.id,status:'ready',exactLastScan:checkedAt};
  if(session?.nativeOptions?.freshId)return {sessionId:session.nativeOptions.freshId,status:'awaiting_history',exactLastScan:checkedAt};
  return {status:'awaiting_native_id',exactLastScan:checkedAt};
}

/** Old sessions are accepted only with a live, recognizable launcher or its direct child; uncertainty never authorizes a signal. */
function terminalProcesses(session,dbPath) {
  const wrapper=terminalProcessIdentity(session.pid),child=terminalProcessIdentity(session.childPid),owned=[];
  let unknown=false;
  const live=p=>p&&!p.zombie;
  const wrapperOwned=live(wrapper)&&(session.wrapperIdentity?sameProcess(wrapper,session.wrapperIdentity):!wrapper.unknown&&wrapper.command.includes('terminal-resume.mjs')&&wrapper.command.includes(dbPath)&&wrapper.command.includes(session.id));
  if(wrapperOwned)owned.push(processKey(wrapper));
  else if(live(wrapper)&&(!session.wrapperIdentity||wrapper.unknown||wrapper.start===session.wrapperIdentity.start&&wrapper.uid!==session.wrapperIdentity.uid))unknown=true;
  const childOwned=live(child)&&(session.childIdentity?sameProcess(child,session.childIdentity):!child.unknown&&wrapperOwned&&child.ppid===wrapper.pid&&child.uid===wrapper.uid);
  if(childOwned)owned.push(processKey(child));
  else if(live(child)&&(!session.childIdentity||child.unknown||child.start===session.childIdentity.start&&child.uid!==session.childIdentity.uid))unknown=true;
  for(const expected of session.stopProcesses||[]){const actual=terminalProcessIdentity(expected.pid);if(live(actual)&&sameProcess(actual,expected))owned.push(expected);else if(actual?.unknown||live(actual)&&actual.start===expected.start&&actual.uid!==expected.uid)unknown=true;}
  return {owned:[...new Map(owned.map(p=>[p.pid,p])).values()],unknown};
}

/** Revoke unused/dead links in the same transaction as native claiming; late preparation cannot resurrect the lease. */
export function checkTerminalSession(db,binding,dbPath,{automatic=false}={}) {
  return db.transaction(()=>{
    const prior=db.get('terminalSessions',binding.id),checkedAt=new Date().toISOString();
    if(prior&&(prior.projectId!==binding.projectId||prior.nodeId!==binding.nodeId))throw new Error(tr('worker.invalidTakeoverId'));
    if(!prior||closed.has(prior.status)){db.put('terminalSessions',{...binding,...prior,status:'released',releasedAt:prior?.releasedAt||checkedAt});return {id:binding.id,status:'released',processState:'released',checkedAt};}
    // Background checks allow time to open a new link; manual refresh remains an explicit revocation of unused links.
    if(automatic&&prior.status==='prepared'&&!prior.pid&&!prior.childPid&&Date.now()-Date.parse(prior.createdAt)<TERMINAL_PREPARATION_TTL_MS) {
      db.put('terminalSessions',{...prior,lastCheckedAt:checkedAt,processState:'prepared'});
      return {id:prior.id,status:'prepared',processState:'prepared',checkedAt};
    }
    const proof=terminalProcesses(prior,dbPath),processState=proof.unknown?'unknown':proof.owned.length?'active':'released';
    db.put('terminalSessions',{...prior,lastCheckedAt:checkedAt,processState,...(processState==='released'?{status:'released',releasedAt:checkedAt}:{})});
    const catalogEntry=processState==='released'?updateNativeCatalog(db,prior,releasedCatalogState(prior,checkedAt)):prior.catalogEntryId?db.get('nativeCatalogEntries',prior.catalogEntryId):null;
    return {id:prior.id,status:processState==='released'?'released':prior.status,processState,checkedAt,...(catalogEntry?{catalogEntry}:{}),...(proof.unknown?{reason:tr('terminalControl.identityUnknown')}:{})};
  });
}

/** Stop only verified descendants of this launcher/CLI, rechecking every identity before signalling. */
export async function stopTerminalSession(db,binding,dbPath,{graceMs=3000,killMs=3000}={}) {
  const checked=checkTerminalSession(db,binding,dbPath);
  if(checked.processState==='released')return {...checked,released:true,forced:false};
  if(checked.processState==='unknown')throw new Error(tr('terminalControl.identityUnknown'));
  const tracked=new Map();
  const collect=()=>{
    const prior=db.get('terminalSessions',binding.id),proof=terminalProcesses(prior,dbPath);
    if(proof.unknown)throw new Error(tr('terminalControl.identityUnknown'));
    for(const p of proof.owned)tracked.set(p.pid,p);
    const parents=new Set(proof.owned.map(p=>p.pid));
    const rows=execFileSync('ps',['-axo','pid=,ppid='],{encoding:'utf8',timeout:3000,maxBuffer:1024*1024}).trim().split('\n').map(s=>s.trim().split(/\s+/).map(Number));
    let changed=true;while(changed){changed=false;for(const [pid,parent]of rows){if(tracked.has(pid)||!parents.has(parent))continue;if(!sameProcess(terminalProcessIdentity(parent),tracked.get(parent)))continue;const p=terminalProcessIdentity(pid);if(!p||p.zombie)continue;if(p.unknown||p.uid!==tracked.get(parent).uid)throw new Error(tr('terminalControl.identityUnknown'));tracked.set(pid,processKey(p));parents.add(pid);changed=true;}}
    db.transaction(()=>{const current=db.get('terminalSessions',binding.id);if(!closed.has(current.status))db.put('terminalSessions',{...current,status:'stopping',stopProcesses:[...tracked.values()]});});
  };
  const alive=()=>[...tracked.values()].some(p=>{const actual=terminalProcessIdentity(p.pid);return actual?.unknown||sameProcess(actual,p)&&!actual.zombie;});
  const signal=name=>{const launcherPid=db.get('terminalSessions',binding.id)?.pid;for(const expected of [...tracked.values()].reverse()){if(name==='SIGTERM'&&expected.pid===launcherPid&&tracked.size>1)continue;const current=terminalProcessIdentity(expected.pid);if(current?.unknown)throw new Error(tr('terminalControl.identityUnknown'));if(sameProcess(current,expected)&&!current.zombie){if(typeof process.getuid==='function'&&current.uid!==process.getuid())throw new Error(tr('terminalControl.identityUnknown'));try{process.kill(expected.pid,name);}catch(e){if(e.code!=='ESRCH')throw e;}}}};
  collect();signal('SIGTERM');let forced=false;
  const wait=async ms=>{const until=Date.now()+ms;while(alive()&&Date.now()<until){await new Promise(r=>setTimeout(r,100));collect();}return !alive();};
  if(!await wait(graceMs)){forced=true;collect();signal('SIGKILL');if(!await wait(killMs))throw new Error(tr('terminalControl.stopPending'));}
  const result=checkTerminalSession(db,binding,dbPath);
  if(result.processState!=='released')throw new Error(tr('terminalControl.stopPending'));
  return {...result,released:true,forced};
}

/** The native CLI environment is stored only in the Worker's private database; secrets are never passed to Home or in the launch link. */
export function resumeEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key])=>
    /^(HOME|PATH|USER|LOGNAME|SHELL|LANG|LC_.*|TMPDIR|XDG_.*|GIT_CONFIG_GLOBAL|GIT_TERMINAL_PROMPT|CODEX_.*|CLAUDE_.*|ANTHROPIC_.*|OPENAI_.*|GROK_.*|XAI_.*|AGY_.*|GOOGLE_.*|GEMINI_.*|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|https?_proxy|all_proxy|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/.test(key)));
}

/** Record the same user and storage paths; tokens and managed wb credentials are not recorded. */
export async function nativeEnvironment(runtime, env = process.env) {
  const command = env[`${runtime.toUpperCase()}_BIN`] || runtime;
  let binary;
  for (const file of command.includes('/') ? [resolve(command)] : String(env.PATH || '').split(delimiter).map(p => join(p, command))) {
    try { await access(file, constants.X_OK); binary = file; break; } catch {}
  }
  if (!binary) throw new Error(tr('terminalResume.originalCliExecutableWasNot'));
  const paths = Object.fromEntries(['HOME','CODEX_HOME','CLAUDE_CONFIG_DIR','XDG_CONFIG_HOME','XDG_DATA_HOME','PATH'].filter(k => env[k]).map(k => [k, env[k]]));
  return { runtime, user:userInfo().username, home:env.HOME || homedir(), binary, env:paths };
}

/** Resolve saved native identity exactly; never walk unrelated histories to recover a missing index. */
export async function findSessionHistory(session,workspace=session.workspace) {
  const { runtime, id, home, env = {} } = session;
  resumeArgs(runtime, id);
  const {registeredNativeHistoryFile}=await import('./native-sessions.mjs');
  const file=await registeredNativeHistoryFile(runtime,id,{env:{HOME:home,...env},record:{runtime,sessionId:id,workspace}});
  if(file&&(await stat(file.path)).size>0)return file.path;
  throw new Error(tr('terminalResume.nativeSessionHistoryForUser'));
}

/** iTerm decodes percent escapes, not form '+' spaces; rebuild old saved links without changing their takeover identity. */
export function terminalLaunchView(session) {
  return session.command?{...session,url:`iterm2:/command?c=${encodeURIComponent(session.command)}`}:session;
}

/** Generate a reviewable command; the link carries no password or platform token. */
export function terminalCommand(info, device = null, identityFile = null) {
  const command = info.launcher.map(quote).join(' ');
  if (!device) return command;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(device.host || '') || !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(device.user || '') || !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(info.user || '') || !Number.isInteger(Number(device.port)) || device.port<1 || device.port>65535) throw new Error(tr('terminalResume.sshConfigurationIncomplete'));
  const remote = device.user === info.user ? command : `sudo -H -u ${quote(info.user)} -- ${command}`;
  return ['ssh','-t',...(identityFile?['-i',identityFile]:[]),'-p',String(device.port),`${device.user}@${device.host}`,remote].map(quote).join(' ');
}

/** A link may be claimed by only one terminal process; an old link cannot run again after release. */
export function claimTerminalSession(db, id, pid) {
  return db.transaction(() => {
    const s=db.get('terminalSessions',id);
    if(s?.status!=='prepared')throw new Error(tr('terminalResume.takeoverHasAlreadyStartedBeen'));
    if(db.get('sourceSyncReservations',s.projectId))throw syncError('sync_busy');
    const wrapperIdentity=processKey(terminalProcessIdentity(pid));
    if(!wrapperIdentity)throw new Error(tr('terminalControl.identityUnknown'));
    const startedAt=new Date().toISOString(),claimed=db.put('terminalSessions',{...s,status:'active',pid,wrapperIdentity,startedAt});
    updateNativeCatalog(db,claimed,{status:'active',startedAt});return claimed;
  });
}

/** Shares the SQLite write transaction with the other process's claim, so it cannot be preempted after the PID check. */
export function releaseTerminalSession(db,id) {
  return db.transaction(()=>{
    const prior=db.get('terminalSessions',id);
    const states=prior?[recordedProcessState(prior.pid,prior.wrapperIdentity,{binary:process.execPath}),
      recordedProcessState(prior.childPid,prior.childIdentity,prior.nativeSession),
      ...(prior.stopProcesses||[]).map(proof=>recordedProcessState(proof.pid,proof))]:[];
    if(states.some(state=>state!=='exited'))throw new Error(tr('terminalResume.terminalCliHasNotExited'));
    if(prior)updateNativeCatalog(db,prior,releasedCatalogState(prior,new Date().toISOString()));
    return db.put('terminalSessions',{...prior,id,status:'released'});
  });
}

/** Native exit is recorded locally; manual refresh verifies it with the Worker before resuming platform dispatch. */
async function runTerminal(dbPath,id) {
  const db=new Store(dbPath), before=db.get('terminalSessions',id);
  if(!before?.nativeSession || before.nativeSession.user!==userInfo().username)throw new Error(tr('terminalResume.runningUserDoesNotMatch'));
  if(!(await stat(before.workspace)).isDirectory())throw new Error(tr('terminalResume.originalWorkingDirectoryDoesNot'));
  if(['new','native'].includes(before.kind)&&await realpath(before.workspace)!==before.workspace)throw new Error(tr('terminalResume.originalWorkingDirectoryDoesNot'));
  if(before.kind!=='new'&&(before.kind!=='native'||before.nativeSession.id))await findSessionHistory(before.nativeSession,before.workspace);
  await access(before.nativeSession.binary,constants.X_OK);
  if(before.kind==='native'){
    const owner=nativeTerminalProject(db,{nodeId:before.nodeId,runtime:before.nativeSession.runtime,sessionId:before.nativeSession.id});
    if(owner&&owner!==before.projectId)throw Error('Native session ownership changed; return this link and prepare it again');
    (await import('./native-sessions.mjs')).assertNativeSessionIdle(db,{nodeId:before.nodeId,runtime:before.nativeSession.runtime,sessionId:before.nativeSession.id,workspace:before.workspace,projectId:before.projectId,claimId:id});
  }
  const session=claimTerminalSession(db,id,process.pid);
  // WB_NATIVE_HELLO: the Worker runs this launcher itself for a session opened on the Sessions page; the CLI answers "Hi" headlessly instead of opening a TUI.
  const hello=process.env.WB_NATIVE_HELLO==='1'&&session.kind==='native';
  let args=session.kind==='native'?(await import('./native-sessions.mjs')).nativeTuiArgs(session.nativeSession.runtime,{id:session.nativeSession.id,...session.nativeOptions}):session.kind==='new'?freshTerminalArgs({...session.roleSettings,runtime:session.nativeSession.runtime,workspace:session.workspace}):[...resumeArgs(session.nativeSession.runtime,session.nativeSession.id),...(scopedTerminalArgs(session.nativeSession.runtime,session.permissionScope,session.toolRoots)||[])];
  console.log(session.kind==='new'||session.kind==='native'&&!session.nativeSession.id?tr('roleTerminal.startingNew',{workspace:session.workspace}):tr('terminalResume.resumingOriginalSessionDirectoryPlatform', { id: session.nativeSession.id, workspace: session.workspace }));
  const env={...session.privateEnv};
  for(const key of ['TERM','COLORTERM','TERM_PROGRAM','TERM_PROGRAM_VERSION'])if(process.env[key])env[key]=process.env[key];
  if(hello)args=nativeHelloArgs(session.nativeSession.runtime,args,session.nativeSwitchId?'Create this empty session for a Workbench Agent switch. Reply READY only. Do not use tools, read or modify files, or begin any task. Wait for the next user message.':'Hi');
  const child=spawn(session.nativeSession.binary,args,{cwd:session.workspace,env,stdio:hello?['ignore','pipe','pipe']:'inherit'});
  let reportedId=null,stderr='';
  if(hello){
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-2000);});
    createInterface({input:child.stdout}).on('line',line=>{if(reportedId)return;try{reportedId=nativeSessionId(JSON.parse(line),session.nativeSession.runtime);}catch{}});
  }
  // Ctrl-C is handed to the CLI; the wrapper process stays until the child process actually exits.
  const onSignal=()=>{};process.on('SIGINT',onSignal);process.on('SIGTERM',()=>child.kill('SIGTERM'));
  let observation=null;
  db.transaction(()=>{const current=db.get('terminalSessions',id);if(closed.has(current.status)){child.kill('SIGTERM');return;}const childIdentity=processKey(terminalProcessIdentity(child.pid));db.put('terminalSessions',{...current,childPid:child.pid,childIdentity});if(current.kind==='native'&&current.catalogEntryId&&!current.nativeSession.id)observation=startNativeSessionObservation(current.nativeSession,childIdentity);});
  const code=await new Promise(resolve=>{child.once('error',e=>{console.error(e.message);resolve(1);});child.once('exit',code=>resolve(code??1));});
  const observed=observation?await observation.finish():[],finishedAt=new Date().toISOString();
  db.transaction(()=>{const current=db.get('terminalSessions',id);if(!closed.has(current.status))db.put('terminalSessions',{...current,status:'finished',finishedAt});if(hello)db.put('terminalSessions',{...db.get('terminalSessions',id),hello:true,exitCode:code,...(code?{helloError:stderr.trim().slice(-500)}:{})});if(current.catalogEntryId){const resumed=Boolean(current.nativeSession.id),sessionId=current.nativeSession.id||current.nativeOptions?.freshId||observed[0]||reportedId||null;updateNativeCatalog(db,current,{sessionId,status:resumed?'ready':sessionId?'awaiting_history':'awaiting_native_id',finishedAt,exactLastScan:finishedAt});}});
  process.removeListener('SIGINT',onSignal);db.db.close();process.exitCode=code;
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  runTerminal(process.argv[2],process.argv[3]).catch(e=>{console.error(e.message);process.exitCode=1;});
}
