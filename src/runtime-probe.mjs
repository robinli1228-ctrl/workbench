import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
const exec = promisify(execFile);

/** A single no-inference probe: reads only the version, login state, and model catalog, and creates no Thread/Turn. */
export async function inspectCodex() {
  const result = { type: 'codex', label: 'Codex CLI', supported: true, installed: false, available: false, models: [], quota: null, quotaStatus: 'unavailable', checkedAt: new Date().toISOString() };
  const bin = process.env.CODEX_BIN || 'codex';
  try { result.version = (await exec(bin, ['--version'], { timeout: 5000 })).stdout.trim(); result.installed = true; }
  catch { return { ...result, reason: 'No runnable Codex CLI found; install it on the device or check CODEX_BIN/PATH' }; }
  const proc = spawn(bin, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: proc.stdout });
  const pending = new Map(); let id = 0;
  const fail = error => { for (const p of pending.values()) p.reject(error); pending.clear(); };
  proc.on('error', () => fail(new Error('App Server could not start')));
  proc.on('exit', () => fail(new Error('App Server has exited')));
  const timer = setTimeout(() => { fail(new Error('CLI status probe timed out')); proc.kill(); }, 15000);
  lines.on('line', line => {
    try { const m = JSON.parse(line), p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error('The CLI does not support the required probe interface')) : p.resolve(m.result); } catch {}
  });
  const call = (method, params) => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); proc.stdin.write(`${JSON.stringify({ id: key, method, params })}\n`); });
  proc.stdin.on('error', () => fail(new Error('The CLI connection was closed (disconnect)')));
  try {
    await call('initialize', { clientInfo: { name: 'agent_workbench_probe', version: '0.3.0' } });
    proc.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    const auth = await call('account/read', { refreshToken: false });
    result.authReady = !!auth.account || auth.requiresOpenaiAuth === false;
    result.authType = auth.account?.type || (auth.requiresOpenaiAuth === false ? 'provider' : 'none');
    try {
      const limits = await call('account/rateLimits/read', {});
      Object.assign(result, normalizeCodexQuota(limits));
    } catch { /* When an older Codex has no quota interface, the model probe is still kept */ }
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
    result.reason = !result.authReady ? 'Run codex login on this device, then refresh the check' : !result.models.length ? 'The CLI returned no available models; check the node configuration' : '';
  } catch (e) { result.reason = `${e.message}; check the CLI on the device and then refresh the check`; }
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

function isoFromEpoch(value) {
  const seconds = finiteNumber(value);
  if (seconds == null) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function rateLimitBucket(bucket) {
  const usedPercent = finiteNumber(bucket?.usedPercent);
  if (usedPercent == null) return null;
  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    resetsAt: isoFromEpoch(bucket.resetsAt),
    windowDurationMins: finiteNumber(bucket.windowDurationMins),
  };
}

function normalizeCodexQuota(response) {
  const limits = response?.rateLimits || response?.rateLimitsByLimitId?.codex;
  if (!limits) return { quota: null, quotaStatus: 'unavailable' };
  const buckets = [limits.primary, limits.secondary].map(rateLimitBucket).filter(Boolean);
  const fiveHour = buckets.find(item => item.windowDurationMins === 300) || null;
  const weekly = buckets.find(item => item.windowDurationMins === 10080) || null;
  const credits = limits.credits ? {
    balance: finiteNumber(limits.credits.balance) ?? limits.credits.balance ?? null,
    hasCredits: limits.credits.hasCredits === true,
    unlimited: limits.credits.unlimited === true,
  } : null;
  if (!fiveHour && !weekly && !credits) return { quota: null, quotaStatus: 'unavailable' };
  return {
    quota: {
      fiveHour,
      weekly,
      credits,
      remainingPercent: fiveHour?.remainingPercent ?? weekly?.remainingPercent,
    },
    quotaStatus: 'ok',
  };
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
  catch { return { ...result, reason: `No runnable ${label} found; install it on the device or check ${binEnv}/PATH` }; }
  try {
    const { stdout, stderr } = await exec(bin, ['models'], { timeout: 15000, maxBuffer: 262144 });
    const text = `${stdout}\n${stderr}`;
    result.models = type === 'agy' ? parseAgyModels(stdout) : parseGrokModels(stdout);
    result.authReady = !looksLoggedOut(text) && result.models.length > 0;
    result.available = result.authReady;
    result.reason = result.available ? '' : looksLoggedOut(text) ? loginHint : 'The CLI returned no available models; check the node configuration or sign in, then refresh the check';
  } catch (e) {
    const text = `${e.message || ''}\n${e.stdout || ''}\n${e.stderr || ''}`;
    result.reason = looksLoggedOut(text) ? loginHint : `${e.message}; check the CLI on the device and then refresh the check`;
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
      for (const item of pending.values()) item.reject(new Error('The Grok probe has ended'));
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
        message.error ? item.reject(new Error(message.error.message || 'Grok ACP error')) : item.resolve(message.result);
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
  const result = await inspectPrintCli({ type: 'grok', label: 'Grok Build', binEnv: 'GROK_BIN', binName: 'grok', loginHint: 'Run grok login on this device, then refresh the check' });
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

/** In print mode, Agy expands /usage and /credits locally and starts no model conversation. */
async function probeAgyQuota(bin) {
  try {
    const [usage, credits] = await Promise.all([
      exec(bin, ['-p', '/usage', '--output-format', 'text'], { timeout: 15000, maxBuffer: 262144 }),
      exec(bin, ['-p', '/credits', '--output-format', 'text'], { timeout: 15000, maxBuffer: 65536 }),
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
  const result = await inspectPrintCli({ type: 'agy', label: 'Antigravity', binEnv: 'AGY_BIN', binName: 'agy', loginHint: 'Sign in to the Antigravity CLI on this device, then refresh the check' });
  if (!result.available) return result;
  const bin = process.env.AGY_BIN || 'agy';
  return { ...result, ...await probeAgyQuota(bin) };
}


/** Claude Code: --version / auth status / model aliases; no conversation is started. */
export async function inspectClaude() {
  const result = baseRuntime('claude', 'Claude Code');
  const bin = process.env.CLAUDE_BIN || 'claude';
  try {
    const ver = await exec(bin, ['--version'], { timeout: 5000, maxBuffer: 16384 });
    result.version = firstLine(ver.stdout || ver.stderr);
    result.installed = true;
  } catch {
    return { ...result, reason: 'No runnable Claude Code found; install it on the device or check CLAUDE_BIN/PATH' };
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
      if (parsed.subscriptionType) result.authType = String(parsed.subscriptionType);
      else if (parsed.authMethod) result.authType = String(parsed.authMethod);
    } else {
      authReady = /logged[\s-]?in|authenticated|subscription/i.test(text) && !looksLoggedOut(text);
    }
  } catch (e) {
    const text = `${e.message || ''}\n${e.stdout || ''}\n${e.stderr || ''}`;
    if (looksLoggedOut(text)) {
      return { ...result, authReady: false, reason: 'Sign in with claude on this device (claude.ai Pro), then refresh the check' };
    }
  }
  // A third-party Anthropic-compatible service declares its models explicitly on the device, to avoid showing MiMo as Opus by mistake.
  // Claude Code has no stable models subcommand; a positional argument would be treated as a prompt and consume quota.
  const providerModel = process.env.CLAUDE_MODEL_ID?.trim();
  const known = providerModel ? [{ id: providerModel, name: providerModel, effort: null, efforts: [] }] : [
    { id: 'sonnet', name: 'Sonnet', effort: null, efforts: [] },
    { id: 'opus', name: 'Opus', effort: null, efforts: [] },
    { id: 'haiku', name: 'Haiku', effort: null, efforts: [] },
  ];
  const models = authReady ? known : [];
  result.models = models;
  result.authReady = authReady;
  result.available = authReady && models.length > 0;
  Object.assign(result, await probeClaudeQuota(bin));
  result.reason = !result.installed ? result.reason
    : !authReady ? 'Sign in with claude on this device (claude.ai Pro), then refresh the check'
    : !models.length ? 'The CLI returned no available models; check the node configuration or sign in, then refresh the check'
    : '';
  return result;
}

function stripAnsi(text) {
  return String(text || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
}

/** Parse the human-readable output of `claude /usage` (session=5h, week=weekly). */
function parseClaudeUsageText(text) {
  let raw = stripAnsi(text);
  const jsonLine = raw.trim().split('\n').filter(Boolean).at(-1);
  if (jsonLine && jsonLine.startsWith('{')) {
    try {
      const parsed = JSON.parse(jsonLine);
      if (parsed?.result) raw = `${raw}\n${parsed.result}`;
    } catch { /* When it is not JSON, parse it as plain text */ }
  }
  const packUsed = (re) => {
    const m = raw.match(re);
    if (!m) return null;
    const used = Number(m[1]);
    if (!Number.isFinite(used)) return null;
    const rest = m[2] || '';
    const reset = rest.match(/resets?\s+(.+?)\s*$/i);
    return { usedPercent: used, remainingPercent: Math.max(0, 100 - used), resetsAt: reset ? reset[1].trim() : undefined };
  };
  const fiveHour = packUsed(/Current session:\s*(\d+(?:\.\d+)?)%\s*used([^\n]*)/i)
    || packUsed(/5\s*h(?:our)?[^\n]{0,40}?(\d+(?:\.\d+)?)%\s*used([^\n]*)/i);
  const weekly = packUsed(/Current week(?:\s*\([^)]*\))?\s*:\s*(\d+(?:\.\d+)?)%\s*used([^\n]*)/i)
    || packUsed(/week[^\n]{0,40}?(\d+(?:\.\d+)?)%\s*used([^\n]*)/i);
  if (!fiveHour && !weekly) return null;
  return { fiveHour, weekly };
}

/** Run `claude /usage`: stdin closed, about a 10s timeout; do not use -p (it spends quota). */
function runClaudeUsage(bin) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['/usage'], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '', stderr = '';
    const finish = (fn, payload) => {
      if (timer) clearTimeout(timer);
      timer = null;
      fn(payload);
    };
    let timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      const err = new Error('claude /usage timeout');
      err.stdout = stdout;
      err.stderr = stderr;
      finish(reject, err);
    }, 10000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      e.stdout = stdout;
      e.stderr = stderr;
      finish(reject, e);
    });
    child.on('close', () => finish(resolve, { stdout, stderr }));
  });
}

async function probeClaudeQuota(bin) {
  const empty = { quota: null, quotaStatus: 'unavailable' };
  const packOk = (parsed) => ({
    quota: {
      fiveHour: parsed.fiveHour || null,
      weekly: parsed.weekly || null,
      remainingPercent: parsed.fiveHour?.remainingPercent ?? parsed.weekly?.remainingPercent,
    },
    quotaStatus: 'ok',
  });
  try {
    const { stdout, stderr } = await runClaudeUsage(bin);
    const parsed = parseClaudeUsageText(`${stdout}\n${stderr}`);
    if (parsed) return packOk(parsed);
  } catch (e) {
    const parsed = parseClaudeUsageText(`${e.stdout || ''}\n${e.stderr || ''}`);
    if (parsed) return packOk(parsed);
  }
  try {
    const json = await new Promise((resolve, reject) => {
      const child = spawn(bin, ['/usage', '--output-format', 'json'], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(new Error('timeout')); }, 10000);
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('error', reject);
      child.on('close', () => { clearTimeout(timer); resolve({ stdout, stderr }); });
    });
    const parsed = parseClaudeUsageText(`${json.stdout}\n${json.stderr}`);
    if (parsed) return packOk(parsed);
  } catch { /* If the json probe fails, stay unavailable */ }
  return empty;
}

/** Saving and dispatching use the same contract; the status comes from that node, and cross-device model lists are not accepted. */
export function runtimeIssue(worker, type, model) {
  if (!worker?.capabilities?.runtimeDiscovery) return 'Upgrade the Worker and refresh the CLI check';
  const runtime = worker.runtimes?.find(r => r.type === type && r.supported);
  if (!runtime?.available) return runtime?.reason || 'This device has no available, connected CLI agent';
  if (!runtime.checkedAt || Date.now() - Date.parse(runtime.checkedAt) > 600000 || !Number.isFinite(Date.parse(runtime.checkedAt))) return 'The CLI check has expired; refresh';
  if (model && !runtime.models?.some(m => m.id === model)) return 'The model is not in this device\'s CLI model list; choose again';
  return null;
}

/** Compatible with old Worker caches; the workbench no longer shows the removed Gemini CLI. */
export function visibleRuntimes(reports) {
  return (Array.isArray(reports) ? reports : []).filter(r => r && r.type !== 'gemini');
}

/** Other installed CLIs only report the fact of installation; adapters that are not integrated cannot take part in scheduling. */
export async function inspectRuntimes() {
  const results = await Promise.all([inspectCodex(), inspectGrok(), inspectAgy(), inspectClaude(), ...['opencode'].map(async type => {
    try { const { stdout } = await exec(type, ['--version'], { timeout: 5000, maxBuffer: 16384 });
      return { type, label: `${type} CLI`, installed: true, supported: false, available: false, models: [], quota: null, quotaStatus: 'unavailable', version: stdout.trim().split('\n')[0].slice(0, 120), checkedAt: new Date().toISOString(), reason: 'Installed, but the platform has not integrated an execution adapter for this CLI yet' };
    } catch { return null; }
  })]);
  return results.filter(Boolean);
}
