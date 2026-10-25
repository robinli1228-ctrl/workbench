import {execFile} from 'node:child_process';
import {constants as fsConstants} from 'node:fs';
import {createHash} from 'node:crypto';
import {lstat,open,realpath} from 'node:fs/promises';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';
import {promisify,TextDecoder} from 'node:util';
import {artifactCandidates} from './run-artifacts.mjs';

const execute=promisify(execFile),MAX_BYTES=600000,GIT_TIMEOUT=5000,GIT_BUFFER=700000;
const decoder=new TextDecoder('utf-8',{fatal:true});
const gitEnv={...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'};

const denied=reason=>new Error(`artifact_source_${reason}`);
const within=(root,path)=>{const rel=relative(root,path);return Boolean(rel)&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`);};
const commitHash=value=>typeof value==='string'&&/^[a-f0-9]{40,64}$/.test(value)?value:null;

async function gitText(root,args) {
  const {stdout}=await execute('git',args,{cwd:root,timeout:GIT_TIMEOUT,maxBuffer:GIT_BUFFER,encoding:'utf8',env:gitEnv});
  return stdout.trim();
}

async function gitBytes(root,args) {
  const {stdout}=await execute('git',args,{cwd:root,timeout:GIT_TIMEOUT,maxBuffer:GIT_BUFFER,encoding:'buffer',env:gitEnv});
  return Buffer.from(stdout);
}

function sensitiveName(name) {
  const lower=name.toLowerCase();
  return lower==='.env'||lower.startsWith('.env.')||
    /(^|[._-])env([._-]|$)/.test(lower)||
    /(^|[._-])(credentials?|secrets?)([._-]|$)/.test(lower)||
    /(^|[._-])private[._-]?key([._-]|$)/.test(lower)||
    /^tokens?(\.|$)/.test(lower)||/^(?:api|worker|access|refresh)[-_]token(?:\.|$)/.test(lower)||
    /^(?:auth(?:-profiles)?|worker-config)\.json$/.test(lower)||
    /^(?:home|worker)(?:[-_.].*)?\.(?:sqlite|db)(?:[-.].*)?$/.test(lower)||
    /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(lower)||/\.(?:key|pem|p12|pfx)$/.test(lower);
}

function validateRelativePath(rel) {
  const parts=rel.split(sep);
  if(parts.length===0||parts.some(part=>!part||part==='.'||part==='..'||/[\0-\x1f\x7f]/.test(part)||sensitiveName(part)))throw denied('path_not_accessible');
  if(parts[0]==='.worktrees') {
    if(parts.length<3||parts[1].startsWith('.'))throw denied('path_not_accessible');
  }
  for(let index=0;index<parts.length;index++) {
    const part=parts[index];
    if(!part.startsWith('.'))continue;
    if(part==='.worktrees'&&index===0)continue;
    if(part==='.workbench'&&parts[index+1]==='docs'&&index+2<parts.length)continue;
    throw denied('path_not_accessible');
  }
  return parts;
}

async function inspectPath(root,absolute,rel) {
  let current=root,final;
  for(const part of rel.split(sep)) {
    current=join(current,part);
    let info;
    try { info=await lstat(current,{bigint:true}); } catch { throw denied('file_unavailable'); }
    if(info.isSymbolicLink())throw denied('symlink_not_allowed');
    final=info;
  }
  if(!final?.isFile())throw denied('not_regular_file');
  if(final.size>BigInt(MAX_BYTES))throw denied('file_too_large');
  let canonical;
  try { canonical=await realpath(absolute); } catch { throw denied('file_unavailable'); }
  if(canonical!==absolute||!within(root,canonical))throw denied('path_not_accessible');
  return final;
}

async function gitIdentity(path) {
  try {
    const top=await realpath(await gitText(path,['rev-parse','--show-toplevel']));
    const common=await realpath(resolve(top,await gitText(top,['rev-parse','--git-common-dir'])));
    return {top,common,head:commitHash(await gitText(top,['rev-parse','HEAD']))};
  } catch { return null; }
}

async function registeredRepositories(run) {
  const result=[];
  for(const repository of run.repositories||[]) {
    if(!repository?.id||typeof repository.localRoot!=='string')continue;
    let root;
    try { root=await realpath(repository.localRoot); } catch { continue; }
    const identity=await gitIdentity(root);
    if(identity?.top===root)result.push({...repository,root,...identity});
  }
  return result;
}

async function sourceRepository(run,root,absolute,parts) {
  const registered=await registeredRepositories(run);
  if(parts[0]==='.worktrees') {
    const worktreeRoot=join(root,parts[0],parts[1]),identity=await gitIdentity(worktreeRoot);
    if(!identity||identity.top!==worktreeRoot||!within(worktreeRoot,absolute))throw denied('worktree_not_registered');
    const repository=registered.find(item=>item.common===identity.common);
    if(!repository)throw denied('worktree_not_registered');
    return {repository,identity,gitPath:relative(identity.top,absolute)};
  }
  const repository=registered.filter(item=>within(item.root,absolute)).sort((a,b)=>b.root.length-a.root.length)[0]||null;
  if(!repository)return {repository:null,identity:null,gitPath:null};
  return {repository,identity:{top:repository.top,common:repository.common,head:commitHash(await gitText(repository.top,['rev-parse','HEAD']).catch(()=>''))},gitPath:relative(repository.top,absolute)};
}

function recordedVersion(run,repository) {
  if(!repository)return null;
  const recorded=(run.repositoryVersions||[]).find(item=>item?.id===repository.id);
  if(!recorded||recorded.dirty!==false)return null;
  const commit=commitHash(recorded.commit);
  if(!commit)throw denied('recorded_commit_invalid');
  return commit;
}

function sameStat(left,right) {
  return left.dev===right.dev&&left.ino===right.ino&&left.mode===right.mode&&left.size===right.size&&left.mtimeNs===right.mtimeNs&&left.ctimeNs===right.ctimeNs;
}

function textContent(bytes) {
  if(bytes.includes(0))throw denied('binary_file');
  try { return decoder.decode(bytes); } catch { throw denied('binary_file'); }
}

async function stableWorkspaceRead(root,absolute,rel,identity) {
  const pathBefore=await inspectPath(root,absolute,rel);
  const headBefore=identity?commitHash(await gitText(identity.top,['rev-parse','HEAD']).catch(()=>'')):null;
  if(identity&&!headBefore)throw denied('repository_unavailable');
  let handle,before,after,bytes;
  try {
    handle=await open(absolute,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);
    before=await handle.stat({bigint:true});
    if(!before.isFile())throw denied('not_regular_file');
    if(before.size>BigInt(MAX_BYTES))throw denied('file_too_large');
    if(!sameStat(pathBefore,before))throw denied('file_changed');
    const buffer=Buffer.allocUnsafe(MAX_BYTES+1);let bytesRead=0;
    while(bytesRead<buffer.length) {
      const chunk=await handle.read(buffer,bytesRead,buffer.length-bytesRead,bytesRead);
      if(chunk.bytesRead===0)break;
      bytesRead+=chunk.bytesRead;
    }
    bytes=buffer.subarray(0,bytesRead);
    after=await handle.stat({bigint:true});
  } catch(error) {
    if(error.message?.startsWith('artifact_source_'))throw error;
    throw denied('file_unavailable');
  } finally { await handle?.close().catch(()=>{}); }
  if(bytes.length>MAX_BYTES)throw denied('file_too_large');
  if(BigInt(bytes.length)!==before.size)throw denied('file_changed');
  if(!sameStat(before,after))throw denied('file_changed');
  const pathAfter=await inspectPath(root,absolute,rel);
  if(!sameStat(after,pathAfter))throw denied('file_changed');
  const headAfter=identity?commitHash(await gitText(identity.top,['rev-parse','HEAD']).catch(()=>'')):null;
  if(identity&&headBefore!==headAfter)throw denied('repository_changed');
  const identityAfter=identity?await gitIdentity(identity.top):null;
  if(identity&&(!identityAfter||identityAfter.top!==identity.top||identityAfter.common!==identity.common))throw denied('repository_changed');
  return {bytes,modifiedAt:new Date(Number(before.mtimeNs/1000000n)).toISOString(),sourceCommit:headBefore};
}

async function recordedBlobRead(root,absolute,rel,identity,commit,gitPath) {
  const before=await inspectPath(root,absolute,rel);
  try { await gitText(identity.top,['cat-file','-e',`${commit}^{commit}`]); }
  catch { throw denied('recorded_commit_unavailable'); }
  let type;
  try { type=await gitText(identity.top,['cat-file','-t',`${commit}:${gitPath}`]); }
  catch { return null; }
  if(type!=='blob')throw denied('not_regular_file');
  const treeEntry=await gitText(identity.top,['ls-tree',commit,'--',gitPath]).catch(()=>null);
  if(!treeEntry?.startsWith('100'))throw denied('not_regular_file');
  const size=Number(await gitText(identity.top,['cat-file','-s',`${commit}:${gitPath}`]).catch(()=>NaN));
  if(!Number.isSafeInteger(size)||size<0)throw denied('recorded_blob_unavailable');
  if(size>MAX_BYTES)throw denied('file_too_large');
  let bytes;
  try { bytes=await gitBytes(identity.top,['cat-file','blob',`${commit}:${gitPath}`]); }
  catch { throw denied('recorded_blob_unavailable'); }
  if(bytes.length!==size)throw denied('recorded_blob_changed');
  const after=await lstat(absolute,{bigint:true}).catch(()=>null);
  if(!after||!sameStat(before,after))throw denied('file_changed');
  const pathAfter=await inspectPath(root,absolute,rel);
  if(!sameStat(after,pathAfter))throw denied('file_changed');
  const identityAfter=await gitIdentity(identity.top);
  if(!identityAfter||identityAfter.top!==identity.top||identityAfter.common!==identity.common)throw denied('repository_changed');
  const modifiedAt=await gitText(identity.top,['show','-s','--format=%cI',commit]).catch(()=>null);
  return {bytes,modifiedAt:modifiedAt||null,sourceCommit:commit};
}

/** Read only an artifact path evidenced by this Run, preserving the original repository/version boundary. */
export async function readRecordedArtifact(run,path,{events=[],homeRecordedPath=null,metadata=false,expectedHash=null,expectedCommit=null}={}) {
  if(!run?.workspace||typeof path!=='string'||!path||path.length>4096||path.includes('\0')||/[\r\n]/.test(path))throw denied('invalid_request');
  if(path.split(/[\\/]/).some(part=>part==='.'||part==='..'))throw denied('path_not_accessible');
  let root;
  try { root=await realpath(run.workspace); } catch { throw denied('workspace_unavailable'); }
  const requested=resolve(root,path),rel=relative(root,requested);
  if(!within(root,requested))throw denied('path_not_accessible');
  const candidates=new Set(artifactCandidates(run,events,[]).map(item=>resolve(root,item.path)));
  // This single path is supplied only by authenticated Home after checking its retained original Run evidence.
  // It is not a browser-provided grant, and never relaxes the filesystem/repository checks below.
  if(typeof homeRecordedPath==='string'&&homeRecordedPath.length<=4096&&isAbsolute(homeRecordedPath)&&homeRecordedPath===requested)candidates.add(requested);
  if(!candidates.has(requested))throw denied('path_not_recorded');
  const parts=validateRelativePath(rel);
  await inspectPath(root,requested,rel);
  const source=await sourceRepository(run,root,requested,parts);
  const managedIndex=parts.indexOf('.workbench');
  if(managedIndex>=0&&managedIndex!==0&&source.gitPath?.split(sep)[0]!=='.workbench')throw denied('path_not_accessible');
  const version=recordedVersion(run,source.repository);
  let read=version&&source.identity&&source.gitPath?await recordedBlobRead(root,requested,rel,source.identity,version,source.gitPath):null;
  let versionEvidence='recorded_commit';
  if(!read) { read=await stableWorkspaceRead(root,requested,rel,source.identity);versionEvidence='workspace_snapshot'; }
  const content=textContent(read.bytes),sha256=createHash('sha256').update(read.bytes).digest('hex');
  if(expectedHash!==null&&(typeof expectedHash!=='string'||expectedHash!==sha256))throw denied('hash_changed');
  if(expectedCommit!==null&&(typeof expectedCommit!=='string'||expectedCommit!==read.sourceCommit))throw denied('commit_changed');
  return {path:requested,content:metadata?null:content,size:read.bytes.length,modifiedAt:read.modifiedAt,sha256,
    sourceCommit:read.sourceCommit||null,versionEvidence,readMode:'recorded'};
}
