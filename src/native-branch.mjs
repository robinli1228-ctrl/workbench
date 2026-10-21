import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { cp, lstat, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

/**
 * Branching and deleting a native session's folder (Sessions page → session settings).
 * Branch: copy the session's working folder next to it, then fork the CLI session into the copy, so the two can run in
 * parallel without touching each other's files. Delete: remove a folder Workbench made for a session, never a project
 * root, a shared default folder or anything another session or project still uses.
 */
export const BRANCH_RUNTIMES = new Set(['claude', 'codex']);
export const BRANCH_LIMITS = Object.freeze({ entries: 200000, bytes: 10 * 1024 ** 3 });

const inside = (root, path) => { const r = relative(root, path); return !r || (r !== '..' && !r.startsWith('../') && !isAbsolute(r)); };
const strictlyInside = (root, path) => root !== path && inside(root, path);

/** The first free sibling "<name>-branch-<n>", which must stay inside the device's allowed folders. */
export async function branchTarget(source, roots, exists = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }) {
  const parent = dirname(source), name = basename(source);
  if (!roots.some(root => strictlyInside(root, join(parent, `${name}-branch-1`)))) throw Error('The session folder is a top-level allowed folder; a branch cannot be created next to it');
  for (let n = 1; n <= 99; n++) { const target = join(parent, `${name}-branch-${n}`); if (!await exists(target)) return target; }
  throw Error('Too many branches next to this folder; delete some first');
}

/** Count before copying: symlinks are copied as links, never followed, and the copy stops at a size an operator would not expect. */
export async function measureFolder(root, limits = BRANCH_LIMITS) {
  let entries = 0, bytes = 0;
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      entries++;
      if (entries > limits.entries) throw Error(`The folder has more than ${limits.entries} files; it is too large to branch`);
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) { bytes += (await lstat(path)).size; if (bytes > limits.bytes) throw Error(`The folder is larger than ${Math.round(limits.bytes / 1024 ** 3)} GB; it is too large to branch`); }
    }
  };
  await walk(root);
  return { entries, bytes };
}

/** An exact copy (hidden files and .git included, timestamps kept, symlinks as links); a partial copy is removed on failure. */
export async function copyFolder(source, target, limits = BRANCH_LIMITS) {
  const size = await measureFolder(source, limits);
  try { await cp(source, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true }); }
  catch (error) { await rm(target, { recursive: true, force: true }).catch(() => {}); throw error; }
  return size;
}

/**
 * Whether Workbench may delete this session's folder, with the reason when not. Only a folder Workbench made for a session
 * qualifies: a branch copy (folderCreated) or "<project>/native-sessions/<name>". It must not be an allowed root, a project's
 * bound folder or hold one, and no other registered session or managed run may work in or under it.
 */
export async function deletableFolder({ workspace, entry, registry = [], runs = [], bindings = [], roots = [] }) {
  if (!entry) return { ok: false, reason: 'Only sessions created in Workbench can delete their folder' };
  if (!workspace) return { ok: false, reason: 'No working folder is recorded for this session yet.' };
  let folder;
  try { folder = await realpath(workspace); } catch (error) { if (error.code === 'ENOENT') return { ok: false, reason: 'The folder no longer exists', missing: true }; throw error; }
  if (!(await lstat(folder)).isDirectory()) return { ok: false, reason: 'The working folder is not a directory' };
  const allowed = await Promise.all(roots.map(root => realpath(root).catch(() => root)));
  if (!allowed.some(root => strictlyInside(root, folder))) return { ok: false, reason: 'The folder is outside, or is itself, a top-level allowed folder' };
  if (!(entry.folderCreated === true || basename(dirname(folder)) === 'native-sessions')) return { ok: false, reason: 'This folder was not created by Workbench for this session; delete it yourself if you mean to' };
  for (const binding of bindings) {
    const root = binding.localRoot ? await realpath(binding.localRoot).catch(() => binding.localRoot) : null;
    if (root && inside(folder, root)) return { ok: false, reason: 'The folder is, or holds, a project folder' };
  }
  const resolve = path => path ? realpath(path).catch(() => path) : null;
  for (const other of registry) {
    if (other.id === entry.id || !other.workspace) continue;
    if (inside(folder, await resolve(other.workspace))) return { ok: false, reason: 'Another session works in this folder' };
  }
  for (const run of runs) if (run.workspace && inside(folder, await resolve(run.workspace))) return { ok: false, reason: 'A group-chat run works in this folder' };
  return { ok: true, path: folder };
}

function child(bin, args, { cwd, env, timeoutMs }) {
  const proc = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const timer = setTimeout(() => { try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); } }, timeoutMs); timer.unref?.();
  const done = new Promise((resolve, reject) => { proc.on('error', error => { clearTimeout(timer); reject(error); }); proc.on('exit', code => { clearTimeout(timer); resolve(code); }); });
  proc.stdin.on('error', () => {});
  return { proc, done, stop: () => { clearTimeout(timer); try { process.kill(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch {} } } };
}

/** Claude: one short print turn resumes the original, forks it under the pre-chosen ID and runs in the copy. */
export async function forkClaude({ bin = process.env.CLAUDE_BIN || 'claude', cwd, sessionId, newSessionId, notice, env = process.env, timeoutMs = 5 * 60000 }) {
  const run = child(bin, ['-p', notice, '--resume', sessionId, '--fork-session', '--session-id', newSessionId, '--output-format', 'json', '--dangerously-skip-permissions'], { cwd, env, timeoutMs });
  run.proc.stdin.end();
  let out = '', err = '';
  run.proc.stdout.on('data', chunk => { out += chunk; }); run.proc.stderr.on('data', chunk => { err += chunk; });
  const code = await run.done;
  let result = null; try { result = JSON.parse(out.trim().split('\n').filter(Boolean).at(-1) || ''); } catch {}
  if (code !== 0 || !result || result.is_error || result.session_id !== newSessionId) throw Error(`Claude could not fork the session: ${(result?.result || err || out || `exit ${code}`).toString().trim().slice(0, 300)}`);
  return { sessionId: newSessionId, reply: String(result.result || '').slice(0, 300) };
}

/** Codex: thread/fork records the copy as the new thread's folder; the notice turn then runs there. */
export async function forkCodex({ bin = process.env.CODEX_BIN || 'codex', cwd, sessionId, notice, env = process.env, timeoutMs = 5 * 60000 }) {
  const run = child(bin, ['app-server', '--listen', 'stdio://', '--disable', 'multi_agent'], { cwd, env, timeoutMs });
  let nextId = 0;
  const pending = new Map(), waiters = [];
  const write = message => run.proc.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method, params) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); write({ id, method, params }); });
  const lines = createInterface({ input: run.proc.stdout });
  lines.on('line', line => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && !m.method) { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); return; }
    // The notice turn needs no approvals or questions; refuse any request so the turn cannot hang on one.
    if (m.id !== undefined && m.method) { write({ id: m.id, error: { code: -32601, message: 'Not available while branching' } }); return; }
    for (const waiter of [...waiters]) if (waiter.match(m)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(m); }
  });
  const dead = message => { for (const p of pending.values()) p.reject(Error(message)); pending.clear(); for (const w of waiters.splice(0)) w.reject(Error(message)); };
  // A Codex that cannot start (missing or unrunnable binary) fails the branch at once instead of hanging it.
  const exited = run.done.then(code => dead(`Codex exited (${code})`), error => dead(`Codex could not start: ${error.message}`));
  const waitFor = match => new Promise((resolve, reject) => waiters.push({ match, resolve, reject }));
  try {
    await request('initialize', { clientInfo: { name: 'agent_collaboration_worker', version: '0.3.0' } });
    write({ method: 'initialized' });
    const forked = await request('thread/fork', { threadId: sessionId, cwd, approvalPolicy: 'never', sandbox: 'workspace-write' });
    const newSessionId = forked?.thread?.id;
    if (!newSessionId || newSessionId === sessionId) throw Error('Codex did not return a new thread for the branch');
    const completed = waitFor(m => m.method === 'turn/completed');
    await request('turn/start', { threadId: newSessionId, input: [{ type: 'text', text: notice }] });
    const done = await completed;
    if (done.params?.turn?.status !== 'completed') throw Error(`The branch's first turn did not complete: ${done.params?.turn?.error?.message || done.params?.turn?.status}`);
    return { sessionId: newSessionId };
  } finally { run.stop(); await exited.catch(() => {}); }
}
