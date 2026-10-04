import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { gitCredentialEnv } from './hosting.mjs';
import { tr } from './i18n.mjs';

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
export async function inspectGitRepositoryVersion({ localRoot, repoUrl, credential }) {
  const root = await realpath(localRoot);
  if (await realpath(await git(root, ['rev-parse','--show-toplevel'], repoUrl, credential)) !== root) throw new Error(tr('gitVersion.directoryNotIndependentGitRepository'));
  const branch = await git(root, ['symbolic-ref','--short','HEAD'], repoUrl, credential).catch(() => 'detached');
  const localCommit = await git(root, ['rev-parse','HEAD'], repoUrl, credential);
  const dirty = Boolean(await git(root, ['status','--porcelain','--untracked-files=all'], repoUrl, credential));
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
