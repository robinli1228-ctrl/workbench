import {open,realpath,stat,mkdir,rename,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,relative,isAbsolute,basename,join,extname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

/** Worker side of large-file viewing: files stay on their device and are read on demand, in ranges, never whole into memory. */
export const MEDIA_ERRORS=Object.freeze(['invalid_media_path','media_missing','media_not_file','file_changed','media_receive_failed']);
const mediaError=(code,detail='')=>Object.assign(new Error(detail?`${code}: ${detail}`:code),{code});
const inside=(root,path)=>{const rel=relative(root,path);return !rel||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../')&&!rel.startsWith('..\\'));};
// Hidden directories (other than the shared .workbench tree) and credential-like names are never served.
const blockedPart=part=>(part.startsWith('.')&&part!=='.workbench')||/credential|secret|token|password|id_rsa|id_ed25519|\.pem$|\.key$|\.p12$|^\.env/i.test(part);

/** Content type comes from the file's own header bytes; the extension only picks between equivalent containers. */
export function sniffMedia(head,name='') {
  const ext=extname(name).slice(1).toLowerCase(),ascii=(start,end)=>head.toString('latin1',start,end);
  if(head.length>=12&&ascii(4,8)==='ftyp'){
    const brand=ascii(8,12);
    if(brand==='qt  ')return {mime:'video/quicktime',kind:'video'};
    if(/^M4A|^M4B/.test(brand)||ext==='m4a')return {mime:'audio/mp4',kind:'audio'};
    return {mime:'video/mp4',kind:'video'};
  }
  if(head.length>=4&&head.readUInt32BE(0)===0x1a45dfa3)return ext==='webm'?{mime:'video/webm',kind:'video'}:{mime:'video/x-matroska',kind:'video'};
  if(ascii(0,4)==='OggS')return ext==='ogv'?{mime:'video/ogg',kind:'video'}:{mime:'audio/ogg',kind:'audio'};
  if(ascii(0,3)==='ID3'||head.length>=2&&head[0]===0xff&&(head[1]&0xe0)===0xe0&&ext==='mp3')return {mime:'audio/mpeg',kind:'audio'};
  if(ascii(0,4)==='RIFF'&&ascii(8,12)==='WAVE')return {mime:'audio/wav',kind:'audio'};
  if(ascii(0,4)==='fLaC')return {mime:'audio/flac',kind:'audio'};
  if(head.length>=8&&head.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return {mime:'image/png',kind:'image'};
  if(head[0]===0xff&&head[1]===0xd8&&head[2]===0xff)return {mime:'image/jpeg',kind:'image'};
  if(/^GIF8[79]a/.test(ascii(0,6)))return {mime:'image/gif',kind:'image'};
  if(ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP')return {mime:'image/webp',kind:'image'};
  if(ascii(0,5)==='%PDF-')return {mime:'application/pdf',kind:'pdf'};
  return {mime:'application/octet-stream',kind:'file'};
}

/** Resolve a caller path inside one allowed root: canonical paths only, no escapes through links or blocked names. */
export async function mediaPath(root,path) {
  if(typeof path!=='string'||!path||path.length>4096||path.includes('\0'))throw mediaError('invalid_media_path');
  const base=await realpath(root),candidate=isAbsolute(path)?resolve(path):resolve(base,path);
  if(!inside(base,candidate))throw mediaError('invalid_media_path');
  if(relative(base,candidate).split(/[\\/]/).some(blockedPart))throw mediaError('invalid_media_path');
  let file;try{file=await realpath(candidate);}catch(error){if(error.code==='ENOENT')throw mediaError('media_missing');throw error;}
  if(!inside(base,file)||relative(base,file).split(/[\\/]/).some(blockedPart))throw mediaError('invalid_media_path');
  return {base,file,relativePath:relative(base,file)};
}

const versionOf=info=>({size:info.size,mtimeMs:info.mtimeMs,ino:String(info.ino),dev:String(info.dev)});
const sameVersion=(a,b)=>a&&b&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ino===b.ino&&a.dev===b.dev;

async function openStable(root,path,expected) {
  const {file,relativePath}=await mediaPath(root,path);
  const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try {
    const info=await handle.stat();if(!info.isFile()){throw mediaError('media_not_file');}
    const version=versionOf(info);
    if(expected&&!sameVersion(version,expected))throw mediaError('file_changed');
    return {handle,file,relativePath,version};
  } catch(error){await handle.close().catch(()=>{});throw error;}
}

/** Identity used by tickets: size, modification time and inode pin one version of the file. */
export async function statMedia({root,path}) {
  const {handle,relativePath,version}=await openStable(root,path);
  try {
    const head=Buffer.alloc(64),{bytesRead}=await handle.read(head,0,64,0);
    return {relativePath,name:basename(relativePath),...version,...sniffMedia(head.subarray(0,bytesRead),relativePath)};
  } finally {await handle.close();}
}

/**
 * Stream bytes [start,end] to Home's relay over plain HTTP (not the control WebSocket), so run events and heartbeats are
 * never queued behind video data. The version is checked before reading and again afterwards.
 */
export async function streamMedia({root,path,version,start,end,url,secret,fetchImpl=fetch,signal}) {
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start)throw mediaError('invalid_media_path','range');
  const opened=await openStable(root,path,version);
  if(end>=opened.version.size){await opened.handle.close();throw mediaError('file_changed');}
  const length=end-start+1;
  try {
    const body=opened.handle.createReadStream({start,end,autoClose:false,highWaterMark:256*1024});
    const response=await fetchImpl(url,{method:'POST',headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/octet-stream'},body,duplex:'half',signal});
    const after=versionOf(await opened.handle.stat());
    if(!response.ok)throw mediaError('media_receive_failed',`HTTP ${response.status}`);
    await response.arrayBuffer().catch(()=>{});
    if(!sameVersion(after,opened.version))throw mediaError('file_changed');
    return {sent:length};
  } finally {await opened.handle.close().catch(()=>{});}
}

/** Streaming SHA-256 for transfers; the whole file is never held in memory. */
export async function hashMedia({root,path,version}) {
  const opened=await openStable(root,path,version),hash=createHash('sha256');let size=0;
  try {
    for await(const chunk of opened.handle.createReadStream({autoClose:false,highWaterMark:1024*1024})){hash.update(chunk);size+=chunk.length;}
    if(!sameVersion(versionOf(await opened.handle.stat()),opened.version)||size!==opened.version.size)throw mediaError('file_changed');
    return {sha256:hash.digest('hex'),size};
  } finally {await opened.handle.close().catch(()=>{});}
}

/** Received copies live under the target project's ignored .workbench/tmp/media/<transfer>/, checked level by level for links. */
async function receiveDirectory(workspace,transferId) {
  const root=await realpath(workspace);let directory=root;
  for(const part of ['.workbench','tmp','media',transferId]){
    const next=join(directory,part);
    await mkdir(next,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    directory=await realpath(next);
    if(!inside(root,directory))throw mediaError('invalid_media_path','receive directory escapes the project');
  }
  return directory;
}
export function safeMediaName(name) {
  const sanitized=String(name||'file').replace(/[^\p{L}\p{N}._-]/gu,'_'),extension=/\.[\p{L}\p{N}]{1,16}$/u.exec(sanitized)?.[0]||'';
  let stem='';for(const char of extension?sanitized.slice(0,-extension.length):sanitized){if(Buffer.byteLength(stem+char+extension)>180)break;stem+=char;}
  return (stem||'file')+extension;
}

/**
 * Pull a file of any size from Home's relay straight to disk, then verify size and SHA-256 before it appears under its
 * final name. Progress is reported through onProgress; a retry reuses the same transfer directory.
 */
export async function receiveMedia({url,size,sha256,name,transferId,workspace,fetchImpl=fetch,onProgress=()=>{},signal}) {
  if(!/^[a-f0-9-]{36}$/.test(transferId||'')||!Number.isSafeInteger(size)||size<0||!/^[a-f0-9]{64}$/.test(sha256||''))throw mediaError('media_receive_failed','invalid transfer');
  const directory=await receiveDirectory(workspace,transferId),path=join(directory,safeMediaName(name)),temp=join(directory,`${randomUUID()}.part`);
  const response=await fetchImpl(url,{signal});
  if(!response.ok||!response.body)throw mediaError('media_receive_failed',`HTTP ${response.status}`);
  const handle=await open(temp,'wx',0o600),hash=createHash('sha256');let received=0,lastReport=0;
  try {
    for await(const chunk of response.body){
      received+=chunk.length;if(received>size)throw mediaError('media_receive_failed','more bytes than expected');
      hash.update(chunk);await handle.write(chunk);
      if(received-lastReport>=8*1024*1024){lastReport=received;onProgress(received);}
    }
    await handle.close();
    if(received!==size||hash.digest('hex')!==sha256)throw mediaError('media_receive_failed','size or SHA-256 mismatch');
    await rename(temp,path);onProgress(received);
    return {path,size:received,sha256};
  } catch(error){await handle.close().catch(()=>{});await unlink(temp).catch(()=>{});throw error;}
}
