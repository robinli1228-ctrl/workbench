import {constants} from 'node:fs';
import {open,opendir,realpath,stat,lstat,mkdir,rename,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {isAbsolute,join,relative,resolve,sep,parse,dirname,basename} from 'node:path';

/**
 * Files on this device for a role or session running elsewhere (wb device ls / read / write). Home sends the scope the
 * project or session settings allow on this device: the folders (a project's, or every project's on this device) or the
 * whole device; folders the owner lists in WORKER_READ_ROOTS stay readable too. Paths resolve through realpath and the
 * opened file is checked to be the one that was resolved, so a link cannot lead outside; credentials and keys and the
 * Worker's own data are refused; reads are bounded pages of text, writes at most 1 MB and land whole.
 */
export const DEVICE_READ_LIMITS=Object.freeze({bytes:64*1024,tailLines:1000,tailWindow:512*1024,entries:500,sniff:8192,depth:5,write:1024*1024,walk:20000,walkMs:10000,scan:512*1024*1024,scanMs:10000,scanLine:1024*1024});
// A deep ls does not go into these (they are listed, not walked): version-control internals, dependencies and caches would
// use up the walk before the files that matter. Pointing path inside one still lists it.
const NOT_WALKED=new Set(['.git','.hg','.svn','node_modules','.venv','venv','__pycache__','.gradle','.next','.nuxt','.terraform']);

// Credentials, keys, shell history, app databases and platform state stay unreadable even inside an allowed folder. Names
// are compared case-folded and NFKC-normalized (macOS folders are case-insensitive). Ordinary sources and logs stay readable:
// the word patterns (credential, secret, token, ...) do not apply to source files, which merely use those words in their names.
const SECRET_NAMES=[
  /^\.(?:git|ssh|gnupg|aws|azure|kube|docker|m2|gradle|config|password-store|data|local)$/,
  /^\.wb-(?:bridge|source-sync)-/,/^keychains$/,
  /^\.(?:netrc|npmrc|pypirc|yarnrc(?:\.yml)?|pgpass|git-credentials|gitconfig|envrc|htpasswd|my\.cnf|[a-z_]*history)$/,/^_netrc$/,
  /^\.env(?:\..*)?$/,/^kubeconfig$/,/^(?:worker-config|\.agent-workbench-project|auth(?:-profiles)?)\.json$/,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?:[._-]|$)/,
  /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg|tfstate|tfvars|sqlite\d?|db|keychain(?:-db)?)(?:[.-].*)?$/,
  /^(?:cookies|login data|web data|key\d\.db|logins\.json|cert\d\.db)$/,
  /^(?:credentials?|secrets?)(?:[._-].*)?\.(?:md|txt|json|ya?ml|toml)$/,
];
const SECRET_WORDS=[/^deploy[-_]?key/,/credential/,/serviceaccount/,/^\.?secrets?(?:[._-]|$)/,/^(?:api|access|refresh|worker|auth)?[-_]?tokens?(?:[._-]|$)/];
const SOURCE_FILE=/\.(?:java|kt|kts|groovy|scala|js|mjs|cjs|ts|tsx|jsx|vue|svelte|py|go|rs|rb|php|cs|swift|m|mm|c|cc|cpp|h|hpp|sh|bash|zsh|sql|md|html|css|scss|less|proto|graphql|dart|lua|pl|r|ex|exs|erl|clj)$/;
const PUBLIC_ENV=/^\.env\.(?:example|sample|template)$/;
const fold=part=>part.normalize('NFKC').toLowerCase();
export const secretName=name=>{const value=fold(name);return !PUBLIC_ENV.test(value)&&(SECRET_NAMES.some(pattern=>pattern.test(value))||!SOURCE_FILE.test(value)&&SECRET_WORDS.some(pattern=>pattern.test(value)));};
// Only credentials and keys are kept out; worktrees, CLI histories and handoffs are as readable as the scope allows.
const secretPath=parts=>parts.some(secretName)||parts.some((part,i)=>
  fold(part)==='.claude'&&/^settings(?:\.local)?\.json$/.test(fold(parts[i+1]||''))||fold(part)==='.codex'&&fold(parts[i+1]||'')==='config.toml');
/** The largest prefix of at most `limit` bytes that does not end inside a UTF-8 character (continuation bytes are 10xxxxxx). */
const wholeCharacters=(bytes,limit)=>{let end=Math.min(limit,bytes.length);while(end>0&&end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;return end;};
const characters=(bytes,limit)=>bytes.subarray(0,wholeCharacters(bytes,limit)).toString('utf8');
const fail=code=>Object.assign(new Error(`device_read: ${code}`),{code});
const within=(root,path)=>path===root||path.startsWith(root.endsWith(sep)?root:root+sep);

/** A folder that is the filesystem root, the home folder or contains it would open everything; it is never readable. */
let homeReal=null;
async function tooWide(path){homeReal??=await realpath(homedir()).catch(()=>resolve(homedir()));return path===parse(path).root||within(path,homeReal);}

/** WORKER_READ_ROOTS: extra readable folders, separated like PATH; missing and too wide ones are skipped. */
export async function readRootsFrom(value,delimiter){
  const roots=[];
  for(const path of String(value||'').split(delimiter).map(p=>p.trim()).filter(Boolean))try{const real=await realpath(path);if(!await tooWide(real))roots.push(real);}catch{}
  return roots;
}

/**
 * The real target and the allowed folder it sits in; relative paths start at the project folder. The literal path is judged
 * first, so a refused or outside path reads the same whether or not it exists.
 */
async function locate(options,path){
  if(typeof path!=='string'||!path||path.length>4096||path.includes('\0'))throw fail('invalid_path');
  const {roots,project,denyRoots}=await scopeOf(options);
  if(!roots.length)throw fail('no_readable_folders');
  if(!project&&!isAbsolute(path))throw fail('absolute_path_required');
  const literal=isAbsolute(path)?resolve(path):resolve(project,path);
  const check=candidate=>{
    const root=roots.find(r=>within(r,candidate));if(!root||denyRoots.some(d=>within(d,candidate)))throw fail('outside_allowed_folders');
    if(secretPath(relative(root,candidate).split(sep).filter(Boolean)))throw fail('secret_path');
    return root;
  };
  if(!roots.some(r=>within(r,literal)))throw fail('outside_allowed_folders');
  const literalRoot=roots.find(r=>within(r,literal));if(secretPath(relative(literalRoot,literal).split(sep).filter(Boolean)))throw fail('secret_path');
  let target;try{target=await realpath(literal);}catch(e){throw fail(e.code==='ENOENT'||e.code==='ENOTDIR'?'not_found':'unreadable');}
  return {target,root:check(target),project,check,denyRoots};
}

/**
 * The folders a request may touch. `scope` comes from Home's settings: `all` is the whole device, otherwise its folders
 * (the first is where relative paths start). Older Homes send `projectRoot`; a Sessions-page caller without a project has
 * only the owner's read roots, and only absolute paths.
 */
async function scopeOf({projectRoot=null,readRoots=[],denyRoots=[],scope=null},{write=false}={}){
  // Home may name folders that must stay out whatever the level (its own data on this device).
  const deny=[...denyRoots,...await Promise.all((scope?.deny||[]).filter(d=>typeof d==='string'&&isAbsolute(d)).map(d=>realpath(d).catch(()=>resolve(d))))];
  // Relative paths start only at the folder Home names as the base; without one, paths must be absolute.
  const base=scope?.base?await realpath(scope.base).catch(()=>null):null;
  if(scope?.all)return {roots:[parse(resolve('/')).root],project:base,denyRoots:deny};
  const folders=scope?scope.roots||[]:projectRoot?[projectRoot]:[],roots=[];
  for(const folder of folders){const real=await realpath(folder).catch(()=>null);if(real&&!await tooWide(real))roots.push(real);}
  if(!scope&&projectRoot&&!roots.length)throw fail('outside_allowed_folders');
  // WORKER_READ_ROOTS are read-only extras: never written.
  return {roots:write?roots:[...roots,...readRoots],project:scope?(base&&roots.some(r=>within(r,base))?base:null):roots[0]||null,denyRoots:deny};
}

/** One folder level: names, kinds, sizes and times of the entries themselves (links are not followed), secret names left out. */
export async function deviceList(options){
  const {depth=1,name}=options;
  if(!Number.isSafeInteger(depth)||depth<1||depth>DEVICE_READ_LIMITS.depth)throw fail('invalid_depth');
  if(name!==undefined&&(typeof name!=='string'||!name||name.length>200))throw fail('invalid_name');
  // Without a project folder, listing nothing in particular names the folders that can be read.
  if(options.path===undefined||options.path==='.'){
    const {roots,project}=await scopeOf(options);
    if(!project){
      if(!roots.length)throw fail('no_readable_folders');
      return {path:null,root:null,projectRoot:null,readRoots:roots,items:roots.map(name=>({name,kind:'folder',size:null,modifiedAt:null})),partial:false};
    }
  }
  const {target,root,project,check,denyRoots}=await locate(options,options.path??'.');
  if(!(await stat(target)).isDirectory())throw fail('not_a_folder');
  // A name pattern (* and ?) with a depth looks several levels down in one request instead of one ls per folder.
  const wanted=name?new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.')}$`,'i'):null;
  // The walk itself is bounded too (entries looked at and time), not only the matches: a pattern over a whole device stops.
  const items=[],skipped=new Set();let partial=false,visited=0;const until=Date.now()+DEVICE_READ_LIMITS.walkMs;
  const walk=async(folder,prefix,level)=>{
    // A directory swapped for a link during the walk cannot escape the checked scope or enter a denied folder.
    const current=await realpath(folder).catch(()=>null);if(current!==folder)return;
    try{check(current);}catch{return;}
    const dir=await opendir(folder).catch(()=>null);if(!dir)return;
    const folders=[];
    try{for await(const item of dir){
      if(++visited>DEVICE_READ_LIMITS.walk||Date.now()>until){partial=true;break;}
      if(secretPath(relative(root,join(folder,item.name)).split(sep).filter(Boolean))||denyRoots.some(d=>within(d,join(folder,item.name))))continue;
      const kind=item.isDirectory()?'folder':item.isFile()?'file':item.isSymbolicLink()?'link':'other';
      if(kind==='folder'&&level<depth){if(NOT_WALKED.has(item.name))skipped.add(item.name);else folders.push(item.name);}
      if(wanted&&!wanted.test(item.name))continue;
      if(items.length>=DEVICE_READ_LIMITS.entries){partial=true;break;}
      let info=null;try{info=await lstat(join(folder,item.name));}catch{}
      items.push({name:prefix+item.name,kind,size:info?.isFile()?info.size:null,modifiedAt:info&&!info.isSymbolicLink()?info.mtime.toISOString():null});
    }}finally{await dir.close().catch(()=>{});}
    for(const sub of folders){if(partial)return;await walk(join(folder,sub),`${prefix}${sub}/`,level+1);}
  };
  await walk(target,'',1);
  items.sort((a,b)=>Number(b.kind==='folder')-Number(a.kind==='folder')||a.name.localeCompare(b.name));
  return {path:target,root,projectRoot:project,items,partial,...(skipped.size?{skipped:[...skipped].sort()}:{})};
}

/**
 * Lines containing `match` (case-insensitive) anywhere in the file, not only near its end: the Worker reads the file once
 * (its last 512 MiB, for at most 10 seconds) and returns the last `tail` hits, each prefixed with the byte offset where its
 * line starts, so `offset` can read the lines around it. Only the hits cross the network.
 */
async function matchLines(read,size,match,tail){
  const lines=tail??200;if(!Number.isSafeInteger(lines)||lines<1||lines>DEVICE_READ_LIMITS.tailLines)throw fail('invalid_tail');
  const needle=match.toLowerCase(),start=Math.max(0,size-DEVICE_READ_LIMITS.scan),until=Date.now()+DEVICE_READ_LIMITS.scanMs;
  const hits=[];let total=0,position=start,rest=Buffer.alloc(0),restAt=start,skipFirst=start>0,partial=false;
  const keep=(at,line)=>{total++;hits.push([at,line]);if(hits.length>lines*2)hits.splice(0,hits.length-lines);};
  const scan=(body,at)=>{
    const text=body.toString('utf8'),lower=text.toLowerCase();
    // Lower-casing can change the length of a few characters; then go line by line to keep offsets right.
    if(lower.length!==text.length){let offset=at;for(const line of text.split('\n')){if(line.toLowerCase().includes(needle))keep(offset,line);offset+=Buffer.byteLength(line)+1;}return;}
    const ascii=text.length===body.length;let charBase=0,byteBase=at;
    for(let index=lower.indexOf(needle);index>=0;){
      const begin=text.lastIndexOf('\n',index)+1,next=text.indexOf('\n',index),end=next<0?text.length:next;
      if(!ascii){byteBase+=Buffer.byteLength(text.slice(charBase,begin));charBase=begin;}
      keep(ascii?at+begin:byteBase,text.slice(begin,end));
      index=next<0?-1:lower.indexOf(needle,end+1);
    }
  };
  while(position<size){
    if(Date.now()>until){partial=true;break;}
    const bytes=await read(position,Math.min(4*1024*1024,size-position));if(!bytes.length)break;position+=bytes.length;
    const data=rest.length?Buffer.concat([rest,bytes]):bytes,dataAt=restAt,last=position>=size;
    let end=last?data.length:data.lastIndexOf(10);
    // A line longer than 1 MiB is taken as it is rather than held back.
    if(end<0){if(data.length<=DEVICE_READ_LIMITS.scanLine){rest=data;continue;}end=data.length;}
    rest=data.subarray(Math.min(end+1,data.length));restAt=dataAt+Math.min(end+1,data.length);
    let body=data.subarray(0,end),bodyAt=dataAt;
    // Starting inside the file, the first (partial) line is dropped.
    if(skipFirst){const first=body.indexOf(10);if(first<0)continue;body=body.subarray(first+1);bodyAt+=first+1;skipFirst=false;}
    scan(body,bodyAt);
  }
  // From the last hit back while the page fits; a single hit over the page is cut to it.
  const picked=[];let bytes=0,cut=false;
  for(const [at,line] of hits.slice(-lines).reverse()){
    const text=`${at}: ${line}`,size=Buffer.byteLength(text)+(picked.length?1:0);
    if(bytes+size>DEVICE_READ_LIMITS.bytes){if(!picked.length){picked.unshift(characters(Buffer.from(text),DEVICE_READ_LIMITS.bytes));cut=true;}break;}
    picked.unshift(text);bytes+=size;
  }
  return {mode:'match',match,lines:picked.length,matches:total,scannedFrom:start,...(partial?{partial:true,scannedTo:position}:{}),...(cut?{lineCut:true}:{}),content:picked.join('\n')};
}

/**
 * A text page of one file: the last `tail` lines (within the last 512 KiB), the lines containing `match` anywhere in the
 * file (matchLines), or `limit` bytes from `offset`. A file whose first 8 KiB hold a NUL byte is binary and refused
 * whatever page is asked for.
 */
export async function deviceRead(options){
  const {tail,offset,limit,match}=options;
  if(match!==undefined&&(typeof match!=='string'||!match||match.length>200))throw fail('invalid_match');
  const {target,check}=await locate(options,options.path);
  // No link is followed and nothing blocks (a FIFO swapped in); the opened file must be the regular file that was checked.
  const handle=await open(target,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0)).catch(e=>{throw fail(e.code==='ENOENT'?'not_found':'unreadable');});
  try{
    const info=await handle.stat();if(!info.isFile())throw fail('not_a_file');
    const again=await realpath(target).catch(()=>null),now=again&&await stat(again).catch(()=>null);
    if(again!==target||!now||now.ino!==info.ino||now.dev!==info.dev)throw fail('changed_while_reading');
    check(again);
    const read=async(start,length)=>{const buffer=Buffer.alloc(length),{bytesRead}=await handle.read(buffer,0,length,start);return buffer.subarray(0,bytesRead);};
    if((await read(0,Math.min(DEVICE_READ_LIMITS.sniff,info.size))).includes(0))throw fail('binary_file');
    const text=bytes=>{if(bytes.includes(0))throw fail('binary_file');return bytes.toString('utf8');};
    const common={path:target,size:info.size,modifiedAt:info.mtime.toISOString()};
    if(match!==undefined)return {...common,...await matchLines(read,info.size,match,tail)};
    if(offset===undefined&&limit===undefined||tail!==undefined){
      const lines=tail??200;if(!Number.isSafeInteger(lines)||lines<1||lines>DEVICE_READ_LIMITS.tailLines)throw fail('invalid_tail');
      const start=Math.max(0,info.size-DEVICE_READ_LIMITS.tailWindow);
      const window=await read(start,info.size-start);let first=0;
      // A bounded window can start inside a character; keep only complete UTF-8 characters.
      while(first<window.length&&(window[first]&0xc0)===0x80)first++;
      const all=text(window.subarray(first)).split('\n');
      if(all.at(-1)==='')all.pop();
      // Drop a partial first line only when later complete lines exist; a sole long line is still useful.
      const windowLineCut=start>0&&all.length===1;
      if(start>0&&all.length>1)all.shift();
      const candidates=all.slice(-lines);
      // From the end back while the page fits; a single line over the page is cut to it.
      const picked=[];let bytes=0,cut=windowLineCut&&candidates.length>0;
      for(let i=candidates.length-1;i>=0;i--){
        const size=Buffer.byteLength(candidates[i])+(picked.length?1:0);
        if(bytes+size>DEVICE_READ_LIMITS.bytes){
          if(!picked.length){picked.unshift(characters(Buffer.from(candidates[i]),DEVICE_READ_LIMITS.bytes));cut=true;}
          break;
        }
        picked.unshift(candidates[i]);bytes+=size;
      }
      return {...common,mode:'tail',lines:picked.length,...(cut?{lineCut:true}:{}),windowStart:start,content:picked.join('\n')};
    }
    const from=offset??0,length=limit??DEVICE_READ_LIMITS.bytes;
    if(!Number.isSafeInteger(from)||from<0||!Number.isSafeInteger(length)||length<1||length>DEVICE_READ_LIMITS.bytes)throw fail('invalid_page');
    // Three bytes past the page show whether it would end inside a multi-byte character; it then stops before it.
    const bytes=await read(from,Math.min(length+3,Math.max(0,info.size-from))),page=bytes.subarray(0,wholeCharacters(bytes,length));
    // Reject split-character offsets or undersized pages instead of returning a cursor that cannot advance.
    if(bytes.length&&(bytes[0]&0xc0)===0x80||!page.length&&from<info.size)throw fail('invalid_page');
    return {...common,mode:'range',offset:from,content:text(page),nextOffset:from+page.length<info.size?from+page.length:null};
  }finally{await handle.close();}
}

/**
 * Write or append text. The folders on the way are created inside the allowed scope; a whole write goes to a temporary
 * file first and replaces the target only once complete, so a dropped link never leaves half a file. Home sends a large
 * write in parts with one `uploadId`: the parts gather in the temporary file and `last` puts it in place.
 */
export async function deviceWrite(options){
  const {content,append=false,uploadId=null,part=0,last=true}=options;
  if(typeof content!=='string')throw fail('invalid_content');
  if(uploadId!==null&&!/^[a-zA-Z0-9-]{8,64}$/.test(String(uploadId))||!Number.isSafeInteger(part)||part<0)throw fail('invalid_upload');
  const bytes=Buffer.from(content,'utf8');if(bytes.length>DEVICE_READ_LIMITS.write)throw fail('content_too_large');
  const path=options.path;
  if(typeof path!=='string'||!path||path.length>4096||path.includes('\0'))throw fail('invalid_path');
  const {roots,project,denyRoots}=await scopeOf(options,{write:true});if(!roots.length)throw fail('no_writable_folders');
  if(!project&&!isAbsolute(path))throw fail('absolute_path_required');
  const literal=isAbsolute(path)?resolve(path):resolve(project,path);
  const inside=candidate=>{const root=roots.find(r=>within(r,candidate));if(!root||denyRoots.some(d=>within(d,candidate)))throw fail('outside_allowed_folders');
    if(secretPath(relative(root,candidate).split(sep).filter(Boolean)))throw fail('secret_path');return root;};
  inside(literal);
  // Create missing folders level by level from the nearest existing one; each must stay inside after links resolve.
  let folder=dirname(literal);const missing=[];
  while(!(await stat(folder).catch(()=>null))){missing.unshift(folder);const up=dirname(folder);if(up===folder)break;folder=up;}
  if(!(await stat(folder)).isDirectory())throw fail('not_a_folder');
  inside(await realpath(folder));
  for(const next of missing){await mkdir(next).catch(e=>{if(e.code!=='EEXIST')throw e;});inside(await realpath(next));}
  const parent=await realpath(dirname(literal)),target=join(parent,basename(literal));inside(target);
  const temp=join(parent,`.wb-write-${uploadId||randomUUID()}.tmp`);
  // Home gives up on a write in parts (a part failed or timed out): its temporary file goes.
  if(options.abort===true){if(uploadId)await rm(temp,{force:true});return {path:target,aborted:true};}
  const existing=await lstat(target).catch(()=>null);
  if(existing&&!existing.isFile())throw fail(existing.isSymbolicLink()?'link_not_written':'not_a_file');
  // Links are never followed into: appends open with O_NOFOLLOW; the first part creates a new temporary file, later parts
  // need the one it made (a lost first part fails instead of landing a file without it).
  const add=async(path,flags)=>{const handle=await open(path,flags|(constants.O_NOFOLLOW??0),existing?existing.mode&0o777:0o644).catch(e=>{throw fail(e.code==='ENOENT'?'upload_missing':e.code==='EEXIST'?'upload_exists':e.code==='ELOOP'?'link_not_written':'unwritable');});try{await handle.writeFile(bytes);}finally{await handle.close();}};
  if(append)await add(target,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT);
  else{
    try{
      await add(temp,part===0?constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL:constants.O_WRONLY|constants.O_APPEND);
      if(last)await rename(temp,target);
    }catch(error){if(error.code!=='upload_exists')await rm(temp,{force:true}).catch(()=>{});throw error;}
    if(!last)return {path:target,pending:true,received:bytes.length};
  }
  const info=await stat(target);
  return {path:target,size:info.size,modifiedAt:info.mtime.toISOString(),appended:Boolean(append)};
}
