import {readdir,stat,unlink} from 'node:fs/promises';
import {join} from 'node:path';

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

export function normalizeRetention(value={}){
 const days=(v,fallback,max)=>{const n=Number(v);return Number.isFinite(n)&&n>=0&&n<=max?Math.round(n*100)/100:fallback;};
 return {syncCommandDays:days(value.syncCommandDays,RETENTION_DEFAULTS.syncCommandDays,365),blobDays:days(value.blobDays,RETENTION_DEFAULTS.blobDays,365),
  manifestVersions:Math.max(1,Math.min(500,Math.round(Number(value.manifestVersions))||RETENTION_DEFAULTS.manifestVersions))};
}

const age=(value,now)=>{const t=Date.parse(value||'');return Number.isFinite(t)?now-t:Infinity;};
const sizes=db=>Object.fromEntries(db.db.prepare('SELECT kind,COUNT(*) AS n,SUM(LENGTH(data)) AS b FROM records GROUP BY kind').all().map(r=>[r.kind,{count:r.n,bytes:r.b||0}]));
const rows=(db,kind)=>db.db.prepare('SELECT id,data,LENGTH(data) AS bytes FROM records WHERE kind=? ORDER BY rowid').all(kind);

/** Which records and blobs the policy lets go right now. Pure: nothing is deleted. */
export async function retentionPlan(db,{policy=RETENTION_DEFAULTS,blobRoot=null,now=Date.now()}={}){
 const p=normalizeRetention(policy),plan={records:[],blobs:[],bytes:0,blobBytes:0,kept:{}};
 const drop=(kind,id,bytes)=>{plan.records.push({kind,id});plan.bytes+=bytes;};
 const batches=new Map(rows(db,'sourceSyncBatches').map(r=>{const b=JSON.parse(r.data);return [b.id,b];}));
 const transports=new Map(rows(db,'sourceSyncTransport').map(r=>[r.id,JSON.parse(r.data)]));
 const receipts=new Set(rows(db,'sourceSyncReceipts').map(r=>r.id));
 const keptCommandText=[];
 for(const r of rows(db,'sourceSyncCommands')){
  const c=JSON.parse(r.data);let reclaim=false,at=null;
  if(c.command){
   // Worker shape: the executed command, its result and the transport that carried the receipt to Home.
   const t=transports.get(c.id);
   reclaim=TERMINAL.has(c.result?.status)&&Boolean(t?.acknowledgedAt)&&!receipts.has(c.id);at=t?.acknowledgedAt;
  }else{
   // Home shape: the issued command, acknowledged by its Worker, inside a batch that has ended.
   const batch=batches.get(c.batchId);
   reclaim=(!batch||TERMINAL_BATCH.has(batch.status))&&(Boolean(c.ackedAt)||TERMINAL.has(c.result?.status)||TERMINAL.has(c.status));at=c.ackedAt||c.receivedAt||batch?.updatedAt||batch?.createdAt||c.lastSentAt;
  }
  if(reclaim&&age(at,now)>=p.syncCommandDays*DAY){
   drop('sourceSyncCommands',c.id,r.bytes);
   const t=transports.get(c.id);if(t)drop('sourceSyncTransport',c.id,Buffer.byteLength(JSON.stringify(t)));
  }else keptCommandText.push(r.data);
 }
 // Home-side receipt-ack cache and Worker-side journals/cancellations belong to their command.
 const dropped=new Set(plan.records.filter(x=>x.kind==='sourceSyncCommands').map(x=>x.id));
 for(const kind of ['sourceSyncReceiptAcks','sourceSyncJournals','sourceSyncCancellations'])for(const r of rows(db,kind)){
  const o=JSON.parse(r.data),owner=o.commandId||String(r.id).split(':')[0];
  if(dropped.has(owner)&&o.status!=='prepared')drop(kind,r.id,r.bytes);
 }
 // Manifest versions: the newest N per repository stay, as does anything a binding or an open conflict still names.
 const named=new Set();
 for(const kind of ['workspaces','repositoryWorkspaces'])for(const r of rows(db,kind)){const o=JSON.parse(r.data);if(o.sourceBaseManifestId)named.add(o.sourceBaseManifestId);}
 for(const r of rows(db,'sourceSyncConflicts')){const o=JSON.parse(r.data);if(o.status==='open')for(const h of r.data.match(HASH)||[])named.add(h);}
 const perRepo=new Map();
 for(const r of rows(db,'sourceSyncVersions').reverse()){const o=JSON.parse(r.data),key=`${o.projectId}:${o.repositoryId}`,n=(perRepo.get(key)||0)+1;perRepo.set(key,n);if(n>p.manifestVersions&&!named.has(r.id))drop('sourceSyncVersions',r.id,r.bytes);}
 // Blobs: content a remaining command still refers to stays; the rest goes once old enough.
 if(blobRoot){
  const referenced=new Set();for(const text of keptCommandText)for(const h of text.match(HASH)||[])referenced.add(h);
  for(const r of rows(db,'sourceSyncReceipts'))for(const h of r.data.match(HASH)||[])referenced.add(h);
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
 const plan=await retentionPlan(db,{policy,blobRoot,now}),byKind=sizes(db);
 const reclaim={};for(const x of plan.records){const s=reclaim[x.kind]||={count:0};s.count++;}
 for(const x of plan.records){const r=db.db.prepare('SELECT LENGTH(data) AS b FROM records WHERE kind=? AND id=?').get(x.kind,x.id);reclaim[x.kind].bytes=(reclaim[x.kind].bytes||0)+(r?.b||0);}
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

/** Delete what the plan names, a few hundred rows per transaction with a yield between, then unlink blobs the same way. */
export async function cleanupData(db,{policy,blobRoot=null,now=Date.now(),batch=200,pause=()=>new Promise(resolve=>setImmediate(resolve)),log=()=>{}}={}){
 const plan=await retentionPlan(db,{policy,blobRoot,now});
 const deleted={};let bytes=0;
 for(let i=0;i<plan.records.length;i+=batch){
  const slice=plan.records.slice(i,i+batch);
  db.transaction(()=>{for(const x of slice){const r=db.db.prepare('SELECT LENGTH(data) AS b FROM records WHERE kind=? AND id=?').get(x.kind,x.id);if(!r)continue;bytes+=r.b;db.remove(x.kind,x.id);deleted[x.kind]=(deleted[x.kind]||0)+1;}});
  await pause();
 }
 let blobsDeleted=0,blobBytes=0;
 for(let i=0;i<plan.blobs.length;i++){
  const b=plan.blobs[i];try{await unlink(join(blobRoot,b.name));blobsDeleted++;blobBytes+=b.bytes;}catch(error){if(error.code!=='ENOENT')log(`blob ${b.name}: ${error.message}`);}
  if(i%50===49)await pause();
 }
 const summary={deleted,bytes,blobsDeleted,blobBytes,at:new Date(now).toISOString()};
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
