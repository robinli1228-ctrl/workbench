import {randomUUID} from 'node:crypto';
import {contentHash,syncError} from './source-sync-manifest.mjs';
const DAY=86400000,RETENTION=30*DAY;
const terminal=new Set(['succeeded','failed']);
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
export function auditCursor(value){if(!value)return null;try{const v=JSON.parse(Buffer.from(value,'base64url').toString());if(!Array.isArray(v)||v.length!==2||typeof v[0]!=='string'||typeof v[1]!=='string'||!Number.isFinite(Date.parse(v[0])))throw Error();return v;}catch{throw syncError('invalid_cursor');}}
const page=(rows)=>({items:rows.slice(0,50),next:rows.length>50?encode([rows[49].recordedAt||rows[49].createdAt,rows[49].id]):null});
const attributes=m=>m?{exists:m.exists,...(m.exists?{mtimeNs:m.mtimeNs,size:m.size}:{})}:null;
const identity=(b,o)=>contentHash(JSON.stringify([b.id,o.repositoryId,o.path]));
/** Expiring audit rows never drive synchronization. Compact replay identities are separate from the log. */
export class SourceSyncAudit {
  constructor({db,now=Date.now}){this.db=db;this.now=now;}
  record(b,o,patch){
    if(b.detection!=='metadata')return null;
    {
      const id=identity(b,o),headId=contentHash(JSON.stringify([b.projectId,o.repositoryId,b.generation,o.path]));
      let s=this.db.get('sourceSyncAuditStates',id),head=this.db.get('sourceSyncAuditHeads',headId);
      const initial=!s,time=this.now(),at=new Date(time).toISOString();
      if(!s){const retry=head?.status==='failed';s={id,projectId:b.projectId,batchId:b.id,operationId:retry?head.operationId:id,attempt:retry?head.attempt+1:1,retryOf:retry?head.recordId:null,startedAt:at,transferredBytes:0};}
      if(terminal.has(s.status)&&patch.status!==s.status)return this.visibleRecord(b.projectId,s.recordId);
      const source=o.source||b.initialization?.sourceNodeId||b.proposal?.sourceNodeId||b.nodeIds[0],target=o.target&&o.source?o.target:b.nodeIds.find(n=>n!==source);
      const before=o.observed?.[source],other=o.observed?.[target];
      const fields={sourceBefore:attributes(before),targetBefore:attributes(other),targetAfter:null,sourceHash:null,targetHash:null,conflictId:null,reason:null,...patch};
      const signature=contentHash(JSON.stringify(fields));
      if(s.signature===signature)return this.visibleRecord(b.projectId,s.recordId);
      const prior=s.recordId&&this.visibleRecord(b.projectId,s.recordId),recordId=prior?.id||randomUUID();
      const finishedAt=terminal.has(fields.status)?s.finishedAt||at:null;
      const r={id:recordId,recordId,operationId:s.operationId,attempt:s.attempt,projectId:b.projectId,scope:o.repositoryId,relativePath:o.path,batchId:b.id,sourceDevice:source,targetDevice:target,
        action:before?.exists?(other?.exists?'modify':'add'):'delete',...fields,startedAt:s.startedAt,finishedAt,recordedAt:prior?.recordedAt||at,phaseChangedAt:at,retryOf:s.retryOf,
        transferredBytes:s.transferredBytes,duration:Math.max(0,Date.parse(finishedAt||at)-Date.parse(s.startedAt)),expiresAt:(finishedAt?Date.parse(finishedAt):time)+RETENTION};
      const write=()=>{this.db.put('sourceSyncAudit',r);s={...s,recordId,signature,status:fields.status,finishedAt};this.db.put('sourceSyncAuditStates',s);
      if(!head||head.stateId===id||initial)this.db.put('sourceSyncAuditHeads',{id:headId,projectId:b.projectId,stateId:id,operationId:s.operationId,recordId,attempt:s.attempt,status:s.status});
      return r;};
      return this.db.transactionDepth?write():this.db.transaction(write);
    }
  }
  visibleRecord(projectId,id){if(!id)return null;const r=this.db.get('sourceSyncAudit',id);return r?.projectId===projectId&&r.expiresAt>this.now()?r:null;}
  /** Derive file outcomes only from already validated command receipts and frozen operation metadata. */
  observe(b){
    if(b?.detection!=='metadata'||!b.metadataOperations?.length)return;
    const commands=this.db.listSourceSyncCommands({batchId:b.id});
    const conflicts=(b.conflictIds||[]).map(id=>this.db.get('sourceSyncConflicts',id)).filter(Boolean);
    const key=(repo,path)=>JSON.stringify([repo,path]),byPath=new Map(),files=new Map();
    for(const c of commands){
      files.set(c,new Map((c.result?.files||[]).map(f=>[f.path,f])));
      for(const path of new Set((c.paths||c.changes||[]).map(p=>p.path))){const k=key(c.repositoryId,path);if(!byPath.has(k))byPath.set(k,[]);byPath.get(k).push(c);}
    }
    const conflictByPath=new Map();for(const c of conflicts)if(!['resolved','initializing'].includes(c.status)&&!conflictByPath.has(key(c.repositoryId,c.path)))conflictByPath.set(key(c.repositoryId,c.path),c);
    const pendingByPath=new Map((b.pendingMetadata||[]).map(p=>[key(p.repositoryId,p.path),p]));
    const observe=()=>{for(const o of b.metadataOperations){
      const k=key(o.repositoryId,o.path),cs=byPath.get(k)||[];
      const reads=cs.filter(c=>c.action==='read'),applies=cs.filter(c=>c.action==='apply');
      const source=o.source||b.initialization?.sourceNodeId||b.proposal?.sourceNodeId||b.nodeIds[0],target=b.nodeIds.find(n=>n!==source);
      const entry=n=>files.get(reads.find(c=>c.nodeId===n))?.get(o.path)?.entry;
      const left=entry(source),right=entry(target),compared=!o.source&&reads.every(c=>c.result?.status==='completed');
      const results=applies.flatMap(c=>{const f=files.get(c)?.get(o.path);return f?[{...f,nodeId:c.nodeId}]:[];});
      const applied=results.find(f=>f.nodeId===target&&f.status==='applied');
      const conflict=conflictByPath.get(k);
      const pending=pendingByPath.get(k);
      const waiting=cs.find(c=>!c.result&&['waiting_idle','waiting_device','reconciling'].includes(c.status));
      const equal=!o.source&&compared&&(left?.hash||null)===(right?.hash||null);
      let status='syncing',phase=waiting?.status||({reading:'read',staging:'stage',applying:'apply',cleaning:'cleanup'}[b.status]||b.status),reason=waiting?.lastResult?.reason||null;
      if(conflict||pending||results.some(f=>f.status==='conflict')){status='failed';phase='conflict';reason=conflict?.reason||pending?.reason||'target_changed';}
      else if(['blocked','cancelling','cancelled'].includes(b.status)){status='failed';phase=b.status==='blocked'?'blocked':'cancelled';reason=b.reason||b.status;}
      else if(applied||equal&&['applying','cleaning','completed','partial_conflict'].includes(b.status)||o.decision==='absent'){status='succeeded';phase=equal||o.decision==='absent'?'verified':'confirmed';}
      const fields={status,phase,reason,targetAfter:applied?attributes(applied.observed):status==='succeeded'?attributes(o.observed[target]):null,
        sourceHash:compared&&o.decision!=='initialize_overwrite'?left?.hash||null:null,targetHash:compared&&o.decision!=='initialize_overwrite'?right?.hash||null:null,conflictId:conflict?.id||null};
      if(equal||o.decision==='absent')fields.action='confirm_equal';
      this.record(b,o,fields);
    }};
    return this.db.transactionDepth?observe():this.db.transaction(observe);
  }
  /** Count HTTP payload once per request, never write per chunk or refresh the phase retention clock. */
  transferred(c,path,bytes){if(c.detection!=='metadata'||!path||!bytes)return;const id=identity({id:c.batchId},{repositoryId:c.repositoryId,path});this.db.transaction(()=>{const s=this.db.get('sourceSyncAuditStates',id);if(!s)return;this.db.put('sourceSyncAuditStates',{...s,transferredBytes:s.transferredBytes+bytes});const r=this.visibleRecord(c.projectId,s.recordId);if(r)this.db.put('sourceSyncAudit',{...r,transferredBytes:r.transferredBytes+bytes});});}
  list(projectId,q={}){
    if(q.status&&!['syncing','succeeded','failed'].includes(q.status))throw syncError('invalid_status');
    const after=auditCursor(q.after),where=["kind='sourceSyncAudit'","json_extract(data,'$.projectId')=?","json_extract(data,'$.expiresAt')>?"] ,args=[projectId,this.now()];
    for(const [key,field] of [['path','relativePath'],['status','status'],['operationId','operationId']])if(q[key]){where.push(`json_extract(data,'$.${field}')=?`);args.push(q[key]);}
    for(const [key,cmp] of [['from','>='],['to','<=']])if(q[key]){if(!Number.isFinite(Date.parse(q[key])))throw syncError('invalid_time');where.push(`json_extract(data,'$.recordedAt')${cmp}?`);args.push(new Date(q[key]).toISOString());}
    if(after){where.push("(json_extract(data,'$.recordedAt'),id)<(?,?)");args.push(...after);}
    const select=(deviceField)=>{
      const conditions=[...where],values=[...args];
      if(deviceField){conditions.push(`json_extract(data,'$.${deviceField}')=?`);values.push(q.device);}
      const index=q.operationId?'operation':q.path?'path':deviceField==='sourceDevice'?'source':deviceField?'target':q.status?'status':'project';
      return this.db.db.prepare(`SELECT data FROM records INDEXED BY records_sync_audit_${index} WHERE ${conditions.join(' AND ')} ORDER BY json_extract(data,'$.recordedAt') DESC,id DESC LIMIT 51`).all(...values).map(r=>JSON.parse(r.data));
    };
    let rows=q.device?[...new Map([...select('sourceDevice'),...select('targetDevice')].map(r=>[r.id,r])).values()].sort((a,b)=>b.recordedAt.localeCompare(a.recordedAt)||b.id.localeCompare(a.id)):select();
    return page(rows);
  }
  detail(projectId,id,q={}){const record=this.visibleRecord(projectId,id);if(!record)throw syncError('record_missing');return {record,retries:this.list(projectId,{operationId:record.operationId,after:q.after})};}
  cleanup(){
    return this.db.transaction(()=>{const time=this.now(),state=this.db.get('sourceSyncAuditMaintenance','retention');
      if(state?.sweepAt===undefined&&state?.lastCleanupAt!==undefined&&time-state.lastCleanupAt<DAY)return {deleted:0};
      const cutoff=state?.sweepAt??time;
      const rows=this.db.db.prepare("SELECT id FROM records INDEXED BY records_sync_audit_expiry WHERE kind='sourceSyncAudit' AND json_extract(data,'$.expiresAt')<=? ORDER BY json_extract(data,'$.expiresAt'),id LIMIT 100").all(cutoff);
      for(const r of rows)this.db.remove('sourceSyncAudit',r.id);
      // A separate indexed cursor visits at most 100 terminal identities, including retained ones.
      const after=state?.stateAfter,values=[new Date(cutoff-RETENTION).toISOString()];
      if(after)values.push(...after);
      const states=state?.statesDone?[]:this.db.db.prepare("SELECT id,data FROM records INDEXED BY records_sync_audit_state_finish WHERE kind='sourceSyncAuditStates' AND json_extract(data,'$.status') IN ('succeeded','failed') AND json_extract(data,'$.finishedAt')<=?"+(after?" AND (json_extract(data,'$.finishedAt'),id)>(?,?)":"")+" ORDER BY json_extract(data,'$.finishedAt'),id LIMIT 100").all(...values);
      let identitiesDeleted=0;const safeBatches=new Map();
      for(const row of states){const s=JSON.parse(row.data);
        if(!safeBatches.has(s.batchId)){
          const b=this.db.get('sourceSyncBatches',s.batchId);
          const ended=!b||['completed','partial_conflict','blocked','cancelled'].includes(b.status);
          safeBatches.set(s.batchId,ended&&!this.db.listSourceSyncCommands({projectId:s.projectId,batchId:s.batchId}).some(c=>!c.result||c.status==='reconciling'));
        }
        if(!safeBatches.get(s.batchId))continue;
        // Only remove a head still pointing to this identity; a later retry owns its own head.
        for(const h of this.db.db.prepare("SELECT id FROM records INDEXED BY records_sync_audit_head_state WHERE kind='sourceSyncAuditHeads' AND json_extract(data,'$.stateId')=?").all(s.id))this.db.remove('sourceSyncAuditHeads',h.id);
        this.db.remove('sourceSyncAuditStates',s.id);identitiesDeleted++;
      }
      const statesDone=state?.statesDone||states.length<100,last=states.at(-1);
      const continuing=rows.length===100||!statesDone;
      this.db.put('sourceSyncAuditMaintenance',{id:'retention',...(continuing?{sweepAt:cutoff,lastCleanupAt:state?.lastCleanupAt??null,statesDone,stateAfter:last?[JSON.parse(last.data).finishedAt,last.id]:after}:{lastCleanupAt:time})});
      return {deleted:rows.length,identitiesDeleted};
    });
  }
}
export function initializationPage(db,projectId,q={}){
  const after=auditCursor(q.after),args=[projectId];let condition='';if(after){condition=" AND (json_extract(data,'$.createdAt'),id)<(?,?)";args.push(...after);}
  return page(db.db.prepare("SELECT data FROM records INDEXED BY records_metadata_init_project WHERE kind='sourceSyncInitializations' AND json_extract(data,'$.projectId')=?"+condition+" ORDER BY json_extract(data,'$.createdAt') DESC,id DESC LIMIT 51").all(...args).map(r=>JSON.parse(r.data)));
}
