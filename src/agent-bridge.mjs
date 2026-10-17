import { mkdir, readdir, readFile, writeFile, rename, link, lstat, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tr } from './i18n.mjs';
import {submitReport} from './report-submission.mjs';

const allowed = new Set(['/api/agent/setup/catalog', '/api/agent/setup/propose', '/api/agent/roles/prompt', '/api/agent/schedule', '/api/agent/timers', '/api/agent/note', '/api/agent/calls', '/api/agent/ask', '/api/agent/wait', '/api/agent/deliveries', '/api/agent/report', '/api/agent/history/search', '/api/agent/history/read', '/api/agent/sessions/current', '/api/agent/sessions/list', '/api/agent/sessions/summary', '/api/agent/sessions/read', '/api/agent/conversation/summary']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
allowed.add('/api/agent/discussions');
allowed.add('/api/agent/pass');
allowed.add('/api/agent/collaboration-sessions');
allowed.add('/api/agent/documents');
allowed.add('/api/agent/source-sync');
allowed.add('/api/agent/notify');
allowed.add('/api/agent/progress');
for(const path of ['/api/agent/read-source','/api/agent/node-query','/api/agent/file-read'])allowed.add(path);

/** Dispatch pause must not swallow accepted work's conclusions; new work and write operations remain blocked. */
export function allowsPausedAgentOperation(pathname,input={}) {
  return new Set(['/api/agent/report','/api/agent/wait','/api/agent/note','/api/agent/setup/catalog','/api/agent/history/search','/api/agent/history/read','/api/agent/sessions/current','/api/agent/sessions/list','/api/agent/sessions/summary','/api/agent/sessions/read','/api/agent/conversation/summary']).has(pathname)
    ||pathname==='/api/agent/discussions'&&['peers','read','reply','resolve'].includes(input.action)
    ||pathname==='/api/agent/pass'||pathname==='/api/agent/documents'||pathname==='/api/agent/progress'||pathname==='/api/agent/collaboration-sessions'&&input.action==='list'
    ||['/api/agent/read-source','/api/agent/node-query','/api/agent/file-read'].includes(pathname);
}

/**
 * Why an operation cannot be sent now, or null. Pause is not cancellation: retained identity, connection and live process
 * checks still apply to every tool call. The code tells the caller whether retrying the same request can help.
 */
export function agentOperationBlock({paused,quitting,connected,status},pathname,input) {
  const reportStatus=pathname==='/api/agent/report'&&input?.action==='status'&&['running','starting','succeeded','failed','interrupted','stopping','reconciling'].includes(status);
  if(quitting)return 'run_ended';
  if(!connected)return 'home_disconnected';
  if(!reportStatus&&!['running','starting'].includes(status))return status==='stopping'?'run_stopping':status==='reconciling'?'run_reconciling':'run_ended';
  if(paused&&!allowsPausedAgentOperation(pathname,input))return 'paused';
  return null;
}
export function canSendAgentOperation(state,pathname,input) {return !agentOperationBlock(state,pathname,input);}
/** Refused before anything ran, so the identical request may be sent again. */
const RETRYABLE=new Set(['run_reconciling','home_disconnected']),RETRY_DELAYS=[1000,2000,4000,5000,5000];
const blockMessage=code=>tr({home_disconnected:'agentBridge.homeDisconnected',paused:'agentBridge.remotePaused',run_stopping:'home.runStopping',run_reconciling:'home.runReconciling'}[code]||'agentBridge.executionHasStoppedRemoteOperations');
async function withRetry(send) {
  for(let attempt=0;;attempt++) {
    try{return await send();}
    catch(error){
      if(!RETRYABLE.has(error.code)||attempt>=RETRY_DELAYS.length){if(error.code&&!error.message.startsWith(`[${error.code}]`))error.message=`[${error.code}] ${error.message}`;throw error;}
      await delay(RETRY_DELAYS[attempt]);
    }
  }
}

/** Sender identity belongs to the persisted Run; target role/session identifiers remain valid tool input. */
const identityKeys=['sender','senderId','senderName','senderRoleId','fromRoleId','sourceRoleId','ownerRoleId','author','authorId','authorRoleId','authorName','speaker','speakerRoleId','collaborationSessionId','batchId','runtimeIdentity'];
/** Project, role, Run and (later) batch come from the trusted runtime; identity-looking fields are rejected at any nesting depth. */
export function assertAgentSender(input) {
  if (['projectId','nodeId'].some(key=>Object.hasOwn(input||{},key)) || hasIdentityKey(input,0))
    throw new Error(tr('agentBridge.toolRequestCannotImpersonateAnother'));
}
function hasIdentityKey(value,depth) {
  if(!value||typeof value!=='object'||depth>6)return false;
  if(Array.isArray(value))return value.some(item=>hasIdentityKey(item,depth+1));
  return Object.keys(value).some(key=>identityKeys.includes(key)||hasIdentityKey(value[key],depth+1));
}

/** A managed CLI may be bridged through the current Run, but must not inherit the Worker's control-plane token. */
export function agentProcessEnv(base, additions) {
  const env={...base,...additions};
  for(const key of ['WORKER_TOKEN','API_TOKEN','WB_TOKEN'])delete env[key];
  return env;
}

/** The CLI sandbox needs no network access; requests can only land in this workspace and are sent on its behalf by the Worker that holds the connection. */
export async function agentRequest(pathname, payload) {
  if(pathname==='/api/agent/report'&&payload.action!=='status')return submitReport(input=>withRetry(()=>agentRequestOnce(pathname,input)),payload);
  return withRetry(()=>agentRequestOnce(pathname,payload));
}
async function agentRequestOnce(pathname,payload) {
  if (!allowed.has(pathname)) throw new Error(tr('agentBridge.operationNotAgentTool'));
  const directory = process.env.WB_BRIDGE;
  if (!directory) return homeRequest(process.env.WB_HOME, process.env.WB_TOKEN, pathname, payload);
  const id = randomUUID(), temporary = join(directory, `${id}.tmp`), requestFile = join(directory, `${id}.request`);
  await writeFile(temporary, JSON.stringify({ pathname, payload }), { flag: 'wx', mode: 0o600 });
  await rename(temporary, requestFile);
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const response = JSON.parse(await readFile(join(directory, `${id}.response`), 'utf8'));
      if (response.error) throw Object.assign(new Error(response.error),{status:response.status,code:response.code,outcomeUnknown:response.outcomeUnknown});
      return response.result;
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await delay(150);
  }
  throw Object.assign(new Error(tr('agentBridge.workerCommunicationTimedOutOutcome')),{outcomeUnknown:true});
}

/** Only allowlisted Agent endpoints pass through the bridge; supervisor notifications are checked by Home, never arbitrary URLs or shell. */
export async function homeRequest(home, token, pathname, payload) {
  if (!home || !allowed.has(pathname)) throw new Error(tr('agentBridge.invalidHomeToolPath'));
  try {
  const response = await fetch(new URL(pathname, home), { method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token || ''}` }, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`),{status:response.status,code:data.code,outcomeUnknown:response.status>=500});
  return data;
  }catch(error){if(!error.status)error.outcomeUnknown=true;throw error;}
}

/** Each Run gets its own bridge directory, and on exit only the communication files it created are cleaned up. */
export async function startAgentBridge({ workspace, runId, home, token, canSend, blockReason }) {
  const directory = join(workspace, `.wb-bridge-${runId}`);
  await mkdir(directory, { mode: 0o700 });
  const consumed = new Set(), pending = new Set();
  let stopped = false, scanning = false;
  async function scan() {
    if (scanning || stopped) return;
    scanning = true;
    try {
      for (const file of await readdir(directory)) {
        if (!/^[a-f0-9-]{36}\.request$/.test(file) || consumed.has(file)) continue;
        consumed.add(file);
        const handle = async () => {
          let response;
          try {
            const path = join(directory, file), info = await lstat(path);
            if (!info.isFile() || info.size > 65536) throw new Error(tr('agentBridge.toolRequestFileInvalidToo'));
            const input = JSON.parse(await readFile(path, 'utf8'));
            assertAgentSender(input.payload);
            const block=blockReason?blockReason(input.pathname,input.payload):canSend(input.pathname,input.payload)?null:'run_ended';
            if (block) throw Object.assign(new Error(blockMessage(block)),{code:block});
            if(input.payload?.runId&&input.payload.runId!==runId)throw new Error(tr('agentBridge.toolRequestCannotImpersonateAnother'));
            response = { result: await homeRequest(home, token, input.pathname, { ...input.payload, runId }) };
          } catch (error) { response = { error: error.message,status:error.status,code:error.code,outcomeUnknown:error.outcomeUnknown }; }
          const responseFile = join(directory, file.replace('.request', '.response'));
          const temporary = `${responseFile}.tmp`;
          await writeFile(temporary, JSON.stringify(response), { flag: 'wx', mode: 0o600 });
          try { await link(temporary, responseFile); }
          finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
        };
        const task = handle(); pending.add(task);
        void task.finally(() => pending.delete(task)).catch(error => console.error('Failed to publish Agent bridge response:', error));
      }
    } catch { /* Do not recreate the communication directory during exit cleanup. */ }
    finally { scanning = false; }
  }
  const timer = setInterval(() => { void scan(); }, 150); timer.unref();
  return { directory, async stop() {
    stopped = true; clearInterval(timer); await Promise.allSettled([...pending]);
    for (const file of await readdir(directory).catch(() => [])) {
      if (/^[a-f0-9-]{36}\.(request|response|response\.tmp|tmp)$/.test(file) || ['turn-context.json','turn-context.json.tmp'].includes(file)) await unlink(join(directory, file)).catch(() => {});
    }
    await rmdir(directory).catch(() => {});
  } };
}
