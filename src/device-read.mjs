import {constants} from 'node:fs';
import {open,opendir,realpath,stat,lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute,join,relative,resolve,sep,parse} from 'node:path';

/**
 * Read-only look at files on this device for a role running elsewhere (wb device ls / read): the project's bound folder,
 * plus any folders the device owner lists in WORKER_READ_ROOTS (for logs kept outside the project). Paths resolve through
 * realpath and the opened file is checked to be the one that was resolved, so a link cannot lead outside; secret-looking
 * names and the Worker's own data are refused; replies are bounded pages of text.
 */
export const DEVICE_READ_LIMITS=Object.freeze({bytes:64*1024,tailLines:1000,tailWindow:512*1024,entries:500,sniff:8192});

// Credentials, keys, shell history, app databases and platform state stay unreadable even inside an allowed folder. Names
// are compared case-folded and NFKC-normalized (macOS folders are case-insensitive). Ordinary sources and logs stay readable:
// the word patterns (credential, secret, token, ...) do not apply to source files, which merely use those words in their names.
const SECRET_NAMES=[
  /^\.(?:git|ssh|gnupg|aws|azure|kube|docker|m2|gradle|config|password-store|codex|claude|data|local|worktrees)$/,
  /^\.wb-(?:bridge|source-sync)-/,/^keychains$/,
  /^\.(?:netrc|npmrc|pypirc|yarnrc(?:\.yml)?|pgpass|git-credentials|gitconfig|envrc|htpasswd|my\.cnf|[a-z_]*history)$/,/^_netrc$/,
  /^\.env(?:\..*)?$/,/^kubeconfig$/,/^(?:worker-config|\.agent-workbench-project|auth(?:-profiles)?)\.json$/,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?:[._-]|$)/,
  /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg|tfstate|tfvars|sqlite\d?|db|keychain(?:-db)?)(?:[.-].*)?$/,
  /^(?:cookies|login data|web data|key\d\.db|logins\.json|cert\d\.db)$/,
];
const SECRET_WORDS=[/^deploy[-_]?key/,/credential/,/serviceaccount/,/^\.?secrets?(?:[._-]|$)/,/^(?:api|access|refresh|worker|auth)?[-_]?tokens?(?:[._-]|$)/];
const SOURCE_FILE=/\.(?:java|kt|kts|groovy|scala|js|mjs|cjs|ts|tsx|jsx|vue|svelte|py|go|rs|rb|php|cs|swift|m|mm|c|cc|cpp|h|hpp|sh|bash|zsh|sql|md|html|css|scss|less|proto|graphql|dart|lua|pl|r|ex|exs|erl|clj)$/;
const PUBLIC_ENV=/^\.env\.(?:example|sample|template)$/;
const fold=part=>part.normalize('NFKC').toLowerCase();
export const secretName=name=>{const value=fold(name);return !PUBLIC_ENV.test(value)&&(SECRET_NAMES.some(pattern=>pattern.test(value))||!SOURCE_FILE.test(value)&&SECRET_WORDS.some(pattern=>pattern.test(value)));};
// Private handoffs of other roles stay out too (independent review isolation is not bypassed through raw folders).
const secretPath=parts=>parts.some(secretName)||parts.some((part,i)=>fold(part)==='.workbench'&&fold(parts[i+1]||'')==='handoffs'&&fold(parts[i+2]||'')==='private');
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
async function locate({projectRoot,readRoots,denyRoots=[]},path){
  if(typeof path!=='string'||!path||path.length>4096||path.includes('\0'))throw fail('invalid_path');
  // A Sessions-page caller has no project: only the owner's read roots, and only by absolute path.
  const project=projectRoot?await realpath(projectRoot):null;if(project&&await tooWide(project))throw fail('outside_allowed_folders');
  const roots=[...(project?[project]:[]),...readRoots];if(!roots.length)throw fail('no_readable_folders');
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
  return {target,root:check(target),project,check};
}

/** One folder level: names, kinds, sizes and times of the entries themselves (links are not followed), secret names left out. */
export async function deviceList(options){
  // Without a project, listing nothing in particular names the folders the owner opened.
  if(!options.projectRoot&&(options.path===undefined||options.path==='.')){
    if(!options.readRoots?.length)throw fail('no_readable_folders');
    return {path:null,root:null,projectRoot:null,readRoots:options.readRoots,items:options.readRoots.map(name=>({name,kind:'folder',size:null,modifiedAt:null})),partial:false};
  }
  const {target,root,project}=await locate(options,options.path??'.');
  if(!(await stat(target)).isDirectory())throw fail('not_a_folder');
  const items=[];let partial=false;
  const dir=await opendir(target);
  try{for await(const item of dir){
    if(secretName(item.name))continue;
    if(items.length>=DEVICE_READ_LIMITS.entries){partial=true;break;}
    let info=null;try{info=await lstat(join(target,item.name));}catch{}
    items.push({name:item.name,kind:item.isDirectory()?'folder':item.isFile()?'file':item.isSymbolicLink()?'link':'other',size:info?.isFile()?info.size:null,modifiedAt:info&&!info.isSymbolicLink()?info.mtime.toISOString():null});
  }}finally{await dir.close().catch(()=>{});}
  items.sort((a,b)=>Number(b.kind==='folder')-Number(a.kind==='folder')||a.name.localeCompare(b.name));
  return {path:target,root,projectRoot:project,readRoots:options.readRoots||[],items,partial};
}

/**
 * A text page of one file: the last `tail` lines (optionally only lines containing `match`, case-insensitive, within the
 * last 512 KiB), or `limit` bytes from `offset`. A file whose first 8 KiB hold a NUL byte is binary and refused whatever
 * page is asked for.
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
    if(offset===undefined&&limit===undefined||tail!==undefined||match!==undefined){
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
      const needle=match?.toLowerCase(),candidates=(needle?all.filter(line=>line.toLowerCase().includes(needle)):all).slice(-lines);
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
      return {...common,mode:'tail',lines:picked.length,...(match?{match}:{}),...(cut?{lineCut:true}:{}),windowStart:start,content:picked.join('\n')};
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
