import {resolve,relative,isAbsolute} from 'node:path';
import {contentHash,validateSourcePath} from './source-sync-manifest.mjs';
import {captureSourceSnapshot,readSourceFile,readSourceBlob,saveSourceBlob} from './source-sync-files.mjs';

const hash=bytes=>bytes===null?null:contentHash(bytes);
const input=item=>{try{return typeof item.input==='string'?JSON.parse(item.input):item.input||item.arguments||{};}catch{return {};}};

/** Only recognized source-write records are candidates; shell commands and text references are not authorship. */
export function sourceWriteCandidates(item) {
  if(item?.type==='fileChange')return (item.changes||[]).map(change=>({path:change.path,change}));
  if(/^(?:write|edit|write_file|edit_file|write_to_file|replace_file_content)$/i.test(item?.name||'')){
    const args=input(item);return [{path:args.file_path||args.path||args.TargetFile,args}].filter(x=>typeof x.path==='string');
  }
  return [];
}

/** Verify unified hunks against captured preimage bytes; unsupported patch formats yield no attribution. */
function patched(before,diff) {
  if(typeof diff!=='string'||!diff.includes('@@'))return undefined;
  const old=before.toString('utf8').split('\n'),hasNewline=old.at(-1)==='';if(hasNewline)old.pop();
  const lines=diff.split('\n'),out=[];let cursor=0,seen=false,lastNewline=hasNewline;
  for(let i=0;i<lines.length;i++){
    const header=lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);if(!header)continue;
    seen=true;const start=Number(header[1])?Number(header[1])-1:0,oldCount=header[2]===undefined?1:Number(header[2]),newCount=header[4]===undefined?1:Number(header[4]);
    if(start<cursor||start>old.length)return undefined;out.push(...old.slice(cursor,start));cursor=start;let removed=0,added=0;
    while(i+1<lines.length&&!lines[i+1].startsWith('@@')){
      const line=lines[++i];if(line==='')break;
      if(line.startsWith('\\ No newline')){if(added)lastNewline=false;continue;}
      if(line[0]===' '||line[0]==='-'){if(old[cursor]!==line.slice(1))return undefined;cursor++;removed++;}
      if(line[0]===' '||line[0]==='+'){out.push(line.slice(1));added++;lastNewline=true;}
      if(![' ','+','-'].includes(line[0]))return undefined;
    }
    if(removed!==oldCount||added!==newCount)return undefined;
  }
  if(!seen)return undefined;if(cursor<old.length){out.push(...old.slice(cursor));lastNewline=hasNewline;}
  return Buffer.from(out.join('\n')+(lastNewline&&out.length?'\n':''));
}

function expectedBytes(candidate,before) {
  if(candidate.change){if(candidate.change.kind?.type==='delete')return null;return patched(before||Buffer.alloc(0),candidate.change.diff);}
  const args=candidate.args;
  const content=args.content??args.CodeContent;
  if(typeof content==='string')return Buffer.from(content);
  const from=args.old_string??args.TargetContent,to=args.new_string??args.ReplacementContent;
  if(before===null||typeof from!=='string'||!from||typeof to!=='string')return undefined;
  const text=before.toString('utf8'),parts=text.split(from);
  if(parts.length<2||parts.length>2&&!args.replace_all)return undefined;
  return Buffer.from(parts.join(to));
}

/** Persist proof only if the successful operation's predicted bytes equal the captured file version. */
export function recordSourceWrite({db,run,repository,event,before,after,observation}) {
  const item=event.payload?.item||event.item||{},path=observation?.path;
  let candidate;
  try{validateSourcePath(path);candidate=sourceWriteCandidates(item).find(c=>relative(repository.localRoot,resolve(run.workspace,c.path))===path);}catch{}
  const beforeBytes=observation?.beforeBytes,afterBytes=observation?.afterBytes;
  const predicted=candidate&&beforeBytes!==undefined?expectedBytes(candidate,beforeBytes):undefined;
  const verified=item.status==='completed'&&!item.is_error&&candidate&&observation?.stable&&!observation.overlap
    &&beforeBytes!==undefined&&afterBytes!==undefined&&hash(beforeBytes)===(before?.hash??null)&&hash(afterBytes)===(after?.hash??null)
    &&predicted!==undefined&&hash(predicted)===hash(afterBytes);
  if(!verified)return {certainty:'unknown',roleId:null,candidates:run.roleId?[run.roleId]:[]};
  const id=contentHash(JSON.stringify([run.id,item.id||event.id,repository.id,path,hash(beforeBytes),hash(afterBytes)]));
  return db.put('sourceSyncProvenance',{id,projectId:run.projectId,repositoryId:repository.id,path,roleId:run.roleId,runId:run.id,
    nodeId:run.nodeId,roleSessionId:run.roleSessionId||null,beforeHash:hash(beforeBytes),afterHash:hash(afterBytes),certainty:'attributed',
    evidenceId:event.id||item.id,method:candidate.change?'verified_patch':'verified_tool_content'});
}

/** Conflicting evidence stays explicit; neither timestamps nor the most recent active role break ties. */
export function attributeSourceChange({records,repositoryId,path,afterHash,nodeId,sourceRunId}) {
  const found=records.filter(r=>r.repositoryId===repositoryId&&r.path===path&&r.afterHash===afterHash&&r.certainty==='attributed'&&(!nodeId||r.nodeId===nodeId)&&(!sourceRunId||r.runId===sourceRunId));
  const candidates=[...new Set(found.map(r=>r.roleId))];
  return candidates.length===1?{certainty:'attributed',roleId:candidates[0],runId:found.at(-1).runId,candidates,evidenceIds:found.map(r=>r.id)}
    :{certainty:'unknown',roleId:null,runId:null,candidates,evidenceIds:found.map(r=>r.id)};
}

/** Capture enabled Run preimages and serialize proof reads per tool without pretending to observe external shells. */
export class SourceProvenanceTracker {
  constructor({db,run,repositories,blobRoot,publish}){Object.assign(this,{db,run,repositories,blobRoot,publish});this.states=new Map();this.tools=new Map();this.epochs=new Map();this.pending=new Set();}
  async start(){for(const repo of this.repositories){try{const snapshot=await captureSourceSnapshot({root:repo.localRoot,repositoryId:repo.id,blobRoot:this.blobRoot});this.states.set(repo.id,snapshot.entries);}catch{this.states.set(repo.id,null);}}}
  observe(event){
    const update=event.payload?.item;if(!update)return;const id=update.id||update.tool_use_id;if(!id)return;
    const item={...this.tools.get(id),...update};this.tools.set(id,item);
    for(const candidate of sourceWriteCandidates(item)){
      const absolute=resolve(this.run.workspace,candidate.path),repo=this.repositories.find(r=>{const p=relative(r.localRoot,absolute);return p&&!p.startsWith('../')&&!isAbsolute(p);});if(!repo)continue;
      const path=relative(repo.localRoot,absolute),key=`${repo.id}:${path}`,epoch=(this.epochs.get(key)||0)+1;this.epochs.set(key,epoch);
      if(item.status!=='completed'||item.is_error||!this.states.get(repo.id))continue;
      const task=this.capture({event:{...event,payload:{...event.payload,item}},repo,path,key,epoch}).catch(()=>{}).finally(()=>this.pending.delete(task));this.pending.add(task);
    }
  }
  async capture({event,repo,path,key,epoch}){
    const state=this.states.get(repo.id),before=Object.hasOwn(state,path)?state[path]:null;
    const beforeBytes=before?await readSourceBlob(this.blobRoot,before.hash):null;
    const captured=await readSourceFile(repo.localRoot,path);
    if(captured.bytes)await saveSourceBlob(this.blobRoot,captured.bytes);
    const proof=recordSourceWrite({db:this.db,run:this.run,repository:repo,event,before,after:captured.entry,observation:{path,beforeBytes,afterBytes:captured.bytes,stable:true,overlap:this.epochs.get(key)!==epoch}});
    state[path]=captured.entry;
    if(proof.certainty==='attributed')this.publish(proof);
  }
  async finish(){await Promise.all([...this.pending]);}
}

/** Home accepts the original Run's identity, not a role ID supplied by model prose or a later reader. */
export function acceptSourceProvenance(db,run,proof) {
  const repo=run.repositories?.find(r=>r.id===proof.repositoryId);
  if(!repo||proof.projectId!==run.projectId||proof.runId!==run.id||proof.nodeId!==run.nodeId||proof.roleId!==run.roleId||proof.certainty!=='attributed')return false;
  try{validateSourcePath(proof.path);}catch{return false;}
  if(!/^[a-f0-9]{64}$/.test(proof.id)||[proof.beforeHash,proof.afterHash].some(h=>h!==null&&!/^[a-f0-9]{64}$/.test(h||'')))return false;
  db.put('sourceSyncProvenance',proof);return true;
}
