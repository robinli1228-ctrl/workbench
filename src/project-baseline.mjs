import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gitCredentialEnv } from './hosting.mjs';
import { giteeRepository } from './repository.mjs';
import { within } from './project-space.mjs';
import { tr } from './i18n.mjs';

const exec = promisify(execFile);
const git = async (root, args, repoUrl, credential) => (await exec('git', args, {
  cwd: root, env: gitCredentialEnv(repoUrl, credential), timeout: 60000, maxBuffer: 1024 * 1024
})).stdout.trim();
const identity = url => { try { return giteeRepository(url)?.webUrl || url; } catch { return url; } };
const common = async (root, repoUrl, credential) => realpath(resolve(root, await git(root, ['rev-parse', '--git-common-dir'], repoUrl, credential)));

/** Every project has one long-lived baseline worktree per device; the source repository checkout is always left untouched. */
export async function prepareProjectBaseline({ projectId, projectRoot, sourceRoot, key, baseBranch, baseCommit, expectedCommit, publishBaseline = true, repoUrl, credential }) {
  if (!/^[a-f0-9-]{36}$/.test(projectId || '') || !/^[a-zA-Z0-9_-]{1,40}$/.test(key || '')) throw new Error(tr('projectBaseline.invalidProjectRepositoryIdentifier'));
  if (baseCommit && !/^[a-f0-9]{40,64}$/.test(baseCommit)) throw new Error(tr('projectBaseline.projectBaselineNeedsFullCommit'));
  const root = await realpath(projectRoot), source = await realpath(sourceRoot);
  if (!within(root, source) || await realpath(await git(source, ['rev-parse', '--show-toplevel'], repoUrl, credential)) !== source) throw new Error(tr('projectBaseline.sourceRepositoryNotIndependentGit'));
  if (identity(await git(source, ['remote', 'get-url', 'origin'], repoUrl, credential)) !== identity(repoUrl)) throw new Error(tr('projectBaseline.sourceRepositoryOriginDoesNot'));
  const branch = `agentwb/${projectId}`;
  const selected = baseBranch || await git(source, ['branch', '--show-current'], repoUrl, credential);
  if (!selected || selected.startsWith('-')) throw new Error(tr('projectBaseline.specifySourceBranchProjectBaseline'));
  await git(source, ['check-ref-format', '--branch', selected], repoUrl, credential);
  const parent = join(root, '.worktrees', 'project-baseline');
  await mkdir(parent, { recursive: true });
  if (!within(root, await realpath(parent))) throw new Error(tr('projectBaseline.projectBaselineDirectoryOutBounds'));
  const target = join(parent, key);
  let exists = false;
  try { exists = (await stat(target)).isDirectory(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (exists) {
    if (await realpath(target) !== target || await realpath(await git(target, ['rev-parse', '--show-toplevel'], repoUrl, credential)) !== target) throw new Error(tr('projectBaseline.existingProjectBaselineDirectoryDoes'));
    if (await common(source, repoUrl, credential) !== await common(target, repoUrl, credential)) throw new Error(tr('projectBaseline.projectBaselineDoesNotBelong'));
    if (await git(target, ['branch', '--show-current'], repoUrl, credential) !== branch) throw new Error(tr('projectBaseline.existingProjectBaselineBranchDoes'));
    if (expectedCommit && await git(target, ['rev-parse', 'HEAD'], repoUrl, credential) !== expectedCommit) {
      await syncProjectBaseline({localRoot:target,branch,commit:expectedCommit,repoUrl,credential});
    }
  } else {
    const remoteBranch = (await git(source, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], repoUrl, credential)) ? branch : selected;
    await git(source, ['fetch', '--no-tags', 'origin', `+refs/heads/${remoteBranch}:refs/remotes/origin/${remoteBranch}`], repoUrl, credential);
    const start = remoteBranch===branch ? `refs/remotes/origin/${remoteBranch}` : baseCommit || `refs/remotes/origin/${remoteBranch}`;
    if(baseCommit && remoteBranch!==branch) {
      try {await git(source,['merge-base','--is-ancestor',baseCommit,`refs/remotes/origin/${selected}`],repoUrl,credential);}
      catch {throw new Error(tr('projectBaseline.specifiedCommitDoesNotBelong'));}
    }
    await git(source, ['worktree', 'add', '-b', branch, target, start], repoUrl, credential);
  }
  let head = await git(target, ['rev-parse', 'HEAD'], repoUrl, credential);
  if (expectedCommit && head !== expectedCommit) throw new Error(tr('projectBaseline.projectBaselineVersionsOnTwo'));
  if(publishBaseline) {
    const remote=await git(target,['ls-remote','--heads','origin',`refs/heads/${branch}`],repoUrl,credential);
    if(!remote)await git(target,['push','origin',`${head}:refs/heads/${branch}`],repoUrl,credential);
    else if(remote.split(/\s+/)[0]!==head) {
      if(expectedCommit)throw new Error(tr('projectBaseline.remoteProjectCollaborationBranchHas'));
      await syncProjectBaseline({localRoot:target,branch,commit:remote.split(/\s+/)[0],repoUrl,credential});
      head=await git(target,['rev-parse','HEAD'],repoUrl,credential);
    }
    if((await git(target,['ls-remote','--heads','origin',`refs/heads/${branch}`],repoUrl,credential)).split(/\s+/)[0]!==head)
      throw new Error(tr('projectBaseline.remoteProjectCollaborationBranchNot'));
  }
  return { localRoot: target, sourceRoot: source, baseBranch: selected, baseCommit:baseCommit || null, baselineBranch: branch,
    git: { head, branch, dirty: Boolean(await git(target, ['status', '--porcelain'], repoUrl, credential)) },published:publishBaseline };
}

/** Advance the local project branch only when the baseline is clean and the target commit is a descendant, to avoid overwriting changes in the original directory. */
export async function advanceProjectBaseline({ localRoot, branch, commit, expectedCommit, repoUrl, credential }) {
  if (!/^agentwb\/[a-f0-9-]{36}$/.test(branch || '') || !/^[a-f0-9]{40,64}$/.test(commit || '')) throw new Error(tr('projectBaseline.invalidProjectBaselineParameters'));
  const root = await realpath(localRoot);
  if (await git(root, ['branch', '--show-current'], repoUrl, credential) !== branch) throw new Error(tr('projectBaseline.currentDirectoryNotOnSpecified'));
  const current = await git(root, ['rev-parse', 'HEAD'], repoUrl, credential);
  if (expectedCommit && current !== expectedCommit) throw new Error(tr('projectBaseline.projectBaselineHasChangedVerify'));
  if (await git(root, ['status', '--porcelain'], repoUrl, credential)) throw new Error(tr('projectBaseline.projectBaselineHasUncommittedContent'));
  if (current !== commit) {
    try { await git(root, ['merge-base', '--is-ancestor', current, commit], repoUrl, credential); }
    catch { throw new Error(tr('projectBaseline.projectBaselineCannotFastForward')); }
    await git(root, ['merge', '--ff-only', commit], repoUrl, credential);
  }
  return { localRoot: root, branch, commit: await git(root, ['rev-parse', 'HEAD'], repoUrl, credential) };
}

/** Publish the committed run artifacts to the project collaboration branch; Git rejects non-fast-forwards, and then the source device baseline is advanced. */
export async function publishProjectBaseline({ localRoot, workingRoot, branch, commit, repoUrl, credential }) {
  const baseline = await realpath(localRoot), working = await realpath(workingRoot);
  if (await common(baseline, repoUrl, credential) !== await common(working, repoUrl, credential)) throw new Error(tr('projectBaseline.runArtifactsDoNotBelong'));
  if (identity(await git(working, ['remote', 'get-url', 'origin'], repoUrl, credential)) !== identity(repoUrl)) throw new Error(tr('projectBaseline.projectRepositoryOriginDoesNot'));
  if (await git(working, ['rev-parse', 'HEAD'], repoUrl, credential) !== commit) throw new Error(tr('projectBaseline.runArtifactCommitHasChanged'));
  if (await git(working, ['status', '--porcelain', '--', '.', ':(exclude).workbench/**', ':(exclude).wb-bridge-*/**'], repoUrl, credential)) throw new Error(tr('projectBaseline.runArtifactsHaveUncommittedContent'));
  const current = await git(baseline, ['rev-parse', 'HEAD'], repoUrl, credential);
  if (await git(baseline, ['branch', '--show-current'], repoUrl, credential) !== branch) throw new Error(tr('projectBaseline.currentDirectoryNotOnSpecified2'));
  if (await git(baseline, ['status', '--porcelain'], repoUrl, credential)) throw new Error(tr('projectBaseline.projectBaselineHasUncommittedContent2'));
  try { await git(baseline, ['merge-base', '--is-ancestor', current, commit], repoUrl, credential); }
  catch { throw new Error(tr('projectBaseline.runArtifactsCannotFastForward')); }
  await git(working, ['push', 'origin', `${commit}:refs/heads/${branch}`], repoUrl, credential);
  const remote = await git(working, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], repoUrl, credential);
  if (remote.split(/\s+/)[0] !== commit) throw new Error(tr('projectBaseline.remoteCollaborationBranchCommitNot'));
  await advanceProjectBaseline({localRoot:baseline,branch,commit,expectedCommit:current,repoUrl,credential});
  return {branch,commit};
}

/** The target device fetches only the pinned commit and fast-forwards its own project baseline worktree. */
export async function syncProjectBaseline({ localRoot, branch, commit, repoUrl, credential }) {
  const root = await realpath(localRoot);
  if (identity(await git(root, ['remote', 'get-url', 'origin'], repoUrl, credential)) !== identity(repoUrl)) throw new Error(tr('projectBaseline.projectRepositoryOriginDoesNot2'));
  await git(root, ['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], repoUrl, credential);
  const fetched = await git(root, ['rev-parse', `refs/remotes/origin/${branch}`], repoUrl, credential);
  if (commit && fetched !== commit) throw new Error(tr('projectBaseline.remoteCollaborationBranchDoesNot'));
  return advanceProjectBaseline({localRoot:root,branch,commit:fetched,repoUrl,credential});
}
