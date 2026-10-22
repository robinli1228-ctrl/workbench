import {randomUUID,randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Writable} from 'node:stream';
import {resolve,relative,isAbsolute,basename} from 'node:path';

/**
 * Large-file viewing without copying files around: a file stays on the device that produced it, the browser gets a short
 * signed ticket for exactly one version of it, and Home relays the byte ranges the player asks for. Workers send bytes
 * over a separate HTTP request per range (never the control WebSocket), and Home pipes them through without buffering.
 */
export const MEDIA_TICKET_MS=15*60000;
/** Browsers keep a file version this long. Card links for one version stay identical for a day, so the cache can hit. */
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

export class MediaStreams {
  constructor({db,query,online,change=()=>{},secret=randomBytes(32),clock=()=>Date.now(),cache=null}) {
    Object.assign(this,{db,query,online,change,secret,clock,cache});
    this.pending=new Map();this.slots=new Map();this.transfers=new Map();this.prefetching=new Set();
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
    if(!worker)return 'source_offline';
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
    if(reason){
      const copy=reason==='source_offline'?this.localCopy(source):null;
      if(!copy)return {available:false,reason,name,sourceNodeId:source.nodeId};
      const described=await this.describe({projectId:source.projectId,nodeId:copy.nodeId,root:copy.workspace,path:copy.path});
      return {...described,copyOf:{nodeId:source.nodeId,transferId:copy.id}};
    }
    let info;
    try{info=await this.query({nodeId:source.nodeId,projectId:source.projectId},'media_stat',{...source.native,root:source.root,file:source.path},10000);}
    catch(error){const code=codeOf(error);if(['media_missing','media_not_file','invalid_media_path'].includes(code))return {available:false,reason:code,name,sourceNodeId:source.nodeId};throw error;}
    // Signed identity is a lookup key, not a directory grant; Home resolves the current binding for every query.
    // Expiry is rounded up to the end of a day bucket: every describe of one file version on one day signs the same ticket,
    // so the link (and the browser's cached bytes) stays the same; a changed file gets a new link through its version fields.
    const payload={v:1,n:source.nodeId,r:source.root,p:info.relativePath,s:info.size,m:info.mtimeMs,i:info.ino,d:info.dev,t:info.mime,k:info.kind,nm:info.name,pr:source.projectId||null,ns:source.native||null,rq:source.path,x:(Math.floor(this.clock()/DAY)+1)*DAY+MEDIA_CACHE_MS};
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
    const cached=this.cache?await this.cache.lookup(t):null;
    const reason=cached?null:this.usable(t.n);if(reason)return respond(res,STATUS[reason],{error:reason,code:reason});
    const size=t.s;let start=0,end=size-1,partial=false;
    const range=req.headers.range;
    if(range&&size>0){
      const m=/^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if(!m||!m[1]&&!m[2])return respond(res,416,{error:'Invalid range'},{'Content-Range':`bytes */${size}`});
      if(m[1]===''){start=Math.max(0,size-Number(m[2]));}else{start=Number(m[1]);end=m[2]?Math.min(Number(m[2]),size-1):size-1;}
      if(!Number.isSafeInteger(start)||start>=size||start>end)return respond(res,416,{error:'Range not satisfiable'},{'Content-Range':`bytes */${size}`});
      if(!download&&!m[2])end=Math.min(end,start+PREVIEW_CHUNK-1);
      partial=true;
    }
    const inline=!download&&PLAYABLE.has(t.k),filename=encodeURIComponent(t.nm||'file');
    const headers={'Content-Type':inline?t.t:'application/octet-stream','Accept-Ranges':'bytes','Cache-Control':MEDIA_CACHE_CONTROL,'X-Content-Type-Options':'nosniff',
      // Browsers will not render a PDF inside a sandboxed document; every other response is sandboxed in case it is opened directly.
      ...(inline&&t.k==='pdf'?{}:{'Content-Security-Policy':"sandbox; default-src 'none'"}),'Content-Disposition':`${inline?'inline':'attachment'}; filename*=UTF-8''${filename}`,'Content-Length':String(size?end-start+1:0),
      ...(partial?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})};
    const status=partial?206:200;
    if(req.method==='HEAD'||size===0){res.writeHead(status,headers);return res.end();}
    if(cached){res.writeHead(status,headers);return pipeline(this.cache.read(cached,start,end),res).catch(()=>res.destroy());}
    const tracked=this.progress.has(token)?{onBytes:count=>this.trackProgress(token,count)}:{};
    // A whole-file read is copied as it passes; a range read of a small enough file fetches the whole file once in the background.
    const writer=this.cache&&start===0&&end===size-1?await this.cache.writer(t):null;
    if(!writer&&this.cache&&partial&&size<=this.cache.prefetchBytes)void this.prefetch(t);
    return this.relay(t,start,end,res,status,headers,{...tracked,writer});
  }

  /** Fill Home's copy of a file the viewer is reading in ranges: one full relay into the cache, nothing to the browser. */
  async prefetch(t) {
    const key=this.cache.key(t);if(this.prefetching.has(key)||await this.cache.lookup(t))return;
    this.prefetching.add(key);
    try{
      const writer=await this.cache.writer(t);if(!writer)return;
      const sink=new Writable({write(chunk,encoding,callback){callback();}});sink.writeHead=()=>{};
      await this.relay(t,0,t.s-1,sink,200,{},{writer});
    }finally{this.prefetching.delete(key);}
  }

  async relay(t,start,end,res,status,headers,{onBytes,writer=null}={}) {
    let release;
    try{release=await this.slot(t.n);}catch(error){void writer?.finish(false);return respond(res,STATUS[error.code]||503,{error:error.code,code:error.code},{'Retry-After':'2'});}
    const id=randomUUID(),secret=randomBytes(24).toString('hex'),length=end-start+1;
    let settle;const done=new Promise(resolveDone=>{settle=resolveDone;});
    const entry={id,secret,nodeId:t.n,length,status,headers,res,started:false,closed:false,onBytes,writer,complete:false,settle:()=>{clearTimeout(entry.timer);this.pending.delete(id);release();void writer?.finish(entry.complete).finally(settle);}};
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
    if(req.method!=='POST'||!authorized||entry.started){req.resume();return respond(res,entry?.started?409:401,{error:'Unknown media stream'});}
    entry.started=true;clearTimeout(entry.timer);
    const out=entry.res;
    if(entry.closed||out.destroyed){req.destroy();respond(res,410,{error:'Viewer closed'});entry.settle();return;}
    out.writeHead(entry.status,entry.headers);
    let count=0,idle;
    const touch=()=>{clearTimeout(idle);idle=setTimeout(()=>req.destroy(new Error('media_idle')),IDLE_MS);};touch();
    req.on('data',chunk=>{count+=chunk.length;touch();entry.onBytes?.(count);entry.writer?.write(chunk);if(count>entry.length)req.destroy(new Error('media_overflow'));});
    try{await pipeline(req,out);entry.complete=count===entry.length;respond(res,entry.complete?200:400,{received:count});}
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
