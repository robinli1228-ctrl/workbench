import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {constants,lstat} from 'node:fs';
import {mkdir,realpath,open,readFile,writeFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {SOURCE_SYNC_LIMITS,SOURCE_SYNC_CAPTURE_POLICY,DIRECTORY_SYNC_CAPTURE_POLICY,OUTPUT_SYNC_CAPTURE_POLICY,includesSyncOutputs,contentHash,syncError,syncLimitError,excludedSourcePath,validateSourcePath,manifestDigest,entryEqual} from './source-sync-manifest.mjs';

const exec=promisify(execFile);
const git=async(root,args,encoding='utf8')=>(await exec('git',args,{cwd:root,encoding,timeout:30000,maxBuffer:24*1024*1024})).stdout;
// Missing .git markers are routine during each safety walk; avoid rejected promises while keeping a fresh lstat.
const exists=path=>new Promise((resolve,reject)=>lstat(path,(error,info)=>{if(!error)resolve(info);else if(error.code==='ENOENT')resolve(null);else reject(error);}));
const blobSaves=new Map();
// Custom DATA_DIRs can live under .local; their database identifies the whole private runtime, including staging.
const runtimeDirectory=async dir=>Boolean(await exists(join(dir,'home.sqlite'))||await exists(join(dir,'worker.sqlite')));

/** Bound file I/O and drain in-flight captures before rejecting, so a failed snapshot leaves no background writes. */
export async function captureSourceEntries(paths,capture,{background=false}={}) {
  const result=new Array(paths.length);let cursor=0,failed=false,error;
  // Reconciliation still checks every byte and path, but yields between small batches instead of saturating
  // the filesystem pool. Explicit transfer/capture requests keep their existing parallel fast path.
  await Promise.all(Array.from({length:Math.min(background?1:8,paths.length)},async()=>{
    while(!failed&&cursor<paths.length){const index=cursor++;try{result[index]=await capture(paths[index]);}catch(e){if(!failed){failed=true;error=e;}}
      if(background&&!failed&&cursor<paths.length&&cursor%32===0)await new Promise(resolve=>setTimeout(resolve,8));
    }
  }));
  if(failed)throw error;return result;
}

/** Walk components, not just the final path: parent links and nested repositories are not source roots. */
export async function sourceFilePath(root,path,{createParents=false,policy={}}={}) {
  validateSourcePath(path,policy);const canonical=await realpath(root);let current=canonical,info;
  const parts=path.split('/');
  for(let i=0;i<parts.length;i++){
    if(includesSyncOutputs(policy)&&await runtimeDirectory(current))throw syncError('runtime_directory',path);
    current=join(current,parts[i]);info=await exists(current);
    if(!info&&i<parts.length-1&&createParents){await mkdir(current,{mode:0o755}).catch(e=>{if(e.code!=='EEXIST')throw e;});info=await exists(current);}
    if(!info){if(i<parts.length-1)return {path:current,missing:true};return {path:current,missing:true};}
    if(info.isSymbolicLink()||i<parts.length-1&&!info.isDirectory()||i===parts.length-1&&(!info.isFile()||info.nlink!==1))throw syncError('unsafe_file',path);
    if(i<parts.length-1&&await exists(join(current,'.git')))throw syncError('nested_repository',path);
  }
  return {path:current,missing:false,stat:info};
}

/** Capture stable bytes from a no-follow descriptor; never infer stability from mtime alone. */
export async function readSourceFile(root,path,policy={}) {
  for(let attempt=0;attempt<2;attempt++){
    const checked=await sourceFilePath(root,path,{policy});if(checked.missing)return {entry:null,bytes:null};
    let file;
    try {
      file=await open(checked.path,constants.O_RDONLY|constants.O_NOFOLLOW);
      const before=await file.stat();if(!before.isFile()||before.nlink!==1)throw syncError('unsafe_file',path);
      if(before.size>SOURCE_SYNC_LIMITS.fileBytes)throw syncLimitError('file_too_large','file',SOURCE_SYNC_LIMITS.fileBytes,before.size,path);
      const bytes=Buffer.alloc(before.size);let offset=0;
      while(offset<bytes.length){const r=await file.read(bytes,offset,bytes.length-offset,offset);if(!r.bytesRead)break;offset+=r.bytesRead;}
      // The final walk already checks and stats the leaf; compare that fresh identity with the open descriptor.
      const after=await file.stat();const final=await sourceFilePath(root,path,{policy});const named=final.missing?null:final.stat;
      if(offset===before.size&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs
        &&named?.ino===after.ino&&named?.dev===after.dev&&named.size===after.size&&named.mtimeMs===after.mtimeMs&&named.ctimeMs===after.ctimeMs)
        return {entry:{hash:contentHash(bytes),size:bytes.length,executable:Boolean(after.mode&0o111)},bytes,modifiedAt:after.mtime.toISOString()};
    } catch(e){if(!['ENOENT','ELOOP'].includes(e.code))throw e;}finally{await file?.close();}
  }
  throw syncError('source_busy',path);
}

/** Private content stores are keyed only by verified hashes and never by caller paths. */
export async function saveSourceBlob(blobRoot,bytes) {
  if(bytes.length>SOURCE_SYNC_LIMITS.fileBytes)throw syncError('file_too_large');
  const hash=contentHash(bytes),key=resolve(blobRoot,hash);
  // Concurrent file captures can share content. Join the current verification/write, never cache a completed verification.
  if(blobSaves.has(key))return blobSaves.get(key);
  const pending=saveBlob(blobRoot,hash,bytes).finally(()=>blobSaves.delete(key));blobSaves.set(key,pending);return pending;
}

async function saveBlob(blobRoot,hash,bytes) {
  // Most startup preimages already exist. Verify them directly instead of mkdir + a knowingly failing exclusive write.
  try{const existing=await readSourceBlob(blobRoot,hash);if(!existing.equals(bytes))throw syncError('blob_corrupt',hash);return hash;}
  catch(e){if(e.code!=='ENOENT')throw e;}
  await mkdir(blobRoot,{recursive:true,mode:0o700});
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
    let captured;try{captured=await readSourceFile(root,path);}catch(e){
      // A new file over the per-file limit is left to on-demand media reads instead of failing the whole batch.
      if(e.code==='file_too_large'&&!Object.hasOwn(base.entries,path)){excluded.push({path,reason:'oversize',size:e.limit?.actual??null});continue;}
      if(e.code!=='nested_repository')throw e;excluded.push({path,reason:e.code});continue;}
    entries[path]=captured.entry;
    if(captured.entry&&!entryEqual(Object.hasOwn(base.entries,path)?base.entries[path]:null,captured.entry))changedBytes+=captured.entry.size;
    if(changedBytes>SOURCE_SYNC_LIMITS.batchBytes)throw syncError('batch_too_large');
    if(captured.bytes&&options.blobRoot)await saveSourceBlob(options.blobRoot,captured.bytes);
  }
  if((await git(root,['rev-parse','HEAD'])).trim()!==head)throw syncError('git_baseline_mismatch');
  return snapshot(options,head,entries,excluded);
}

/** Directory scopes use saved-content baselines and the same hash/transfer contract as repository scopes. */
export async function captureDirectorySnapshot(options) {
  const root=await realpath(options.root),policy=options.scopePolicy||{},entries=Object.create(null),excluded=[],paths=[];
  const outputs=includesSyncOutputs(policy),metadataOnly=outputs&&options.preview===true;
  if(outputs&&await runtimeDirectory(root))throw syncError('runtime_directory');
  let visited=0,changedBytes=0,ignored=[];
  // Git ignore is an optional file-selection source, never the directory scope's version history.
  if(!outputs||metadataOnly)try{if(await realpath((await git(root,['rev-parse','--show-toplevel'])).trim())===root)ignored=(await git(root,['ls-files','-z','--others','--ignored','--exclude-standard','--directory'])).split('\0').filter(Boolean);}catch(e){if(!e.stderr?.includes('not a git repository')&&!String(e.message).includes('not a git repository')&&e.code!=='ENOENT')throw e;}
  const isIgnored=path=>ignored.some(p=>path===p||path.startsWith(p.endsWith('/')?p:p+'/'));
  async function walk(dir,prefix=''){
    for(const item of await readdir(dir,{withFileTypes:true})){
      const path=prefix+item.name;if(++visited>SOURCE_SYNC_LIMITS.paths*2)throw syncLimitError('manifest_too_large','scan_entries',SOURCE_SYNC_LIMITS.paths*2,visited,path);
      const shared=policy.sharedDocs===true&&(path==='.workbench'||path==='.workbench/docs'||path.startsWith('.workbench/docs/'));
      const sharedParent=shared&&(path==='.workbench'||path==='.workbench/docs');
      if(!sharedParent&&(excludedSourcePath(path,policy)||!outputs&&!shared&&isIgnored(path))){excluded.push({path,reason:'excluded'});continue;}
      if(item.isSymbolicLink()||!item.isFile()&&!item.isDirectory())throw syncError('unsafe_file',path);
      if(item.isDirectory()){
        if(outputs&&await runtimeDirectory(join(dir,item.name))){excluded.push({path,reason:'runtime_directory'});continue;}
        if(await exists(join(dir,item.name,'.git'))){excluded.push({path,reason:'nested_repository'});continue;}
        await walk(join(dir,item.name),path+'/');continue;
      }
      paths.push(path);if(paths.length>SOURCE_SYNC_LIMITS.paths)throw syncLimitError('manifest_too_large','files',SOURCE_SYNC_LIMITS.paths,paths.length,path);
    }
  }
  await walk(root);
  const captured=await captureSourceEntries(paths,async path=>{
    let value;
    try{value=await readSourceFile(root,path,policy);}
    catch(e){
      // A file this device never synchronized and that exceeds the per-file limit is recorded as oversize, not a batch
      // failure; it stays viewable through on-demand media reads. A previously synchronized file still blocks (Home fences it).
      if(e.code==='file_too_large'&&!options.baselineEntries?.[path]){excluded.push({path,reason:'oversize',size:e.limit?.actual??null});return undefined;}
      throw e;
    }
    if(!value.entry)throw syncError('source_busy',path);
    if(!entryEqual(value.entry,options.baselineEntries?.[path]||null))changedBytes+=value.entry.size;
    if(changedBytes>SOURCE_SYNC_LIMITS.batchBytes)throw syncLimitError('batch_too_large','batch',SOURCE_SYNC_LIMITS.batchBytes,changedBytes,path);
    if(options.blobRoot&&!metadataOnly)await saveSourceBlob(options.blobRoot,value.bytes);
    return value.entry;
  },{background:options.background===true});
  for(let i=0;i<paths.length;i++)if(captured[i]!==undefined)entries[paths[i]]=captured[i];
  return {repositoryId:options.repositoryId,generation:options.generation,scopeKind:'directory',scopePolicy:policy,capturePolicy:outputs?OUTPUT_SYNC_CAPTURE_POLICY:DIRECTORY_SYNC_CAPTURE_POLICY,...(metadataOnly?{metadataOnly:true,newlyIncluded:paths.filter(path=>excludedSourcePath(path,{...policy,contentMode:'source-only'})||!(policy.sharedDocs&&path.startsWith('.workbench/docs/'))&&isIgnored(path))}:{}),baseCommit:null,entries,digest:manifestDigest(entries,policy),excluded};
}
