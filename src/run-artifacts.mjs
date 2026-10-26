import {realpath,stat} from 'node:fs/promises';
import {resolve,relative,isAbsolute,sep,extname,basename} from 'node:path';
import { tr } from './i18n.mjs';

/** Artifacts may only be read from regular files inside the bound workspace and from platform documents; links that escape the workspace and credential paths are rejected. */
export async function inspectArtifactFiles(workspace,paths) {
  if(!Array.isArray(paths)||paths.length>100)throw new Error(tr('runArtifacts.artifactQueryAcceptsAtMost'));
  const root=await realpath(workspace),files=[];
  for(const path of paths) {
    try {
      if(typeof path!=='string'||path.length>4096)throw new Error(tr('runArtifacts.invalidPath'));
      const file=await realpath(resolve(root,path)),rel=relative(root,file),parts=rel.split(sep);
      const managed=parts[0]==='.workbench'&&parts[1]==='docs';
      if(!rel||rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel)||parts.some((p,i)=>(p.startsWith('.')&&!(managed&&i===0))||/credential|secret/i.test(p)))throw new Error(tr('runArtifacts.filePathNotAccessible'));
      const info=await stat(file);if(!info.isFile())throw new Error(tr('runArtifacts.notRegularFile'));
      files.push({path,size:info.size,modifiedAt:info.mtime.toISOString()});
    }catch(error){files.push({path,error:error.code==='ENOENT'?tr('runArtifacts.fileWasMovedDeleted'):error.message});}
  }
  return {files};
}

/** Merge tool lifecycles; initiating a Write does not mean the write succeeded, and reads or report references are not used to infer who modified a file. */
export function artifactCandidates(run,events=[],messages=[],registered=null) {
  const found=new Map(),tools=new Map();
  const add=(path,writtenAt=null)=>{
    if(typeof path!=='string'||!path||path.length>4096)return;
    const absolute=resolve(run.workspace,path),rel=relative(run.workspace,absolute);
    if(!rel)return;
    const outside=rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel);
    if(outside&&!registered?.(absolute))return;
    const key=outside?absolute:rel,old=found.get(key);if(!old||writtenAt)found.set(key,{path:key,writtenAt});
  };
  for(const e of events){if(e.type!=='tool'||!e.payload?.item)continue;const item=e.payload.item,id=item.id||item.tool_use_id;
    if(id)tools.set(id,{...tools.get(id),...item,at:e.createdAt});}
  for(const item of tools.values()) {
    if(item.status!=='completed'||item.is_error)continue;
    if(item.type==='fileChange')for(const change of item.changes||[])if(change.kind?.type!=='delete')add(change.path,item.at);
    if(/^(write|edit|write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content)$/i.test(item.name||'')) {
      let args=item.input||item.arguments||{};if(typeof args==='string'){try{args=JSON.parse(args);}catch{continue;}}
      add(args.file_path||args.path||args.TargetFile,item.at);
    }
  }
  for(const text of [run.result,run.report?.summary,...(run.report?.evidence||[]),...messages.map(m=>m.text)].filter(x=>typeof x==='string')) {
    for(const match of text.matchAll(/\[[^\]\n]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"\n]*")?\)/g)) {
      let path=match[1].replace(/^<|>$/g,'');
      try {
        if(path.startsWith('/document.html?'))path=new URL(path,'http://local').searchParams.get('path');
        else if(/^[a-z]+:/i.test(path))continue;
        else path=path.replace(/#.*$/,'').replace(/(\.[a-z\d]+):[1-9]\d*(?::[1-9]\d*)?$/i,'$1');
        add(decodeURIComponent(path||''));
      }catch{}
    }
  }
  return [...found.values()];
}

/** Home may retain tool evidence after Worker event cleanup; only a saved Run reference can authorize the source path. */
export function recordedArtifactPath(db,run,path,knownCandidates=null){
  if(!run?.workspace||typeof path!=='string'||!path||path.length>4096)throw Error('artifact_source_invalid_request');
  const wanted=resolve(run.workspace,path);
  const candidates=knownCandidates||artifactCandidates(run,db.events(run.id),db.listProject('roomMessages',run.projectId).filter(m=>m.runId===run.id));
  const found=candidates.find(item=>resolve(run.workspace,item.path)===wanted);
  if(!found)throw Error('artifact_source_path_not_recorded');
  return resolve(run.workspace,found.path);
}

/** One time per card: the newest of its write record, its newest mention in a reply and the file's modification time. */
function latestEvidence(c,modifiedAt) {
  const role=run=>run?.roleSnapshot?.name||null;
  return [{kind:'write',at:c.writtenAt,roleName:role(c.run),runtime:c.run.roleSnapshot?.runtime||null},
    {kind:'reference',at:c.mention?.at||null,roleName:role(c.mention?.run),runtime:null},
    {kind:'modified',at:modifiedAt||null,roleName:null,runtime:null}]
    .filter(e=>Number.isFinite(Date.parse(e.at))).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at))[0]
    ||{kind:'reference',at:c.run.updatedAt||c.run.createdAt||null,roleName:role(c.run),runtime:null};
}

/** Query a bounded set of recent runs without walking the whole workspace; for the same device and path only the latest record is shown. */
export async function recentProjectArtifacts(db,projectId,query,online,projectFiles=null) {
  if(!db.get('projects',projectId))throw new Error(tr('runArtifacts.projectNotFound'));
  const runs=db.list('runs').filter(r=>r.projectId===projectId&&r.workspace).sort((a,b)=>String(b.updatedAt||b.createdAt).localeCompare(String(a.updatedAt||a.createdAt)));
  const messages=db.list('roomMessages').filter(m=>m.projectId===projectId),candidates=new Map();
  for(const run of runs.slice(0,40))for(const file of artifactCandidates(run,db.events(run.id),messages.filter(m=>m.runId===run.id),projectFiles?path=>projectFiles.reference(run,path):null)) {
    const ref=projectFiles?.reference(run,file.path),key=ref?`${ref.scopeId}:${ref.path}`:`${run.nodeId}:${resolve(run.workspace,file.path)}`,prior=candidates.get(key);
    // The write record (or the newest run) still decides how the file is read; the newest mention is kept beside it.
    const mention=file.writtenAt?null:{at:run.finishedAt||run.updatedAt||run.createdAt,run};
    const base=!prior||file.writtenAt&&(!prior.writtenAt||file.writtenAt>prior.writtenAt)?{...file,run,ref}:prior;
    candidates.set(key,{...base,mention:[prior?.mention,mention].filter(Boolean).sort((a,b)=>String(b.at).localeCompare(String(a.at)))[0]||null});
  }
  if(projectFiles){
    const selected=[...candidates.values()].slice(0,100),items=[],deviceErrors=new Map();
    for(let i=0;i<selected.length;i+=4)await Promise.all(selected.slice(i,i+4).map(async c=>{
      let local,error=null,readNode=c.run.nodeId;
      try{
        if(c.ref&&!projectFiles.legacyReadable(c.run))readNode=projectFiles.config?.(projectId)?.displayNodeId||`shared:${projectId}`;
        if(deviceErrors.has(readNode))throw deviceErrors.get(readNode);
        if(!c.ref){
          if(db.get('workers',c.run.nodeId)?.capabilities?.recordedArtifacts!==1)throw new Error(tr('runArtifacts.filePathNotAccessible'));
          if(!online(c.run.nodeId))throw new Error(tr('runArtifacts.deviceOffline'));
          const source=await query(c.run,'artifact_source',{path:c.path,homeRecordedPath:recordedArtifactPath(db,c.run,c.path,[c]),metadata:true},15000);
          local={...source,nodeId:c.run.nodeId,shared:false,syncState:'source',relativePath:null};
        }
        if(c.ref&&projectFiles.legacyReadable(c.run)){
          if(!online(c.run.nodeId))throw new Error(tr('runArtifacts.deviceOffline'));
          const result=await query(c.run,'artifact_files',[c.path],5000),info=result?.files?.find(f=>f.path===c.path);
          if(!info||info.error)throw new Error(info?.error||tr('runArtifacts.deviceReturnedNoFileInformation'));
          local={...info,path:resolve(c.run.workspace,c.path),nodeId:c.run.nodeId,shared:false,syncState:'disabled',relativePath:null};
        }else if(c.ref)local=await projectFiles.read(projectId,c.ref.scopeId,c.ref.path,{metadata:true});
      }catch(e){error=e.message;if(/timed? out|timeout|offline|closed|disconnected|\u8d85\u65f6|\u79bb\u7ebf/i.test(error))deviceErrors.set(readNode,e);}
      items.push({...local,projectId,runId:c.run.id,originNodeId:c.run.nodeId,originPath:resolve(c.run.workspace,c.path),
        scopeId:c.ref?.scopeId||null,relativePath:local?.shared===false?null:c.ref?.path||null,path:local?.path||null,shared:local?.shared??Boolean(c.ref),
        name:basename(c.path),type:extname(c.path).slice(1).toUpperCase()||'FILE',recordedAt:c.writtenAt||c.run.updatedAt||c.run.createdAt,
        runtime:c.writtenAt?c.run.roleSnapshot?.runtime||null:null,roleName:c.writtenAt?c.run.roleSnapshot?.name||null:null,
        sourceKind:c.writtenAt?'write':'reference',source:c.writtenAt?tr('runArtifacts.writeRecord'):tr('runArtifacts.replyReference'),
        error,syncState:error?'read_error':local.syncState,latest:latestEvidence(c,local?.modifiedAt)});
    }));
    items.sort((a,b)=>String(b.latest.at).localeCompare(String(a.latest.at)));
    return {items,partial:runs.length>40||candidates.size>100,scannedRuns:Math.min(40,runs.length)};
  }
  const selected=[...candidates.values()].slice(0,100),groups=new Map(),items=[];
  for(const c of selected){const list=groups.get(c.run.id)||[];list.push(c);groups.set(c.run.id,list);}
  // An offline node does not block the list for other nodes; each failed group keeps its source record and a readable reason.
  const entries=[...groups.values()].slice(0,12);
  for(let i=0;i<entries.length;i+=4)await Promise.all(entries.slice(i,i+4).map(async group=>{
    const run=group[0].run;let result,error;
    try{if(!online(run.nodeId))throw new Error(tr('runArtifacts.deviceOffline'));result=await query(run,'artifact_files',group.map(c=>c.path),5000);}catch(e){error=/unknown node quer|\u672a\u77e5\u8282\u70b9\u67e5\u8be2/i.test(e.message)?tr('runArtifacts.deviceMustBeUpdatedVerify'):e.message;}
    for(const c of group){const info=result?.files?.find(f=>f.path===c.path),modified=Date.parse(info?.modifiedAt),written=Date.parse(c.writtenAt);
      const attributed=Number.isFinite(modified)&&Number.isFinite(written)&&Math.abs(modified-written)<3000;
      items.push({runId:run.id,nodeId:run.nodeId,path:c.path,name:basename(c.path),type:extname(c.path).slice(1).toUpperCase()||'FILE',
        size:info?.size??null,modifiedAt:info?.modifiedAt||null,recordedAt:c.writtenAt||run.updatedAt||run.createdAt,
        runtime:attributed?run.roleSnapshot?.runtime||null:null,roleName:attributed?run.roleSnapshot?.name||null:null,
        source:c.writtenAt?tr('runArtifacts.writeRecord'):tr('runArtifacts.replyReference'),error:error||info?.error||(!info?tr('runArtifacts.deviceReturnedNoFileInformation'):null),
        latest:latestEvidence(c,info?.modifiedAt)});
    }
  }));
  items.sort((a,b)=>String(b.latest.at).localeCompare(String(a.latest.at)));
  return {items,partial:runs.length>40||candidates.size>100||groups.size>12,scannedRuns:Math.min(40,runs.length)};
}
