import { writeFile, realpath, readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tr } from './i18n.mjs';

const exec = promisify(execFile);
const git = (cwd, args) => exec('git', args, { cwd, timeout: 30000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
export const AGENTS_COMMIT_MESSAGE = 'chore: add AGENTS.md project memory';

/** Create AGENTS.md (the single project memory) and a CLAUDE.md pointer only when absent; existing files are never overwritten.
 * When the directory is a Git repository root, commit only the newly created files locally (never pushes); commit failures are reported, not thrown. */
export async function ensureAgentsFiles(dir) {
  const created = [];
  for (const [name, text] of [['AGENTS.md', tr('agentsMd.template')], ['CLAUDE.md', '@AGENTS.md\n']]) {
    try { await writeFile(join(dir, name), text, { flag: 'wx', mode: 0o644 }); created.push(name); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const result = { created, committed: false, commitError: null };
  if (!created.length) return result;
  let top;
  try { top = await realpath((await git(dir, ['rev-parse', '--show-toplevel'])).stdout.trim()); } catch { return result; }
  if (top !== await realpath(dir)) return result;
  try {
    await git(dir, ['add', '--', ...created]);
    await git(dir, ['commit', '-q', '-m', AGENTS_COMMIT_MESSAGE, '--only', '--', ...created]);
    result.committed = true;
  } catch (e) {
    await git(dir, ['reset', '-q', '--', ...created]).catch(() => {});
    result.commitError = String(e.stderr || e.message || e).trim().slice(0, 300);
  }
  return result;
}

const inside = (root, path) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
const AGENTS_MAX_BYTES = 600000;

/**
 * The AGENTS.md a session uses: the nearest one at or above the folder, but never above the project root (`stopAt`); a session
 * outside any project looks only in its own folder. Files shared above the project are not offered for editing here.
 */
export async function locateAgentsFile(roots, dir, { stopAt = null } = {}) {
  const start = await realpath(dir), allowed = (await Promise.all(roots.map(r => realpath(r).catch(() => null)))).filter(Boolean);
  const deviceRoot = allowed.find(r => inside(r, start));
  if (!deviceRoot) throw new Error('Folder is outside the device roots');
  const stop = stopAt ? await realpath(stopAt) : null;
  const top = stop && inside(deviceRoot, stop) && inside(stop, start) ? stop : start;
  let current = start;
  for (;;) {
    const candidate = join(current, 'AGENTS.md');
    try { const info = await stat(candidate); if (info.isFile()) return { found: true, path: candidate, dir: current, size: info.size, modifiedAt: info.mtime.toISOString() }; }
    catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
    if (current === top || dirname(current) === current) break;
    current = dirname(current);
  }
  return { found: false, path: join(start, 'AGENTS.md'), dir: start, top };
}

export async function readAgentsFile(roots, dir, options = {}) {
  const located = await locateAgentsFile(roots, dir, options);
  if (!located.found) return located;
  if (located.size > AGENTS_MAX_BYTES) return { ...located, content: null, tooLarge: true };
  return { ...located, content: await readFile(located.path, 'utf8') };
}

/**
 * Write only the AGENTS.md this folder uses (a stale edit is refused), or create one when none exists: in `createDir` when it
 * is an ancestor of the folder inside the same device root (the project folder), else in the folder itself. Creation goes
 * through ensureAgentsFiles, so the CLAUDE.md pointer and the local commit happen as for a new project.
 */
export async function writeAgentsFile(roots, dir, { path = null, content, expectedModifiedAt = null, create = false, createDir = null, stopAt = null } = {}) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > AGENTS_MAX_BYTES) throw new Error('AGENTS.md content must be text up to 600 KB');
  const located = await locateAgentsFile(roots, dir, { stopAt });
  let target = located.path;
  if (located.found) {
    if (path && path !== located.path) throw new Error('Only the AGENTS.md this folder uses can be edited here');
    if (expectedModifiedAt && expectedModifiedAt !== located.modifiedAt) throw new Error('AGENTS.md changed on the device; reload it and try again');
    await writeFile(located.path, content, 'utf8');
  } else {
    if (!create) throw new Error('No AGENTS.md above this folder; create it first');
    let where = located.dir;
    if (createDir) { const candidate = await realpath(createDir); if (inside(candidate, located.dir)) where = candidate; }
    await ensureAgentsFiles(where);
    target = join(where, 'AGENTS.md');
    if (content.trim()) await writeFile(target, content, 'utf8');
  }
  const info = await stat(target);
  return { path: target, dir: dirname(target), size: info.size, modifiedAt: info.mtime.toISOString() };
}
