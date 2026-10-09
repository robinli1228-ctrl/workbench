import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {constants} from 'node:fs';
import {mkdir,lstat,realpath,open,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {SOURCE_SYNC_LIMITS,SOURCE_SYNC_CAPTURE_POLICY,contentHash,syncError,excludedSourcePath,validateSourcePath,manifestDigest,entryEqual} from './source-sync-manifest.mjs';

const exec=promisify(execFile);
const git=async(root,args,encoding='utf8')=>(await exec('git',args,{cwd:root,encoding,timeout:30000,maxBuffer:24*1024*1024})).stdout;
const exists=async path=>{try{return await lstat(path);}catch(e){if(e.code==='ENOENT')return null;throw e;}};

/** Walk components, not just the final path: parent links and nested repositories are not source roots. */
export async function sourceFilePath(root,path,{createParents=false}={}) {
  validateSourcePath(path);const canonical=await realpath(root);let current=canonical;
  const parts=path.split('/');
  for(let i=0;i<parts.length;i++){
    current=join(current,parts[i]);let info=await exists(current);
    if(!info&&i<parts.length-1&&createParents){await mkdir(current,{mode:0o755}).catch(e=>{if(e.code!=='EEXIST')throw e;});info=await exists(current);}
    if(!info){if(i<parts.length-1)return {path:current,missing:true};return {path:current,missing:true};}
    if(info.isSymbolicLink()||i<parts.length-1&&!info.isDirectory()||i===parts.length-1&&(!info.isFile()||info.nlink!==1))throw syncError('unsafe_file',path);
    if(i<parts.length-1&&await exists(join(current,'.git')))throw syncError('nested_repository',path);
  }
  return {path:current,missing:false};
}

/** Capture stable bytes from a no-follow descriptor; never infer stability from mtime alone. */
export async function readSourceFile(root,path) {
  for(let attempt=0;attempt<2;attempt++){
    const checked=await sourceFilePath(root,path);if(checked.missing)return {entry:null,bytes:null};
    let file;
    try {
      file=await open(checked.path,constants.O_RDONLY|constants.O_NOFOLLOW);
      const before=await file.stat();if(!before.isFile()||before.nlink!==1)throw syncError('unsafe_file',path);
      if(before.size>SOURCE_SYNC_LIMITS.fileBytes)throw syncError('file_too_large',path);
      const bytes=Buffer.alloc(before.size);let offset=0;
      while(offset<bytes.length){const r=await file.read(bytes,offset,bytes.length-offset,offset);if(!r.bytesRead)break;offset+=r.bytesRead;}
      const after=await file.stat();const final=await sourceFilePath(root,path);const named=final.missing?null:await lstat(final.path);
      if(offset===before.size&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs
        &&named?.ino===after.ino&&named?.dev===after.dev&&named.size===after.size&&named.mtimeMs===after.mtimeMs&&named.ctimeMs===after.ctimeMs)
        return {entry:{hash:contentHash(bytes),size:bytes.length,executable:Boolean(after.mode&0o111)},bytes};
    } catch(e){if(!['ENOENT','ELOOP'].includes(e.code))throw e;}finally{await file?.close();}
  }
  throw syncError('source_busy',path);
}

/** Private content stores are keyed only by verified hashes and never by caller paths. */
export async function saveSourceBlob(blobRoot,bytes) {
  if(bytes.length>SOURCE_SYNC_LIMITS.fileBytes)throw syncError('file_too_large');
  const hash=contentHash(bytes);await mkdir(blobRoot,{recursive:true,mode:0o700});
  const path=join(blobRoot,hash);
  try{await writeFile(path,bytes,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;const existing=await readSourceBlob(blobRoot,hash);if(!existing.equals(bytes))throw syncError('blob_corrupt',hash);}
  return hash;
}

export async function readSourceBlob(blobRoot,hash) {
  if(!/^[a-f0-9]{64}$/.test(hash||''))throw syncError('invalid_hash');
  const file=await open(join(blobRoot,hash),constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const s=await file.stat();if(!s.isFile()||s.nlink!==1||s.size>SOURCE_SYNC_LIMITS.fileBytes)throw syncError('blob_corrupt',hash);
    const bytes=await file.readFile();if(bytes.length!==s.size||contentHash(bytes)!==hash)throw syncError('blob_corrupt',hash);return bytes;
  }finally{await file.close();}
}

async function inspectRoot(options) {
  const root=await realpath(options.root);
  if(await realpath((await git(root,['rev-parse','--show-toplevel'])).trim())!==root)throw syncError('invalid_repository');
  const head=(await git(root,['rev-parse','HEAD'])).trim();
  if(options.expectedHead&&options.expectedHead!==head)throw syncError('git_baseline_mismatch');
  return {root,head};
}

function snapshot(options,head,entries,excluded) {
  return {repositoryId:options.repositoryId,generation:options.generation,capturePolicy:SOURCE_SYNC_CAPTURE_POLICY,baseCommit:head,entries,digest:manifestDigest(entries),excluded};
}

/** Establish the shared base from committed tree objects, not a possibly dirty device. */
export async function captureGitBase(options) {
  const {root,head}=await inspectRoot(options);const entries=Object.create(null),excluded=[];
  const records=(await git(root,['ls-tree','-rz','--full-tree',head])).split('\0').filter(Boolean);
  if(records.length>SOURCE_SYNC_LIMITS.paths)throw syncError('manifest_too_large');
  for(const record of records){const tab=record.indexOf('\t'),[mode,type,hash]=record.slice(0,tab).split(' '),path=record.slice(tab+1);
    if(excludedSourcePath(path)||type!=='blob'){excluded.push({path,reason:type==='commit'?'nested_repository':'excluded'});continue;}
    validateSourcePath(path);if(!['100644','100755'].includes(mode))throw syncError('unsafe_file',path);
    const size=Number((await git(root,['cat-file','-s',hash])).trim());if(size>SOURCE_SYNC_LIMITS.fileBytes)throw syncError('file_too_large',path);
    const bytes=await git(root,['cat-file','blob',hash],null);if(bytes.length!==size)throw syncError('source_busy',path);
    const digest=options.blobRoot?await saveSourceBlob(options.blobRoot,bytes):contentHash(bytes);
    entries[path]={hash:digest,size,executable:mode==='100755'};
  }
  if((await git(root,['rev-parse','HEAD'])).trim()!==head)throw syncError('git_baseline_mismatch');
  return snapshot(options,head,entries,excluded);
}

/** A complete source snapshot contains explicit tracked deletions and never touches HEAD/index. */
export async function captureSourceSnapshot(options) {
  const {root,head}=await inspectRoot(options);const base=options.base||await captureGitBase({...options,root,expectedHead:head});
  if(base.baseCommit!==head)throw syncError('git_baseline_mismatch');
  const paths=[...new Set([...Object.keys(base.entries),...(await git(root,['ls-files','-z','--cached','--others','--exclude-standard'])).split('\0').filter(Boolean)])].sort();
  if(paths.length>SOURCE_SYNC_LIMITS.paths)throw syncError('manifest_too_large');
  // Ignored files remain exclusions, not deletions of an earlier synchronized untracked file.
  const ignored=(await git(root,['ls-files','-z','--others','--ignored','--exclude-standard','--directory'])).split('\0').filter(Boolean);
  if(ignored.length>SOURCE_SYNC_LIMITS.paths)throw syncError('manifest_too_large');
  const entries=Object.create(null),excluded=[...base.excluded||[],...ignored.map(path=>({path,reason:'ignored'}))];let changedBytes=0;
  for(const path of paths){if(excludedSourcePath(path)||base.excluded?.some(e=>e.reason==='nested_repository'&&(path===e.path||path.startsWith(e.path+'/')))){excluded.push({path,reason:'excluded'});continue;}
    // Git reports an untracked embedded repository as one directory ending in slash.
    if(path.endsWith('/')&&await exists(join(root,path,'.git'))){excluded.push({path,reason:'nested_repository'});continue;}
    let captured;try{captured=await readSourceFile(root,path);}catch(e){if(e.code!=='nested_repository')throw e;excluded.push({path,reason:e.code});continue;}
    entries[path]=captured.entry;
    if(captured.entry&&!entryEqual(Object.hasOwn(base.entries,path)?base.entries[path]:null,captured.entry))changedBytes+=captured.entry.size;
    if(changedBytes>SOURCE_SYNC_LIMITS.batchBytes)throw syncError('batch_too_large');
    if(captured.bytes&&options.blobRoot)await saveSourceBlob(options.blobRoot,captured.bytes);
  }
  if((await git(root,['rev-parse','HEAD'])).trim()!==head)throw syncError('git_baseline_mismatch');
  return snapshot(options,head,entries,excluded);
}
