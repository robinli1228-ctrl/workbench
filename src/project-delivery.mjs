import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { gitCredentialEnv } from './hosting.mjs';
import { giteeRepository } from './repository.mjs';
import { within } from './project-space.mjs';
import { publishProjectBaseline, syncProjectBaseline } from './project-baseline.mjs';

const exec = promisify(execFile);
const git = async (cwd,args,repo) => {
  try { return (await exec('git',args,{cwd,env:gitCredentialEnv(repo.repoUrl,repo.credential),timeout:60000,maxBuffer:1024*1024})).stdout.trim(); }
  catch { throw new Error(`Git operation failed for repository ${repo.key}; check the device credentials, network, or commit`); }
};

/** An unchanged repository gets its objects through the existing source branch; no delivery ref is created for a read-only repository. */
async function unchangedVersion(repo,item) {
  if(!repo.baseBranch)throw new Error('The unchanged repository has no baseline source branch');
  await git(repo.localRoot,['fetch','--no-tags','origin',`+refs/heads/${repo.baseBranch}:refs/remotes/origin/${repo.baseBranch}`],repo);
  await git(repo.localRoot,['cat-file','-e',`${item.commit}^{commit}`],repo);
  await git(repo.localRoot,['merge-base','--is-ancestor',item.commit,`refs/remotes/origin/${repo.baseBranch}`],repo);
}

/** An approved delivery only fetches the pinned ref into the local object store; it does not switch the original branch or overwrite the working directory. */
export async function fetchExecutionDeliveries(repositories, deliveries) {
  for(const delivery of deliveries) {
    if(delivery.status!=='ready'||!delivery.approvedAt||!/^refs\/heads\/agent-delivery\/[a-f0-9]{32}$/.test(delivery.ref))throw new Error('Only approved and published Git deliveries can be received');
    for(const item of delivery.items||[]) {
      const repo=repositories.find(r=>r.id===item.id);if(!repo)continue;
      if(repo.repoUrl!==item.repoUrl||!/^[a-f0-9]{40,64}$/.test(item.commit))throw new Error('The delivery does not match the project repository');
      if(giteeRepository(await git(repo.localRoot,['config','--get','remote.origin.url'],repo))?.webUrl!==giteeRepository(repo.repoUrl).webUrl)throw new Error('The receiving repository origin does not match');
      if(item.changed===false && repo.baselineRoot)await unchangedVersion(repo,item);
      else {
        await git(repo.localRoot,['fetch','--no-tags','origin',delivery.ref],repo);
        if(await git(repo.localRoot,['rev-parse','FETCH_HEAD'],repo)!==item.commit)throw new Error('The received commit does not match');
      }
      if(repo.baselineRoot && item.changed!==false)await syncProjectBaseline({localRoot:repo.baselineRoot,branch:repo.baselineBranch,
        commit:item.commit,repoUrl:repo.repoUrl,credential:repo.credential});
    }
  }
  return {received:true};
}

/** A project delivery is published at an explicit SHA per repository; the user's current branch is never switched. */
export async function publishProjectDelivery(repositories, delivery) {
  for (const item of delivery.items) {
    const repo = repositories.find(r=>r.id===item.id);
    if (!repo?.localRoot || repo.repoUrl !== item.repoUrl) throw new Error('The delivery repository configuration has changed');
    const cwd = repo.localRoot;
    if (giteeRepository(await git(cwd,['config','--get','remote.origin.url'],repo))?.webUrl !== giteeRepository(repo.repoUrl).webUrl) throw new Error('The repository origin does not match the delivery');
    const pushUrl=await git(cwd,['config','--get','remote.origin.pushurl'],repo).catch(()=>null);
    if(pushUrl && giteeRepository(pushUrl)?.webUrl !== giteeRepository(repo.repoUrl).webUrl)throw new Error('The push URL does not match the delivery repository');
    if (await git(cwd,['rev-parse','HEAD'],repo) !== item.commit) throw new Error('The repository commit changed after delivery; deliver again');
    const dirty = await git(cwd,['status','--porcelain','--','.',':(exclude).workbench/**',':(exclude).wb-bridge-*/**',':(exclude).agent-workbench-project.json'],repo);
    if (dirty) throw new Error('The repository has uncommitted changes; commit them before delivering');
    if(item.changed===false && repo.baselineRoot)await unchangedVersion(repo,item);
    else {
      const existing = await git(cwd,['ls-remote','origin',delivery.ref],repo);
      if (existing && existing.split(/\s/)[0] !== item.commit) throw new Error('The delivery branch already contains another commit');
      if (!existing) await git(cwd,['push','origin',`${item.commit}:${delivery.ref}`],repo);
      if ((await git(cwd,['ls-remote','origin',delivery.ref],repo)).split(/\s/)[0] !== item.commit) throw new Error('The remote delivery version is not confirmed');
    }
    if(repo.baselineRoot && item.changed!==false)await publishProjectBaseline({localRoot:repo.baselineRoot,workingRoot:cwd,branch:repo.baselineBranch,
      commit:item.commit,repoUrl:repo.repoUrl,credential:repo.credential});
  }
  return { status:'ready', commit:delivery.commit, ref:delivery.ref };
}

/** The receiver builds the complete repository set of this delivery inside the project and confirms each pinned commit one by one. */
export async function receiveProjectDelivery(root, runId, repositories, delivery) {
  if (!Array.isArray(delivery.items) || delivery.items.length !== repositories.length || new Set(delivery.items.map(r=>r.id)).size !== repositories.length) throw new Error('The project repository set has changed; deliver all repositories again');
  if (!/^[a-f0-9-]{36}$/.test(runId) || !/^refs\/heads\/agent-delivery\/[a-f0-9]{32}$/.test(delivery.ref)) throw new Error('Invalid delivery parameters');
  const parent = join(root,'.worktrees'); await mkdir(parent,{recursive:true});
  if (!within(await realpath(root),await realpath(parent))) throw new Error('The delivery directory is out of bounds');
  const folder = join(parent,`run-${runId}`); await mkdir(folder);
  const checked = [];
  for (const item of delivery.items) {
    const repo = repositories.find(r=>r.id===item.id);
    if (!repo?.localRoot || repo.repoUrl !== item.repoUrl || !/^[a-zA-Z0-9_-]+$/.test(repo.key)) throw new Error('The receiving device lacks the project repository');
    if(giteeRepository(await git(repo.localRoot,['config','--get','remote.origin.url'],repo))?.webUrl !== giteeRepository(repo.repoUrl).webUrl)throw new Error('The receiving repository origin does not match');
    if(item.changed===false && repo.baselineRoot)await unchangedVersion(repo,item);
    else {
      await git(repo.localRoot,['fetch','--no-tags','origin',delivery.ref],repo);
      if (await git(repo.localRoot,['rev-parse','FETCH_HEAD'],repo) !== item.commit) throw new Error('The received commit does not match the delivery record');
    }
    if(repo.baselineRoot && item.changed!==false)await syncProjectBaseline({localRoot:repo.baselineRoot,branch:repo.baselineBranch,
      commit:item.commit,repoUrl:repo.repoUrl,credential:repo.credential});
    const target = join(folder,repo.key);
    await git(repo.localRoot,['worktree','add','--detach',target,item.commit],repo);
    const {credential,...publicRepo} = repo;
    checked.push({...publicRepo,localRoot:target});
  }
  return {folder,baseCommit:delivery.commit,repositories:checked};
}
