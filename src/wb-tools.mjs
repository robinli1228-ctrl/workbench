import { mkdir, readFile, writeFile, readdir, stat, appendFile } from 'node:fs/promises';
import { agentRequest } from './agent-bridge.mjs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tr } from './i18n.mjs';

const exec = promisify(execFile);
const now = () => new Date().toISOString();

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

export function context() {
  const projectRoot = env('WB_PROJECT_ROOT');
  const knowledge = env('WB_KNOWLEDGE') || (projectRoot ? join(projectRoot, '.workbench') : '');
  return {
    projectRoot,
    knowledge,
    workspace: env('WB_WORKSPACE'),
    runId: env('WB_RUN_ID'),
    role: env('WB_ROLE'),
    hop: Number(env('WB_HOP') || 0),
    home: env('WB_HOME'),
    token: env('WB_TOKEN'),
    mode: env('WB_MODE')
  };
}

function inside(root, path) {
  const rel = relative(root, path);
  return !rel || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function ensureKnowledge(dir) {
  if (!dir) throw new Error(tr('wbTools.wbKnowledgeWbProjectRoot'));
  await mkdir(join(dir, 'docs'), { recursive: true });
  await mkdir(join(dir, 'handoffs'), { recursive: true });
  const index = join(dir, 'INDEX.md');
  const memory = join(dir, 'MEMORY.md');
  try { await stat(index); } catch {
    await writeFile(index, tr('wbTools.projectKnowledgeIndexMemoryMd'), 'utf8');
  }
  try { await stat(memory); } catch {
    await writeFile(memory, tr('wbTools.projectMemoryRecordConfirmedFacts'), 'utf8');
  }
  return dir;
}

export async function boot() {
  const ctx = context();
  const knowledge = await ensureKnowledge(ctx.knowledge);
  const index = await readFile(join(knowledge, 'INDEX.md'), 'utf8').catch(() => '');
  const last = await readFile(join(knowledge, 'handoffs', 'LATEST.md'), 'utf8').catch(() => '');
  return {
    ok: true,
    role: ctx.role || null,
    hop: ctx.hop,
    knowledge,
    projectRoot: ctx.projectRoot,
    indexPreview: index.slice(0, 800),
    lastHandoff: last.slice(0, 2000) || null
  };
}

export async function memoryRead() {
  const dir = await ensureKnowledge(context().knowledge);
  return { path: join(dir, 'MEMORY.md'), text: await readFile(join(dir, 'MEMORY.md'), 'utf8') };
}

export async function memoryWrite(text) {
  if (!text || !String(text).trim()) throw new Error(tr('wbTools.memoryWriteNeedsContent'));
  const ctx = context();
  const dir = await ensureKnowledge(ctx.knowledge);
  const line = `\n## ${now()} · ${ctx.role || 'unknown'}\n${String(text).trim()}\n`;
  await appendFile(join(dir, 'MEMORY.md'), line, 'utf8');
  return { ok: true, path: join(dir, 'MEMORY.md') };
}

export async function memorySearch(query) {
  if (!query) throw new Error(tr('wbTools.searchTermRequired'));
  const dir = await ensureKnowledge(context().knowledge);
  const q = String(query).toLowerCase();
  const files = ['MEMORY.md', 'INDEX.md'];
  const docs = join(dir, 'docs');
  try {
    for (const name of await readdir(docs)) {
      if (name.endsWith('.md')) files.push(join('docs', name));
    }
  } catch { /* With no docs directory, search memory only */ }
  const hits = [];
  for (const rel of files) {
    const text = await readFile(join(dir, rel), 'utf8').catch(() => '');
    const lines = text.split('\n').map((line, i) => ({ n: i + 1, line })).filter(x => x.line.toLowerCase().includes(q));
    if (lines.length) hits.push({ file: rel, matches: lines.slice(0, 20) });
  }
  return { query, hits };
}

export async function docsList() {
  const dir = await ensureKnowledge(context().knowledge);
  const docs = join(dir, 'docs');
  let names = [];
  try { names = (await readdir(docs)).filter(n => !n.startsWith('.')); } catch { names = []; }
  return { index: 'INDEX.md', memory: 'MEMORY.md', docs: names };
}

export async function docsRead(rel) {
  const dir = await ensureKnowledge(context().knowledge);
  const target = resolve(dir, String(rel || ''));
  if (!inside(dir, target)) throw new Error(tr('wbTools.onlyFilesInsideWorkbenchCan'));
  const st = await stat(target);
  if (!st.isFile()) throw new Error(tr('wbTools.notFile'));
  if (st.size > 200000) throw new Error(tr('wbTools.fileExceeds200kbUseShorter'));
  return { path: relative(dir, target), text: await readFile(target, 'utf8') };
}

function gitEnv() {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oStrictHostKeyChecking=yes -oConnectTimeout=8' };
}

async function gitCwd() {
  const root = context().workspace || context().projectRoot;
  if (!root) throw new Error(tr('wbTools.wbProjectRootNotSet'));
  return root;
}

async function git(args) {
  const cwd = await gitCwd();
  const { stdout, stderr } = await exec('git', args, { cwd, timeout: 60000, maxBuffer: 1024 * 1024, env: gitEnv() });
  return { stdout: stdout.trim(), stderr: stderr.trim(), cwd };
}

export async function gitStatus() {
  const { stdout, cwd } = await git(['status', '-sb']);
  let origin = '';
  try { origin = (await git(['remote', 'get-url', 'origin'])).stdout; } catch { origin = ''; }
  return { cwd, origin, status: stdout };
}

async function homeFetch(pathname, payload) {
  const ctx = context();
  if (!ctx.home) throw new Error(tr('wbTools.wbHomeNotSet'));
  return agentRequest(pathname, payload);
}

export async function chatPost(text) {
  if (!String(text || '').trim()) throw new Error(tr('wbTools.chatNeedsText'));
  return homeFetch('/api/agent/note', { runId: context().runId, text: String(text).trim() });
}

export async function askRole(name, text) {
  const ctx = context();
  if (!name || !text) throw new Error(tr('wbTools.usageWbAskRoleName'));
  return homeFetch('/api/agent/ask', { runId: ctx.runId, role: String(name).replace(/^@/, ''), text: String(text).trim() });
}

/** The platform handles cross-node communication; local tools neither connect to other CLIs directly nor read their workspaces. */
export async function callRole({ role, kind = 'consult', requestId, text, deliveryId,sourceSyncBatchId }) {
  if (!role || !text || !requestId) throw new Error(tr('wbTools.roleTextStableRequestId'));
  if (!['consult', 'handoff','direct'].includes(kind)) throw new Error(tr('wbTools.kindMustBeConsultHandoff'));
  return homeFetch('/api/agent/calls', { runId: context().runId, role, kind,
    requestId: `${context().runId}:${requestId}`, text, deliveryId,sourceSyncBatchId });
}

export async function waitForRole(summary,options={}) {
  return homeFetch('/api/agent/wait', { runId: context().runId, summary,requestIds:options.requestIds,timeoutSeconds:options.timeoutSeconds });
}

/** Only submits a delivery request; once the user approves it, the Worker pushes the specified SHA. */
export async function requestDelivery(requestId, commit, summary) {
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(requestId)
    || typeof commit !== 'string' || (commit !== 'auto' && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))
    || typeof summary !== 'string' || !summary.trim() || summary.length > 8000) throw new Error(tr('wbTools.deliveryUsage'));
  if (commit === 'auto') {
    const repositories = JSON.parse(process.env.WB_REPOSITORIES || '[]');
    if (!repositories.length) throw new Error(tr('wbTools.currentRunHasNoDeliverable'));
    const items = [];
    for (const repo of repositories) {
      const head = (await exec('git',['rev-parse','HEAD'],{cwd:repo.localRoot,timeout:5000})).stdout.trim();
      items.push({id:repo.id,repoUrl:repo.repoUrl,commit:head});
    }
    return homeFetch('/api/agent/deliveries',{runId:context().runId,requestId,commit:items[0].commit,items,summary});
  }
  return homeFetch('/api/agent/deliveries', { runId: context().runId, requestId, commit, summary });
}

async function gitSnapshot(cwd) {
  if (!cwd) return { head: '', branch: '', files: '', status: '' };
  const run = async args => {
    try { return (await exec('git', args, { cwd, timeout: 8000, env: gitEnv() })).stdout.trim(); }
    catch { return ''; }
  };
  return {
    head: await run(['rev-parse', '--short', 'HEAD']),
    branch: await run(['rev-parse', '--abbrev-ref', 'HEAD']),
    files: (await run(['diff', '--name-status', 'HEAD'])) || (await run(['status', '--porcelain'])),
    status: await run(['status', '-sb'])
  };
}

function renderHandoff({ ctx, git, done, files, verify, next, blocked, auto }) {
  const fileLines = files || git.files || tr('wbTools.noChanges');
  return tr('wbTools.handoffRoleTimeRunWorkspace', { p1: ctx.role || 'unknown', p2: now(), p3: ctx.runId || '', p4: ctx.workspace || '', p5: git.branch || '—', p6: git.head || '—', p7: auto ? tr('wbTools.filledInByWorkerFrom') : tr('wbTools.submittedByRole'), p8: (done || tr('wbTools.notProvided')).trim(), p9: String(fileLines).trim(), p10: (verify || tr('wbTools.notProvided2')).trim(), p11: (next || tr('wbTools.nextPersonStartsWithWb')).trim(), p12: (blocked || tr('wbTools.none')).trim() });
}

export async function handoffLast() {
  const dir = await ensureKnowledge(context().knowledge);
  const text = await readFile(join(dir, 'handoffs', 'LATEST.md'), 'utf8').catch(() => '');
  if (!text) return { ok: false, error: tr('wbTools.noWrittenHandoffYet') };
  return { ok: true, path: join(dir, 'handoffs', 'LATEST.md'), text };
}

export async function handoffHasRun(runId, knowledge) {
  if (!runId) return false;
  const dir = join(knowledge || context().knowledge, 'handoffs');
  const names = await readdir(dir).catch(() => []);
  return names.some(name => name.includes(runId));
}

/** Fixed template: done items / files / commit / next steps. With auto=true, skipped if this run already has a handoff. */
export async function writeHandoff(fields = {}, override = {}) {
  const ctx = { ...context(), ...override };
  const dir = await ensureKnowledge(ctx.knowledge);
  if (fields.auto && ctx.runId && await handoffHasRun(ctx.runId, dir)) {
    return { ok: true, skipped: true, reason: tr('wbTools.turnAlreadyHasWrittenHandoff') };
  }
  const git = await gitSnapshot(ctx.workspace || ctx.projectRoot);
  const body = renderHandoff({
    ctx, git,
    done: fields.done,
    files: fields.files,
    verify: fields.verify,
    next: fields.next,
    blocked: fields.blocked,
    auto: !!fields.auto
  });
  const stamp = now().replace(/[:.]/g, '-');
  const file = join(dir, 'handoffs', `${stamp}-${ctx.role || 'role'}-${ctx.runId || 'norun'}.md`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, body, 'utf8');
  await writeFile(join(dir, 'handoffs', 'LATEST.md'), body, 'utf8');
  return { ok: true, path: file, latest: join(dir, 'handoffs', 'LATEST.md') };
}

export const helpText = () => [tr('minimal.teamHelp'),tr('minimal.waitHelp'),tr('wbTools.builtInCollaborationToolsWorkbench'),process.env.WB_SOURCE_SYNC==='1'?tr('sourceSync.toolGuide'):''].filter(Boolean).join('\n\n');
