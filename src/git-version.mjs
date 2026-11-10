import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { gitCredentialEnv } from './hosting.mjs';
import { tr } from './i18n.mjs';
import {gitPrintsAnything} from './git-changes.mjs';

const exec = promisify(execFile);

async function git(cwd, args, repoUrl, credential, timeout=10000) {
  return (await exec('git', args, {
    cwd,
    timeout,
    maxBuffer: 1024 * 1024,
    env: gitCredentialEnv(repoUrl, credential)
  })).stdout.trim();
}

/** Project versions are checked per repository and device; the supervisor device only affects the display order. */
export function selectGitVersionBindings(repositories, bindings, workers, supervisorNodeId) {
  const workerById = new Map(workers.map(worker => [worker.id, worker]));
  return repositories.flatMap(repository => {
    const candidates = bindings.filter(binding => binding.repositoryId === repository.id)
      .sort((a,b) => Number(b.nodeId === supervisorNodeId) - Number(a.nodeId === supervisorNodeId));
    return candidates.length ? candidates.map(binding => ({repository,binding,online:Boolean(workerById.get(binding.nodeId)?.online)}))
      : [{repository,binding:null,online:false}];
  });
}

/** The remote comparison only updates FETCH_HEAD; it does not pull, switch branches, or modify the working tree. */
export async function inspectGitRepositoryVersion({ localRoot, repoUrl, credential, targetBranch=null }) {
  // A unified branch compares every device with origin's copy of that branch, whatever branch each one has checked out.
  if (targetBranch) return inspectAgainstBranch({ localRoot, repoUrl, credential, targetBranch });
  const root = await realpath(localRoot);
  if (await realpath(await git(root, ['rev-parse','--show-toplevel'], repoUrl, credential)) !== root) throw new Error(tr('gitVersion.directoryNotIndependentGitRepository'));
  const branch = await git(root, ['symbolic-ref','--short','HEAD'], repoUrl, credential).catch(() => 'detached');
  const localCommit = await git(root, ['rev-parse','HEAD'], repoUrl, credential);
  // Platform folders (.workbench: shared reports, work materials, attachments) are not the repository's uncommitted work.
  const dirty = await gitPrintsAnything(root, ['status','--porcelain','--untracked-files=all','--','.',':(exclude).workbench',':(exclude).wb-bridge-*'], { env: gitCredentialEnv(repoUrl, credential), timeout: 10000 });
  if (branch === 'detached') return { branch, localCommit, remoteCommit:null, ahead:0, behind:0, status:'unknown', dirty, checkedAt:new Date().toISOString(), error:tr('gitVersion.repositoryInDetachedHeadState') };
  await git(root, ['check-ref-format','--branch',branch], repoUrl, credential);
  if(branch.startsWith('agentwb/')) {
    const published=await git(root,['ls-remote','--heads','origin',`refs/heads/${branch}`],repoUrl,credential).catch(()=>null);
    if(published==='')return {branch,localCommit,remoteCommit:null,ahead:0,behind:0,status:'unpublished',dirty,
      checkedAt:new Date().toISOString(),error:tr('gitVersion.projectCollaborationBranchHasNot')};
  }
  const remoteRef=`refs/remotes/origin/${branch}`;
  let stale=false,error=null,checkedAt;
  try {
    await git(root, ['fetch','--no-tags','--','origin',`+refs/heads/${branch}:${remoteRef}`], repoUrl, credential,8000);
    checkedAt=new Date().toISOString();
  } catch {
    stale=true;error=tr('gitVersion.remoteTemporarilyUnavailableUsingLocal');
    try {await git(root,['show-ref','--verify',remoteRef],repoUrl,credential);}
    catch {throw new Error(tr('gitVersion.remoteUnavailableThereNoLocal'));}
    const reflog=await git(root,['reflog','show','-1','--date=iso-strict','--format=%gD',remoteRef],repoUrl,credential).catch(()=>null);
    checkedAt=reflog?.match(/@\{(.+)\}$/)?.[1] || null;
  }
  const remoteCommit = await git(root, ['rev-parse',remoteRef], repoUrl, credential);
  const counts = (await git(root, ['rev-list','--left-right','--count',`HEAD...${remoteRef}`], repoUrl, credential)).split(/\s+/).map(Number);
  const ahead = counts[0] || 0, behind = counts[1] || 0;
  const status = ahead && behind ? 'diverged' : ahead ? 'ahead' : behind ? 'behind' : 'synced';
  return { branch, localCommit, remoteCommit, ahead, behind, status, dirty, checkedAt,stale,error };
}

/** The project card summarizes repository counts and commit differences; the sync time is the latest completion time among the repositories in this round. */
export function summarizeGitVersions(items) {
  const summary = { repositoryCount:new Set(items.map(item=>item.repositoryId || item.key)).size,
    deviceCount:new Set(items.map(item=>item.nodeId).filter(Boolean)).size,synced:0,ahead:0,behind:0,divergent:0,unknown:0,checkedAt:null };
  for (const item of items) {
    if (item.status === 'synced') summary.synced++;
    else if (item.status === 'diverged') summary.divergent++;
    else if (!['ahead','behind'].includes(item.status)) summary.unknown++;
    summary.ahead += Number(item.ahead) || 0;
    summary.behind += Number(item.behind) || 0;
    if (item.checkedAt && (!summary.checkedAt || item.checkedAt > summary.checkedAt)) summary.checkedAt = item.checkedAt;
  }
  return summary;
}

const validBranch = async (root, branch, repoUrl, credential) => {
  if (typeof branch !== 'string' || !branch || branch.length > 200 || branch.startsWith('-')) throw new Error(tr('gitVersion.invalidUnifiedBranch'));
  await git(root, ['check-ref-format', '--branch', branch], repoUrl, credential).catch(() => { throw new Error(tr('gitVersion.invalidUnifiedBranch')); });
};
async function repositoryRoot(localRoot, repoUrl, credential) {
  const root = await realpath(localRoot);
  if (await realpath(await git(root, ['rev-parse','--show-toplevel'], repoUrl, credential)) !== root) throw new Error(tr('gitVersion.directoryNotIndependentGitRepository'));
  return root;
}
async function fetchBranch(root, branch, repoUrl, credential) {
  const remoteRef = `refs/remotes/origin/${branch}`;
  try { await git(root, ['fetch','--no-tags','--','origin',`+refs/heads/${branch}:${remoteRef}`], repoUrl, credential, 15000); return { remoteRef, stale:false }; }
  catch {
    try { await git(root, ['show-ref','--verify',remoteRef], repoUrl, credential); } catch { throw new Error(tr('gitVersion.unifiedBranchUnavailable', { branch })); }
    return { remoteRef, stale:true };
  }
}
const uncommitted = (root, repoUrl, credential) => gitPrintsAnything(root, ['status','--porcelain','--untracked-files=all','--','.',':(exclude).workbench',':(exclude).wb-bridge-*'], { env: gitCredentialEnv(repoUrl, credential) });

/** Where one device stands against origin's copy of the unified branch; nothing in the working tree changes. */
async function inspectAgainstBranch({ localRoot, repoUrl, credential, targetBranch }) {
  const root = await repositoryRoot(localRoot, repoUrl, credential);
  await validBranch(root, targetBranch, repoUrl, credential);
  const head = await git(root, ['symbolic-ref','-q','--short','HEAD'], repoUrl, credential).catch(() => null), branch = head || 'detached';
  const localCommit = await git(root, ['rev-parse','HEAD'], repoUrl, credential), dirty = await uncommitted(root, repoUrl, credential);
  const { remoteRef, stale } = await fetchBranch(root, targetBranch, repoUrl, credential);
  const remoteCommit = await git(root, ['rev-parse',remoteRef], repoUrl, credential);
  const [ahead=0, behind=0] = (await git(root, ['rev-list','--left-right','--count',`HEAD...${remoteRef}`], repoUrl, credential)).split(/\s+/).map(Number);
  const status = ahead && behind ? 'diverged' : ahead ? 'ahead' : behind ? 'behind' : 'synced';
  return { branch, targetBranch, onTarget:head === targetBranch, localCommit, remoteCommit, ahead, behind, status, dirty, stale,
    checkedAt:new Date().toISOString(), error:stale ? tr('gitVersion.remoteTemporarilyUnavailableUsingLocal') : null };
}

/**
 * Bring one device to origin's copy of the unified branch, only in ways that lose nothing: fast-forward, or switch a clean
 * working tree to that branch when the user confirmed it. Uncommitted changes, unpushed commits, a diverged branch, commits
 * reachable only from a detached HEAD, or a remote that could not be reached stay as they are and are reported. Ignored
 * local files (such as .env) are never overwritten by a tracked file of the same name.
 */
export async function alignRepository({ localRoot, repoUrl, credential, branch, allowSwitch=false }) {
  const root = await repositoryRoot(localRoot, repoUrl, credential);
  await validBranch(root, branch, repoUrl, credential);
  const { remoteRef, stale } = await fetchBranch(root, branch, repoUrl, credential);
  const before = await git(root, ['rev-parse','HEAD'], repoUrl, credential);
  // An old local copy of the branch is not the unified version: a deleted or unreachable remote branch changes nothing.
  if (stale) return { status:'remote_unavailable', localCommit:before };
  if (await uncommitted(root, repoUrl, credential)) return { status:'dirty', localCommit:before };
  const current = await git(root, ['symbolic-ref','-q','--short','HEAD'], repoUrl, credential).catch(() => null);
  if (current !== branch) {
    if (!allowSwitch) return { status:'needs_switch', branch:current || 'detached', localCommit:before };
    // A detached HEAD whose commits no branch holds would leave them reachable only from the reflog.
    if (!current && !(await git(root, ['for-each-ref','--count=1','--contains','HEAD','--format=%(refname)','refs/heads','refs/remotes'], repoUrl, credential)))
      return { status:'detached_commits', localCommit:before };
    const local = await git(root, ['show-ref','--verify','-q',`refs/heads/${branch}`], repoUrl, credential).then(() => true, () => false);
    await git(root, local ? ['switch','--no-overwrite-ignore','--',branch] : ['switch','--no-overwrite-ignore','-c',branch,'--track',`origin/${branch}`], repoUrl, credential, 30000);
  }
  const [ahead=0, behind=0] = (await git(root, ['rev-list','--left-right','--count',`HEAD...${remoteRef}`], repoUrl, credential)).split(/\s+/).map(Number);
  const switched = current !== branch ? { switchedFrom:current || 'detached' } : {};
  if (ahead && behind) return { status:'diverged', ahead, behind, localCommit:await git(root, ['rev-parse','HEAD'], repoUrl, credential), ...switched };
  if (ahead) return { status:'ahead', ahead, localCommit:await git(root, ['rev-parse','HEAD'], repoUrl, credential), ...switched };
  if (behind) await git(root, ['merge','--ff-only','--no-overwrite-ignore',remoteRef], repoUrl, credential, 30000);
  const after = await git(root, ['rev-parse','HEAD'], repoUrl, credential);
  return { status:behind ? 'updated' : 'synced', from:before, localCommit:after, ...switched };
}
