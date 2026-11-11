import {gzip,gunzipSync} from 'node:zlib';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

const compress=promisify(gzip),passes=new WeakMap(),DAY=86400000;
// Keep identity, provenance, role metadata, final results and errors in the searchable record.
const INPUT_FIELDS=['contextPacket','inputTask','teamContext','runtimeInstructions','executionConfiguration'];
const digest=value=>createHash('sha256').update(value).digest('hex');

/** Restore original input properties lazily. The compressed bytes belong to this read's snapshot, not a later DB read. */
export function decodeRunInput(run){
 const archive=run.archivedRunInput;
 if(!archive)return run;
 if(archive.version!==1||!Array.isArray(archive.fields)||archive.fields.some(key=>!INPUT_FIELDS.includes(key)))throw Error('Invalid Run input archive');
 delete run.archivedRunInput;
 let decoded;
 const load=()=>{
  if(decoded)return decoded;
  try{
   const bytes=gunzipSync(Buffer.from(archive.body,'base64'),{maxOutputLength:archive.bytes});
   if(bytes.length!==archive.bytes||digest(bytes)!==archive.sha256)throw Error('checksum');
   decoded=JSON.parse(bytes.toString('utf8'));
   if(archive.fields.some(key=>!Object.hasOwn(decoded,key)))throw Error('missing field');
   return decoded;
  }catch{throw Error('Unable to read Run input archive');}
 };
 for(const key of archive.fields)Object.defineProperty(run,key,{enumerable:true,configurable:true,
  get(){const value=load()[key];Object.defineProperty(this,key,{value,writable:true,enumerable:true,configurable:true});return value;},
  set(value){Object.defineProperty(this,key,{value,writable:true,enumerable:true,configurable:true});}});
 return run;
}

/** One maintenance pass per Store; asynchronous compression and per-record yields leave room for requests. */
export function compactRunInputs(store,options={}){
 if(passes.has(store))return passes.get(store);
 const work=compact(store,options).finally(()=>passes.delete(store));passes.set(store,work);return work;
}
async function compact(store,{now=Date.now()}={}){
 const cutoff=new Date(now-7*DAY).toISOString(),summary={compacted:0,beforeBytes:0,afterBytes:0};
 let after=0;
 for(;;){
  // Read IDs only; at most one full input is held/compressed at a time. Missing dates never count as old.
  const ids=store.db.prepare(`SELECT rowid AS position,id FROM records WHERE kind='runs' AND rowid>?
   AND json_extract(data,'$.status') IN ('succeeded','failed','interrupted')
   AND json_extract(data,'$.archivedRunInput') IS NULL
   AND julianday(json_extract(data,'$.finishedAt'))<=julianday(?)
   AND julianday(json_extract(data,'$.updatedAt'))<=julianday(?) ORDER BY rowid LIMIT 25`).all(after,cutoff,cutoff);
  if(!ids.length)return summary;
  for(const {position,id} of ids){
   after=position;
   const row=store.db.prepare("SELECT data FROM records WHERE kind='runs' AND id=?").get(id);
   if(!row)continue;
   const run=JSON.parse(row.data);
   // Another request may have changed an ID while the previous record was being compressed.
   if(run.archivedRunInput||!['succeeded','failed','interrupted'].includes(run.status)||!(Date.parse(run.finishedAt)<=Date.parse(cutoff))||!(Date.parse(run.updatedAt)<=Date.parse(cutoff)))continue;
   const fields=INPUT_FIELDS.filter(key=>Object.hasOwn(run,key));
   const raw=Buffer.from(JSON.stringify(Object.fromEntries(fields.map(key=>[key,run[key]]))));
   if(raw.length<16384)continue;
   const packed=await compress(raw);
   // Leave placeholders so decoding preserves original property order, including explicit null values.
   for(const key of fields)run[key]=null;
   run.archivedRunInput={version:1,fields,bytes:raw.length,sha256:digest(raw),body:packed.toString('base64')};
   const data=JSON.stringify(run),before=Buffer.byteLength(row.data),afterBytes=Buffer.byteLength(data);
   if(afterBytes<before){
    // Compare-and-swap makes compression atomic without holding a transaction across an await.
    const changed=store.db.prepare("UPDATE records SET data=? WHERE kind='runs' AND id=? AND data=?").run(data,id,row.data).changes;
    if(changed){store.recordChanged?.('runs');summary.compacted++;summary.beforeBytes+=before;summary.afterBytes+=afterBytes;}
   }
   await new Promise(resolve=>setImmediate(resolve));
  }
  await new Promise(resolve=>setImmediate(resolve));
 }
}

/** Offline downgrade helper: stop Home first, expand original JSON with this version, then start the older version. */
export async function restoreRunInputs(store){
 if(passes.has(store))throw Error('Wait for Run input maintenance before restoring');
 let after=0,count=0;
 for(;;){
  const rows=store.db.prepare("SELECT rowid AS position,id FROM records WHERE kind='runs' AND rowid>? AND json_extract(data,'$.archivedRunInput') IS NOT NULL ORDER BY rowid LIMIT 25").all(after);
  if(!rows.length)return count;
  for(const {position,id} of rows){
   after=position;
   const row=store.db.prepare("SELECT data FROM records WHERE kind='runs' AND id=?").get(id);
   if(!row)continue;
   const data=JSON.stringify(decodeRunInput(JSON.parse(row.data)));
   if(store.db.prepare("UPDATE records SET data=? WHERE kind='runs' AND id=? AND data=?").run(data,id,row.data).changes){store.recordChanged?.('runs');count++;}
   await new Promise(resolve=>setImmediate(resolve));
  }
 }
}
