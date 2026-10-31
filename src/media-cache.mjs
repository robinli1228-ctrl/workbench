import {createHash,randomUUID} from 'node:crypto';
import {mkdir,stat,rename,unlink,readdir,utimes,readFile,writeFile,copyFile,open} from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {Readable} from 'node:stream';
import {join,resolve,basename} from 'node:path';

/**
 * Home's copy of media bytes that came from a device. Media tickets pin one file version (size, mtime, inode, device),
 * so a copy is keyed by that version: a changed file is a new key. Verified continuous prefixes retain requested bytes
 * across ranges and interrupted downloads. Complete copies and prefixes are dropped after 10 days without use or when the cache passes
 * its size limit (least recently used first). With a copy, the bytes never cross the device link again, and the file
 * still opens while that device is offline.
 */
export const MEDIA_CACHE_DEFAULTS=Object.freeze({limitBytes:2*1024**3,maxFileBytes:256*1024**2,maxAgeMs:10*86400000});
const KEY=/^[a-f0-9]{64}$/,PART=/^[a-f0-9]{64}\.[a-f0-9-]{36}\.part$/,TOUCH_MS=3600000;
const PREFIX=/^[a-f0-9]{64}\.prefix$/;
const META=/^[a-f0-9]{64}\.meta$/;

export class MediaCache {
  constructor({dir,clock=()=>Date.now(),...options}) {
    Object.assign(this,MEDIA_CACHE_DEFAULTS,options,{dir,clock});
    this.ready=this.prepare();this.writing=new Set();this.touched=new Map();this.trimming=null;
  }
  /** The folder exists (again, if it was removed while Home ran); a failure means no copies, never a crash. */
  prepare() {return mkdir(this.dir,{recursive:true,mode:0o700}).then(()=>true,()=>false);}
  key(t) {return createHash('sha256').update(JSON.stringify([t.n,t.r,t.p,t.s,t.m,t.i,t.d])).digest('hex');}
  sourceKey(node,root,path) {return createHash('sha256').update(JSON.stringify([node,resolve(root),resolve(root,path)])).digest('hex');}
  cacheable(t) {return Number.isSafeInteger(t?.s)&&t.s>0&&t.s<=this.maxFileBytes;}
  descriptor(t) {return this.cacheable(t)&&t.v===1&&['n','r','p','nm','t','k'].every(k=>typeof t[k]==='string'&&t[k])&&Number.isFinite(t.m)&&Math.abs(t.m)<=8640000000000000&&t.i!=null&&t.d!=null;}
  /** Read one bounded descriptor; partial/old metadata never authorizes bytes or causes a cache-wide scan. */
  async metadata(path) {
    try{if((await stat(path)).size>16384)return null;return JSON.parse(await readFile(path,'utf8'));}catch{return null;}
  }
  /** Persist path aliases only after the complete version exists. Metadata is a locator, never an authorization grant. */
  async remember(t) {
    if(!this.descriptor(t))return;
    if(!await this.lookup(t))return;
    const body=JSON.stringify({version:t});if(Buffer.byteLength(body)>16384)return;
    for(const alias of new Set([t.p,t.rq].filter(p=>typeof p==='string'&&p))){
      const key=this.sourceKey(t.n,t.r,alias),tmp=join(this.dir,`${key}.${randomUUID()}.part`);
      try{await writeFile(tmp,body,{mode:0o600});await rename(tmp,join(this.dir,`${key}.meta`));}
      catch{await unlink(tmp).catch(()=>{});}
    }
  }
  /** Find the last complete cached version by the exact requested path, including its original bare-name alias. */
  async find(source) {
    const path=join(this.dir,`${this.sourceKey(source.nodeId,source.root,source.path)}.meta`),entry=await this.metadata(path),t=entry?.version;
    if(!this.descriptor(t)||t.n!==source.nodeId||resolve(t.r)!==resolve(source.root)||![t.p,t.rq].some(p=>typeof p==='string'&&resolve(t.r,p)===resolve(source.root,source.path)))return null;
    return await this.lookup(t)?t:null;
  }
  /** The path of a complete copy of this version, or null. Use keeps it young (at most one timestamp write an hour). */
  async lookup(t) {
    if(!this.cacheable(t))return null;
    const path=join(this.dir,this.key(t));
    try{const info=await stat(path);if(!info.isFile()||info.size!==t.s)return null;this.touch(path);return path;}catch{return null;}
  }
  touch(path) {
    const now=this.clock();if(now-(this.touched.get(path)||0)<TOUCH_MS)return;this.touched.set(path,now);
    if(this.touched.size>4096)this.touched.delete(this.touched.keys().next().value);
    void utimes(path,new Date(now),new Date(now)).catch(()=>{});
  }
  /** A queued reader may outlive prefix promotion; open its same-version complete copy if the prefix was removed. */
  read(path,start,end) {
    if(!PREFIX.test(basename(path)))return createReadStream(path,{start,end});
    return Readable.from((async function*(){
      let handle;
      try{handle=await open(path,'r');}
      catch(error){if(error.code!=='ENOENT')throw error;handle=await open(path.slice(0,-'.prefix'.length),'r');}
      try{yield* handle.createReadStream({start,end,autoClose:false});}
      finally{await handle.close();}
    })(),{objectMode:false});
  }
  /** A writer for one full copy, or null when the file is too large or another copy of it is being written. */
  async writer(t) {
    if(!this.cacheable(t))return null;
    const key=this.key(t);if(this.writing.has(key))return null;
    this.writing.add(key);
    if(!await this.prepare()){this.writing.delete(key);return null;}
    const tmp=join(this.dir,`${key}.${randomUUID()}.part`),stream=createWriteStream(tmp,{mode:0o600});
    let count=0,failed=false,done=false;stream.on('error',()=>{failed=true;});
    return {
      write:chunk=>{if(failed||done)return;count+=chunk.length;if(count>t.s)failed=true;else stream.write(chunk);},
      /** Keep the copy only when the relay finished and every byte arrived; otherwise leave nothing behind. */
      finish:async ok=>{
        if(done)return false;done=true;
        // A stream that already failed has closed; waiting for its close again would never return.
        if(!stream.closed)await new Promise(resolveClose=>{stream.once('close',resolveClose);stream.end();});
        this.writing.delete(key);
        if(ok&&!failed&&count===t.s){try{await rename(tmp,join(this.dir,key));await this.remember(t);this.scheduleTrim();return true;}catch{}}
        await unlink(tmp).catch(()=>{});return false;
      }
    };
  }
  /** Only a verified continuous prefix is reusable; holes and unverified temporary writes are never exposed. */
  async prefix(t) {
    if(!this.cacheable(t))return null;
    const path=join(this.dir,`${this.key(t)}.prefix`);
    try{const info=await stat(path);if(!info.isFile()||info.size<=0||info.size>=t.s)return null;this.touch(path);return {path,size:info.size};}catch{return null;}
  }
  /** Append to a private copy, publishing atomically only after the source version has been checked again. */
  async append(t,start) {
    if(!this.cacheable(t))return null;
    const key=this.key(t);if(this.writing.has(key))return null;
    this.writing.add(key);
    const tmp=join(this.dir,`${key}.${randomUUID()}.part`),prefixPath=join(this.dir,`${key}.prefix`);
    let stream;
    try {
      if(!await this.prepare())throw new Error('cache unavailable');
      const prefix=await this.prefix(t);
      if(start!==(prefix?.size||0)||await this.lookup(t))throw new Error('prefix changed');
      if(start)await copyFile(prefix.path,tmp);
      stream=createWriteStream(tmp,{flags:start?'a':'wx',mode:0o600});
    } catch {await unlink(tmp).catch(()=>{});this.writing.delete(key);return null;}
    let count=start,failed=false,done=false;stream.on('error',()=>{failed=true;});
    return {
      partial:true,
      // Await disk writes in the relay: a slow cache must not create an unbounded memory queue.
      write:chunk=>new Promise(resolveWrite=>{
        if(failed||done)return resolveWrite();
        if(count+chunk.length>t.s){failed=true;return resolveWrite();}
        stream.write(chunk,error=>{if(error)failed=true;else count+=chunk.length;resolveWrite();});
      }),
      finish:async ok=>{
        if(done)return false;done=true;
        try {
          if(!stream.closed)await new Promise(resolveClose=>{stream.once('close',resolveClose);stream.end();});
          if(ok&&!failed&&count>start){
            await rename(tmp,count===t.s?join(this.dir,key):prefixPath);
            if(count===t.s){await unlink(prefixPath).catch(()=>{});await this.remember(t);}
            this.scheduleTrim();return true;
          }
        } catch {} finally {this.writing.delete(key);}
        await unlink(tmp).catch(()=>{});return false;
      }
    };
  }
  scheduleTrim() {if(this.trimming)return;this.trimming=setTimeout(()=>{this.trimming=null;void this.sweep().catch(()=>{});},5000);this.trimming.unref?.();}
  async list() {
    await this.ready;const out=[];
    for(const name of await readdir(this.dir).catch(()=>[])){
      if(!KEY.test(name)&&!PART.test(name)&&!PREFIX.test(name))continue;
      try{const info=await stat(join(this.dir,name));if(info.isFile())out.push({name,size:info.size,at:info.mtimeMs,part:PART.test(name),prefix:PREFIX.test(name)});}catch{}
    }
    return out;
  }
  async stats() {const files=(await this.list()).filter(f=>!f.part);return {count:files.length,bytes:files.reduce((a,f)=>a+f.size,0),limitBytes:this.limitBytes,maxAgeDays:Math.round(this.maxAgeMs/86400000)};}
  /** Drop copies unused for 10 days, then the least recently used until under the limit; stale partial writes go too. */
  async sweep() {
    const now=this.clock(),files=await this.list();let deleted=0,freed=0;
    const drop=async f=>{if(this.writing.has(f.name.slice(0,64)))return false;try{await unlink(join(this.dir,f.name));deleted++;freed+=f.size;this.touched.delete(join(this.dir,f.name));return true;}catch{return false;}};
    for(const f of files.filter(f=>f.part&&now-f.at>86400000&&!this.writing.has(f.name.slice(0,64))))await drop(f);
    const kept=[];
    for(const f of files.filter(f=>!f.part)){if(now-f.at>=this.maxAgeMs&&await drop(f))continue;kept.push(f);}
    let total=kept.reduce((a,f)=>a+f.size,0);
    for(const f of kept.sort((a,b)=>a.at-b.at)){if(total<=this.limitBytes)break;if(await drop(f))total-=f.size;}
    // Sidecars follow their complete version; only maintenance scans them, never a normal description request.
    for(const name of (await readdir(this.dir).catch(()=>[])).filter(name=>META.test(name))){
      const path=join(this.dir,name),entry=await this.metadata(path),t=entry?.version;
      let present=false;try{const info=this.descriptor(t)&&await stat(join(this.dir,this.key(t)));present=Boolean(info?.isFile()&&info.size===t.s);}catch{}
      if(!present)await unlink(path).catch(()=>{});
    }
    return {deleted,freed,bytes:total};
  }
}
