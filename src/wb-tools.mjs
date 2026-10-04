import { mkdir, readFile, writeFile, readdir, stat, appendFile } from 'node:fs/promises';
import { agentRequest } from './agent-bridge.mjs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
  if (!dir) throw new Error('WB_KNOWLEDGE / WB_PROJECT_ROOT is not set');
  await mkdir(join(dir, 'docs'), { recursive: true });
  await mkdir(join(dir, 'handoffs'), { recursive: true });
  const index = join(dir, 'INDEX.md');
  const memory = join(dir, 'MEMORY.md');
  try { await stat(index); } catch {
    await writeFile(index, `# Project Knowledge Index\n\n- MEMORY.md — decisions already made\n- docs/ — long documents, read on demand, never read end to end\n- handoffs/LATEST.md — the most recent written handoff (done items / files / commit / next step)\n\nStart with \`wb boot\` and always finish with \`wb handoff\`.\n`, 'utf8');
  }
  try { await stat(memory); } catch {
    await writeFile(memory, `# Project Memory\n\nRecord confirmed facts only. When appending, include the time and role name, and do not delete other people's entries.\n\n`, 'utf8');
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
  if (!text || !String(text).trim()) throw new Error('memory write needs content');
  const ctx = context();
  const dir = await ensureKnowledge(ctx.knowledge);
  const line = `\n## ${now()} · ${ctx.role || 'unknown'}\n${String(text).trim()}\n`;
  await appendFile(join(dir, 'MEMORY.md'), line, 'utf8');
  return { ok: true, path: join(dir, 'MEMORY.md') };
}

export async function memorySearch(query) {
  if (!query) throw new Error('A search term is required');
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
  if (!inside(dir, target)) throw new Error('Only files inside .workbench can be read');
  const st = await stat(target);
  if (!st.isFile()) throw new Error('Not a file');
  if (st.size > 200000) throw new Error('The file exceeds 200KB; use a shorter document or search first');
  return { path: relative(dir, target), text: await readFile(target, 'utf8') };
}

function gitEnv() {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oStrictHostKeyChecking=yes -oConnectTimeout=8' };
}

async function gitCwd() {
  const root = context().workspace || context().projectRoot;
  if (!root) throw new Error('WB_PROJECT_ROOT is not set');
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
  if (!ctx.home) throw new Error('WB_HOME is not set');
  return agentRequest(pathname, payload);
}

export async function chatPost(text) {
  if (!String(text || '').trim()) throw new Error('chat needs text');
  return homeFetch('/api/agent/note', { runId: context().runId, text: String(text).trim() });
}

export async function askRole(name, text) {
  const ctx = context();
  if (!name || !text) throw new Error('Usage: wb ask ROLE_NAME DESCRIPTION');
  return homeFetch('/api/agent/ask', { runId: ctx.runId, role: String(name).replace(/^@/, ''), text: String(text).trim() });
}

/** The platform handles cross-node communication; local tools neither connect to other CLIs directly nor read their workspaces. */
export async function callRole({ role, kind = 'consult', requestId, text, deliveryId }) {
  if (!role || !text || !requestId) throw new Error('--role, --text, and a stable --request-id are required');
  if (!['consult', 'handoff'].includes(kind)) throw new Error('kind must be consult or handoff');
  return homeFetch('/api/agent/calls', { runId: context().runId, role, kind,
    requestId: `${context().runId}:${requestId}`, text, deliveryId });
}

export async function waitForRole(summary) {
  return homeFetch('/api/agent/wait', { runId: context().runId, summary });
}

/** Only submits a delivery request; once the user approves it, the Worker pushes the specified SHA. */
export async function requestDelivery(requestId, commit, summary) {
  if (commit === 'auto') {
    const repositories = JSON.parse(process.env.WB_REPOSITORIES || '[]');
    if (!repositories.length) throw new Error('The current run has no deliverable repository');
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
  const fileLines = files || git.files || '(no changes)';
  return `# Handoff

- Role: ${ctx.role || 'unknown'}
- Time: ${now()}
- Run: ${ctx.runId || ''}
- Workspace: ${ctx.workspace || ''}
- Branch: ${git.branch || '—'}
- HEAD: ${git.head || '—'}
- Source: ${auto ? 'Filled in by the Worker from git state (the role wrote no formal handoff)' : 'Submitted by the role'}

## Done
${(done || '(not provided)').trim()}

## Files
${String(fileLines).trim()}

## Verification
${(verify || '(not provided)').trim()}

## Next steps
${(next || 'The next person starts with \`wb boot\` and reads handoffs/LATEST.md').trim()}

## Blockers
${(blocked || 'None').trim()}
`;
}

export async function handoffLast() {
  const dir = await ensureKnowledge(context().knowledge);
  const text = await readFile(join(dir, 'handoffs', 'LATEST.md'), 'utf8').catch(() => '');
  if (!text) return { ok: false, error: 'No written handoff yet' };
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
    return { ok: true, skipped: true, reason: 'This turn already has a written handoff' };
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

export const HELP = `Built-in collaboration tools of the workbench (shared by all roles)

wb capabilities      Current collaboration tools and protocol version
wb setup catalog     Read-only query, for all roles, of the full role roster, responsibility prompts, CLIs, models, and configuration of the current project
wb discuss peers     Query, for all valid role sessions, the current tasks, working directories, and recent notes of peers
wb boot              Read INDEX + the latest handoff on demand; not needed every turn
wb history search TERM  Search messages and reports of the current project; returns source IDs
wb session current     Show this turn's role session ID and status
wb session list --limit 20 [--cursor ID]  List the project's role sessions
wb session summary SESSION_ID  Show a role session summary
wb session read SESSION_ID [--offset N --version V]  Read visible assignments and replies in segments
wb chat summary       Show the conversation digest of the current project
wb history read ID [offset] [version]  Read the original message text in segments
wb result read ID [offset] [version]   Read a full run/call report in segments
wb report JSON       Submit the verdict/summary/evidence/next business conclusion
wb memory            Read MEMORY.md
wb memory write TEXT  Append a memory entry (with role and time)
wb memory search TERM   Search memory and docs
wb docs              List documents
wb docs read PATH     Read a file inside .workbench
wb git               Show repository status and origin (read-only)
wb chat TEXT         Leave a note in the project group chat (does not dispatch)
wb ask ROLE DESCRIPTION      Compatibility consultation entry; only one request per target is accepted in the same turn
wb call --role FULL_ROLE_NAME_OR_ID --kind consult --request-id ID --text DESCRIPTION
                    Start a consultation that can cross devices; reuse the ID when retrying
wb role prompt '{"roleId":"ROLE_ID","revision":3,"requestId":"stable-id","instructions":"complete new prompt"}'
                    Only the project supervisor can directly update this project's working-role prompts; affects new tasks only
wb timer list        Project supervisor only: view the current project's timed jobs and trigger records
wb timer create|update|pause|resume|delete '<JSON>'
                    Project supervisor only: manage wall-clock timed jobs; writes need a stable requestId, and update/pause/resume/delete need id and revision
                    Progress patrol example: wb timer create '{"requestId":"check-1","name":"Progress patrol","description":"Check for project blockers","roleId":"SUPERVISOR_ROLE_ID","jobType":"monitor","type":"interval","intervalMinutes":10}'
                    Stage scheduling is for the project supervisor only and is different from wall-clock timed jobs
wb wait RESUME_SUMMARY      Register a wait and end the turn; the platform resumes it when the results return
wb deliver ID FULL_COMMIT_SHA DESCRIPTION
                    Register a delivery; waits for the run to finish and the web push confirmation
wb handoff           Write a written handoff (done items / files / commit / next steps)
wb handoff last      Read the most recent handoff

Handoff example:
  wb handoff --done "Fixed login validation" --next "@reviewer check the diff" --verify "Local curl passed"

The Worker fills in handoffs automatically. Before a new run ends you must submit a real business conclusion with wb report; a turn that is waiting on child calls does not need to report a pass early.`;
