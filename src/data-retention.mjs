import {readdir,stat} from 'node:fs/promises';
import {unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {contentHash} from './source-sync-manifest.mjs';

/**
 * Data retention for Home and Worker stores. What each side keeps forever (chat history, session turns, attachments,
 * run logs) is never touched here. What is reclaimed is bookkeeping that has finished its job:
 * - source-sync command records (each carries a full file list in its command and again in its result), once their batch
 *   is terminal and the other side has acknowledged them;
 * - on a Worker, content blobs captured for a sync that no remaining command refers to;
 * - on Home, manifest versions beyond the newest N per repository that nothing refers to.
 * A plan lists what qualifies (the Data page shows it); cleanup deletes it in small batches, yielding between them, so a
 * pass never stalls requests. VACUUM, the only step that locks the file, runs separately when the caller says it is idle.
 */
export const RETENTION_DEFAULTS=Object.freeze({syncCommandDays:1,blobDays:7,manifestVersions:20});
const DAY=86400000,TERMINAL=new Set(['completed','partial_conflict','cancelled','blocked']);
const TERMINAL_BATCH=new Set(['completed','partial_conflict','blocked','cancelled','preview_ready','evidence_ready']);
const HASH=/[a-f0-9]{64}/g;
const COMMAND_PAYLOADS=['sourceSyncTransport','sourceSyncUploads','sourceSyncUploadReceipts'];
// These are the plan's inputs. Store revisions also invalidate on direct SQL or another connection's writes.
const RETENTION_KINDS=['sourceSyncBatches','sourceSyncCommands','sourceSyncTransport','sourceSyncReceipts','sourceSyncReceiptAcks','sourceSyncJournals','sourceSyncCancellations','workspaces','repositoryWorkspaces','sourceSyncConflicts','runs','sourceSyncVersions','sourceSyncWatchStates'];

export function normalizeRetention(value={}){
 const days=(v,fallback,max)=>{const n=Number(v);return Number.isFinite(n)&&n>=0&&n<=max?Math.round(n*100)/100:fallback;};
 return {syncCommandDays:days(value.syncCommandDays,RETENTION_DEFAULTS.syncCommandDays,365),blobDays:days(value.blobDays,RETENTION_DEFAULTS.blobDays,365),
  manifestVersions:Math.max(1,Math.min(500,Math.round(Number(value.manifestVersions))||RETENTION_DEFAULTS.manifestVersions))};
}

function commandExpired({resultStatus, worker, transport, pendingReceipt, batch, receivedAt, ackedAt},policy,now){
 if(!TERMINAL.has(resultStatus))return false;
 if(worker){
  if(pendingReceipt||transport?.ready===false)return false;
  const acknowledged=Date.parse(transport?.acknowledgedAt||'');
  return Number.isFinite(acknowledged)&&now-acknowledged>=policy.syncCommandDays*DAY;
 }
 if(!TERMINAL_BATCH.has(batch?.status)||batch.detection==='metadata'&&!batch.metadataCleanedAt)return false;
 const receipts=[receivedAt,ackedAt].map(v=>Date.parse(v||'')).filter(Number.isFinite);
 if(!receipts.length)return false;
 const timestamps=[...receipts,Date.parse(batch.updatedAt||batch.createdAt||'')].filter(Number.isFinite);
 return now-Math.max(...timestamps)>=policy.syncCommandDays*DAY;
}
const yieldRequests=()=>new Promise(resolve=>setImmediate(resolve));
/** Count bounded physical-row pages. octet_length reads stored byte lengths without loading large TEXT bodies. */
async function sizes(db){
 const totals=Object.create(null),end=db.db.prepare('SELECT MAX(rowid) AS r FROM records').get().r;
 const read=db.db.prepare('SELECT rowid AS r,kind,octet_length(data) AS bytes FROM records WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 8');
 let last=0;
 for(;;){
  const batch=read.all(last,end||0);if(!batch.length)return totals;
  for(const r of batch){last=r.r;const total=totals[r.kind]||={count:0,bytes:0};total.count++;total.bytes+=r.bytes||0;}
  await yieldRequests();
 }
}
/**
 * Use the existing (kind,id) primary key, never a kind filter followed by a rowid sort that copies large bodies.
 * Each query finishes before yielding. Only decision metadata enters JS; a blob hash scan fetches one body separately.
 */
async function* field(db,kind,paths){
 const columns=['rowid AS r','id',...paths.map((p,i)=>`${p.startsWith('!')?p.slice(1):`json_extract(data,'$.${p}')`} AS f${i}`)].join(',');
 const end=db.db.prepare('SELECT id FROM records WHERE kind=? ORDER BY id DESC LIMIT 1').get(kind)?.id;
 if(end===undefined)return;
 const first=db.db.prepare(`SELECT ${columns} FROM records WHERE kind=? AND id<=? ORDER BY id LIMIT 4`);
 const next=db.db.prepare(`SELECT ${columns} FROM records WHERE kind=? AND id>? AND id<=? ORDER BY id LIMIT 4`);
 let last=null;
 for(;;){
  const batch=last===null?first.all(kind,end):next.all(kind,last,end);if(!batch.length)return;
  for(const r of batch){last=r.id;yield r;}
  await yieldRequests();
 }
}
const recordBytes=(db,row)=>db.db.prepare('SELECT octet_length(data) AS bytes FROM records WHERE rowid=?').get(row.r)?.bytes||0;
const body=(db,row)=>db.db.prepare('SELECT data FROM records WHERE rowid=?').get(row.r)?.data||'';

/**
 * A Worker's capture record holds the scope's whole file list twice, as the command's baseline and the result's manifest:
 * up to 5 MB a row, plus a list of excluded paths. Once Home has acknowledged the receipt, these lists are dropped in
 * place, inside SQLite (no row is parsed here). The row
 * itself still goes when the retention period ends. Returns whether the row was compacted.
 */
export function compactSyncCommand(db,id){
 const changed=db.db.prepare(`UPDATE records SET data=json_remove(json_set(data,'$.command.baselineEntries',json('null'),'$.result.manifest.entries',json('null'),'$.compacted',json('true')),'$.result.manifest.excluded')
  WHERE kind='sourceSyncCommands' AND id=? AND json_extract(data,'$.command.action')='capture'
  AND json_extract(data,'$.result.status') IN ('completed','partial_conflict','cancelled','blocked')
  AND (json_type(data,'$.command.baselineEntries')='object' OR json_type(data,'$.result.manifest.entries')='object'
   OR json_type(data,'$.result.manifest.excluded')='array')
  AND EXISTS(SELECT 1 FROM records t WHERE t.kind='sourceSyncTransport' AND t.id=records.id
   AND json_extract(t.data,'$.acknowledgedAt') IS NOT NULL)
  AND NOT EXISTS(SELECT 1 FROM records r WHERE r.kind='sourceSyncReceipts' AND r.id=records.id)`).run(id).changes>0;
 if(changed)db.recordChanged?.('sourceSyncCommands');
 return changed;
}
/** The same for records acknowledged before this existed, five rows at a time so requests keep being served. */
export async function compactAcknowledgedCommands(db,{chunk=5}={}){
 let last=0,count=0;
 for(;;){
  const rows=db.db.prepare(`SELECT c.rowid AS r,c.id FROM records c JOIN records t ON t.kind='sourceSyncTransport' AND t.id=c.id
   WHERE c.kind='sourceSyncCommands' AND c.rowid>? AND json_extract(t.data,'$.acknowledgedAt') IS NOT NULL ORDER BY c.rowid LIMIT ?`).all(last,chunk);
  if(!rows.length)return count;
  for(const row of rows){last=row.r;if(compactSyncCommand(db,row.id))count++;}
  await new Promise(resolve=>setImmediate(resolve));
 }
}

/** Which records and blobs the policy lets go right now. Pure: nothing is deleted. */
export async function retentionPlan(db,{policy=RETENTION_DEFAULTS,blobRoot=null,now=Date.now()}={}){
 const p=normalizeRetention(policy),plan={records:[],blobs:[],bytes:0,blobBytes:0,kept:{}};
 const drop=(kind,id,bytes,commandId)=>{plan.records.push({kind,id,bytes,...(commandId?{commandId}:{})});plan.bytes+=bytes;};
 // Metadata queries stay bounded even when the corresponding command or manifest has megabytes of entries.
 const batches=new Map();for await(const r of field(db,'sourceSyncBatches',['status','updatedAt','createdAt','detection','metadataCleanedAt']))
  batches.set(r.id,{status:r.f0,updatedAt:r.f1,createdAt:r.f2,detection:r.f3,metadataCleanedAt:r.f4});
 const transports=new Map();for await(const r of field(db,'sourceSyncTransport',['ready','acknowledgedAt']))transports.set(r.id,{ready:r.f0===0?false:r.f0,acknowledgedAt:r.f1,r:r.r});
 const receipts=new Set();for await(const r of field(db,'sourceSyncReceipts',[]))receipts.add(r.id);
 // Downloads precede command persistence; captures publish their hashes only when finished.
 let blobsBusy=[...transports.values()].some(t=>t.ready===false);
 // Copy hashes so V8 does not retain a whole body via string slices. Home never needs blob references.
 const referenced=new Set(),remember=text=>{for(const h of text.match(HASH)||[])referenced.add(Buffer.from(h,'latin1').toString('latin1'));};
 const commandFields=["!json_type(data,'$.command')='object'",'result.status','batchId','receivedAt','ackedAt','status'];
 for await(const r of field(db,'sourceSyncCommands',commandFields)){
  const id=r.id,worker=r.f0===1,t=transports.get(id);
  if(worker&&!TERMINAL.has(r.f1))blobsBusy=true;
  if(r.f5!=='reconciling'&&commandExpired({resultStatus:r.f1,worker,transport:t,pendingReceipt:receipts.has(id),
    batch:batches.get(r.f2),receivedAt:r.f3,ackedAt:r.f4},p,now)){
   drop('sourceSyncCommands',id,recordBytes(db,r));
   if(t)drop('sourceSyncTransport',id,recordBytes(db,t),id);
  }else if(blobRoot)remember(body(db,r));
 }
 // Compacted captures no longer name their files' blobs; the Worker's latest snapshot of each scope still does.
 if(blobRoot)for await(const r of field(db,'sourceSyncWatchStates',[]))remember(body(db,r));
 // Home-side receipt-ack cache and Worker-side journals/cancellations belong to their command.
 const dropped=new Set(plan.records.filter(x=>x.kind==='sourceSyncCommands').map(x=>x.id));
 for(const kind of ['sourceSyncReceiptAcks','sourceSyncJournals','sourceSyncCancellations','sourceSyncUploads','sourceSyncUploadReceipts']){
  const direct=kind==='sourceSyncUploads'||kind==='sourceSyncUploadReceipts';
  for await(const r of field(db,kind,direct?[]:['commandId','status'])){
   const owner=direct?r.id:r.f0||r.id.split(':')[0];
   if(dropped.has(owner)&&!['preparing','prepared'].includes(r.f1))drop(kind,r.id,recordBytes(db,r),owner);
  }
 }
 // Manifest versions: the newest N per repository stay, as does anything a binding or an open conflict still names.
 const named=new Set();
 for(const kind of ['workspaces','repositoryWorkspaces'])for await(const r of field(db,kind,['sourceBaseManifestId']))if(r.f0)named.add(r.f0);
 for await(const r of field(db,'sourceSyncConflicts',['status']))if(r.f0==='open')for(const h of body(db,r).match(HASH)||[])named.add(Buffer.from(h,'latin1').toString('latin1'));
 // A run still to start or running carries the manifest versions its inputs were frozen at.
 for await(const r of field(db,'runs',['status',"!CASE WHEN json_extract(data,'$.status') NOT IN ('succeeded','failed','interrupted') OR json_extract(data,'$.status') IS NULL THEN json_extract(data,'$.sourceInputs') END"])){
  if(['succeeded','failed','interrupted'].includes(r.f0))continue;
  for(const input of JSON.parse(r.f1||'null')||[])if(input?.manifestId)named.add(input.manifestId);
 }
 const perRepo=new Map(),versions=[];
 for await(const r of field(db,'sourceSyncVersions',['projectId','repositoryId']))versions.push(r);
 // Only small decision metadata is sorted, preserving the original insertion-order retention rule.
 versions.sort((a,b)=>b.r-a.r);
 for(let i=0;i<versions.length;i++){const r=versions[i],key=`${r.f0}:${r.f1}`,n=(perRepo.get(key)||0)+1;perRepo.set(key,n);if(n>p.manifestVersions&&!named.has(r.id))drop('sourceSyncVersions',r.id,recordBytes(db,r));if(i%4===3)await yieldRequests();}
 // Blobs: content a remaining command still refers to stays; the rest goes once old enough.
 if(blobRoot&&!blobsBusy){
  for await(const r of field(db,'sourceSyncReceipts',[]))remember(body(db,r));
  let names=[];try{names=await readdir(blobRoot);}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const name of names){
   if(!/^[a-f0-9]{64}$/.test(name)||referenced.has(name))continue;
   let info;try{info=await stat(join(blobRoot,name));}catch{continue;}
   if(!info.isFile()||now-info.mtimeMs<p.blobDays*DAY)continue;
   plan.blobs.push({name,bytes:info.size});plan.blobBytes+=info.size;
  }
 }
 return plan;
}

/** Counts and bytes per kind, the file's size and free space, blob totals, and what the plan would reclaim: the Data page. */
export async function dataStats(db,{policy,blobRoot=null,now=Date.now()}={}){
 const plan=await retentionPlan(db,{policy,blobRoot,now}),byKind=await sizes(db);
 const reclaim={};for(const x of plan.records){const s=reclaim[x.kind]||={count:0,bytes:0};s.count++;s.bytes+=x.bytes||0;}
 const pageSize=db.db.prepare('PRAGMA page_size').get().page_size,pages=db.db.prepare('PRAGMA page_count').get().page_count,free=db.db.prepare('PRAGMA freelist_count').get().freelist_count;
 let blobs=null;
 if(blobRoot){
  let count=0,bytes=0;try{for(const name of await readdir(blobRoot)){if(!/^[a-f0-9]{64}$/.test(name))continue;try{const info=await stat(join(blobRoot,name));if(info.isFile()){count++;bytes+=info.size;}}catch{}}}catch{}
  blobs={count,bytes,reclaimableCount:plan.blobs.length,reclaimableBytes:plan.blobBytes};
 }
 const kinds=Object.entries(byKind).map(([kind,s])=>({kind,count:s.count,bytes:s.bytes,reclaimableCount:reclaim[kind]?.count||0,reclaimableBytes:reclaim[kind]?.bytes||0})).sort((a,b)=>b.bytes-a.bytes);
 const maintenance=db.get('settings','data-maintenance')||null;
 return {dbBytes:pageSize*pages,dbFreeBytes:pageSize*free,kinds,blobs,reclaimableBytes:plan.bytes+plan.blobBytes,lastCleanupAt:maintenance?.lastCleanupAt||null,lastVacuumAt:maintenance?.lastVacuumAt||null,policy:normalizeRetention(policy)};
}

/**
 * Recheck commands and their dependents in the deletion transaction. Only versions and blobs still depend on the full
 * plan's revision, since their references may be spread across many records.
 */
export async function cleanupData(db,{policy,blobRoot=null,now=Date.now(),batch=200,pause=()=>new Promise(resolve=>setImmediate(resolve)),log=()=>{}}={}){
 const retention=normalizeRetention(policy);
 let revision=db.readRevision(RETENTION_KINDS);
 const plan=await retentionPlan(db,{policy:retention,blobRoot,now});
 const deleted={};let bytes=0,deferred=false;
 const current=()=>revision!==null&&db.readRevision(RETENTION_KINDS)===revision;
 const dataVersion=db.db.prepare('PRAGMA data_version');
 const refreshRevision=observedVersion=>{
  const value=db.readRevision(RETENTION_KINDS);
  return dataVersion.get().data_version===observedVersion?value:null;
 };
 const commandIds=[],dependents=new Map(),versions=[];
 for(const x of plan.records){
  if(x.kind==='sourceSyncCommands')commandIds.push(x.id);
  else if(x.commandId&&!COMMAND_PAYLOADS.includes(x.kind)){
   if(!dependents.has(x.commandId))dependents.set(x.commandId,[]);
   dependents.get(x.commandId).push(x);
  }else if(x.kind==='sourceSyncVersions')versions.push(x);
 }
 const rowSize=db.db.prepare('SELECT octet_length(data) AS bytes FROM records WHERE kind=? AND id=?');
 const remove=(kind,id)=>{
  const row=rowSize.get(kind,id);if(!row)return;
  db.remove(kind,id);bytes+=row.bytes;deleted[kind]=(deleted[kind]||0)+1;
 };
 const chunk=Math.min(batch,8);
 for(let i=0;i<commandIds.length;i+=chunk){
  const observedVersion=dataVersion.get().data_version;
  let keepPlan=current();
  db.transaction(()=>{
   keepPlan=keepPlan&&dataVersion.get().data_version===observedVersion;
   for(const id of commandIds.slice(i,i+chunk)){
    const command=db.get('sourceSyncCommands',id);if(!command||command.status==='reconciling')continue;
    const worker=Boolean(command.command);
    if(!commandExpired({resultStatus:command.result?.status,worker,
     transport:worker?db.get('sourceSyncTransport',id):null,
     pendingReceipt:worker&&Boolean(db.get('sourceSyncReceipts',id)),
     batch:worker?null:db.get('sourceSyncBatches',command.batchId||''),
     receivedAt:command.receivedAt,ackedAt:command.ackedAt},retention,now))continue;
    // Preserve the exact result hash and owner before any command or upload body is removed.
    if(!worker&&command.nodeId){
     const receiptHash=contentHash(JSON.stringify(command.result)),key=`${id}:${receiptHash}`;
     db.put('sourceSyncRetiredReceipts',{id:key,projectId:command.projectId,nodeId:command.nodeId,
      ack:{type:'source_sync_receipt_ack',commandId:id,receiptHash}});
    }
    for(const x of dependents.get(id)||[]){
     const record=db.get(x.kind,x.id);
     if(!record||(record.commandId||record.ack?.commandId||x.id.split(':')[0])!==id)continue;
     if(x.kind==='sourceSyncJournals'&&['preparing','prepared'].includes(record.status))continue;
     if(x.kind==='sourceSyncReceiptAcks'&&record.nodeId&&record.ack?.commandId&&record.ack?.receiptHash)
      db.put('sourceSyncRetiredReceipts',record);
     remove(x.kind,x.id);
    }
    // These records use the command ID as their key, even if an upload arrived after the plan's scan.
    for(const kind of COMMAND_PAYLOADS)remove(kind,id);
    remove('sourceSyncCommands',id);
   }
  });
  revision=keepPlan?refreshRevision(observedVersion):null;
  await pause();
 }
 for(let i=0;i<versions.length;i+=batch){
  const observedVersion=dataVersion.get().data_version;
  if(!current()){deferred=true;break;}
  db.transaction(()=>{
   if(dataVersion.get().data_version!==observedVersion){deferred=true;return;}
   for(const x of versions.slice(i,i+batch))remove(x.kind,x.id);
  });
  if(deferred)break;
  revision=refreshRevision(observedVersion);
  await pause();
 }
 let blobsDeleted=0,blobBytes=0;
 for(let i=0;i<plan.blobs.length;i++){
  if(deferred||!current()){deferred=true;break;}
  // One local unlink is synchronous so a new capture cannot publish/reuse a hash between validation and deletion.
  const b=plan.blobs[i];try{unlinkSync(join(blobRoot,b.name));blobsDeleted++;blobBytes+=b.bytes;}catch(error){if(error.code!=='ENOENT')log(`blob ${b.name}: ${error.message}`);}
  if(i%50===49)await pause();
 }
 const summary={deleted,bytes,blobsDeleted,blobBytes,...(deferred?{deferred:true}:{}),at:new Date(now).toISOString()};
 db.put('settings',{...(db.get('settings','data-maintenance')||{}),id:'data-maintenance',lastCleanupAt:summary.at,lastCleanup:summary});
 return summary;
}

/** Give freed pages back to the file system. Locks the store for the duration, so the caller runs it only when idle. */
export function vacuumIfWasteful(db,{minRatio=0.25,minBytes=64*1024*1024,force=false,now=Date.now()}={}){
 const pageSize=db.db.prepare('PRAGMA page_size').get().page_size,pages=db.db.prepare('PRAGMA page_count').get().page_count,free=db.db.prepare('PRAGMA freelist_count').get().freelist_count;
 const wasted=pageSize*free;
 if(!force&&(wasted<minBytes||free/Math.max(1,pages)<minRatio))return {vacuumed:false,wasted};
 const before=pageSize*pages;
 db.db.exec('VACUUM');
 const after=db.db.prepare('PRAGMA page_count').get().page_count*pageSize;
 db.put('settings',{...(db.get('settings','data-maintenance')||{}),id:'data-maintenance',lastVacuumAt:new Date(now).toISOString(),lastVacuum:{before,after}});
 return {vacuumed:true,before,after,wasted};
}
