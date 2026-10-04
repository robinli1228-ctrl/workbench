import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, realpath, cp, access } from 'node:fs/promises';
import { join } from 'node:path';
import { within } from './project-space.mjs';
import { tr } from './i18n.mjs';

const exec = promisify(execFile);
const git = async (root,args) => (await exec('git',args,{cwd:root,timeout:30000,maxBuffer:1024*1024})).stdout.trim();
const internal = [':(exclude).workbench',':(exclude).attachments',':(exclude).worktrees',':(exclude).wb-bridge-*'];

/** A bare SHA across devices does not mean delivered; when the object is missing, block explicitly before dispatch and never push on our own. */
export async function verifyExecutionVersions(repositories,versions) {
  for(const v of versions) {
    const repo=repositories.find(r=>r.id===v.id);
    if(!repo || !/^[a-f0-9]{40,64}$/.test(v.commit||'')) throw new Error(tr('executionWorkspace.invalidInputRepositoryPinnedVersion'));
    try { await git(repo.localRoot,['cat-file','-e',`${v.commit}^{commit}`]); }
    catch {throw new Error(tr('executionWorkspace.missingVersionDeliverItThrough', { key: repo.key, p2: v.commit.slice(0,12) }));}
  }
  return {ready:true};
}

/** Snapshots accept only complete Git repositories; uncommitted input cannot be silently replaced by a clean HEAD. */
export async function inspectExecutionRepositories(repositories) {
  const result=[];
  for (const repository of repositories) {
    const root=await realpath(repository.localRoot);
    try { await access(join(root,'.git')); } catch(e) {
      if(e.code!=='ENOENT') throw e;
      result.push({id:repository.id,key:repository.key,nonGit:true,dirty:true});continue;
    }
    if (await realpath(await git(root,['rev-parse','--show-toplevel'])) !== root) throw new Error(tr('executionWorkspace.notIndependentRepositoryRoot', { key: repository.key }));
    const commit=await git(root,['rev-parse','HEAD']);
    const dirty=Boolean(await git(root,['status','--porcelain','--untracked-files=all','--','.',...internal]));
    result.push({id:repository.id,key:repository.key,commit,dirty});
  }
  return result;
}

/** Each run creates an independent branch for every repository; the original directory and other roles' LATEST do not take part in writes. */
export async function prepareExecutionWorkspace(root,run,repositories) {
  const parent=join(root,'.worktrees'); await mkdir(parent,{recursive:true});
  if (!within(root,await realpath(parent))) throw new Error(tr('executionWorkspace.worktreeDirectoryOutBounds'));
  const folder=join(parent,`run-${run.id}`); await mkdir(folder,{recursive:false});
  const result=[];
  for (const repo of repositories) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(repo.key)) throw new Error(tr('executionWorkspace.invalidRepositoryIdentifier'));
    const commit=run.execution.baselines?.find(b=>b.id===repo.id)?.commit;
    if (!/^[a-f0-9]{40,64}$/.test(commit||'')) throw new Error(tr('executionWorkspace.hasNoPinnedVersion', { key: repo.key }));
    await git(repo.localRoot,['cat-file','-e',`${commit}^{commit}`]);
    for(const source of run.execution.inputs||[]) for(const v of source.versions||[]) {
      if(v.id===repo.id) await git(repo.localRoot,['cat-file','-e',`${v.commit}^{commit}`]);
    }
    const localRoot=join(folder,repo.key);
    await git(repo.localRoot,['worktree','add','-b',`agent/${run.id}`,localRoot,commit]);
    result.push({...repo,localRoot});
  }
  // Copy only existing local knowledge material; another run's live handoff is never written into the shared directory.
  const knowledge=join(root,'.workbench');
  await mkdir(join(folder,'.workbench'),{recursive:true});
  for(const name of ['INDEX.md','MEMORY.md','docs']) {
    try {await cp(join(knowledge,name),join(folder,'.workbench',name),{recursive:true,dereference:false});}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  return {folder,baseCommit:null,repositories:result};
}

/** Runs not approved by the supervisor keep using the project lock; isolated parallel runs share a device only with isolated runs of the same batch. */
export function executionConflict(candidate,active) {
  return active.some(other => {
    if (other.projectId!==candidate.projectId) return false;
    if (candidate.execution?.exclusive || other.execution?.exclusive) return true;
    if (candidate.nodeId!==other.nodeId) return false;
    return !(candidate.execution?.isolated && other.execution?.isolated && candidate.execution.batchId===other.execution.batchId);
  });
}
