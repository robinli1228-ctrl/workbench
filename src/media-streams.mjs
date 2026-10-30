import {randomUUID,randomBytes,createHmac,timingSafeEqual,createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {resolve,relative,isAbsolute,basename} from 'node:path';
import {folderAccessFor,nativeFolderAccess} from './folder-access.mjs';

/**
 * Large-file viewing without copying files around: a file stays on the device that produced it, the browser gets a short
 * signed ticket for exactly one version of it, and Home relays the byte ranges the player asks for. Workers send bytes
 * over a separate HTTP request per range (never the control WebSocket), and Home pipes them through without buffering.
 */
export const MEDIA_TICKET_MS=15*60000;
/**
 * Browsers keep a file version this long. A card link is the only credential for its bytes, so it is valid only to the end
 * of the next day; within a day every link for one version is identical, so the browser's copy is reused, and the next
 * day's new link is answered from Home's own copy, without the device.
 */
export const MEDIA_CACHE_MS=10*86400000;
const DAY=86400000;
export const MEDIA_CACHE_CONTROL=`private, max-age=${MEDIA_CACHE_MS/1000}, immutable`;
export const PREVIEW_CHUNK=8*1024*1024;
const NODE_STREAMS=4,SLOT_WAIT_MS=20000,ARRIVAL_MS=20000,IDLE_MS=60000;
const PLAYABLE=new Set(['video','audio','image','pdf']);
const STATUS={source_offline:503,worker_upgrade:501,media_missing:404,file_changed:409,media_busy:503,media_timeout:504,media_ticket_invalid:401,invalid_media_path:400,media_not_file:400};
const failure=(code,detail='')=>Object.assign(new Error(detail||code),{code,status:STATUS[code]||400});
const codeOf=error=>error?.code||String(error?.message||'').split(':')[0].trim()||'media_failed';
const b64=value=>Buffer.from(value).toString('base64url');
const equal=(a,b)=>a.length===b.length&&timingSafeEqual(a,b);
const beneath=(root,path)=>{const rel=relative(root,path);return !isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../');};

/** Home's current cached-read boundary mirrors Worker static roots plus its current scoped folder envelope, even offline. */
export function cachedMediaAllowed(db,t) {
  const worker=db.get('workers',t.n);if(!worker||db.get('removedDevices',t.n)||typeof t.r!=='string'||!isAbsolute(t.r))return false;
  const project=t.pr?folderAccessFor(db,t.n,`project:${t.pr}`):null;
  const envelope=t.ns?.runtime?nativeFolderAccess(db,t.n,t.ns.runtime,t.ns.sessionId,t.ns.entryId)||project:project;
  const roots=[...(Array.isArray(worker.allowedRoots)?worker.allowedRoots:[]),...(envelope?.grant?.root?[envelope.grant.root]:[])];
  return roots.some(root=>typeof root==='string'&&isAbsolute(root)&&beneath(resolve(root),resolve(t.r)));
}

export class MediaStreams {
  constructor({db,query,online,change=()=>{},secret=randomBytes(32),clock=()=>Date.now(),cache=null,canReadCached=()=>true}) {
    Object.assign(this,{db,query,online,change,secret,clock,cache,canReadCached});
    this.pending=new Map();this.slots=new Map();this.transfers=new Map();
  }

  sign(payload) {const body=b64(JSON.stringify(payload));return `${body}.${createHmac('sha256',this.secret).update(body).digest('base64url')}`;}
  /** A ticket names one device, root, path and file version, and expires; it is the only credential a media URL carries. */
  verify(token) {
    if(typeof token!=='string'||token.length>4096)return null;
    const [body,signature]=token.split('.');if(!body||!signature)return null;
    const expected=createHmac('sha256',this.secret).update(body).digest();
    let given;try{given=Buffer.from(signature,'base64url');}catch{return null;}
    if(!equal(given,expected))return null;
    let payload;try{payload=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));}catch{return null;}
    return payload?.v===1&&Number.isSafeInteger(payload.x)&&payload.x>this.clock()?payload:null;
  }

  /** Group-chat paths resolve against the run's own workspace or bound roots on the device that ran it. */
  sourceForRun(run,path) {
    if(typeof path!=='string'||!path||path.length>4096||path.includes('\0'))throw failure('invalid_media_path');
    const projectRoot=this.db.get('workspaces',`${run.projectId}:${run.nodeId}`)?.localRoot||run.projectRoot;
    const repositories=this.db.list('repositoryWorkspaces').filter(b=>b.projectId===run.projectId&&b.nodeId===run.nodeId&&b.localRoot).map(b=>b.localRoot);
    let root;
    if(!isAbsolute(path))root=path.startsWith('.workbench/docs/')?projectRoot:run.workspace;
    else root=[run.workspace,run.projectRoot,projectRoot,...repositories].filter(Boolean).map(r=>resolve(r)).sort((a,b)=>b.length-a.length).find(r=>beneath(r,resolve(path)));
    if(!root)throw failure('invalid_media_path');
    return {projectId:run.projectId,nodeId:run.nodeId,root:resolve(root),path};
  }
  /** Native-session paths resolve only inside that registered session's working directory. */
  sourceForNative(nodeId,record,path) {
    if(!record?.workspace)throw failure('invalid_media_path');
    if(typeof path!=='string'||!path||path.length>4096||path.includes('\0'))throw failure('invalid_media_path');
    if(isAbsolute(path)&&!beneath(resolve(record.workspace),resolve(path)))throw failure('invalid_media_path');
    return {projectId:record.roleBinding?.projectId||null,nodeId,root:resolve(record.workspace),path,
      native:{runtime:record.runtime,sessionId:record.sessionId,entryId:record.entryId||record.id}};
  }

  usable(nodeId) {
    const worker=this.db.get('workers',nodeId);
    if(!worker||this.db.get('removedDevices',nodeId))return 'source_offline';
    if(!this.online(nodeId))return 'source_offline';
    return worker.capabilities?.mediaStream===1?null:'worker_upgrade';
  }
  /** A verified copy made by an earlier transfer can stand in while the producing device is offline. */
  localCopy(source) {
    if(!source.projectId)return null;
    return this.db.listProject('mediaTransfers',source.projectId).filter(t=>t.status==='completed'&&t.source?.nodeId===source.nodeId&&t.source.root===source.root
      &&(t.source.path===source.path||t.source.requestedPath===source.path)&&!this.usable(t.nodeId)).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]||null;
  }

  /** Metadata for a card; bytes are not read until the player asks for them. */
  async describe(source) {
    const name=basename(source.path),reason=this.usable(source.nodeId);
    if(this.db.get('removedDevices',source.nodeId))return {available:false,reason:'source_offline',name,sourceNodeId:source.nodeId};
    if(reason){
      const cached=reason==='source_offline'&&this.cache?await this.cache.find(source):null;
      if(cached){
        // The current request supplies its scope; a persisted descriptor cannot revive an old grant or native identity.
        const payload={...cached,pr:source.projectId||null,ns:source.native||null,rq:source.path,x:(Math.floor(this.clock()/DAY)+2)*DAY};
        if(!this.canReadCached(payload))return {available:false,reason:'invalid_media_path',name,sourceNodeId:source.nodeId};
        const ticket=this.sign(payload),worker=this.db.get('workers',source.nodeId);
        if(!worker||this.db.get('removedDevices',source.nodeId))return {available:false,reason:'source_offline',name,sourceNodeId:source.nodeId};
        return {available:true,cached:true,ticket,url:`/media/${ticket}`,downloadUrl:`/media/${ticket}?download=1`,name:payload.nm,size:payload.s,mime:payload.t,kind:payload.k,playable:PLAYABLE.has(payload.k),
          modifiedAt:new Date(payload.m).toISOString(),expiresAt:new Date(payload.x).toISOString(),sourceNodeId:source.nodeId,sourceName:worker.name||source.nodeId,transfers:[]};
      }
      const copy=reason==='source_offline'?this.localCopy(source):null;
      if(!copy)return {available:false,reason,name,sourceNodeId:source.nodeId};
      const described=await this.describe({projectId:source.projectId,nodeId:copy.nodeId,root:copy.workspace,path:copy.path});
      return {...described,copyOf:{nodeId:source.nodeId,transferId:copy.id}};
    }
    let info;
    try{info=await this.query({nodeId:source.nodeId,projectId:source.projectId},'media_stat',{...source.native,root:source.root,file:source.path},10000);}
    catch(error){const code=codeOf(error);if(['media_missing','media_not_file','invalid_media_path'].includes(code))return {available:false,reason:code,name,sourceNodeId:source.nodeId};throw error;}
    // Signed identity is a lookup key, not a directory grant; Home resolves the current binding for every query.
    // Expiry is the end of the next UTC day: every describe of one file version on one day signs the same ticket, so the
    // link (and the browser's cached bytes) stays the same all day; a changed file gets a new link through its version fields.
    const payload={v:1,n:source.nodeId,r:source.root,p:info.relativePath,s:info.size,m:info.mtimeMs,i:info.ino,d:info.dev,t:info.mime,k:info.kind,nm:info.name,pr:source.projectId||null,ns:source.native||null,rq:source.path,x:(Math.floor(this.clock()/DAY)+2)*DAY};
    // Existing complete caches from before sidecars were introduced gain a locator on the next successful description.
    if(this.cache&&this.canReadCached(payload))await this.cache.remember(payload);
    const ticket=this.sign(payload),worker=this.db.get('workers',source.nodeId);
    const transfers=source.projectId?this.db.listProject('mediaTransfers',source.projectId).filter(t=>t.source?.nodeId===source.nodeId&&t.source.root===source.root&&t.source.path===info.relativePath)
      .map(t=>({id:t.id,nodeId:t.nodeId,status:t.status,received:t.received||0,size:t.size,path:t.path||null,error:t.error||null})):[];
    return {available:true,ticket,url:`/media/${ticket}`,downloadUrl:`/media/${ticket}?download=1`,name:info.name,size:info.size,mime:info.mime,kind:info.kind,
      playable:PLAYABLE.has(info.kind),modifiedAt:new Date(info.mtimeMs).toISOString(),expiresAt:new Date(payload.x).toISOString(),sourceNodeId:source.nodeId,sourceName:worker?.name||source.nodeId,transfers};
  }

  /** At most a few concurrent relays per device; extra requests wait briefly instead of crowding the Worker. */
  async slot(nodeId) {
    const state=this.slots.get(nodeId)||{active:0,waiting:[]};this.slots.set(nodeId,state);
    if(state.active>=NODE_STREAMS)await new Promise((resolveSlot,reject)=>{
      const waiter={resolve:resolveSlot,timer:setTimeout(()=>{state.waiting.splice(state.waiting.indexOf(waiter),1);reject(failure('media_busy'));},SLOT_WAIT_MS)};state.waiting.push(waiter);
    });
    state.active++;
    let released=false;
    return ()=>{if(released)return;released=true;state.active--;const next=state.waiting.shift();if(next){clearTimeout(next.timer);next.resolve();}};
  }

  /** Browser-facing reads: Range requests for playing and seeking, full streams for downloads and transfers. */
  async serve(req,res,token,{download=false}={}) {
    if(!['GET','HEAD'].includes(req.method))return respond(res,405,{error:'Method not allowed'});
    if(req.headers['sec-fetch-site']==='cross-site')return respond(res,403,{error:'Cross-site media request rejected'});
    const t=this.verify(token);if(!t)return respond(res,401,{error:'media_ticket_invalid',code:'media_ticket_invalid'});
    // Home's copy of this exact version answers first, so the bytes never cross the device link twice (and still open offline).
    // A removed device's files are not served from the copy either.
    const known=Boolean(this.db.get('workers',t.n))&&!this.db.get('removedDevices',t.n);
    const cached=this.cache&&known?await this.cache.lookup(t):null;
    const prefix=!cached&&this.cache&&known?await this.cache.prefix(t):null;
    if((cached||prefix)&&!this.canReadCached(t))return respond(res,403,{error:'invalid_media_path',code:'invalid_media_path'});
    if(!this.db.get('workers',t.n)||this.db.get('removedDevices',t.n))return respond(res,503,{error:'source_offline',code:'source_offline'});
    const size=t.s;let start=0,end=size-1,partial=false;
    const etag=`"${createHash('sha256').update(JSON.stringify([t.n,t.r,t.p,t.s,t.m,t.i,t.d])).digest('hex')}"`;
    const modified=new Date(t.m).toUTCString(),ifRange=req.headers['if-range'];
    // Only the exact strong ETag permits a resumed range. Filesystem dates have second precision and are not strong.
    const range=!ifRange||ifRange===etag?req.headers.range:null;
    if(range&&size>0){
      const m=/^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if(!m||!m[1]&&!m[2])return respond(res,416,{error:'Invalid range'},{'Content-Range':`bytes */${size}`});
      if(m[1]===''){start=Math.max(0,size-Number(m[2]));}else{start=Number(m[1]);end=m[2]?Math.min(Number(m[2]),size-1):size-1;}
      if(!Number.isSafeInteger(start)||start>=size||start>end)return respond(res,416,{error:'Range not satisfiable'},{'Content-Range':`bytes */${size}`});
      if(!download&&!m[2])end=Math.min(end,start+PREVIEW_CHUNK-1);
      partial=true;
    }
    const covered=cached||(prefix&&end<prefix.size?prefix.path:null);
    const reason=covered?null:this.usable(t.n);if(reason)return respond(res,STATUS[reason],{error:reason,code:reason});
    const inline=!download&&PLAYABLE.has(t.k),filename=encodeURIComponent(t.nm||'file');
    const headers={'ETag':etag,'Last-Modified':modified,'Content-Type':inline?t.t:'application/octet-stream','Accept-Ranges':'bytes','Cache-Control':MEDIA_CACHE_CONTROL,'X-Content-Type-Options':'nosniff',
      // Browsers will not render a PDF inside a sandboxed document; every other response is sandboxed in case it is opened directly.
      ...(inline&&t.k==='pdf'?{}:{'Content-Security-Policy':"sandbox; default-src 'none'"}),'Content-Disposition':`${inline?'inline':'attachment'}; filename*=UTF-8''${filename}`,'Content-Length':String(size?end-start+1:0),
      ...(partial?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})};
    const status=partial?206:200;
    if(req.method==='HEAD'||size===0){res.writeHead(status,headers);return res.end();}
    if(covered){res.writeHead(status,headers);return pipeline(this.cache.read(covered,start,end),res).catch(()=>res.destroy());}
    const tracked=this.progress.has(token)?{onBytes:count=>this.trackProgress(token,count)}:{};
    // Retain only bytes the caller actually requests, never turn a thumbnail into a background whole-file download.
    // A later read starts with the verified prefix and relays only its missing suffix in the same HTTP response.
    const saved=prefix&&start<prefix.size?{...prefix,start}:null,remoteStart=saved?prefix.size:start;
    const writer=this.cache?await this.cache.append(t,remoteStart):null;
    if(res.destroyed){if(writer)await writer.finish(false);return;}
    return this.relay(t,remoteStart,end,res,status,headers,{...tracked,writer,prefix:saved});
  }

  /** Whether the device still holds exactly this version; a copy is kept only then (a file rewritten mid-read is not). */
  async unchanged(t) {
    try{const info=await this.query({nodeId:t.n,projectId:t.pr},'media_stat',{...t.ns,root:t.r,file:t.p},10000);return info.size===t.s&&info.mtimeMs===t.m&&info.ino===t.i&&info.dev===t.d;}
    catch{return false;}
  }

  async relay(t,start,end,res,status,headers,{onBytes,writer=null,prefix=null}={}) {
    let release;
    try{release=await this.slot(t.n);}catch(error){if(writer)void writer.finish(false);return respond(res,STATUS[error.code]||503,{error:error.code,code:error.code},{'Retry-After':'2'});}
    if(res.destroyed){release();if(writer)await writer.finish(false);return;}
    const id=randomUUID(),secret=randomBytes(24).toString('hex'),length=end-start+1;
    let settle;const done=new Promise(resolveDone=>{settle=resolveDone;});
    const entry={id,secret,nodeId:t.n,length,status,headers,res,started:false,closed:false,onBytes,writer,prefix,complete:false,overflow:false,settle:()=>{clearTimeout(entry.timer);this.pending.delete(id);release();
      if(!writer)return settle();
      // A bounded interrupted prefix is useful too, but only after the same source-version check as a full copy.
      void ((entry.started&&(entry.complete||writer.partial&&!entry.overflow))?this.unchanged(t):Promise.resolve(false)).then(ok=>writer.finish(ok),()=>writer.finish(false)).finally(settle);}};
    this.pending.set(id,entry);
    entry.timer=setTimeout(()=>this.fail(id,'media_timeout'),ARRIVAL_MS);
    res.on('close',()=>{entry.closed=true;if(!entry.started)this.fail(id,null);});
    try{
      await this.query({nodeId:t.n,projectId:t.pr},'media_stream',{...t.ns,id,secret,path:`/api/worker/media-streams/${id}`,root:t.r,file:t.p,version:{size:t.s,mtimeMs:t.m,ino:t.i,dev:t.d},start,end},ARRIVAL_MS);
    }catch(error){this.fail(id,codeOf(error));}
    await done;
  }
  fail(id,code) {
    const entry=this.pending.get(id);if(!entry||entry.started)return;
    if(code&&!entry.closed&&!entry.res.headersSent)respond(entry.res,STATUS[code]||502,{error:code,code});
    entry.settle();
  }

  /** The Worker's upload for one relay; the per-relay secret is the only credential, and bytes go straight to the browser. */
  async receive(req,res,id) {
    const entry=this.pending.get(id);
    const authorized=entry&&typeof req.headers.authorization==='string'&&equal(Buffer.from(req.headers.authorization),Buffer.from(`Bearer ${entry.secret}`));
    // Closing the transport also closes the SSH channel; draining a late upload would waste the slow link.
    if(req.method!=='POST'||!authorized||entry.started){req.destroy();return;}
    entry.started=true;clearTimeout(entry.timer);
    const out=entry.res;
    if(entry.closed||out.destroyed){req.destroy();respond(res,410,{error:'Viewer closed'});entry.settle();return;}
    out.writeHead(entry.status,entry.headers);
    let count=0,idle;
    const touch=()=>{clearTimeout(idle);idle=setTimeout(()=>req.destroy(new Error('media_idle')),IDLE_MS);};touch();
    const meter=new Transform({transform(chunk,encoding,callback){
      count+=chunk.length;touch();
      if(count>entry.length){entry.overflow=true;return callback(new Error('media_overflow'));}
      entry.onBytes?.(count+(entry.prefix?entry.prefix.size-entry.prefix.start:0));
      Promise.resolve(entry.writer?.write(chunk)).then(()=>callback(null,chunk),callback);
    }});
    const cache=this.cache;
    const prepend=async function*(source){
      if(entry.prefix)for await(const chunk of cache.read(entry.prefix.path,entry.prefix.start,entry.prefix.size-1)){touch();yield chunk;}
      yield* source;
    };
    try{
      await pipeline(req,meter,prepend,out);entry.complete=count===entry.length;respond(res,entry.complete?200:400,{received:count});
    }
    catch{out.destroy();if(!res.headersSent)respond(res,400,{received:count});}
    finally{clearTimeout(idle);entry.settle();}
  }

  /**
   * "Send to device": the source hashes its file, the target pulls it through the same relay straight to disk and
   * verifies size and SHA-256. Progress is the relayed byte count. A retry with the same ID resumes the same record.
   */
  async transfer(projectId,{clientTransferId,ticket,nodeId}) {
    if(!/^[a-f0-9-]{36}$/.test(clientTransferId||''))throw failure('invalid_media_path','Invalid transfer ID');
    const t=this.verify(ticket);if(!t)throw failure('media_ticket_invalid');
    if(t.pr!==projectId)throw failure('invalid_media_path','Ticket belongs to another project');
    if(nodeId===t.n)throw failure('invalid_media_path','The file is already on that device');
    const binding=this.db.get('workspaces',`${projectId}:${nodeId}`);if(!binding?.localRoot)throw failure('invalid_media_path','The target device has no project directory');
    const reason=this.usable(nodeId)||this.usable(t.n);if(reason)throw failure(reason);
    const fingerprint=JSON.stringify([t.n,t.r,t.p,t.s,t.m,t.i,nodeId]);
    const prior=this.db.get('mediaTransfers',clientTransferId);
    if(prior&&prior.fingerprint!==fingerprint)throw failure('invalid_media_path','Transfer ID reused for a different file');
    if(prior?.status==='completed')return prior;
    if(this.transfers.has(clientTransferId))return this.db.get('mediaTransfers',clientTransferId);
    const now=new Date(this.clock()).toISOString();
    const record=this.db.put('mediaTransfers',{id:clientTransferId,projectId,nodeId,fingerprint,workspace:binding.localRoot,
      source:{nodeId:t.n,root:t.r,path:t.p,requestedPath:t.rq||t.p,size:t.s,mtimeMs:t.m,name:t.nm},size:t.s,received:0,status:'hashing',createdAt:prior?.createdAt||now,updatedAt:now});
    this.change();
    const run=(async()=>{
      try {
        const version={size:t.s,mtimeMs:t.m,ino:t.i,dev:t.d};
        const hashed=await this.query({nodeId:t.n,projectId:t.pr},'media_hash',{...t.ns,root:t.r,file:t.p,version},60000+Math.ceil(t.s/(20*1024*1024))*1000);
        this.update(record.id,{status:'transferring',sha256:hashed.sha256});
        const relayTicket=this.sign({...t,x:this.clock()+MEDIA_TICKET_MS});
        this.progress.set(relayTicket,{id:record.id,last:0});
        const result=await this.query({nodeId,projectId},'media_receive',{path:`/media/${relayTicket}?download=1`,size:t.s,sha256:hashed.sha256,name:t.nm,transferId:record.id,workspace:binding.localRoot},
          300000+Math.ceil(t.s/(512*1024))*1000);
        if(result?.sha256!==hashed.sha256||result.size!==t.s||typeof result.path!=='string')throw failure('media_receive_failed','Target confirmation does not match');
        const copyPath=relative(resolve(binding.localRoot),resolve(result.path));
        return this.update(record.id,{status:'completed',received:t.s,path:copyPath,absolutePath:result.path});
      } catch(error) {return this.update(record.id,{status:'failed',error:codeOf(error)==='media_failed'?error.message:codeOf(error)});}
      finally {this.transfers.delete(record.id);for(const [key,value] of this.progress)if(value.id===record.id)this.progress.delete(key);this.change();}
    })();
    this.transfers.set(record.id,run);
    return record;
  }
  update(id,patch) {const current=this.db.get('mediaTransfers',id);return this.db.put('mediaTransfers',{...current,...patch,updatedAt:new Date(this.clock()).toISOString()});}
  /** Transfer progress is recorded from the relay itself, throttled to roughly every 8 MB. */
  get progress() {return this._progress||=new Map();}
  trackProgress(token,count) {
    const entry=this.progress.get(token);if(!entry||count-entry.last<8*1024*1024)return;
    entry.last=count;this.update(entry.id,{received:count});this.change();
  }
}

function respond(res,status,body,headers={}) {
  if(res.headersSent){res.destroy();return;}
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(body));
}
