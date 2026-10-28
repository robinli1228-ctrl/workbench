import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, realpath, cp, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { within } from './project-space.mjs';
import { tr } from './i18n.mjs';

const exec = promisify(execFile);
const git = async (root,args) => (await exec('git',args,{cwd:root,timeout:30000,maxBuffer:1024*1024,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}})).stdout.trim();
const internal = [':(exclude).workbench',':(exclude).attachments',':(exclude).worktrees',':(exclude).wb-bridge-*'];

/** Resolve a worktree's owning repository, not an enclosing repository inherited by a plain subdirectory. */
async function repositoryIdentity(root) {
  try {
    if(await realpath(await git(root,['rev-parse','--show-toplevel']))!==root)return null;
    return await realpath(resolve(root,await git(root,['rev-parse','--git-common-dir'])));
  } catch {return null;}
}

/** Native resume preserves cwd; repair its repository mapping without silently selecting the newer bound copy. */
export async function resolveExecutionRepositories({workspace,projectRoot,repositories=[],previousRepositories=[],resuming=false}) {
  if(!resuming)return repositories;
  const folder=await realpath(workspace),root=await realpath(projectRoot);
  if(folder===root)return Promise.all(repositories.map(async repo=>{
    const previous=previousRepositories.find(item=>item.id===repo.id);
    return previous?.localRoot?{...repo,localRoot:await realpath(previous.localRoot)}:repo;
  }));
  const result=[];
  for(const repo of repositories) {
    if(!repo.localRoot){result.push(repo);continue;}
    if(!/^[a-zA-Z0-9_-]{1,64}$/.test(repo.key))throw new Error(tr('executionWorkspace.invalidRepositoryIdentifier'));
    const previous=previousRepositories.find(item=>item.id===repo.id);
    const bound=await realpath(repo.localRoot),identity=await repositoryIdentity(previous?.localRoot?await realpath(previous.localRoot):bound);
    let actual;
    const child=join(folder,repo.key);
    for(const candidate of [...(repositories.length===1&&identity?[folder]:[]),child]) {
      let canonical;
      try {canonical=await realpath(candidate);}catch(error){if(error.code==='ENOENT')continue;throw error;}
      if(!within(folder,canonical))throw new Error(tr('executionWorkspace.resumeRepositoryIdentityMismatch',{key:repo.key}));
      if(await repositoryIdentity(canonical)===identity){actual=canonical;break;}
      if(candidate===child)throw new Error(tr('executionWorkspace.resumeRepositoryIdentityMismatch',{key:repo.key}));
    }
    if(!actual) {
      // Explicit external mappings survive; a missing old in-workspace copy must not fall back to the project binding.
      if(previous?.localRoot&&!within(root,await realpath(previous.localRoot))) {
        actual=await realpath(previous.localRoot);
        if(await repositoryIdentity(actual)!==identity)throw new Error(tr('executionWorkspace.resumeRepositoryIdentityMismatch',{key:repo.key}));
      }
    }
    if(!actual)throw new Error(tr('executionWorkspace.resumeRepositoryMissing',{key:repo.key}));
    result.push({...repo,localRoot:actual});
  }
  return result;
}

/** One local startup snapshot; bound HEAD is a comparison, never a replacement for the actual execution version. */
export async function inspectExecutionInput(repositories,boundRepositories=[],baselines=[]) {
  const inspected=await inspectExecutionRepositories(repositories.filter(repo=>repo.localRoot)),result=[];
  for(const repo of repositories) {
    const value=inspected.find(item=>item.id===repo.id),binding=boundRepositories.find(item=>item.id===repo.id);
    const localRoot=repo.localRoot?await realpath(repo.localRoot):null;
    const boundRoot=binding?.localRoot?await realpath(binding.localRoot):null;
    const boundCommit=boundRoot===localRoot?value?.commit||null:boundRoot?await git(boundRoot,['rev-parse','HEAD']).catch(()=>null):null;
    result.push({id:repo.id,key:repo.key,...value,localRoot,commit:value?.commit||null,dirty:value?.dirty??null,
      ...(!localRoot?{unavailable:true}:{}),boundCommit,expectedCommit:baselines.find(item=>item.id===repo.id)?.commit||null});
  }
  return result;
}

/** Fixed-version mismatches block before CLI input; ordinary retained sessions are disclosed, not rewritten. */
export function assertExecutionInputVersions(versions,baselines=[]) {
  for(const baseline of baselines) {
    const actual=versions.find(item=>item.id===baseline.id);
    if(!/^[a-f0-9]{40,64}$/.test(baseline.commit||'')||actual?.commit!==baseline.commit)
      throw new Error(tr('executionWorkspace.inputVersionMismatch',{key:baseline.key||baseline.id,expected:baseline.commit||'unknown',actual:actual?.commit||'unknown'}));
  }
}

/** A continuation of an authorized writing stage may already have committed its output; read-only stages cannot redefine their pinned input. */
export function executionInputBaselines(run,continued) {
  return (run.execution?.baselines||[]).map(baseline=>{
    const output=continued?.repositoryVersions?.find(item=>item.id===baseline.id);
    return output&&(run.execution?.writeRepositories||[]).includes(baseline.key)?{...baseline,commit:output.commit}:baseline;
  });
}

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
  for(const name of ['docs']) {
    try {await cp(join(knowledge,name),join(folder,'.workbench',name),{recursive:true,dereference:false});}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  // Read-only snapshot of the project's AGENTS.md / CLAUDE.md so every CLI loads it natively; edits belong in the project root.
  for(const name of ['AGENTS.md','CLAUDE.md']) {
    try {await cp(join(root,name),join(folder,name),{dereference:false,force:false,errorOnExist:false});}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  return {folder,baseCommit:null,repositories:result};
}

/**
 * Runs not approved by the supervisor keep using the project lock; isolated parallel runs share a device only with isolated runs of the same batch.
 * With the project's concurrent-writes switch on, a pair that includes an ordinary chat run (one outside any plan stage) may overlap,
 * exclusive stages included; two plan stages keep their rules.
 */
export function executionConflict(candidate,active,{concurrent=false}={}) {
  return active.some(other => {
    if (other.projectId!==candidate.projectId) return false;
    if (concurrent && (!candidate.execution || !other.execution)) return false;
    if (candidate.execution?.exclusive || other.execution?.exclusive) return true;
    if (candidate.nodeId!==other.nodeId) return false;
    return !(candidate.execution?.isolated && other.execution?.isolated && candidate.execution.batchId===other.execution.batchId);
  });
}
