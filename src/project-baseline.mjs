import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gitCredentialEnv } from './hosting.mjs';
import { giteeRepository } from './repository.mjs';
import { within } from './project-space.mjs';

const exec = promisify(execFile);
const git = async (root, args, repoUrl, credential) => (await exec('git', args, {
  cwd: root, env: gitCredentialEnv(repoUrl, credential), timeout: 60000, maxBuffer: 1024 * 1024
})).stdout.trim();
const identity = url => { try { return giteeRepository(url)?.webUrl || url; } catch { return url; } };
const common = async (root, repoUrl, credential) => realpath(resolve(root, await git(root, ['rev-parse', '--git-common-dir'], repoUrl, credential)));

/** Every project has one long-lived baseline worktree per device; the source repository checkout is always left untouched. */
export async function prepareProjectBaseline({ projectId, projectRoot, sourceRoot, key, baseBranch, baseCommit, expectedCommit, publishBaseline = true, repoUrl, credential }) {
  if (!/^[a-f0-9-]{36}$/.test(projectId || '') || !/^[a-zA-Z0-9_-]{1,40}$/.test(key || '')) throw new Error('Invalid project or repository identifier');
  if (baseCommit && !/^[a-f0-9]{40,64}$/.test(baseCommit)) throw new Error('The project baseline needs a full commit ID');
  const root = await realpath(projectRoot), source = await realpath(sourceRoot);
  if (!within(root, source) || await realpath(await git(source, ['rev-parse', '--show-toplevel'], repoUrl, credential)) !== source) throw new Error('The source repository is not an independent Git repository inside the project');
  if (identity(await git(source, ['remote', 'get-url', 'origin'], repoUrl, credential)) !== identity(repoUrl)) throw new Error('The source repository origin does not match the project repository');
  const branch = `agentwb/${projectId}`;
  const selected = baseBranch || await git(source, ['branch', '--show-current'], repoUrl, credential);
  if (!selected || selected.startsWith('-')) throw new Error('Specify the source branch of the project baseline');
  await git(source, ['check-ref-format', '--branch', selected], repoUrl, credential);
  const parent = join(root, '.worktrees', 'project-baseline');
  await mkdir(parent, { recursive: true });
  if (!within(root, await realpath(parent))) throw new Error('The project baseline directory is out of bounds');
  const target = join(parent, key);
  let exists = false;
  try { exists = (await stat(target)).isDirectory(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (exists) {
    if (await realpath(target) !== target || await realpath(await git(target, ['rev-parse', '--show-toplevel'], repoUrl, credential)) !== target) throw new Error('The existing project baseline directory does not match');
    if (await common(source, repoUrl, credential) !== await common(target, repoUrl, credential)) throw new Error('The project baseline does not belong to the source repository');
    if (await git(target, ['branch', '--show-current'], repoUrl, credential) !== branch) throw new Error('The existing project baseline branch does not match');
    if (expectedCommit && await git(target, ['rev-parse', 'HEAD'], repoUrl, credential) !== expectedCommit) {
      await syncProjectBaseline({localRoot:target,branch,commit:expectedCommit,repoUrl,credential});
    }
  } else {
    const remoteBranch = (await git(source, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], repoUrl, credential)) ? branch : selected;
    await git(source, ['fetch', '--no-tags', 'origin', `+refs/heads/${remoteBranch}:refs/remotes/origin/${remoteBranch}`], repoUrl, credential);
    const start = remoteBranch===branch ? `refs/remotes/origin/${remoteBranch}` : baseCommit || `refs/remotes/origin/${remoteBranch}`;
    if(baseCommit && remoteBranch!==branch) {
      try {await git(source,['merge-base','--is-ancestor',baseCommit,`refs/remotes/origin/${selected}`],repoUrl,credential);}
      catch {throw new Error('The specified commit does not belong to the source branch; check the full commit ID');}
    }
    await git(source, ['worktree', 'add', '-b', branch, target, start], repoUrl, credential);
  }
  let head = await git(target, ['rev-parse', 'HEAD'], repoUrl, credential);
  if (expectedCommit && head !== expectedCommit) throw new Error('The project baseline versions on the two devices differ; check the remote collaboration branch first');
  if(publishBaseline) {
    const remote=await git(target,['ls-remote','--heads','origin',`refs/heads/${branch}`],repoUrl,credential);
    if(!remote)await git(target,['push','origin',`${head}:refs/heads/${branch}`],repoUrl,credential);
    else if(remote.split(/\s+/)[0]!==head) {
      if(expectedCommit)throw new Error('The remote project collaboration branch has changed; verify the version again');
      await syncProjectBaseline({localRoot:target,branch,commit:remote.split(/\s+/)[0],repoUrl,credential});
      head=await git(target,['rev-parse','HEAD'],repoUrl,credential);
    }
    if((await git(target,['ls-remote','--heads','origin',`refs/heads/${branch}`],repoUrl,credential)).split(/\s+/)[0]!==head)
      throw new Error('The remote project collaboration branch is not confirmed');
  }
  return { localRoot: target, sourceRoot: source, baseBranch: selected, baseCommit:baseCommit || null, baselineBranch: branch,
    git: { head, branch, dirty: Boolean(await git(target, ['status', '--porcelain'], repoUrl, credential)) },published:publishBaseline };
}

/** Advance the local project branch only when the baseline is clean and the target commit is a descendant, to avoid overwriting changes in the original directory. */
export async function advanceProjectBaseline({ localRoot, branch, commit, expectedCommit, repoUrl, credential }) {
  if (!/^agentwb\/[a-f0-9-]{36}$/.test(branch || '') || !/^[a-f0-9]{40,64}$/.test(commit || '')) throw new Error('Invalid project baseline parameters');
  const root = await realpath(localRoot);
  if (await git(root, ['branch', '--show-current'], repoUrl, credential) !== branch) throw new Error('The current directory is not on the specified project baseline branch');
  const current = await git(root, ['rev-parse', 'HEAD'], repoUrl, credential);
  if (expectedCommit && current !== expectedCommit) throw new Error('The project baseline has changed; verify the version again');
  if (await git(root, ['status', '--porcelain'], repoUrl, credential)) throw new Error('The project baseline has uncommitted content and cannot be synced automatically');
  if (current !== commit) {
    try { await git(root, ['merge-base', '--is-ancestor', current, commit], repoUrl, credential); }
    catch { throw new Error('The project baseline cannot fast-forward to the target commit; a manual merge is needed'); }
    await git(root, ['merge', '--ff-only', commit], repoUrl, credential);
  }
  return { localRoot: root, branch, commit: await git(root, ['rev-parse', 'HEAD'], repoUrl, credential) };
}

/** Publish the committed run artifacts to the project collaboration branch; Git rejects non-fast-forwards, and then the source device baseline is advanced. */
export async function publishProjectBaseline({ localRoot, workingRoot, branch, commit, repoUrl, credential }) {
  const baseline = await realpath(localRoot), working = await realpath(workingRoot);
  if (await common(baseline, repoUrl, credential) !== await common(working, repoUrl, credential)) throw new Error('The run artifacts do not belong to the project baseline repository');
  if (identity(await git(working, ['remote', 'get-url', 'origin'], repoUrl, credential)) !== identity(repoUrl)) throw new Error('The project repository origin does not match');
  if (await git(working, ['rev-parse', 'HEAD'], repoUrl, credential) !== commit) throw new Error('The run artifact commit has changed');
  if (await git(working, ['status', '--porcelain', '--', '.', ':(exclude).workbench/**', ':(exclude).wb-bridge-*/**'], repoUrl, credential)) throw new Error('The run artifacts have uncommitted content');
  const current = await git(baseline, ['rev-parse', 'HEAD'], repoUrl, credential);
  if (await git(baseline, ['branch', '--show-current'], repoUrl, credential) !== branch) throw new Error('The current directory is not on the specified project baseline branch');
  if (await git(baseline, ['status', '--porcelain'], repoUrl, credential)) throw new Error('The project baseline has uncommitted content and cannot be synced automatically');
  try { await git(baseline, ['merge-base', '--is-ancestor', current, commit], repoUrl, credential); }
  catch { throw new Error('The run artifacts cannot fast-forward the project baseline; a manual merge is needed'); }
  await git(working, ['push', 'origin', `${commit}:refs/heads/${branch}`], repoUrl, credential);
  const remote = await git(working, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], repoUrl, credential);
  if (remote.split(/\s+/)[0] !== commit) throw new Error('The remote collaboration branch commit is not confirmed');
  await advanceProjectBaseline({localRoot:baseline,branch,commit,expectedCommit:current,repoUrl,credential});
  return {branch,commit};
}

/** The target device fetches only the pinned commit and fast-forwards its own project baseline worktree. */
export async function syncProjectBaseline({ localRoot, branch, commit, repoUrl, credential }) {
  const root = await realpath(localRoot);
  if (identity(await git(root, ['remote', 'get-url', 'origin'], repoUrl, credential)) !== identity(repoUrl)) throw new Error('The project repository origin does not match');
  await git(root, ['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], repoUrl, credential);
  const fetched = await git(root, ['rev-parse', `refs/remotes/origin/${branch}`], repoUrl, credential);
  if (commit && fetched !== commit) throw new Error('The remote collaboration branch does not match the delivery commit');
  return advanceProjectBaseline({localRoot:root,branch,commit:fetched,repoUrl,credential});
}
