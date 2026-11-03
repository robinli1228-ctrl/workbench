import {lstatSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';

const RETIRED="('completed','partial_conflict','blocked','cancelled')";
// Activation advances the configuration revision; an older preview cannot be consumed or pin content forever.
const batchNeeded=`(COALESCE(json_extract(b.data,'$.status'),'') NOT IN ${RETIRED} AND NOT (json_extract(b.data,'$.status')='preview_ready' AND EXISTS(SELECT 1 FROM records cfg WHERE cfg.kind='sourceSyncConfigs' AND cfg.id=json_extract(b.data,'$.projectId') AND json_extract(cfg.data,'$.revision')!=json_extract(b.data,'$.configRevision'))))`;
// Missing apply receipts may still recover a write; a cancelled capture cannot advance a baseline.
const commandNeeded=`(${batchNeeded} OR json_extract(c.data,'$.status')='reconciling' OR (json_extract(c.data,'$.result') IS NULL AND json_extract(c.data,'$.action')!='capture'))`;
const REFERENCES=[
 ['sourceSyncManifests'],['sourceSyncVersions'],['sourceSyncDevices'],['sourceSyncCandidates'],
 ['sourceSyncConflicts',"AND (COALESCE(json_extract(r.data,'$.detection'),'')!='metadata' OR json_extract(r.data,'$.copiesReleasedAt') IS NULL)"],
 ['sourceSyncConflictHistory',"AND COALESCE(json_extract(r.data,'$.detection'),'')!='metadata'"],
 ['sourceSyncBatches',`AND ${batchNeeded.replaceAll('b.data','r.data')}`],
 ['sourceSyncCommands',`AND EXISTS(SELECT 1 FROM records c LEFT JOIN records b ON b.kind='sourceSyncBatches' AND b.id=json_extract(c.data,'$.batchId') WHERE c.kind='sourceSyncCommands' AND c.id=r.id AND ${commandNeeded})`],
 ...['sourceSyncUploads','sourceSyncUploadReceipts'].map(kind=>[kind,`AND EXISTS(SELECT 1 FROM records c LEFT JOIN records b ON b.kind='sourceSyncBatches' AND b.id=json_extract(c.data,'$.batchId') WHERE c.kind='sourceSyncCommands' AND c.id=r.id AND ${commandNeeded})`])
];
const KINDS=[...REFERENCES.map(([kind])=>kind),'sourceSyncConfigs'];

/** Reclaim only unreferenced ordinary Home blobs; metadata staging keeps its Worker-ACK cleanup. */
export async function collectSourceSyncBlobs(storage,projectId,{now=Date.now(),pause=()=>new Promise(resolve=>setImmediate(resolve))}={}){
 const {db}=storage,summary={blobsDeleted:0,blobBytes:0};
 let revision=db.readRevision(KINDS);
 const current=()=>{if(db.readRevision(KINDS)===revision)return true;summary.deferred=true;return false;};
 const referenced=new Set();
 // Read project-local pages; retired captures retain audit metadata without pinning every historical payload.
 for(const [kind,extra=''] of REFERENCES){
  const page=db.db.prepare("SELECT rowid AS cursor,id FROM records WHERE kind=? AND json_extract(data,'$.projectId')=? AND rowid>? ORDER BY rowid LIMIT 32");
  const query=db.db.prepare(`SELECT r.data FROM records r WHERE r.kind=? AND r.id=? ${extra}`);
  let cursor=0;
  for(;;){
   if(!current())return summary;
   const rows=page.all(kind,projectId,cursor);if(!rows.length)break;
   for(const row of rows){const r=query.get(kind,row.id);if(r)for(const hash of r.data.match(/[a-f0-9]{64}/g)||[])referenced.add(Buffer.from(hash,'latin1').toString('latin1'));
    // A capture can contain megabytes; yield after a large record rather than reading 32 without a break.
    if(r?.data.length>256*1024){await pause();if(!current())return summary;}
   }
   cursor=rows.at(-1).cursor;
   await pause();
  }
 }
 const blobs=db.db.prepare("SELECT rowid AS cursor,id,data FROM records WHERE kind='sourceSyncBlobs' AND json_extract(data,'$.projectId')=? AND json_extract(data,'$.namespace') IS NULL AND rowid>? ORDER BY rowid LIMIT 50");
 let cursor=0;
 for(;;){
  if(!current())return summary;
  const rows=blobs.all(projectId,cursor);if(!rows.length)break;cursor=rows.at(-1).cursor;
  // Do not await between validation, unlink and quota release: no reference can be published midway.
  db.transaction(()=>{
   for(const r of rows){
    const row=JSON.parse(r.data);
    if(!/^[a-f0-9]{64}$/.test(row.hash)||referenced.has(row.hash)||storage.writes.has(r.id))continue;
    const path=join(storage.directory(projectId),row.hash);
    try{
     const info=lstatSync(path);
     // Candidate references can follow upload completion; keep a minute of grace and retain nonregular files.
     if(!info.isFile()||now-info.mtimeMs<60000)continue;
     unlinkSync(path);
    }catch(error){if(error.code!=='ENOENT'){summary.errors=(summary.errors||0)+1;continue;}}
    db.remove('sourceSyncBlobs',r.id);
    const usage=db.get('sourceSyncBlobUsage',projectId);
    if(usage)db.put('sourceSyncBlobUsage',{...usage,bytes:Math.max(0,usage.bytes-row.size)});
    summary.blobsDeleted++;summary.blobBytes+=row.size;
   }
  });
  revision=db.readRevision(KINDS);
  await pause();
 }
 return summary;
}
