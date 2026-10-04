import { mkdir, realpath, stat } from 'node:fs/promises';
import { join, dirname, basename, relative, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { giteeRepository } from './repository.mjs';
import { gitCredentialEnv } from './hosting.mjs';
import { tr } from './i18n.mjs';

const exec = promisify(execFile);
const inside = (root, path) => { const rel = relative(root, path); return !rel || (!rel.startsWith('..') && !isAbsolute(rel)); };
const git = async (cwd, args) => (await exec('git', args, { cwd, timeout: 60000, maxBuffer: 1024 * 1024,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oStrictHostKeyChecking=yes -oConnectTimeout=8' } })).stdout.trim();

/** The supervisor configuration directory is independent of code repositories; no repository needs to exist when a project is created. */
export async function prepareSupervisorDirectory(roots, projectId) {
  if (!/^[a-f0-9-]{36}$/.test(projectId)) throw new Error(tr('setupWorkspace.invalidProjectId'));
  const parent = join(roots[0], '.workbench-projects');
  await mkdir(parent, { recursive: true });
  if (!inside(roots[0], await realpath(parent))) throw new Error(tr('setupWorkspace.supervisorDirectoryEscapesAllowedRoot'));
  const dir = join(parent, projectId);
  await mkdir(dir, { recursive: true });
  if (!inside(roots[0], await realpath(dir))) throw new Error(tr('setupWorkspace.supervisorDirectoryEscapesAllowedRoot2'));
  return { localRoot: await realpath(dir) };
}

/** Clone only into a directory that does not exist; an existing directory must be the repository root with the same origin, and no branch is switched or anything overwritten. */
export async function setupRepository(roots, input) {
  const repo = giteeRepository(input.repoUrl);
  if (!repo || !isAbsolute(input.localRoot || '') || input.localRoot.includes('\0')) throw new Error(tr('setupWorkspace.invalidRepositoryUrlDirectory'));
  const parent = await realpath(dirname(input.localRoot));
  if (!roots.some(root => inside(root, parent))) throw new Error(tr('setupWorkspace.directoryOutsideRangeWorkerAllows'));
  const target = join(parent, basename(input.localRoot));
  let exists = false;
  try { await stat(target); exists = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!exists) {
    if (!input.clone) throw new Error(tr('setupWorkspace.directoryDoesNotExistIt'));
    try { await exec('git', ['clone', '--', repo.url, target], { cwd: parent, env: gitCredentialEnv(repo.url, input.credential), timeout: 60000, maxBuffer: 1024 * 1024 }); }
    catch { throw new Error(tr('setupWorkspace.cloneFailedCheckDeviceNetwork')); }
  }
  const root = await realpath(target);
  if (!roots.some(allowed => inside(allowed, root))) throw new Error(tr('setupWorkspace.directoryLinkEscapesAllowedRoot'));
  if (await realpath(await git(root, ['rev-parse', '--show-toplevel'])) !== root) throw new Error(tr('setupWorkspace.selectRepositoryRootDirectory'));
  // Read the logical repository URL, preserving the device's existing insteadOf transport configuration (SSH aliases or mirrors).
  const origin = giteeRepository(await git(root, ['config', '--get', 'remote.origin.url']));
  if (origin?.webUrl !== repo.webUrl) throw new Error(tr('setupWorkspace.originExistingDirectoryDoesNot'));
  return { localRoot: root, git: { head: await git(root, ['rev-parse', 'HEAD']).catch(() => null),
    branch: await git(root, ['symbolic-ref', '--short', 'HEAD']).catch(() => 'detached'), dirty: Boolean(await git(root, ['status', '--porcelain'])) } };
}
