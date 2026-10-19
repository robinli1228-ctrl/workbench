import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run=promisify(execFile);
const STATUS_BYTES=1024*1024;
// Conflict codes from `git status --porcelain=v1`; everything else splits into index (X) and work-tree (Y) changes.
const CONFLICTS=new Set(['DD','AU','UD','UA','DU','AA','UU']);

/**
 * Read-only, offline Git facts for one working folder that the caller already validated against its allowed roots:
 * repository root, branch, HEAD commit, the configured upstream with ahead/behind from local refs, and a change summary.
 * Never fetches, never contacts a remote, and GIT_OPTIONAL_LOCKS=0 keeps `git status` from rewriting the index.
 */
export async function inspectWorkspaceGit(dir,{timeout=3000,exec=run,clock=()=>new Date(),authorizeRoot=async()=>{}}={}) {
  // Repository fsmonitor hooks and promisor-object fetches are not part of a read-only sidebar observation.
  const env={...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0',LC_ALL:'C'};
  const git=async(args,options={})=>(await exec('git',['-c','core.fsmonitor=false','-C',dir,...args],{timeout,maxBuffer:64*1024,env,...options})).stdout;
  const checkedAt=clock().toISOString();
  let root;
  try{root=(await git(['rev-parse','--show-toplevel'])).trim();}
  catch(error){
    // Not a repository is a normal answer; a missing git binary or refused repository is reported as unavailable.
    if(error.code==='ENOENT')return {git:false,reason:'git_unavailable',checkedAt};
    return {git:false,reason:/not a git repository/i.test(String(error.stderr||error.message))?'not_git':'git_unavailable',detail:String(error.stderr||error.message).trim().slice(0,300),checkedAt};
  }
  // Git can discover a parent repository outside a grant for a child directory. Do not read its facts without authority.
  await authorizeRoot(root);
  const optional=async args=>{try{return (await git(args)).trim();}catch{return null;}};
  const commit=await optional(['rev-parse','HEAD']);
  const branch=await optional(['symbolic-ref','--quiet','--short','HEAD']);
  const subject=commit?await optional(['log','-1','--format=%s']):null;
  const upstream=commit?await optional(['rev-parse','--abbrev-ref','--symbolic-full-name','@{upstream}']):null;
  let ahead=null,behind=null;
  if(upstream){const counts=await optional(['rev-list','--left-right','--count','@{upstream}...HEAD']);const m=/^(\d+)\s+(\d+)$/.exec(counts||'');if(m){behind=Number(m[1]);ahead=Number(m[2]);}}
  let changes;
  try{
    const out=await git(['status','--porcelain=v1','-z','--untracked-files=normal','--ignore-submodules=dirty'],{maxBuffer:STATUS_BYTES});
    changes=summarize(out);
  }catch(error){
    changes=error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER'?{...summarize(String(error.stdout||'')),truncated:true}:{unknown:true,reason:error.killed?'git_timeout':'git_status_failed'};
  }
  return {git:true,root,branch,detached:!branch,commit,subject:subject?subject.slice(0,200):null,upstream,ahead,behind,changes,checkedAt};
}

/** Count porcelain v1 -z entries; a rename or copy entry carries its source path as the next field. */
export function summarize(out) {
  const fields=out.split('\0');const counts={staged:0,modified:0,untracked:0,conflicted:0,total:0,truncated:false};
  for(let i=0;i<fields.length;i++){
    const entry=fields[i];if(entry.length<4)continue;
    const code=entry.slice(0,2),x=code[0],y=code[1];counts.total++;
    if(code==='??')counts.untracked++;
    else if(CONFLICTS.has(code))counts.conflicted++;
    else{if(x!==' ')counts.staged++;if(y!==' ')counts.modified++;}
    if(x==='R'||x==='C')i++;
  }
  return counts;
}
