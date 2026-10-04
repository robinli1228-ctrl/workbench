import { mkdir, readdir, readFile, writeFile, rename, lstat, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tr } from './i18n.mjs';

const allowed = new Set(['/api/agent/setup/catalog', '/api/agent/setup/propose', '/api/agent/roles/prompt', '/api/agent/schedule', '/api/agent/timers', '/api/agent/note', '/api/agent/calls', '/api/agent/ask', '/api/agent/wait', '/api/agent/deliveries', '/api/agent/report', '/api/agent/history/search', '/api/agent/history/read', '/api/agent/sessions/current', '/api/agent/sessions/list', '/api/agent/sessions/summary', '/api/agent/sessions/read', '/api/agent/conversation/summary']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
allowed.add('/api/agent/discussions');

/** A managed CLI may be bridged through the current Run, but must not inherit the Worker's control-plane token. */
export function agentProcessEnv(base, additions) {
  const env={...base,...additions};
  for(const key of ['WORKER_TOKEN','API_TOKEN','WB_TOKEN'])delete env[key];
  return env;
}

/** The CLI sandbox needs no network access; requests can only land in this workspace and are sent on its behalf by the Worker that holds the connection. */
export async function agentRequest(pathname, payload) {
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
      if (response.error) throw new Error(response.error);
      return response.result;
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await delay(150);
  }
  throw new Error(tr('agentBridge.workerCommunicationTimedOutOutcome'));
}

/** Only allowlisted Agent endpoints can pass through the bridge; there is no user-confirmation, arbitrary-URL, or Shell endpoint. */
export async function homeRequest(home, token, pathname, payload) {
  if (!home || !allowed.has(pathname)) throw new Error(tr('agentBridge.invalidHomeToolPath'));
  const response = await fetch(new URL(pathname, home), { method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token || ''}` }, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

/** Each Run gets its own bridge directory, and on exit only the communication files it created are cleaned up. */
export async function startAgentBridge({ workspace, runId, home, token, canSend }) {
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
            if (!canSend()) throw new Error(tr('agentBridge.executionHasStoppedRemoteOperations'));
            if(input.payload?.runId&&input.payload.runId!==runId)throw new Error(tr('agentBridge.toolRequestCannotImpersonateAnother'));
            response = { result: await homeRequest(home, token, input.pathname, { ...input.payload, runId }) };
          } catch (error) { response = { error: error.message }; }
          await writeFile(join(directory, file.replace('.request', '.response')), JSON.stringify(response), { flag: 'wx', mode: 0o600 }).catch(() => {});
        };
        const task = handle(); pending.add(task); void task.finally(() => pending.delete(task));
      }
    } catch { /* Do not recreate the communication directory during exit cleanup. */ }
    finally { scanning = false; }
  }
  const timer = setInterval(() => { void scan(); }, 150); timer.unref();
  return { directory, async stop() {
    stopped = true; clearInterval(timer); await Promise.allSettled([...pending]);
    for (const file of await readdir(directory).catch(() => [])) {
      if (/^[a-f0-9-]{36}\.(request|response|tmp)$/.test(file) || ['turn-context.json','turn-context.json.tmp'].includes(file)) await unlink(join(directory, file)).catch(() => {});
    }
    await rmdir(directory).catch(() => {});
  } };
}
