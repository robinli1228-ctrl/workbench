import { userInfo, homedir } from 'node:os';
import { readdir, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Store } from './store.mjs';

const sessionPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const closed = new Set(['released', 'cancelled']);

/** Only accept the CLI's session fields; an arbitrary tool call id is never treated as a session. */
export function nativeSessionId(raw, runtime) {
  const id = runtime === 'agy'
    ? raw.conversationId || raw.conversation_id || raw.session_id || raw.sessionId
    : raw.session_id || raw.sessionId;
  return typeof id === 'string' && sessionPattern.test(id) ? id : null;
}

/** Use an explicit native ID; never last, continue, or fork. */
export function resumeArgs(runtime, id) {
  if (!sessionPattern.test(id || '')) throw new Error('A valid native session ID is missing');
  const option = { codex:'resume', claude:'--resume', grok:'--resume', agy:'--conversation' }[runtime];
  if (!option) throw new Error('This CLI does not support resume yet');
  return [option, id];
}

/** Take over the whole project's execution window on this node, avoiding concurrent use of the shared directory and deliveries. */
export function projectTerminalLock(db, projectId, nodeId) {
  return db.list('terminalSessions').find(s => s.projectId === projectId && s.nodeId === nodeId && !closed.has(s.status)) || null;
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
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
  if (!binary) throw new Error('The original CLI executable was not found');
  const paths = Object.fromEntries(['HOME','CODEX_HOME','CLAUDE_CONFIG_DIR','XDG_CONFIG_HOME','XDG_DATA_HOME','PATH'].filter(k => env[k]).map(k => [k, env[k]]));
  return { runtime, user:userInfo().username, home:env.HOME || homedir(), binary, env:paths };
}

/** Search the vendor session directory by exact ID only; if missing, refuse to create a blank session. */
export async function findSessionHistory(session) {
  const { runtime, id, home, env = {} } = session;
  resumeArgs(runtime, id);
  const roots = {
    codex:[join(env.CODEX_HOME || join(home,'.codex'),'sessions'),join(env.CODEX_HOME || join(home,'.codex'),'archived_sessions')],
    claude:[join(env.CLAUDE_CONFIG_DIR || join(home,'.claude'),'projects')],
    grok:[join(home,'.grok','sessions')],
    agy:[join(home,'.gemini','antigravity-cli','conversations')]
  }[runtime];
  let visited = 0;
  async function walk(dir, depth = 0) {
    let entries; try { entries = await readdir(dir,{withFileTypes:true}); } catch (e) { if(e.code==='ENOENT')return null; throw e; }
    for (const entry of entries) {
      if (++visited > 20000) throw new Error('Session directory is too large; could not confirm the specified history');
      const file = join(dir,entry.name);
      if (entry.isFile() && (entry.name === `${id}.jsonl` || entry.name === `${id}.pb` || (runtime==='agy'&&entry.name===`${id}.db`) || (runtime==='codex' && entry.name.endsWith(`-${id}.jsonl`)))) return file;
      if (runtime==='grok' && entry.isDirectory() && entry.name===id) {
        const history = join(file,'chat_history.jsonl');
        try { if((await stat(history)).size>0)return history; } catch {}
      }
      if (entry.isDirectory() && depth < 5 && !['subagents','resources_state','terminal'].includes(entry.name)) {
        const match = await walk(file,depth+1); if(match)return match;
      }
    }
    return null;
  }
  for (const root of roots) { const file=await walk(root); if(file && (await stat(file)).size>0)return file; }
  throw new Error('The native session history for this user does not exist and cannot be resumed; no blank session will be created');
}

/** Generate a reviewable command; the link carries no password or platform token. */
export function terminalCommand(info, device = null, identityFile = null) {
  const command = info.launcher.map(quote).join(' ');
  if (!device) return command;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(device.host || '') || !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(device.user || '') || !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(info.user || '') || !Number.isInteger(Number(device.port)) || device.port<1 || device.port>65535) throw new Error('SSH configuration is incomplete');
  const remote = device.user === info.user ? command : `sudo -H -u ${quote(info.user)} -- ${command}`;
  return ['ssh','-t',...(identityFile?['-i',identityFile]:[]),'-p',String(device.port),`${device.user}@${device.host}`,remote].map(quote).join(' ');
}

/** A link may be claimed by only one terminal process; an old link cannot run again after release. */
export function claimTerminalSession(db, id, pid) {
  return db.transaction(() => {
    const s=db.get('terminalSessions',id);
    if(s?.status!=='prepared')throw new Error('This takeover has already started, been released, or expired; check in the workbench');
    return db.put('terminalSessions',{...s,status:'active',pid,startedAt:new Date().toISOString()});
  });
}

/** Shares the SQLite write transaction with the other process's claim, so it cannot be preempted after the PID check. */
export function releaseTerminalSession(db,id) {
  return db.transaction(()=>{
    const prior=db.get('terminalSessions',id);
    if(prior && (processAlive(prior.pid)||processAlive(prior.childPid)))throw new Error('The terminal CLI has not exited; close the session before releasing');
    return db.put('terminalSessions',{...prior,id,status:'released'});
  });
}

/** Start the interactive CLI under the original Worker user; exiting does not make the platform automatically resume dispatching. */
async function runTerminal(dbPath,id) {
  const db=new Store(dbPath), before=db.get('terminalSessions',id);
  if(!before?.nativeSession || before.nativeSession.user!==userInfo().username)throw new Error('The running user does not match the original session');
  if(!(await stat(before.workspace)).isDirectory())throw new Error('The original working directory does not exist');
  await findSessionHistory(before.nativeSession);
  await access(before.nativeSession.binary,constants.X_OK);
  const session=claimTerminalSession(db,id,process.pid);
  const args=resumeArgs(session.nativeSession.runtime,session.nativeSession.id);
  console.log(`Resuming original session ${session.nativeSession.id}\nDirectory: ${session.workspace}\nThe platform has paused project dispatch on this device. When finished, click "Return to platform" in the web UI.\nNew conversation in the terminal is not sent back to the group chat automatically, and the original managed wb tools are unavailable.`);
  const env={...session.privateEnv};
  for(const key of ['TERM','COLORTERM','TERM_PROGRAM','TERM_PROGRAM_VERSION'])if(process.env[key])env[key]=process.env[key];
  const child=spawn(session.nativeSession.binary,args,{cwd:session.workspace,env,stdio:'inherit'});
  // Ctrl-C is handed to the CLI; the wrapper process stays until the child process actually exits.
  const onSignal=()=>{};process.on('SIGINT',onSignal);process.on('SIGTERM',()=>child.kill('SIGTERM'));
  db.put('terminalSessions',{...session,childPid:child.pid});
  const code=await new Promise(resolve=>{child.once('error',e=>{console.error(e.message);resolve(1);});child.once('exit',code=>resolve(code??1));});
  db.put('terminalSessions',{...db.get('terminalSessions',id),status:'finished',finishedAt:new Date().toISOString()});
  process.removeListener('SIGINT',onSignal);db.db.close();process.exitCode=code;
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  runTerminal(process.argv[2],process.argv[3]).catch(e=>{console.error(e.message);process.exitCode=1;});
}
