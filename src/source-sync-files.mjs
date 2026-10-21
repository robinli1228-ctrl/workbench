import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {constants,lstat} from 'node:fs';
import {mkdir,realpath,open,readFile,writeFile,readdir,lstat as pathStat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {SOURCE_SYNC_LIMITS,SOURCE_SYNC_CAPTURE_POLICY,DIRECTORY_SYNC_CAPTURE_POLICY,OUTPUT_SYNC_CAPTURE_POLICY,includesSyncOutputs,contentHash,syncError,syncLimitError,excludedSourcePath,validateSourcePath,manifestDigest,entryEqual} from './source-sync-manifest.mjs';

const exec=promisify(execFile);
const git=async(root,args,encoding='utf8')=>(await exec('git',args,{cwd:root,encoding,timeout:30000,maxBuffer:24*1024*1024})).stdout;
// Missing .git markers are routine during each safety walk; avoid rejected promises while keeping a fresh lstat.
const exists=path=>new Promise((resolve,reject)=>lstat(path,(error,info)=>{if(!error)resolve(info);else if(error.code==='ENOENT')resolve(null);else reject(error);}));
const blobSaves=new Map();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Custom DATA_DIRs can live under .local; their database identifies the whole private runtime, including staging.
const runtimeDirectory=async dir=>Boolean(await exists(join(dir,'home.sqlite'))||await exists(join(dir,'worker.sqlite')));

/** Background checks release the event loop between fixed batches. Busy task load gets shorter work slices and longer,
 * still finite rests; explicit captures do not use this path. */
function backgroundYield({busy=()=>false,cancelled=()=>false,yieldControl}={}){
  return (phase,count,force=false)=>{
    const loaded=Boolean(busy());if(!force&&!loaded&&count%32!==0)return;
    return (async()=>{if(cancelled())throw syncError('capture_cancelled');
      if(yieldControl)await yieldControl(phase,{busy:loaded});else await pause(loaded?25:10);
      if(cancelled())throw syncError('capture_cancelled');})();
  };
}

/** Bound file I/O and drain in-flight captures before rejecting, so a failed snapshot leaves no background writes. */
export async function captureSourceEntries(paths,capture,{background=false,busy=()=>false,cancelled=()=>false,yieldControl,cooperate}={}) {
  const result=new Array(paths.length);let cursor=0,failed=false,error;
  const yieldBackground=background?(cooperate||backgroundYield({busy,cancelled,yieldControl})):null;
  // Busy observations remain finite (they may be prerequisites of the active task), but yield more often.
  await Promise.all(Array.from({length:Math.min(background?1:8,paths.length)},async()=>{
    while(!failed&&cursor<paths.length){const index=cursor++;try{result[index]=await capture(paths[index]);const wait=yieldBackground&&!failed&&cursor<paths.length&&cursor%8===0&&yieldBackground('files',cursor);if(wait)await wait;}catch(e){if(!failed){failed=true;error=e;}}
    }
  }));
  if(background&&cancelled()&&!failed){failed=true;error=syncError('capture_cancelled');}
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
export async function readSourceFile(root,path,policy={},observation=null) {
  // A background observation whose directory walk just listed this path (no symlinks, no nested repositories on the
  // way) needs one no-follow lstat to see that nothing changed; the per-component walk is repeated only for files
  // that did change and for every byte read. Transfers never take this path.
  if(observation?.walked&&observation.cached){
    validateSourcePath(path,policy);
    const named=await pathStat(join(root,path),{bigint:true}).catch(e=>{if(['ENOENT','ENOTDIR'].includes(e.code))return null;throw e;});
    if(!named)return {entry:null,bytes:null};
    const metadata=fileMetadata(named);
    if(named.isFile()&&named.nlink===1n&&metadata===observation.cached.metadata){
      if(observation.metrics){const m=observation.metrics;m.reused=(m.reused||0)+1;m.bytesRead=m.bytesRead||0;}
      return {entry:{...observation.cached.entry},bytes:null,metadata,modifiedAt:named.mtime.toISOString()};
    }
  }
  for(let attempt=0;attempt<2;attempt++){
    // A walked observation already rejected links and nested repositories on the way down; the component walk after
    // the read still has to agree with the bytes, so only the walk before the read is saved.
    const checked=observation?.walked&&!observation.cached?{path:join(root,validateSourcePath(path,policy)),missing:false}:await sourceFilePath(root,path,{policy});
    if(checked.missing)return {entry:null,bytes:null};
    let file;
    try {
      // Observation does not read content or authorize a transfer. A fresh safe component walk plus
      // matching no-follow leaf metadata can reuse its old hash without opening the unchanged file.
      if(observation?.cached){const named=await pathStat(checked.path,{bigint:true}),metadata=fileMetadata(named);
        if(named.isFile()&&named.nlink===1n&&Number(named.ino)===checked.stat.ino&&Number(named.dev)===checked.stat.dev&&metadata===observation.cached.metadata){
          if(observation.metrics){const m=observation.metrics;m.reused=(m.reused||0)+1;m.bytesRead=m.bytesRead||0;}
          return {entry:{...observation.cached.entry},bytes:null,metadata,modifiedAt:named.mtime.toISOString()};
        }
      }
      file=await open(checked.path,constants.O_RDONLY|constants.O_NOFOLLOW);
      const before=await file.stat({bigint:true});if(!before.isFile()||before.nlink!==1n)throw syncError('unsafe_file',path);
      if(before.size>BigInt(SOURCE_SYNC_LIMITS.fileBytes))throw syncLimitError('file_too_large','file',SOURCE_SYNC_LIMITS.fileBytes,Number(before.size),path);
      const metadata=fileMetadata(before),bytes=Buffer.alloc(Number(before.size));let offset=0;
      while(offset<bytes.length){const r=await file.read(bytes,offset,bytes.length-offset,offset);if(!r.bytesRead)break;offset+=r.bytesRead;}
      // Actual byte reads still check descriptor/name identity and repeat the safe component walk.
      const after=await file.stat({bigint:true}),final=await sourceFilePath(root,path,{policy});
      const named=final.missing?null:await pathStat(final.path,{bigint:true});
      if(offset===Number(before.size)&&metadata===fileMetadata(after)&&named&&metadata===fileMetadata(named)){
        if(observation?.metrics){const m=observation.metrics;m.hashed=(m.hashed||0)+1;m.bytesRead=(m.bytesRead||0)+bytes.length;}
        return {entry:{hash:contentHash(bytes),size:bytes.length,executable:Boolean(after.mode&0o111n)},bytes,metadata,modifiedAt:after.mtime.toISOString()};
      }
    } catch(e){if(!['ENOENT','ELOOP'].includes(e.code))throw e;}finally{await file?.close();}
  }
  throw syncError('source_busy',path);
}

/** Nanosecond fields retain each filesystem's precision; periodic full hashing remains the final backstop. */
const fileMetadata=s=>[s.dev,s.ino,s.size,s.mode,s.nlink,s.mtimeNs,s.ctimeNs].join(':');

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
  // Only background observation can reuse hashes. Transfer/blob capture always reads verified bytes.
  const observation=options.blobRoot?null:options.observation;
  const cooperate=options.background?backgroundYield(options):null;
  const rootInfo=await pathStat(root,{bigint:true});
  const outputs=includesSyncOutputs(policy),metadataOnly=outputs&&options.preview===true;
  if(outputs&&await runtimeDirectory(root))throw syncError('runtime_directory');
  let visited=0,changedBytes=0,ignored=[];
  // Git ignore is an optional file-selection source, never the directory scope's version history.
  if(!outputs||metadataOnly)try{if(await realpath((await git(root,['rev-parse','--show-toplevel'])).trim())===root)ignored=(await git(root,['ls-files','-z','--others','--ignored','--exclude-standard','--directory'])).split('\0').filter(Boolean);}catch(e){if(!e.stderr?.includes('not a git repository')&&!String(e.message).includes('not a git repository')&&e.code!=='ENOENT')throw e;}
  const isIgnored=path=>ignored.some(p=>path===p||path.startsWith(p.endsWith('/')?p:p+'/'));
  // Git's effective selection also includes info/exclude and global rules that directory watches cannot see.
  const signature=JSON.stringify([root,String(rootInfo.dev),String(rootInfo.ino),options.repositoryId,options.generation,policy,ignored]);
  const cached=observation?.signature===signature?observation.cache:new Map();
  const partial=Boolean(observation&&!observation.fullHash&&observation.signature===signature&&observation.snapshot&&options.changedPaths?.length&&options.changedPaths.every(path=>cached.has(path)));
  const nextCache=partial?new Map(cached):new Map();
  const directories=partial?new Map(observation.directories):new Map();
  async function walk(dir,prefix=''){
    // Empty directories need watchers too; retain identity during this walk so replacements cannot reuse an old inode's watcher.
    if(observation){const info=dir===root?rootInfo:await pathStat(dir,{bigint:true});if(!info.isDirectory())throw syncError('unsafe_file',prefix);directories.set(dir,`${info.dev}:${info.ino}`);}
    for(const item of await readdir(dir,{withFileTypes:true})){
      const path=prefix+item.name;if(++visited>SOURCE_SYNC_LIMITS.paths*2)throw syncLimitError('manifest_too_large','scan_entries',SOURCE_SYNC_LIMITS.paths*2,visited,path);
      if(cooperate&&visited%32===0)await cooperate('walk',visited);
      const shared=policy.sharedDocs===true&&(path==='.workbench'||path==='.workbench/docs'||path.startsWith('.workbench/docs/'));
      const sharedParent=shared&&(path==='.workbench'||path==='.workbench/docs');
      if(!sharedParent&&(excludedSourcePath(path,policy)||!outputs&&!shared&&isIgnored(path))){excluded.push({path,reason:'excluded'});continue;}
      // A link or a special file is never read or transferred; it is listed as excluded so one link cannot block the whole scope.
      if(item.isSymbolicLink()||!item.isFile()&&!item.isDirectory()){excluded.push({path,reason:item.isSymbolicLink()?'symlink':'special_file'});continue;}
      if(item.isDirectory()){
        if(outputs&&await runtimeDirectory(join(dir,item.name))){excluded.push({path,reason:'runtime_directory'});continue;}
        if(await exists(join(dir,item.name,'.git'))){excluded.push({path,reason:'nested_repository'});continue;}
        await walk(join(dir,item.name),path+'/');continue;
      }
      paths.push(path);if(paths.length>SOURCE_SYNC_LIMITS.paths)throw syncLimitError('manifest_too_large','files',SOURCE_SYNC_LIMITS.paths,paths.length,path);
    }
  }
  if(partial){paths.push(...new Set(options.changedPaths));Object.assign(entries,observation.snapshot.entries);excluded.push(...observation.snapshot.excluded);}
  else await walk(root);
  const captured=await captureSourceEntries(paths,async path=>{
    let value;
    try{value=await readSourceFile(root,path,policy,observation?{cached:observation.fullHash||partial?null:cached.get(path),metrics:observation.metrics,walked:!partial}:null);}
    catch(e){
      // A file this device never synchronized and that exceeds the per-file limit is recorded as oversize, not a batch
      // failure; it stays viewable through on-demand media reads. A previously synchronized file still blocks (Home fences it).
      if(e.code==='file_too_large'&&!options.baselineEntries?.[path]){excluded.push({path,reason:'oversize',size:e.limit?.actual??null});return undefined;}
      // A changed path (from a directory event) that is now a link or hard link leaves the observation like a deleted file.
      if(e.code==='unsafe_file'&&partial){excluded.push({path,reason:'symlink'});delete entries[path];nextCache.delete(path);return undefined;}
      throw e;
    }
    if(!value.entry){if(partial){delete entries[path];nextCache.delete(path);return undefined;}throw syncError('source_busy',path);}
    if(!entryEqual(value.entry,options.baselineEntries?.[path]||null))changedBytes+=value.entry.size;
    if(changedBytes>SOURCE_SYNC_LIMITS.batchBytes)throw syncLimitError('batch_too_large','batch',SOURCE_SYNC_LIMITS.batchBytes,changedBytes,path);
    if(options.blobRoot&&!metadataOnly)await saveSourceBlob(options.blobRoot,value.bytes);
    if(observation)nextCache.set(path,{metadata:value.metadata,entry:value.entry});
    return value.entry;
  },{background:options.background===true,busy:options.busy,cancelled:options.cancelled,yieldControl:options.yieldControl,cooperate});
  for(let i=0;i<paths.length;i++)if(captured[i]!==undefined)entries[paths[i]]=captured[i];
  if(cooperate)await cooperate('manifest',1,true);
  const digest=manifestDigest(entries,policy);
  // Publish the cache only with a complete successful observation, never a failed/partial traversal.
  if(observation){observation.cache=nextCache;observation.signature=signature;observation.snapshot={entries,excluded};observation.directories=directories;}
  return {repositoryId:options.repositoryId,generation:options.generation,scopeKind:'directory',scopePolicy:policy,capturePolicy:outputs?OUTPUT_SYNC_CAPTURE_POLICY:DIRECTORY_SYNC_CAPTURE_POLICY,...(metadataOnly?{metadataOnly:true,newlyIncluded:paths.filter(path=>excludedSourcePath(path,{...policy,contentMode:'source-only'})||!(policy.sharedDocs&&path.startsWith('.workbench/docs/'))&&isIgnored(path))}:{}),baseCommit:null,entries,digest,excluded};
}
