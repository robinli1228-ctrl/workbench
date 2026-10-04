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
export function artifactCandidates(run,events=[],messages=[]) {
  const found=new Map(),tools=new Map();
  const add=(path,writtenAt=null)=>{
    if(typeof path!=='string'||!path||path.length>4096)return;
    const absolute=resolve(run.workspace,path),rel=relative(run.workspace,absolute);
    if(!rel||rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))return;
    const old=found.get(rel);if(!old||writtenAt)found.set(rel,{path:rel,writtenAt});
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

/** Query a bounded set of recent runs without walking the whole workspace; for the same device and path only the latest record is shown. */
export async function recentProjectArtifacts(db,projectId,query,online) {
  if(!db.get('projects',projectId))throw new Error(tr('runArtifacts.projectNotFound'));
  const runs=db.list('runs').filter(r=>r.projectId===projectId&&r.workspace).sort((a,b)=>String(b.updatedAt||b.createdAt).localeCompare(String(a.updatedAt||a.createdAt)));
  const messages=db.list('roomMessages').filter(m=>m.projectId===projectId),candidates=new Map();
  for(const run of runs.slice(0,40))for(const file of artifactCandidates(run,db.events(run.id),messages.filter(m=>m.runId===run.id))) {
    const key=`${run.nodeId}:${resolve(run.workspace,file.path)}`,prior=candidates.get(key);
    if(!prior||file.writtenAt&&(!prior.writtenAt||file.writtenAt>prior.writtenAt))candidates.set(key,{...file,run});
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
        source:c.writtenAt?tr('runArtifacts.writeRecord'):tr('runArtifacts.replyReference'),error:error||info?.error||(!info?tr('runArtifacts.deviceReturnedNoFileInformation'):null)});
    }
  }));
  items.sort((a,b)=>String(b.modifiedAt||b.recordedAt).localeCompare(String(a.modifiedAt||a.recordedAt)));
  return {items,partial:runs.length>40||candidates.size>100||groups.size>12,scannedRuns:Math.min(40,runs.length)};
}
