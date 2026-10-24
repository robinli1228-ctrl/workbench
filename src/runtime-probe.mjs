import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {mergeRuntimeQuota} from './runtime-quota.mjs';
import { tr } from './i18n.mjs';
const exec = promisify(execFile);
let quotaIdentitySalt=randomUUID();
/** The Worker keeps its salt in its database, so a restart keeps the same identity and Home keeps the saved quota. */
export function useQuotaIdentitySalt(salt){if(typeof salt==='string'&&salt)quotaIdentitySalt=salt;}
/** Report an opaque, salted identity, never an email, account ID or token. */
function quotaIdentity(type,account,env=process.env) {
  const id=account?.email||account?.emailAddress||account?.accountUuid||account?.accountId;
  // A token-only Claude login names no account: the token itself is the account, so its salted hash changes with it.
  // The token never leaves this function; only the salted digest is reported.
  const token=type==='claude'&&(account?.loggedIn===true||account?.authenticated===true)?account.authMethod==='oauth_token'?env.CLAUDE_CODE_OAUTH_TOKEN||env.ANTHROPIC_AUTH_TOKEN:account.authMethod==='api_key'?env.ANTHROPIC_API_KEY:null:null;
  const key=typeof id==='string'&&id?id:typeof token==='string'&&token?`token:${token}`:null;
  return key?createHash('sha256').update(JSON.stringify([quotaIdentitySalt,type,key,account.organizationId||account.orgId||null])).digest('hex'):null;
}
/** Only a timeout, a kill or a short-lived resource shortage leaves the account unknown; any other failure is an answer. */
// ENOENT/ETXTBSY: the binary was swapped by a self-update between --version and auth status; a too-long answer is no answer either.
const checkInterrupted=e=>Boolean(e?.killed||e?.signal||['ETIMEDOUT','EAGAIN','ENOMEM','EMFILE','ENFILE','ENOENT','ETXTBSY','ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(e?.code));

/** A single no-inference probe: reads only the version, login state, and model catalog, and creates no Thread/Turn. */
export async function inspectCodex() {
  const result = { type: 'codex', label: 'Codex CLI', supported: true, installed: false, available: false, models: [], quota: null, quotaStatus: 'unavailable', checkedAt: new Date().toISOString() };
  const bin = process.env.CODEX_BIN || 'codex';
  try { result.version = (await exec(bin, ['--version'], { timeout: 5000 })).stdout.trim(); result.installed = true; }
  catch { return { ...result, reason: tr('runtimeProbe.noRunnableCodexCliFound') }; }
  const proc = spawn(bin, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: proc.stdout });
  const pending = new Map(); let id = 0, transportError = null;
  // Optional quota failures must not send another RPC into a transport that has already exited.
  const fail = error => { transportError ||= error; for (const p of pending.values()) p.reject(transportError); pending.clear(); };
  // Process-level failures may clear up on the next attempt; login, catalog and protocol errors are definite answers.
  const transient = key => Object.assign(new Error(tr(key)), { transient: true });
  proc.on('error', () => fail(transient('runtimeProbe.appServerCouldNotStart')));
  proc.on('exit', () => fail(transient('runtimeProbe.appServerHasExited')));
  const timer = setTimeout(() => { fail(transient('runtimeProbe.cliStatusProbeTimedOut')); proc.kill(); }, 15000);
  lines.on('line', line => {
    try { const m = JSON.parse(line), p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(tr('runtimeProbe.cliDoesNotSupportRequired'))) : p.resolve(m.result); } catch {}
  });
  const call = (method, params) => new Promise((resolve, reject) => { if(transportError)return reject(transportError);const key = ++id; pending.set(key, { resolve, reject }); proc.stdin.write(`${JSON.stringify({ id: key, method, params })}\n`); });
  proc.stdin.on('error', () => fail(transient('runtimeProbe.cliConnectionWasClosedDisconnect')));
  try {
    await call('initialize', { clientInfo: { name: 'agent_workbench_probe', version: '0.3.0' } });
    proc.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    const auth = await call('account/read', { refreshToken: false });
    result.authReady = !!auth.account || auth.requiresOpenaiAuth === false;
    // A real answer saying there is no account is a definite sign-out (unlike a probe that failed or timed out).
    if(!result.authReady)result.authState='signed_out';
    result.quotaIdentity=quotaIdentity('codex',auth.account);
    result.authType = auth.account?.type || (auth.requiresOpenaiAuth === false ? 'provider' : 'none');
    let cursor = null; const seen = new Set();
    do {
      const page = await call('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      for (const m of page.data || []) if (typeof m.model === 'string' && !m.hidden && !seen.has(m.model)) {
        seen.add(m.model); const efforts = (m.supportedReasoningEfforts || []).map(e => e.reasoningEffort).filter(Boolean);
        result.models.push({
          id: m.model,
          name: m.displayName || m.model,
          effort: efforts.includes('low') ? 'low' : m.defaultReasoningEffort || null,
          efforts
        });
      }
      cursor = page.nextCursor;
    } while (cursor && result.models.length < 500);
    result.available = result.authReady && result.models.length > 0;
    result.reason = !result.authReady ? tr('runtimeProbe.runCodexLoginOnDevice') : !result.models.length ? tr('runtimeProbe.cliReturnedNoAvailableModels') : '';
  } catch (e) {
    // Once account/read has confirmed a missing login, a later transport error must not make the result look transient.
    if (result.authReady === false) result.reason = tr('runtimeProbe.runCodexLoginOnDevice');
    else { result.reason = tr('runtimeProbe.checkCliOnDeviceThen', { message: e.message }); if (e.transient) { result.transient = true; if (result.authReady === undefined) result.authUnknown = true; } }
  }
  finally { clearTimeout(timer); lines.close(); proc.stdin.end(); proc.kill(); }
  return result;
}

function baseRuntime(type, label) {
  return { type, label, supported: true, installed: false, available: false, models: [], quota: null, quotaStatus: 'unavailable', checkedAt: new Date().toISOString() };
}
function firstLine(text) { return String(text || '').trim().split('\n')[0].slice(0, 120); }
function looksLoggedOut(text) { return /not logged in|not authenticated|please (log|sign) in|login required|unauthori[sz]ed|unauthenticated|auth(?:entication)? (?:failed|required)/i.test(text); }

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** The grok models output is a human-readable list; take the model IDs marked with * or -. */
function parseGrokModels(stdout) {
  const models = [], seen = new Set();
  for (const line of String(stdout).split('\n')) {
    const marked = line.match(/^\s*[*+-]\s+(\S+)/);
    const id = (marked?.[1] || '').replace(/[,:]$/, '');
    if (!id || seen.has(id) || /^(available|default|models)$/i.test(id)) continue;
    seen.add(id); models.push({ id, name: id, effort: null, efforts: ['low', 'medium', 'high'] });
  }
  if (!models.length) {
    const fallback = String(stdout).match(/Default model:\s+(\S+)/i);
    if (fallback) models.push({ id: fallback[1], name: fallback[1], effort: null, efforts: ['low', 'medium', 'high'] });
  }
  return models;
}

/** agy models gives an ID and a display name (separated by a tab or spaces); the effort can be inferred from the ID suffix. */
function parseAgyModels(stdout) {
  const models = [], seen = new Set();
  for (const line of String(stdout).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || /fetching/i.test(trimmed)) continue;
    const parts = trimmed.split(/\s*\t\s*|\s{2,}/);
    const id = (parts[0] || '').trim();
    if (!id || seen.has(id) || /^(id|model|name)$/i.test(id)) continue;
    seen.add(id);
    const name = parts.slice(1).join(' ').trim() || id;
    const effort = /-(high|medium|low)$/.exec(id)?.[1] || null;
    models.push({ id, name, effort, efforts: effort ? [effort] : [] });
  }
  return models;
}

async function inspectPrintCli({ type, label, binEnv, binName, loginHint }) {
  const result = baseRuntime(type, label);
  const bin = process.env[binEnv] || binName;
  try { result.version = firstLine((await exec(bin, ['--version'], { timeout: 5000, maxBuffer: 16384 })).stdout); result.installed = true; }
  catch { return { ...result, reason: tr('runtimeProbe.noRunnableFoundInstallIt', { label, binEnv }) }; }
  try {
    const { stdout, stderr } = await exec(bin, ['models'], { timeout: 15000, maxBuffer: 262144 });
    const text = `${stdout}\n${stderr}`;
    result.models = type === 'agy' ? parseAgyModels(stdout) : parseGrokModels(stdout);
    result.authReady = !looksLoggedOut(text) && result.models.length > 0;
    result.available = result.authReady;
    result.reason = result.available ? '' : looksLoggedOut(text) ? loginHint : tr('runtimeProbe.cliReturnedNoAvailableModels2');
  } catch (e) {
    const text = `${e.message || ''}\n${e.stdout || ''}\n${e.stderr || ''}`;
    result.reason = looksLoggedOut(text) ? loginHint : tr('runtimeProbe.checkCliOnDeviceThen2', { message: e.message });
  }
  return result;
}

function grokQuotaFromBilling(response) {
  const config = response?.config;
  const usedPercent = finiteNumber(config?.creditUsagePercent);
  if (!config || usedPercent == null) return { quota: null, quotaStatus: 'unavailable' };
  return {
    quota: {
      fiveHour: null,
      weekly: {
        usedPercent,
        remainingPercent: Math.max(0, 100 - usedPercent),
        resetsAt: config.currentPeriod?.end || config.billingPeriodEnd,
      },
      credits: {
        balance: finiteNumber(config.prepaidBalance?.val) ?? 0,
        onDemandCap: finiteNumber(config.onDemandCap?.val) ?? 0,
        onDemandUsed: finiteNumber(config.onDemandUsed?.val) ?? 0,
      },
      remainingPercent: Math.max(0, 100 - usedPercent),
    },
    quotaStatus: 'ok',
    authType: response.subscription_tier || undefined,
  };
}

/** The billing extension of Grok Build ACP only reads account usage and creates no session or model call. */
function probeGrokQuota(bin) {
  return new Promise((resolve) => {
    const proc = spawn(bin, ['agent', 'stdio'], { stdio: ['pipe', 'pipe', 'ignore'], env: process.env });
    const lines = createInterface({ input: proc.stdout });
    const pending = new Map();
    let id = 0, settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const item of pending.values()) item.reject(new Error(tr('runtimeProbe.grokProbeHasEnded')));
      pending.clear();
      lines.close();
      proc.stdin.end();
      proc.kill();
      resolve(value);
    };
    const call = (method, params = {}) => new Promise((accept, reject) => {
      const key = ++id;
      pending.set(key, { resolve: accept, reject });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: key, method, params })}\n`);
    });
    lines.on('line', line => {
      try {
        const message = JSON.parse(line);
        const item = pending.get(message.id);
        if (!item) return;
        pending.delete(message.id);
        message.error ? item.reject(new Error(message.error.message || tr('runtimeProbe.grokAcpError'))) : item.resolve(message.result);
      } catch { /* Ignore non-protocol logs */ }
    });
    proc.on('error', () => finish({ quota: null, quotaStatus: 'unavailable' }));
    proc.on('exit', () => finish({ quota: null, quotaStatus: 'unavailable' }));
    const timer = setTimeout(() => finish({ quota: null, quotaStatus: 'unavailable' }), 10000);
    (async () => {
      try {
        await call('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'agent-workbench-probe', version: '0.3.0' },
        });
        await call('authenticate', { methodId: 'cached_token' });
        finish(grokQuotaFromBilling(await call('_x.ai/billing', {})));
      } catch { finish({ quota: null, quotaStatus: 'unavailable' }); }
    })();
  });
}

/** A single no-inference probe: version, login, and model list; no conversation is started. */
export async function inspectGrok() {
  const result = await inspectPrintCli({ type: 'grok', label: 'Grok Build', binEnv: 'GROK_BIN', binName: 'grok', loginHint: tr('runtimeProbe.runGrokLoginOnDevice') });
  if (!result.available) return result;
  const bin = process.env.GROK_BIN || 'grok';
  return { ...result, ...await probeGrokQuota(bin) };
}

function agyGroupKey(label) {
  return /claude|gpt/i.test(label) ? 'claudeGpt' : 'gemini';
}

function parseAgyUsage(stdout) {
  const groups = {};
  for (const line of String(stdout || '').split('\n')) {
    const [label, windowLabel, percentText, resetsAt] = line.trim().split(/\t+/);
    const remainingPercent = finiteNumber(String(percentText || '').replace('%', ''));
    if (!label || remainingPercent == null) continue;
    const bucketName = /five\s*hour/i.test(windowLabel) ? 'fiveHour' : /week/i.test(windowLabel) ? 'weekly' : null;
    if (!bucketName) continue;
    const key = agyGroupKey(label);
    groups[key] ||= { label };
    groups[key][bucketName] = {
      usedPercent: Math.max(0, 100 - remainingPercent),
      remainingPercent,
      resetsAt: resetsAt || undefined,
    };
  }
  return groups;
}

function parseAgyCredits(stdout) {
  const match = String(stdout || '').match(/Remaining credits\s*[\t ]+([\d.]+)/i);
  return match ? finiteNumber(match[1]) : null;
}

/** In print mode, Agy expands /usage and /credits locally and starts no model conversation.
 * These disposable probes need a hard deadline: some CLI builds ignore SIGTERM and otherwise hold Worker registration. */
async function probeAgyQuota(bin) {
  try {
    const [usage, credits] = await Promise.all([
      exec(bin, ['-p', '/usage', '--output-format', 'text'], { timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 262144 }),
      exec(bin, ['-p', '/credits', '--output-format', 'text'], { timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 65536 }),
    ]);
    const groups = parseAgyUsage(usage.stdout);
    const primary = groups.gemini || groups.claudeGpt;
    if (!primary) return { quota: null, quotaStatus: 'unavailable' };
    const balance = parseAgyCredits(credits.stdout);
    return {
      quota: {
        fiveHour: primary.fiveHour || null,
        weekly: primary.weekly || null,
        groups,
        credits: balance == null ? null : { balance },
        remainingPercent: primary.fiveHour?.remainingPercent ?? primary.weekly?.remainingPercent,
      },
      quotaStatus: 'ok',
    };
  } catch { return { quota: null, quotaStatus: 'unavailable' }; }
}

/** A single no-inference probe: version, login, and model list; no conversation is started. */
export async function inspectAgy() {
  const result = await inspectPrintCli({ type: 'agy', label: 'Antigravity', binEnv: 'AGY_BIN', binName: 'agy', loginHint: tr('runtimeProbe.signInAntigravityCliOn') });
  if (!result.available) return result;
  const bin = process.env.AGY_BIN || 'agy';
  return { ...result, ...await probeAgyQuota(bin) };
}


/** Read native model capabilities without a user turn, saved session, hooks or MCP startup. Older CLIs keep unspecified levels. */
// Claude may be renewing its login while it starts: the old refresh token is already spent once the request is sent, so a
// kill before the new one is saved leaves only a dead token and signs the device out. A probe is therefore never killed
// early: its stdin closes once it has lived long enough to finish start-up, and only one still running a minute later is killed.
const CLAUDE_PROBE_SETTLE_MS = 15000, CLAUDE_PROBE_KILL_MS = 60000;
// The catalog changes with the CLI version or the account, not every five minutes; the periodic check reuses it for an hour.
const CLAUDE_CATALOG_TTL_MS = 3600000;
let claudeCatalog = null;

export function probeClaudeModels(bin, { settleMs = CLAUDE_PROBE_SETTLE_MS, killMs = CLAUDE_PROBE_KILL_MS } = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(bin, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--settings', '{"disableAllHooks":true}'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = createInterface({ input: child.stdout });
    let settled = false, bytes = 0;
    let exited = false;
    child.on('exit', () => { exited = true; });
    const finish = models => {
      if (settled) return;
      settled = true; clearTimeout(timer); lines.close();
      resolve(models);
      if (exited) return;
      const close = setTimeout(() => {
        try { child.stdin.end(); } catch {}
        const kill = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, killMs); kill.unref?.();
      }, Math.max(0, settleMs - (Date.now() - started)));
      close.unref?.();
    };
    const timer = setTimeout(() => finish(null), 5000);
    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
    child.stdin.on('error', () => finish(null));
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 1048576) finish(null); });
    lines.on('line', line => {
      try {
        const message = JSON.parse(line), response = message.response;
        if (message.type !== 'control_response' || response?.request_id !== 'wb-model-capabilities') return;
        const models = response.subtype === 'success' ? response.response?.models : null;
        finish(Array.isArray(models) ? models : null);
      } catch { /* Ignore non-protocol startup output; the bounded timeout still applies. */ }
    });
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'wb-model-capabilities', request: { subtype: 'initialize' } })}\n`);
  });
}

/** Claude Code: read installation, authentication and model capabilities without starting a conversation. */
export async function inspectClaude({ force = true } = {}) {
  const result = baseRuntime('claude', 'Claude Code');
  const bin = process.env.CLAUDE_BIN || 'claude';
  try {
    const ver = await exec(bin, ['--version'], { timeout: 5000, maxBuffer: 16384 });
    result.version = firstLine(ver.stdout || ver.stderr);
    result.installed = true;
  } catch {
    return { ...result, reason: tr('runtimeProbe.noRunnableClaudeCodeFound') };
  }
  let authReady = false;
  try {
    const { stdout, stderr } = await exec(bin, ['auth', 'status'], { timeout: 10000, maxBuffer: 65536 });
    const text = `${stdout}\n${stderr}`.trim();
    let parsed = null;
    try {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) parsed = JSON.parse(text.slice(start, end + 1));
    } catch {}
    if (parsed && typeof parsed === 'object') {
      authReady = parsed.loggedIn === true || parsed.authenticated === true;
      if (!authReady) result.authState = 'signed_out';
      result.quotaIdentity=authReady?quotaIdentity('claude',parsed):null;
      if (parsed.subscriptionType) result.authType = String(parsed.subscriptionType);
      else if (parsed.authMethod) result.authType = String(parsed.authMethod);
    } else {
      authReady = /logged[\s-]?in|authenticated|subscription/i.test(text) && !looksLoggedOut(text);
      if (looksLoggedOut(text)) result.authState = 'signed_out';
    }
  } catch (e) {
    const text = `${e.message || ''}\n${e.stdout || ''}\n${e.stderr || ''}`;
    // Signed out, `auth status` exits 1 with its JSON still saying loggedIn false; that is a definite answer.
    let signedOut = false;
    try { const out = String(e.stdout || ''), start = out.indexOf('{'), end = out.lastIndexOf('}'); signedOut = start >= 0 && end > start && JSON.parse(out.slice(start, end + 1)).loggedIn === false; } catch {}
    if (signedOut || looksLoggedOut(text)) {
      return { ...result, authReady: false, authState: 'signed_out', reason: tr('runtimeProbe.signInWithClaudeOn') };
    }
    // A check that timed out or was killed does not know the account: it is retried, and the saved quota is kept meanwhile.
    if (checkInterrupted(e)) { result.authUnknown = true; result.transient = true; result.authCheckError = e.killed || e.signal || e.code === 'ETIMEDOUT' ? tr('runtimeProbe.cliStatusProbeTimedOut') : String(e.code); }
  }
  // A third-party Anthropic-compatible service declares its models explicitly on the device, to avoid showing MiMo as Opus by mistake.
  // Claude Code has no stable models subcommand; a positional argument would be treated as a prompt and consume quota.
  const providerModel = process.env.CLAUDE_MODEL_ID?.trim();
  const known = providerModel ? [{ id: providerModel, name: providerModel, effort: null, efforts: [] }] : [
    { id: 'sonnet', name: 'Sonnet', effort: null, efforts: [] },
    { id: 'opus', name: 'Opus', effort: null, efforts: [] },
    { id: 'haiku', name: 'Haiku', effort: null, efforts: [] },
  ];
  const fresh = claudeCatalog && !force && claudeCatalog.version === result.version && claudeCatalog.identity === JSON.stringify(result.quotaIdentity) && Date.now() - claudeCatalog.at < CLAUDE_CATALOG_TTL_MS;
  const nativeModels = !authReady ? [] : fresh ? claudeCatalog.models : await probeClaudeModels(bin);
  if (authReady && !fresh && nativeModels) claudeCatalog = { version: result.version, identity: JSON.stringify(result.quotaIdentity), models: nativeModels, at: Date.now() };
  // An empty successful catalog is authoritative; only an unavailable probe keeps legacy aliases.
  const seen = new Set();
  const catalog = nativeModels?.filter(m => {
    if (typeof m?.value !== 'string' || !m.value.trim() || seen.has(m.value)) return false;
    seen.add(m.value); return true;
  });
  const choices = providerModel || !catalog ? known : catalog.map(m => ({id:m.value,name:typeof m.displayName==='string'&&m.displayName.trim()?m.displayName:m.value,effort:null,efforts:[]}));
  const models = authReady ? choices.map(model => {
    const native = catalog?.find(m => m.value === model.id)
      || (providerModel ? catalog?.find(m => m.resolvedModel === providerModel) : null);
    const efforts = native?.supportsEffort === true && Array.isArray(native.supportedEffortLevels)
      ? [...new Set(native.supportedEffortLevels.filter(value => ['low', 'medium', 'high', 'xhigh', 'max'].includes(value)))] : [];
    const resolvedModel = typeof native?.resolvedModel === 'string' ? native.resolvedModel : null;
    const usageCreditsMayApply = [model.id,resolvedModel].some(id=>typeof id==='string'&&/^(?:fable(?:$|\[)|claude-fable-)/i.test(id));
    return { ...model, efforts, ...(resolvedModel ? {resolvedModel} : {}), ...(usageCreditsMayApply ? {usageCreditsMayApply:true} : {}) };
  }) : [];
  result.models = models;
  result.authReady = authReady;
  result.available = authReady && models.length > 0;
  result.reason = !result.installed ? result.reason
    : result.authUnknown ? tr('runtimeProbe.checkCliOnDeviceThen2', { message: result.authCheckError })
    : !authReady ? tr('runtimeProbe.signInWithClaudeOn2')
    : !models.length ? tr('runtimeProbe.cliReturnedNoAvailableModels3')
    : '';
  return result;
}

export const RUNTIME_TRANSIENT_LIMIT = 2;
export const RUNTIME_RETRY_MS = Object.freeze([30000, 60000, 120000]);

/**
 * One process-level probe failure (for example the App Server exiting mid-probe) keeps the last good report of the
 * same CLI version, so dispatch is not blocked for a whole probe interval. The kept report retains its original
 * checkedAt, so the ten-minute expiry in runtimeIssue still bounds how stale it can get. The second consecutive
 * failure reports the CLI unavailable. Failed probes are retried after 30s, 60s, then every 120s until one succeeds.
 */
export function mergeRuntimeReports(previous, next, failures = {}) {
  const counts = {};
  const runtimes = (Array.isArray(next) ? next : []).map(report => {
    if (!report?.transient || report.available) return report;
    const count = (failures[report.type] || 0) + 1, warning = { reason: report.reason, at: report.checkedAt, failures: count };
    counts[report.type] = count;
    const last = (Array.isArray(previous) ? previous : []).find(item => item?.type === report.type);
    if (count < RUNTIME_TRANSIENT_LIMIT && last?.available && !last.probeWarning && last.version === report.version) return { ...last, probeWarning: warning };
    return { ...report, probeWarning: warning };
  }).map(report=>mergeRuntimeQuota((previous||[]).find(r=>r.type===report.type),report));
  const worst = Math.max(0, ...Object.values(counts));
  return { runtimes, failures: counts, retryMs: worst ? RUNTIME_RETRY_MS[Math.min(worst, RUNTIME_RETRY_MS.length) - 1] : null };
}

/** Saving and dispatching use the same contract; the status comes from that node, and cross-device model lists are not accepted. */
export function runtimeIssue(worker, type, model) {
  if (!worker?.capabilities?.runtimeDiscovery) return tr('runtimeProbe.upgradeWorkerRefreshCliCheck');
  const runtime = worker.runtimes?.find(r => r.type === type && r.supported);
  if (!runtime?.available) return runtime?.reason || tr('runtimeProbe.deviceHasNoAvailableConnected');
  if (!runtime.checkedAt || Date.now() - Date.parse(runtime.checkedAt) > 600000 || !Number.isFinite(Date.parse(runtime.checkedAt))) return tr('runtimeProbe.cliCheckHasExpiredRefresh');
  if (model && !runtime.models?.some(m => m.id === model)) return tr('runtimeProbe.modelNotInDeviceS');
  return null;
}

/** Compatible with old Worker caches; the workbench no longer shows the removed Gemini CLI. */
export function visibleRuntimes(reports, hiddenRuntimes = []) {
  return (Array.isArray(reports) ? reports : []).filter(r => r && r.type !== 'gemini' && (r.available || !hiddenRuntimes.includes(r.type)));
}

/** Other installed CLIs only report the fact of installation; adapters that are not integrated cannot take part in scheduling. */
export async function inspectRuntimes({ force = true } = {}) {
  const results = await Promise.all([inspectCodex(), inspectGrok(), inspectAgy(), inspectClaude({ force }), ...['opencode'].map(async type => {
    try { const { stdout } = await exec(type, ['--version'], { timeout: 5000, maxBuffer: 16384 });
      return { type, label: `${type} CLI`, installed: true, supported: false, available: false, models: [], quota: null, quotaStatus: 'unavailable', version: stdout.trim().split('\n')[0].slice(0, 120), checkedAt: new Date().toISOString(), reason: tr('runtimeProbe.installedButPlatformHasNot') };
    } catch { return null; }
  })]);
  return results.filter(Boolean);
}
