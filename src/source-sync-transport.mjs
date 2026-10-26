import {SourceSyncInitialization} from './source-sync-initialization.mjs';
import {Readable} from 'node:stream';
import {validateMetadataCapture,contentEqual} from './source-sync-metadata.mjs';
import {metadataBlobRoot,confirmMetadataRead} from './source-sync-metadata-files.mjs';
import {timingSafeEqual} from 'node:crypto';
import {join} from 'node:path';
import {SourceSync} from './source-sync.mjs';
import {SourceSyncStorage} from './source-sync-storage.mjs';
import {SourceSyncWorker} from './source-sync-worker.mjs';
import {SourceSyncConflicts} from './source-sync-conflicts.mjs';
import {SourceSyncAgent} from './source-sync-agent.mjs';
import {runtimeIssue} from './runtime-probe.mjs';
import {validateSourceCapture,syncError,syncLimitError,contentHash,entryEqual,SOURCE_SYNC_LIMITS} from './source-sync-manifest.mjs';
import {sourceScopeBinding} from './source-sync-scopes.mjs';
import {SourceSyncWatch} from './source-sync-watch.mjs';
import {folderAccessFor} from './folder-access.mjs';
import {saveSourceBlob,readSourceBlob} from './source-sync-files.mjs';

const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
const matches=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
async function body(req,limit=64*1024*1024){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw syncError('request_too_large');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString());}
const entries=bundle=>[...Object.values(bundle.base.entries),...Object.values(bundle.manifest.entries)].filter(Boolean);
// Cancelling or blocked batches never distribute capture content, so their late captures need no file bytes at Home.
const retiring=batch=>['cancelling','blocked','cancelled'].includes(batch?.status);
const retryDelay=attempt=>[5000,15000,30000,60000,300000][Math.min(Math.max(attempt-1,0),4)];
// DOMException numeric codes describe transport failures, not permanent sync-policy failures.
const transportFailure=error=>!error.code||typeof error.code!=='string'||['transfer_failed','ECONNRESET','ECONNREFUSED','ETIMEDOUT'].includes(error.code)||['AbortError','TimeoutError'].includes(error.name);

/** Every replay path uses the same compact reference; durable result bytes and their hash remain unchanged. */
function receiptEnvelope(commandId,result){
  const inlineCancellation=result.status==='cancelled'&&result.files?.length===0;
  const reference=result.base?{status:'completed',captureId:commandId}:Array.isArray(result.files)&&!inlineCancellation?{status:result.status,receiptId:commandId}:result;
  return {type:'source_sync_receipt',commandId,result:reference,receiptHash:contentHash(JSON.stringify(result))};
}

/** The existing Home listener transports content; scoped transfer credentials never enter model input. */
export class SourceSyncHome {
  constructor({db,data,online,socket,change,rooms,query}){Object.assign(this,{db,online,socket,change});this.sync=new SourceSync({db,online,change});this.storage=new SourceSyncStorage({db,root:join(data,'source-sync')});this.ticking=false;this.baselines=new SourceSyncInitialization(this);
    this.conflicts=new SourceSyncConflicts({db,rooms,sync:this.sync,reachability:role=>online(role.nodeId)&&db.get('workers',role.nodeId)?.capabilities?.sourceSyncTools===1&&!runtimeIssue(db.get('workers',role.nodeId),role.runtime,role.model)});
    this.agent=new SourceSyncAgent({db,sync:this.sync,conflicts:this.conflicts,storage:this.storage,query});
  }
  busy(projectId,nodeId){return this.db.listSourceSyncCommands({projectId,nodeId,action:'apply',pending:true}).length>0;}
  async tick(){if(this.ticking)return;this.ticking=true;try{
    await this.cleanupMetadataBatches();
    this.baselines.tick();
    await this.cleanupMetadataConflicts();
    this.watchTick();
    this.conflicts.tick();
    for(const c of this.sync.schedule()){
      const socket=this.socket(c.nodeId);if(!socket?.workerReady||socket.readyState!==1)continue;
      if(c.lastSentAt&&Date.now()-Date.parse(c.lastSentAt)<5000)continue;
      // Cleanup uses frozen batch credentials and private paths, even after reconfiguration/cancellation.
      if(c.detection==='metadata'&&c.action==='cleanup'){
        this.db.put('sourceSyncCommands',{...c,lastSentAt:new Date().toISOString()});
        socket.send(JSON.stringify({type:'source_sync_command',commandId:c.id,batchId:c.batchId,projectId:c.projectId,secret:c.secret}));continue;
      }
      const binding=sourceScopeBinding(this.db,c.projectId,c.repositoryId,c.nodeId);
      if(c.scopeKind==='directory'){
        const batch=this.db.get('sourceSyncBatches',c.batchId);
        try{const current=this.sync.bindings(c.projectId,batch.repositoryIds,batch.nodeIds,batch).find(b=>b.repositoryId===c.repositoryId&&b.nodeId===c.nodeId);
          if(!current||current.root!==c.root||JSON.stringify(current.scopePolicy)!==JSON.stringify(c.scopePolicy))throw syncError('binding_changed');
        }catch(e){this.sync.acceptReceipt(c.nodeId,{commandId:c.id,result:{status:'blocked',reason:e.code||'binding_changed'}});continue;}
      }
      const source=c.sourceRunId?this.db.get('runs',c.sourceRunId):null,expectedRoot=source?.repositories?.find(r=>r.id===c.repositoryId)?.localRoot;
      const origin=this.db.get('sourceSyncBatches',c.batchId)?.actor?.runId;
      if(origin&&['failed','interrupted'].includes(this.db.get('runs',origin)?.status)){this.sync.acceptReceipt(c.nodeId,{commandId:c.id,result:{status:'blocked',reason:'source_run_failed'}});continue;}
      if(!this.db.get('projects',c.projectId)||(c.sourceRunId?(source?.projectId!==c.projectId||source.nodeId!==c.nodeId||expectedRoot!==c.root):binding?.localRoot!==c.root)){this.sync.acceptReceipt(c.nodeId,{commandId:c.id,result:{status:'blocked',reason:'binding_changed'}});continue;}
      this.db.put('sourceSyncCommands',{...c,lastSentAt:new Date().toISOString()});
      if(['cancelling','blocked'].includes(this.db.get('sourceSyncBatches',c.batchId)?.status)){socket.send(JSON.stringify({type:'source_sync_cancel',commandId:c.id}));continue;}
      socket.send(JSON.stringify({type:'source_sync_command',commandId:c.id,batchId:c.batchId,projectId:c.projectId,folderAccess:folderAccessFor(this.db,c.nodeId,`project:${c.projectId}`),secret:c.secret}));
    }
  }finally{this.ticking=false;}}
  async cleanupMetadataConflicts(){
    const rows=this.db.db.prepare("SELECT data FROM records WHERE kind='sourceSyncConflicts' AND json_extract(data,'$.detection')='metadata' AND json_extract(data,'$.status')='resolved' AND json_extract(data,'$.copiesReleasedAt') IS NULL AND id>? ORDER BY id LIMIT 16").all(this.conflictCleanupCursor||'').map(r=>JSON.parse(r.data));
    this.conflictCleanupCursor=rows.at(-1)?.id||'';
    for(const c of rows)this.storage.releaseConflictCopies(c);
  }
  async cleanupMetadataBatches(){
    const batches=this.db.metadataCleanupBatches(this.metadataCleanupCursor||'');
    this.metadataCleanupCursor=batches.at(-1)?.id||'';
    for(const b of batches){
      const commands=this.db.listSourceSyncCommands({projectId:b.projectId,batchId:b.id});
      // Home cannot inspect Worker journals. Wait for definite command results AND every Worker's guarded cleanup ACK.
      if(commands.some(c=>c.action!=='cleanup'&&(!c.result||c.status==='reconciling')))continue;
      const cleanups=b.bindings.map(binding=>{
        const extra={journalCommands:commands.filter(c=>c.action==='apply'&&c.nodeId===binding.nodeId&&c.repositoryId===binding.repositoryId).map(c=>c.id)};
        const previous=this.sync.command(b,binding,'cleanup',extra);
        // Pre-upgrade cleanup may already have a terminal failure. Preserve its receipt and use one stable retirement ID.
        return previous.result&&previous.result.status!=='completed'?this.sync.command(b,binding,'cleanup',{...extra,retirementOf:previous.id}):previous;
      });
      if(cleanups.some(c=>c.result?.status!=='completed'))continue;
      try{await this.storage.scoped(b.id).cleanup(b.projectId);}catch(e){if(e.code==='sync_busy')continue;throw e;}
      const current=this.db.get('sourceSyncBatches',b.id),cleanedAt=new Date().toISOString();
      this.db.put('sourceSyncBatches',{...current,metadataCleanedAt:cleanedAt,...(current.status==='cleaning'?{status:current.conflictIds.length||current.pendingMetadata?.length?'partial_conflict':'completed',updatedAt:cleanedAt}:{})});
    }
  }
  /** Persist each observation once and coalesce later saves; file notifications never invoke a model. */
  watchTick(){
    const configs=this.db.list('sourceSyncConfigs').filter(c=>c.enabled&&c.scopeKind==='directory'&&c.mode==='continuous');
    for(const worker of this.db.list('workers').filter(w=>w.capabilities?.sourceSyncDirectory===1)){
      const socket=this.socket(worker.id);if(!socket?.workerReady||socket.readyState!==1)continue;
      const supported=configs.filter(c=>(c.contentMode!=='source-and-outputs'||worker.capabilities.sourceSyncOutputs===1)&&(c.detection!=='metadata'||worker.capabilities.sourceSyncMetadataMode===1));
      for(const c of configs.filter(c=>!supported.includes(c)))for(const b of c.bindings.filter(b=>b.nodeId===worker.id)){
        const id=`${worker.id}:${c.projectId}:${b.repositoryId}`,old=this.db.get('sourceSyncWatchStates',id);
        if(old?.error!=='worker_unsupported'||old.generation!==c.generation)this.db.put('sourceSyncWatchStates',{id,projectId:c.projectId,repositoryId:b.repositoryId,nodeId:worker.id,generation:c.generation,status:'blocked',error:'worker_unsupported'});
      }
      const scopes=supported.flatMap(c=>c.bindings.filter(b=>b.nodeId===worker.id&&sourceScopeBinding(this.db,c.projectId,b.repositoryId,b.nodeId)?.localRoot===b.root).map(b=>({...b,projectId:c.projectId,generation:c.generation,folderAccess:folderAccessFor(this.db,worker.id,`project:${c.projectId}`)})));
      const version=contentHash(JSON.stringify(scopes));
      if(socket.sourceWatchAck!==version&&(!socket.sourceWatchSent||Date.now()-socket.sourceWatchSent>5000)){socket.sourceWatchSent=Date.now();socket.send(JSON.stringify({type:'source_sync_watch_config',version,scopes}));}
    }
    if(this.db.get('settings','main')?.paused)return;
    for(const config of configs){
      const notices=this.db.listProject('sourceSyncWatchNotices',config.projectId).filter(n=>n.generation===config.generation&&!n.handled);
      for(const n of notices.filter(n=>n.batchId)){
        const batch=this.db.get('sourceSyncBatches',n.batchId);
        if(['completed','partial_conflict'].includes(batch?.status))this.db.put('sourceSyncWatchNotices',{...n,handled:true});
        else if(['blocked','cancelled'].includes(batch?.status)){
          const retryable=typeof batch.reason==='number'||['transfer_failed','waiting_device','paused'].includes(batch.reason);
          if(!retryable||(n.attempts||0)>=5){if(n.error!==(batch.reason||'retry_limit'))this.db.put('sourceSyncWatchNotices',{...n,error:batch.reason||'retry_limit'});continue;}
          if(Date.now()-Date.parse(n.queuedAt)>retryDelay(n.attempts||1))this.db.put('sourceSyncWatchNotices',{...n,batchId:null});
        }
      }
      if(this.db.listSourceSyncBatches({projectId:config.projectId}).length)continue;
      const pending=this.db.listProject('sourceSyncWatchNotices',config.projectId).filter(n=>n.generation===config.generation&&!n.handled&&!n.batchId);if(!pending.length)continue;
      const sourceNodeId=config.nodeIds.includes(pending[0].nodeId)?pending[0].nodeId:config.nodeIds[0];
      try{const batch=this.sync.request(config.projectId,{requestId:contentHash(JSON.stringify(pending.map(n=>[n.noticeId,n.attempts||0]))),sourceNodeId,targetNodeIds:config.nodeIds.filter(id=>id!==sourceNodeId)} ,{kind:'watcher'});
        for(const n of pending)this.db.put('sourceSyncWatchNotices',{...n,batchId:batch.id,queuedAt:new Date().toISOString(),attempts:(n.attempts||0)+1});
      }catch(e){for(const n of pending)this.db.put('sourceSyncWatchNotices',{...n,error:e.code||'queue_failed'});}
    }
  }
  watchMessage(nodeId,message){
    if(message.type==='source_sync_watch_ack'){const socket=this.socket(nodeId);if(socket)socket.sourceWatchAck=message.version;return;}
    const config=this.sync.config(message.projectId);
    if(!config.enabled||config.scopeKind!=='directory'||config.mode!=='continuous'||config.generation!==message.generation||!config.nodeIds.includes(nodeId)||!config.repositoryIds.includes(message.repositoryId)){
      if(message.type==='source_sync_dirty')this.socket(nodeId)?.send(JSON.stringify({type:'source_sync_dirty_ack',noticeId:message.noticeId,disposition:'obsolete'}));return;
    }
    const id=`${nodeId}:${message.projectId}:${message.repositoryId}`;
    if(message.type==='source_sync_watch_status'){this.db.put('sourceSyncWatchStates',{id,projectId:message.projectId,nodeId,repositoryId:message.repositoryId,generation:message.generation,status:message.status,error:message.error,limit:message.limit,checkedAt:message.checkedAt,digest:message.digest});return;}
    if(!/^[a-f0-9-]{36}$/.test(message.noticeId||'')||!/^[a-f0-9]{64}$/.test(message.digest||''))throw syncError('invalid_notice');
    const prior=this.db.get('sourceSyncWatchNotices',id);
    if(prior?.noticeId!==message.noticeId)this.db.put('sourceSyncWatchNotices',{id,projectId:message.projectId,nodeId,repositoryId:message.repositoryId,generation:message.generation,noticeId:message.noticeId,digest:message.digest,observedAt:message.observedAt});
    this.socket(nodeId)?.send(JSON.stringify({type:'source_sync_dirty_ack',noticeId:message.noticeId}));
  }
  async message(nodeId,message){
    if(['source_sync_watch_ack','source_sync_watch_status','source_sync_dirty'].includes(message.type)){this.watchMessage(nodeId,message);return;}
    if(this.db.get('sourceSyncTombstones',message.commandId)?.nodeId===nodeId){this.socket(nodeId)?.send(JSON.stringify({type:'source_sync_receipt_ack',commandId:message.commandId,disposition:'project_deleted'}));return;}
    // Compact proof survives command retention: only the authenticated owner and exact accepted hash may replay its ACK.
    const ackKey=typeof message.receiptHash==='string'&&/^[a-f0-9]{64}$/.test(message.receiptHash)?`${message.commandId}:${message.receiptHash}`:null;
    const previousAck=ackKey&&(this.db.get('sourceSyncReceiptAcks',ackKey)||this.db.get('sourceSyncRetiredReceipts',ackKey));
    if(message.type==='source_sync_receipt'&&previousAck?.nodeId===nodeId){this.socket(nodeId)?.send(JSON.stringify(previousAck.ack));return;}
    const c=this.db.get('sourceSyncCommands',message.commandId);if(!c||c.nodeId!==nodeId)throw syncError('receipt_owner_mismatch');
    const uploaded=c.action!=='capture'?this.db.get('sourceSyncUploadReceipts',c.id):null;
    if(message.type==='source_sync_command_ack'){
      this.db.put('sourceSyncCommands',{...c,ackedAt:new Date().toISOString()});
      if(!uploaded||['read','stage'].includes(c.action))return;
    }else if(message.type!=='source_sync_receipt')return;
    if(message.result?.receiptId&&message.result.receiptId!==c.id)throw syncError('receipt_owner_mismatch');
    // A timed-out upload response cannot invalidate saved evidence. The ordinary receipt validator still decides completion.
    let result=['read','stage'].includes(c.action)&&!message.result?.receiptId?message.result:uploaded?.result||message.result;
    if(uploaded&&result===uploaded.result&&uploaded.fingerprint!==contentHash(JSON.stringify(result)))throw syncError('receipt_changed');
    // Legacy Workers encoded cancelled captures as apply references despite having no upload.
    if(result?.receiptId&&c.action==='capture'&&result.status==='cancelled')result={status:'cancelled',files:[]};
    if(result?.receiptId)throw syncError('receipt_missing');
    if(result?.captureId){const bundle=this.db.get('sourceSyncUploads',c.id)?.bundle;if(!bundle)throw syncError('manifest_missing');
      if(result.captureId!==c.id||c.action!=='capture')throw syncError('receipt_owner_mismatch');
      if(!bundle.manifest.metadataOnly&&!c.result&&!retiring(this.db.get('sourceSyncBatches',c.batchId)))for(const entry of entries(bundle))if(!await this.storage.has(c.projectId,entry))throw syncError('blob_missing');
      result={status:'completed',...bundle};
    }
    if(!['completed','partial_conflict','cancelled','blocked'].includes(result?.status)){
      if(!c.result)this.sync.acceptReceipt(nodeId,{commandId:c.id,result});
      return;
    }
    this.sync.validateReceipt(c,result);
    const receiptHash=contentHash(JSON.stringify(result));
    if(message.receiptHash&&message.receiptHash!==receiptHash)throw syncError('receipt_changed');
    const batch=this.db.get('sourceSyncBatches',c.batchId);
    if(c.result&&contentHash(JSON.stringify(c.result))!==receiptHash||batch?.status==='cancelled'&&!(c.detection==='metadata'&&c.action==='cleanup')){
      // Receipt delivery is complete, not the operation. Keep both outcomes and the original terminal status.
      const id=`${c.id}:${receiptHash}`,ack={type:'source_sync_receipt_ack',commandId:c.id,receiptHash,disposition:'recorded_terminal'};
      this.db.transaction(()=>{
        if(!this.db.get('sourceSyncLateReceipts',id))this.db.put('sourceSyncLateReceipts',{id,commandId:c.id,projectId:c.projectId,nodeId,result,receivedAt:new Date().toISOString()});
        this.db.put('sourceSyncReceiptAcks',{id,projectId:c.projectId,nodeId,ack});
      });
      this.socket(nodeId)?.send(JSON.stringify(ack));return;
    }
    if(c.detection==='metadata'&&['read','stage'].includes(c.action)&&result.status==='completed'&&!c.result&&!retiring(batch)){
      const storage=this.storage.scoped(c.batchId);
      for(const f of result.files)if(f.entry&&!(c.action==='read'&&c.paths.find(p=>p.path===f.path)?.compare)&&!await storage.has(c.projectId,f.entry))throw syncError('blob_missing');
      const stages=this.db.listSourceSyncCommands({batchId:c.batchId,action:'stage'}).map(x=>x.id===c.id?{...x,result}:x);
      const reads=this.db.listSourceSyncCommands({batchId:c.batchId,action:'read'});
      if(c.action==='stage'&&stages.every(x=>x.result?.status==='completed'))for(const op of batch.metadataOperations||[]){
        if(op.source)continue;
        const sides=batch.nodeIds.map(n=>reads.find(r=>r.repositoryId===op.repositoryId&&r.nodeId===n)?.result.files.find(f=>f.path===op.path)?.entry||null);
        if(!['resolution','initialize_overwrite'].includes(op.decision)&&contentEqual(sides[0],sides[1]))continue;
        for(const entry of sides.filter(Boolean))await this.storage.receive(c.projectId,entry,Readable.from(await storage.read(c.projectId,entry.hash)));
      }
    }
    this.sync.acceptReceipt(nodeId,{commandId:c.id,result});
    const saved=this.db.get('sourceSyncCommands',c.id)?.result;
    // Only a validated, committed result can clear the matching Worker outbox; transient observations are not acknowledgments.
    if(saved){const ack={type:'source_sync_receipt_ack',commandId:c.id,receiptHash:contentHash(JSON.stringify(saved))};
      this.db.put('sourceSyncReceiptAcks',{id:`${c.id}:${ack.receiptHash}`,projectId:c.projectId,nodeId,ack});this.socket(nodeId)?.send(JSON.stringify(ack));}
    this.change();await this.tick();
  }
  async workerHttp(req,res,pathname){
    const m=pathname.match(/^\/api\/worker\/source-sync\/([a-f0-9]{64})\/(plan|capture|receipt|blobs)(?:\/([a-f0-9]{64}))?$/);if(!m)return false;
    const c=this.db.get('sourceSyncCommands',m[1]);
    if(!c||!matches(req.headers.authorization||'',`Bearer ${c.secret}`)){json(res,{error:'Unauthorized'},401);return true;}
    const batch=this.db.get('sourceSyncBatches',c.batchId);
    const evidenceRequest=req.method==='PUT'&&['capture','receipt'].includes(m[2])||req.method==='GET'&&m[2]==='receipt';
    if(!this.db.get('projects',c.projectId)||!batch||batch.status==='cancelled'&&!evidenceRequest&&!(c.detection==='metadata'&&c.action==='cleanup'))throw syncError('batch_inactive');
    if(m[2]==='receipt'&&req.method==='GET'){
      // A small proof avoids retransmitting historical manifests over a slow or recovering connection.
      const uploaded=c.action!=='capture'?this.db.get('sourceSyncUploadReceipts',c.id)?.result:null;
      const bundle=c.action==='capture'&&(c.result||batch.status==='cancelled')?this.db.get('sourceSyncUploads',c.id)?.bundle:null;
      const result=(['read','stage'].includes(c.action)&&!c.result?null:uploaded)||(bundle?{status:'completed',...bundle}:null);
      json(res,{receiptHash:result?contentHash(JSON.stringify(result)):null});return true;
    }
    if(m[2]==='plan'&&req.method==='GET'&&c.detection==='metadata'&&c.action!=='cleanup'&&batch.metadataCleanedAt)throw syncError('batch_inactive');
    if(m[2]==='plan'&&req.method==='GET'){const {result,lastResult,secret,status,lastSentAt,ackedAt,receivedAt,...plan}=c;json(res,plan);return true;}
    if(m[2]==='receipt'&&req.method==='PUT'&&c.action!=='capture'){
      const result=await body(req);if(!Array.isArray(result.files)||result.files.length>10000)throw syncError('invalid_receipt');
      const fingerprint=contentHash(JSON.stringify(result)),old=this.db.get('sourceSyncUploadReceipts',c.id);
      if(old&&old.fingerprint!==fingerprint)throw syncError('receipt_changed');
      this.sync.validateReceipt(c,result);
      this.db.put('sourceSyncUploadReceipts',{id:c.id,projectId:c.projectId,result,fingerprint});
      const missing=[];if(['read','stage'].includes(c.action)&&!c.result&&!retiring(batch))for(const f of result.files)if(f.entry&&!(c.action==='read'&&c.paths.find(p=>p.path===f.path)?.compare)&&!await this.storage.scoped(c.batchId).has(c.projectId,f.entry))missing.push(f.entry);json(res,{stored:true,missing});return true;
    }
    if(m[2]==='capture'&&req.method==='PUT'&&c.action==='capture'){
      const bundle=await body(req);
      // Reject old captures before accepting any content uploads, not after their bytes have been staged.
      for(const s of [bundle.base,bundle.manifest])(c.detection==='metadata'?validateMetadataCapture:validateSourceCapture)(s,c);
      if(c.scopeKind!=='directory'&&(bundle.base.baseCommit!==bundle.manifest.baseCommit||c.baseCommit&&c.baseCommit!==bundle.base.baseCommit))throw syncError('git_baseline_mismatch');
      const fingerprint=contentHash(JSON.stringify(bundle)),old=this.db.get('sourceSyncUploads',c.id);
      if(old&&old.fingerprint!==fingerprint)throw syncError('capture_changed');
      if(batch.detection!=='metadata'&&batch.contentMode==='source-and-outputs'&&!c.result&&batch.status!=='cancelled'){
        const offered=new Set();let bytes=0;
        for(const capture of this.db.listSourceSyncCommands({projectId:c.projectId,batchId:c.batchId,action:'capture'})){
          const snapshot=capture.id===c.id?bundle.manifest:this.db.get('sourceSyncUploads',capture.id)?.bundle.manifest;
          for(const [path,entry] of Object.entries(snapshot?.entries||{})){
            if(!entry||entryEqual(entry,capture.baselineEntries?.[path]||null)||offered.has(entry.hash))continue;
            offered.add(entry.hash);bytes+=entry.size;
            if(bytes>SOURCE_SYNC_LIMITS.batchBytes)throw syncLimitError('batch_too_large','batch',SOURCE_SYNC_LIMITS.batchBytes,bytes,path);
          }
        }
      }
      this.db.put('sourceSyncUploads',{id:c.id,projectId:c.projectId,bundle,fingerprint});
      // Terminal commands only retain late evidence; they cannot consume source blobs or advance a version.
      if(bundle.manifest.metadataOnly||c.result||retiring(batch)){json(res,{missing:[]});return true;}
      const missing=[];for(const entry of new Map(entries(bundle).map(e=>[e.hash,e])).values())if(!await this.storage.has(c.projectId,entry))missing.push(entry);
      json(res,{missing});return true;
    }
    if(m[2]==='blobs'&&m[3]){
      const bundle=this.db.get('sourceSyncUploads',c.id)?.bundle;
      const allowed=['read','stage'].includes(c.action)?(this.db.get('sourceSyncUploadReceipts',c.id)?.result.files||[]).map(f=>f.entry).filter(Boolean):c.action==='capture'&&bundle?entries(bundle):(c.changes||[]).map(x=>x.after).filter(Boolean);
      const storage=c.detection==='metadata'?this.storage.scoped(c.batchId):this.storage;
      const entry=allowed.find(e=>e.hash===m[3]);if(!entry)throw syncError('blob_not_in_command');
      if(req.method==='PUT'&&['capture','read','stage'].includes(c.action)){if(c.detection==='metadata'&&(c.result||retiring(batch)||['cleaning','completed','partial_conflict'].includes(batch.status))){req.resume();json(res,{stored:false,terminal:true});return true;}if(bundle?.manifest.metadataOnly)throw syncError('preview_metadata_only');json(res,await storage.receive(c.projectId,entry,req));return true;}
      if(req.method==='GET'&&c.action==='apply'){const bytes=await storage.read(c.projectId,entry.hash);res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':bytes.length,'Cache-Control':'no-store'});res.end(bytes);return true;}
    }
    throw syncError('invalid_sync_action');
  }
  async browserHttp(req,res,pathname){const m=pathname.match(/^\/api\/projects\/([^/]+)\/source-sync(?:\/(.*))?$/);if(!m)return false;
    const projectId=m[1],route=m[2]||'';if(!this.db.get('projects',projectId))throw syncError('project_missing');
    let value;
    if(req.method==='GET'&&!route)value={...this.sync.status(projectId),initializations:this.db.db.prepare("SELECT data FROM records WHERE kind='sourceSyncInitializations' AND json_extract(data,'$.projectId')=? ORDER BY rowid DESC LIMIT 20").all(projectId).map(r=>JSON.parse(r.data))};
    else if(req.method==='GET'&&route==='pending'){const q=new URL(req.url,'http://localhost').searchParams;value=this.baselines.pending(projectId,q.get('repositoryId'),{after:q.get('after')||'',limit:q.get('limit')});}
    else if(req.method==='GET'&&route==='initializations')value=this.db.db.prepare("SELECT data FROM records WHERE kind='sourceSyncInitializations' AND json_extract(data,'$.projectId')=? ORDER BY rowid DESC LIMIT 20").all(projectId).map(r=>JSON.parse(r.data));
    else if(req.method==='POST'&&route==='initializations')value=this.baselines.start(projectId,await body(req,100000));
    else if(req.method==='POST'&&/^initializations\/[a-f0-9]{64}\/resume$/.test(route))value=this.baselines.resume(projectId,route.split('/')[1]);
    else if(req.method==='GET'&&route==='config')value=this.sync.config(projectId);
    else if(req.method==='PUT'&&route==='config')value=this.sync.configure(projectId,await body(req,100000));
    else if(req.method==='POST'&&route==='preview')value=this.sync.preview(projectId,await body(req,100000));
    else if(req.method==='POST'&&route==='batches')value=this.sync.request(projectId,await body(req,100000));
    else if(req.method==='POST'&&/^batches\/[a-f0-9]{64}\/cancel$/.test(route))value=this.sync.cancel(projectId,route.split('/')[1],(await body(req,100000)).revision);
    else if(req.method==='GET'&&/^batches\/[a-f0-9]{64}$/.test(route)){
      const batch=this.db.get('sourceSyncBatches',route.split('/')[1]);if(batch?.projectId!==projectId)throw syncError('batch_changed');
      value={batch:{...batch,fingerprint:undefined},captures:this.db.listSourceSyncCommands({projectId,batchId:batch.id,action:'capture'}).map(c=>({nodeId:c.nodeId,repositoryId:c.repositoryId,status:c.status,root:c.root,entries:c.result?.manifest?.entries,newlyIncluded:c.result?.manifest?.newlyIncluded,excluded:c.result?.manifest?.excluded,reason:c.result?.reason,limit:c.result?.limit}))};
    }
    else if(req.method==='GET'&&/^conflicts\/[^/]+$/.test(route))value=await this.agent.execute({projectId},'read',{conflictId:route.split('/')[1]});
    else if(req.method==='POST'&&/^conflicts\/[^/]+\/read$/.test(route))value=await this.agent.execute({projectId},'read',{...await body(req,100000),conflictId:route.split('/')[1]});
    else if(req.method==='POST'&&/^conflicts\/[^/]+\/resolve$/.test(route)){
      const c=this.db.get('sourceSyncConflicts',route.split('/')[1]),input=await body(req,100000);
      if(c?.projectId!==projectId||c.detection!=='metadata'||c.generation!==input.generation||input.confirmed!==true||['resolved','cancelled'].includes(c.status))throw syncError('conflict_changed');
      const side=c.sides.find(s=>s.nodeId===input.sourceNodeId);if(!side||side.unknown)throw syncError('invalid_scope');
      value=this.sync.resolve(c,{id:contentHash(JSON.stringify([c.id,c.generation,side.nodeId])),entry:side.entry,sourceNodeId:side.nodeId,sourceRoot:side.root});
    }
    else if(req.method==='POST'&&/^conflicts\/[^/]+\/(assign|review)$/.test(route)){
      const id=route.split('/')[1],input=await body(req,100000);if(this.db.get('sourceSyncConflicts',id)?.projectId!==projectId)throw syncError('conflict_missing');
      value=route.endsWith('/assign')?this.conflicts.assign(id,input.generation,input.roleId,{kind:'human'}):this.conflicts.acceptReview(id,input.generation,input.proposalId);
    }
    else throw syncError('invalid_sync_action');
    await this.tick();json(res,value);return true;
  }
  /** A Worker may hydrate only manifests frozen on this active Run, never an arbitrary project hash. */
  async inputHttp(req,res,pathname){
    const candidate=pathname.match(/^\/api\/agent\/source-candidates\/([^/]+)\/([a-f0-9]{64})\/blob$/);
    if(candidate&&req.method==='PUT'){
      const run=this.db.get('runs',candidate[1]);if(!run||['succeeded','failed','interrupted','reconciling','stopping'].includes(run.status))throw syncError('candidate_not_ready');
      const value=this.agent.candidate(run,candidate[2]);if(!value.scopeVerified||!value.entry)throw syncError('candidate_not_ready');json(res,await this.storage.receive(run.projectId,value.entry,req));return true;
    }
    const m=pathname.match(/^\/api\/agent\/source-inputs\/([^/]+)\/([^/]+)(?:\/blobs\/([a-f0-9]{64}))?$/);if(!m||req.method!=='GET')return false;
    const run=this.db.get('runs',m[1]),input=run?.sourceInputs?.find(v=>v.manifestId===m[2]);
    if(!input||['succeeded','failed','interrupted'].includes(run.status)||!this.db.get('projects',run.projectId))throw syncError('source_input_not_ready');
    const version=this.db.get('sourceSyncVersions',input.manifestId);if(!version||version.projectId!==run.projectId||version.digest!==input.manifestHash)throw syncError('source_input_changed');
    if(!m[3]){json(res,version);return true;}
    if(!Object.values(version.entries).some(e=>e?.hash===m[3]))throw syncError('blob_not_in_command');
    const bytes=await this.storage.read(run.projectId,m[3]);res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':bytes.length,'Cache-Control':'no-store'});res.end(bytes);return true;
  }
}

/** Network replay carries metadata receipts, not full manifests or source bytes on the event outbox. */
export class SourceSyncClient {
  constructor({db,data,home,send,resolveBinding,activeRuns,takeoverState,paused,withFolderAccess=(message,command,fn)=>fn()}){
    Object.assign(this,{db,home,send,paused,withFolderAccess});this.blobRoot=join(data,'source-sync-blobs');this.inFlight=new Set();this.sent=new Map();
    // Resource hints never grant apply permission. Refresh at most once per second, not once per file.
    let loadAt=-Infinity,loaded=new Set();const terminals=new Map();
    const observationBusy=projectId=>{const at=Date.now();if(at-loadAt>=1000){loaded=new Set((activeRuns?.()||[]).filter(r=>!['succeeded','failed','interrupted'].includes(r.status)).map(r=>r.projectId));loadAt=at;terminals.clear();}
      if(!terminals.has(projectId))terminals.set(projectId,Boolean(takeoverState?.(projectId)));return loaded.size>0||terminals.get(projectId);};
    this.worker=new SourceSyncWorker({db,blobRoot:this.blobRoot,resolveBinding,activeRuns,takeoverState,paused,observationBusy});
    this.watch=new SourceSyncWatch({db,send,resolveBinding,busy:observationBusy,blocked:projectId=>Boolean(db.get('sourceSyncReservations',projectId))});
  }
  async request(message,path,method='GET',value){
    const response=await fetch(`${this.home}/api/worker/source-sync/${message.commandId}/${path}`,{method,headers:{Authorization:`Bearer ${message.secret}`,...(value&&!Buffer.isBuffer(value)?{'Content-Type':'application/json'}:{})},body:value===undefined?undefined:Buffer.isBuffer(value)?value:JSON.stringify(value),signal:AbortSignal.timeout(60000)});
    if(!response.ok){const result=await response.json();throw Object.assign(syncError(result.code||'transfer_failed',result.error||''),result.limit?{limit:result.limit}:{});}return response;
  }
  async execute(message){
    if(this.inFlight.has(message.commandId))return;
    this.inFlight.add(message.commandId);
    try{
      const settled=this.db.get('sourceSyncTransport',message.commandId);
      if(settled?.terminalResult){
        if(!this.db.get('sourceSyncReceipts',message.commandId))this.db.put('sourceSyncReceipts',{id:message.commandId,projectId:settled.projectId,result:settled.terminalResult,createdAt:new Date().toISOString()});
        this.send(receiptEnvelope(message.commandId,settled.terminalResult));return;
      }
      const prior=this.db.get('sourceSyncCommands',message.commandId);
      const command=prior?.result&&prior.command?prior.command:await (await this.request(message,'plan')).json();
      if(command.detection==='metadata'&&command.action==='cleanup'&&[...this.inFlight].some(id=>{if(id===command.id)return false;const batchId=this.db.get('sourceSyncTransport',id)?.batchId||this.db.get('sourceSyncCommands',id)?.command?.batchId;return !batchId||batchId===command.batchId;})){
        this.send({type:'source_sync_receipt',commandId:command.id,result:{status:'waiting_idle',reason:'transfer_in_flight'}});return;
      }
      // A delayed command must not repopulate staging after this Worker's durable cleanup receipt.
      if(command.detection==='metadata'&&command.action!=='cleanup'&&!prior?.result&&this.db.db.prepare("SELECT 1 FROM records WHERE kind='sourceSyncCommands' AND json_extract(data,'$.command.batchId')=? AND json_extract(data,'$.command.action')='cleanup' AND json_extract(data,'$.result.status')='completed' LIMIT 1").get(command.batchId)){
        this.send(receiptEnvelope(command.id,{status:'cancelled',files:[]}));return;
      }
      const blobRoot=command.detection==='metadata'?metadataBlobRoot(this.blobRoot,command):this.blobRoot;
      const transport=this.db.get('sourceSyncTransport',command.id);
      this.db.put('sourceSyncTransport',{...transport,id:command.id,projectId:command.projectId,batchId:command.batchId,message,ready:false});
      this.send({type:'source_sync_command_ack',commandId:command.id});
      const saved=this.db.get('sourceSyncCommands',command.id)?.result;
      // Receipt replay needs only the saved result; execute still checks the exact command fingerprint below.
      if(command.action==='apply'&&!['completed','partial_conflict','cancelled','blocked'].includes(saved?.status))for(const entry of new Map(command.changes.map(c=>c.after).filter(Boolean).map(e=>[e.hash,e])).values()){
        let present=false;try{present=(await readSourceBlob(blobRoot,entry.hash)).length===entry.size;}catch{}
        if(!present){const r=await this.request(message,`blobs/${entry.hash}`),bytes=Buffer.from(await r.arrayBuffer());if(bytes.length!==entry.size||contentHash(bytes)!==entry.hash)throw syncError('blob_corrupt');await saveSourceBlob(blobRoot,bytes);}
      }
      const result=await this.withFolderAccess(message,command,()=>this.worker.execute(command));
      this.watch.received(command,result);
      let alreadyUploaded=false;
      if(saved)try{const proof=await (await this.request(message,'receipt')).json();alreadyUploaded=proof.receiptHash===contentHash(JSON.stringify(result));}catch{ /* Old Homes can still accept the original upload path. */ }
      if(!alreadyUploaded&&result.status==='completed'&&command.action==='capture'){
        const needed=await (await this.request(message,'capture','PUT',{base:result.base,manifest:result.manifest})).json();
        for(const entry of needed.missing)await this.request(message,`blobs/${entry.hash}`,'PUT',await readSourceBlob(blobRoot,entry.hash));
      }
      if(!alreadyUploaded&&command.action!=='capture'&&Array.isArray(result.files)){const needed=await (await this.request(message,'receipt','PUT',result)).json();for(const entry of needed.missing||[])await this.request(message,`blobs/${entry.hash}`,'PUT',await readSourceBlob(blobRoot,entry.hash));
        if(['read','stage'].includes(command.action)&&result.status==='completed')await confirmMetadataRead(command,(await this.worker.resolveBinding(command)).root,result);
      }
      this.db.put('sourceSyncTransport',{...this.db.get('sourceSyncTransport',command.id),ready:true,recoveryAttempts:0,nextRecoveryAt:0});
      this.flush();
      if(!['completed','partial_conflict','cancelled'].includes(result.status))this.send({type:'source_sync_receipt',commandId:command.id,result});
    }catch(error){
      const transport=this.db.get('sourceSyncTransport',message.commandId),attempts=(transport?.recoveryAttempts||0)+1;
      if(this.retainQuotaResult(transport,message.commandId,error))return;
      if(!transportFailure(error)&&this.db.get('sourceSyncCommands',message.commandId)?.command?.detection==='metadata'){const result={status:'blocked',reason:error.code};this.db.put('sourceSyncTransport',{...transport,ready:true,terminalResult:result});this.db.put('sourceSyncReceipts',{id:message.commandId,projectId:transport.projectId,result});this.send(receiptEnvelope(message.commandId,result));return;}
      if(transport)this.db.put('sourceSyncTransport',{...transport,recoveryAttempts:attempts,nextRecoveryAt:Date.now()+retryDelay(attempts),recoveryError:transportFailure(error)?'transfer_failed':error.code});
      this.send({type:'source_sync_receipt',commandId:message.commandId,result:{status:transportFailure(error)?'reconciling':'blocked',reason:transportFailure(error)?'transfer_failed':error.code,...(error.limit?{limit:error.limit}:{})}});
    }finally{this.inFlight.delete(message.commandId);}
  }
  acknowledge(id,message={}){
    const receipt=this.db.get('sourceSyncReceipts',id);
    // Old Homes send no result hash. Keep that receipt until a matching confirmation arrives after upgrade.
    if(!receipt||message.disposition!=='project_deleted'&&message.receiptHash!==contentHash(JSON.stringify(receipt.result)))return;
    const transport=this.db.get('sourceSyncTransport',id);
    if(transport)this.db.put('sourceSyncTransport',{...transport,acknowledgedAt:new Date().toISOString(),receiptDisposition:message.disposition||'accepted',receiptHash:message.receiptHash});
    this.db.remove('sourceSyncReceipts',id);this.sent.delete(id);
  }
  cancel(id){
    this.db.put('sourceSyncCancellations',{id});
    if(this.inFlight.has(id))return;
    const record=this.db.get('sourceSyncCommands',id),transport=this.db.get('sourceSyncTransport',id);
    if(record&&!record.result){
      // Restart loses the in-memory flight, not the journal. Recover before claiming cancellation.
      if(transport?.message){void this.execute(transport.message);return;}
      this.send({type:'source_sync_receipt',commandId:id,result:{status:'reconciling',reason:'recovery_required'}});return;
    }
    // Home may never have stored this capture's manifest; offer the saved one again before the receipt, never a recapture.
    if(record?.command?.detection==='metadata'&&Array.isArray(record.result?.files)&&!transport?.terminalResult&&transport?.message){void this.execute(transport.message);return;}
    if(record?.result?.base&&!transport?.terminalResult&&transport?.message){void this.replayCapture(id,record.result,transport.message);return;}
    this.send(receiptEnvelope(id,transport?.terminalResult||record?.result||{status:'cancelled',files:[]}));
  }
  async replayCapture(id,result,message){
    if(this.inFlight.has(id))return;
    this.inFlight.add(id);
    try{
      await this.request(message,'capture','PUT',{base:result.base,manifest:result.manifest});
      this.send(receiptEnvelope(id,result));
    }catch(error){
      // Only a quota rejection becomes terminal; anything else keeps the saved capture receipt for the next reminder.
      this.retainQuotaResult(this.db.get('sourceSyncTransport',id),id,error);
    }finally{this.inFlight.delete(id);}
  }
  /** Capture success is evidence, not successful transfer. Retain it and acknowledge the terminal quota result separately. */
  retainQuotaResult(transport,commandId,error){
    if(!transport||!error.limit||transportFailure(error))return false;
    const result={status:'blocked',reason:error.code,limit:error.limit};
    this.db.transaction(()=>{this.db.put('sourceSyncTransport',{...transport,ready:true,terminalResult:result,nextReceiptAt:0});this.db.put('sourceSyncReceipts',{...this.db.get('sourceSyncReceipts',commandId),id:commandId,projectId:transport.projectId,result,createdAt:new Date().toISOString()});});
    this.send({type:'source_sync_receipt',commandId,result,receiptHash:contentHash(JSON.stringify(result))});return true;
  }
  flush(){
    const at=Date.now(),exclude=[...this.inFlight];
    for(const transport of this.db.sourceReceiptTransports({at,exclude})){
      const receipt=this.db.get('sourceSyncReceipts',transport.id);if(!receipt)continue;
      const attempts=(transport.receiptAttempts||0)+1;
      this.db.put('sourceSyncTransport',{...transport,receiptAttempts:attempts,nextReceiptAt:at+retryDelay(attempts)});
      this.send(receiptEnvelope(receipt.id,receipt.result));this.sent.set(receipt.id,at);
    }
    // Recover a lost upload response from saved bytes, one command at a time; never recapture or reapply.
    if(!this.inFlight.size)for(const transport of this.db.sourceReceiptTransports({ready:false,at,limit:1}))void this.execute(transport.message);
  }
}
