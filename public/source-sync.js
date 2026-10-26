import {t,onLanguageChange} from './i18n.js';
import {setActionIcon} from './role-icons.js';

const el=(tag,cls,text)=>Object.assign(document.createElement(tag),{className:cls||'',...(text===undefined?{}:{textContent:text})});
const labels={running:'Initializing',paused:'Paused',initializing:'Saving initial versions',queued:'Queued',capturing:'Scanning files',reading:'Reading changed files',staging:'Reading changed files',cleaning:'Clearing transfer staging',applying:'Applying files',completed:'Synchronized',partial_conflict:'Conflicts detected',blocked:'Blocked',cancelling:'Cancelling',cancelled:'Cancelled',preview_ready:'Scope ready',evidence_ready:'Evidence ready',open:'Conflict open',resolving:'Repair in progress',verifying:'Verifying',resolved_pending_sync:'Waiting for device receipts',resolved:'Resolved',needs_input:'Needs attention'};
const terminal=new Set(['completed','partial_conflict','blocked','cancelled','preview_ready','evidence_ready']);
const limitCodes=new Set(['file_too_large','batch_too_large','manifest_too_large','storage_full']);
const reasons={metadata_two_devices:'Simple mode requires exactly two devices and a directory scope.',metadata_baseline_required:'Pending sync baseline',metadata_conflict:'Both devices changed this file.',worker_unsupported:'Worker update required'};
const issue=(reason,limit)=>limitCodes.has(reason)?`${t('Over sync limit')}${limit?.path?' · '+limit.path:''}${limit?' · '+limit.actual.toLocaleString()+' / '+limit.maximum.toLocaleString()+' '+t(['files','scan_entries'].includes(limit.kind)?'entries':'bytes'):''}`:t(reasons[reason]||reason||'');
const button=(text,fn,cls='secondary')=>{const b=el('button',cls,t(text));b.type='button';b.addEventListener('click',()=>void fn(b));return b;};

/** Source bodies are loaded on demand. Project/dialog epochs fence all delayed responses. */
export function sourceSyncPanel({api:request,getData,getProject,refreshState=()=>{}}){
  const api=(path,json,method='POST')=>request(path,json===undefined?{}:{method,json});
  const panel=document.querySelector('#source-sync-panel'),dialog=el('dialog','source-sync-dialog');dialog.id='source-sync-dialog';dialog.setAttribute('aria-labelledby','source-sync-title');document.body.append(dialog);
  let projectId=null,epoch=0,view=0,state=null,loading=false,loadedAt=0,action=false,selectedSource=null;
  const endpoint=(id=projectId)=>`/api/projects/${encodeURIComponent(id)}/source-sync`;
  const valid=(id,v)=>id===projectId&&v===view&&dialog.open;
  const device=id=>getData().workers?.find(w=>w.id===id),name=id=>device(id)?.name||id;
  const status=value=>t(labels[value]||value);
  function modal(title){view++;dialog.replaceChildren();const h=el('header','source-sync-heading'),heading=el('h2','',t(title));heading.id='source-sync-title';h.append(heading,setActionIcon(button('Close',()=>dialog.close(),'icon-button'),'close',t('Close')));const body=el('div','source-sync-body'),note=el('p','workspace-note');note.setAttribute('role','status');dialog.append(h,body,note);if(!dialog.open)dialog.showModal();return {body,note,id:projectId,v:view};}
  dialog.addEventListener('close',()=>view++);
  async function load(force=false){
    if(!projectId||loading||(!force&&Date.now()-loadedAt<2000))return;const id=projectId,e=epoch;loading=true;
    try{const result=await api(endpoint(id));if(e!==epoch)return;state=result;loadedAt=Date.now();draw();}catch(error){if(e===epoch)panel.replaceChildren(el('p','workspace-note',error.message));}finally{if(e===epoch)loading=false;}
  }
  async function act(fn,b){if(action)return;action=true;if(b)b.disabled=true;const e=epoch;try{await fn();if(e===epoch){await load(true);await refreshState();}}catch(error){if(e===epoch){const note=el('p','workspace-note',error.message);note.setAttribute('role','alert');panel.append(note);}}finally{action=false;if(b?.isConnected)b.disabled=false;}}
  function draw(){
    panel.replaceChildren();if(!state)return;
    const h=el('div','source-sync-heading');h.append(el('h3','',t('Project file sync')),setActionIcon(button('Configure project file sync',configure),'settings',t('Configure project file sync')));panel.append(h,el('p','workspace-note',t(state.config.enabled?'Enabled':'Disabled')));
    panel.append(el('p','workspace-note',t('Saved code, documents and resources; Git delivery remains separate.')),el('p','workspace-note',t(state.config.contentMode==='source-and-outputs'?'Source and outputs':'Source only')));
    if(state.config.detection==='metadata')panel.append(el('p','workspace-note',t('Simple mode: metadata and completion receipts; equal time and size can miss content changes.')));
    if(state.config.mode==='continuous')panel.append(el('p','workspace-note',t('Automatic two-way sync continues while this page is closed.')),el('p','workspace-note',`${t('Local display device')}: ${name(state.config.displayNodeId)}`));
    for(const watcher of state.watchers||[])if(watcher.generation===state.config.generation&&watcher.status!=='watching')panel.append(el('p','workspace-note',`${name(watcher.nodeId)} · ${status(watcher.status)}${watcher.error?' · '+issue(watcher.error,watcher.limit):''}`));
    if(state.config.enabled){
      const field=el('label','',t('Source device')),select=el('select');select.setAttribute('aria-label',t('Source device'));
      for(const id of state.config.nodeIds||[]){const w=device(id),o=el('option','',`${name(id)} · ${t(!w?.online?'Offline':w.capabilities?.sourceSync!==1?'Worker update required':'Online')}`);o.value=id;select.append(o);}
      if(!state.config.nodeIds.includes(selectedSource))selectedSource=state.config.nodeIds[0];select.value=selectedSource;select.addEventListener('change',()=>selectedSource=select.value);field.append(select);panel.append(field);
      const sync=button('Sync now',b=>act(()=>api(endpoint()+'/batches',{requestId:crypto.randomUUID(),sourceNodeId:selectedSource,targetNodeIds:state.config.nodeIds.filter(id=>id!==selectedSource)}),b));sync.disabled=action||getData().settings?.paused||state.batches.some(b=>!terminal.has(b.status));panel.append(sync);
      if(getData().settings?.paused)panel.append(el('p','workspace-note',t('Execution is paused')));
    }
    if(state.config.enabled&&state.config.detection==='metadata'){
      panel.append(button('Establish sync baseline',initialize));
      for(const j of state.initializations||[]){const row=el('div','source-sync-row');row.append(el('small','workspace-note',`${t('Baseline initialization')} · ${status(j.status)} · ${j.processed} ${t('paths processed')}${j.reason?' · '+issue(j.reason):''}`));if(j.status==='paused')row.append(button('Resume initialization',b=>act(()=>api(endpoint()+'/initializations/'+j.id+'/resume',{}),b)));panel.append(row);}
    }
    for(const b of state.batches.slice(-4).reverse()){
      const row=el('div','source-sync-row');row.append(el('span','',status(b.status)));const meta=el('small','workspace-note',`${b.id.slice(0,8)}${b.reason?' · '+issue(b.reason,b.limit):''}`);meta.setAttribute('translate','no');row.append(meta);
      if(!terminal.has(b.status)){const offline=b.nodeIds.filter(id=>!device(id)?.online);if(offline.length)row.append(el('small','workspace-note',t('Waiting for devices: {names}',{names:offline.map(name).join(', ')})));row.append(button('Cancel sync',btn=>act(()=>api(endpoint()+'/batches/'+b.id+'/cancel',{revision:b.revision}),btn)));}
      for(const item of (b.pendingMetadata||[]).slice(0,20))row.append(el('small','workspace-note',`${item.path} · ${issue(item.reason)}`));
      panel.append(row);
    }
    for(const c of state.conflicts.filter(c=>!['resolved','cancelled'].includes(c.status))){const row=el('div','source-sync-row');const open=button(c.path,()=>detail(c.id));open.setAttribute('translate','no');row.append(open,el('small','workspace-note',status(c.status)));panel.append(row);}
  }
  async function initialize(){
    const {body,note,id,v}=modal('Establish sync baseline');const config=state.config;let after='',next=null,items=[],selected=new Set();
    body.append(el('p','workspace-note',t('Files may differ. Metadata alone does not prove equality. Nothing is written until you confirm an operation.')));
    const scope=el('select');scope.setAttribute('aria-label',t('Repositories'));for(const r of config.repositoryIds){const o=el('option','',getData().repositories?.find(x=>x.id===r)?.name||t('Project files and shared documents'));o.value=r;scope.append(o);}body.append(scope);
    const allLabel=el('label','source-sync-choice'),all=el('input');all.type='checkbox';allLabel.append(all,el('span','',t('All currently pending paths in this scope')));body.append(allLabel);
    const list=el('div','source-sync-preview'),more=button('Next page',async()=>{after=next;await page();}),first=button('First page',async()=>{after='';await page();});body.append(list,first,more);
    const source=el('select');source.setAttribute('aria-label',t('Source device'));for(const n of config.nodeIds){const o=el('option','',name(n));o.value=n;source.append(o);}body.append(source);
    async function page(){try{const r=await api(endpoint(id)+'/pending?'+new URLSearchParams({repositoryId:scope.value,after,limit:'50'}));if(!valid(id,v))return;items=r.items;next=r.next;more.disabled=!next;list.replaceChildren();for(const item of items){const label=el('label','source-sync-choice'),check=el('input');check.type='checkbox';check.checked=selected.has(item.path);check.addEventListener('change',()=>check.checked?selected.add(item.path):selected.delete(item.path));const text=el('span','',item.path);text.setAttribute('translate','no');label.append(check,text);list.append(label);for(const [node,m] of Object.entries(item.endpoints||{}))list.append(el('small','workspace-note',`${name(node)} · ${m.exists?t('Exists'):t('File deleted')} · ${m.size??0} ${t('bytes')} · ${m.mtimeNs||'—'} ns`));}note.textContent=t('Pending sync baseline');}catch(e){if(valid(id,v))note.textContent=e.message;}}
    scope.addEventListener('change',()=>{after='';selected.clear();void page();});
    async function submit(mode,b){if(!all.checked&&!selected.size){note.textContent=t('Select pending paths first');return;}
      if(!window.confirm(t(mode==='verify'?'Read both devices once to verify the selected files? Different contents will be preserved as conflicts.':'Save both existing versions, then overwrite from the selected source? This changes the other device.')))return;
      b.disabled=true;try{await api(endpoint(id)+'/initializations',{requestId:crypto.randomUUID(),repositoryId:scope.value,revision:config.revision,confirmed:true,all:all.checked,paths:[...selected],mode,...(mode==='overwrite'?{sourceNodeId:source.value}:{})});if(valid(id,v)){dialog.close();await load(true);}}catch(e){if(valid(id,v)){note.textContent=e.message;b.disabled=false;}}
    }
    body.append(button('Verify contents once',b=>submit('verify',b)),button('Initialize from selected source',b=>submit('overwrite',b)));await page();
  }
  async function configure(){
    await load(true);if(!state)return;const ctx=modal('Configure project file sync'),{body,note,id,v}=ctx,config=state.config;let preview=null,pending=false;
    body.append(el('p','workspace-note',t('Choose bound repositories and at least two devices. Preview scans without changing files. Disable sync before changing its scope.')));
    if(config.enabled){body.append(button('Disable project file sync',async b=>{b.disabled=true;try{await api(endpoint(id)+'/config',{enabled:false,revision:config.revision},'PUT');if(valid(id,v)){dialog.close();await load(true);}}catch(e){if(valid(id,v)){note.textContent=e.message;b.disabled=false;}}}));return;}
    const contentLabel=el('label','',t('Sync content')),content=el('select');content.setAttribute('aria-label',t('Sync content'));
    for(const [value,label] of [['source-only','Source only'],['source-and-outputs','Source and outputs']]){const option=el('option','',t(label));option.value=value;content.append(option);}content.value=config.contentMode||'source-only';contentLabel.append(content);body.append(contentLabel);
    const detectionLabel=el('label','',t('Change detection')),detection=el('select');detection.setAttribute('aria-label',t('Change detection'));
    for(const [value,label] of [['','Content hashes (existing mode)'],['metadata','Simple metadata mode (two devices)']]){const o=el('option','',t(label));o.value=value;detection.append(o);}detection.value=config.detection||'';detectionLabel.append(detection);body.append(detectionLabel,el('p','workspace-note',t('Simple mode: metadata and completion receipts; equal time and size can miss content changes.')));
    const warning=el('p','workspace-note',t('Outputs include Git-ignored reports, logs, .local and .workbench files. Filename rules cannot detect embedded tokens or hostnames. Review every newly included path before enabling. build/ and dist/ remain excluded.'));
    warning.hidden=content.value!=='source-and-outputs';body.append(warning);
    const nodes=el('fieldset'),repos=el('fieldset');nodes.append(el('legend','',t('Devices')));repos.append(el('legend','',t('Repositories')));body.append(nodes,repos);
    const displayLabel=el('label','',t('Local display device')),display=el('select');display.setAttribute('aria-label',t('Local display device'));
    for(const w of getData().workers||[])if(w.platform==='darwin'&&w.capabilities?.sourceSyncDirectory===1){const option=el('option','',w.name||w.id);option.value=w.id;display.append(option);}displayLabel.append(display);body.append(displayLabel,el('p','workspace-note',t('Source, documents and resources share one background sync. Git commits are not synchronized.')));
    const selected=(set)=>[...set.querySelectorAll('input:checked')].map(i=>i.value);
    const checkbox=(parent,text,value,disabled=false)=>{const label=el('label','source-sync-choice'),input=el('input');input.type='checkbox';input.value=value;input.disabled=disabled;input.checked=(parent===nodes?config.nodeIds:config.repositoryIds)?.includes(value)||false;label.append(input,el('span','',text));parent.append(label);input.addEventListener('change',()=>{preview=null;enable.disabled=true;previewBody.replaceChildren();});};
    for(const w of getData().workers||[]){const supported=w.capabilities?.sourceSyncDirectory===1;checkbox(nodes,`${w.name||w.id} · ${t(!supported?'Worker update required':w.online?'Online':'Offline')}`,w.id,!supported);}
    checkbox(repos,t('Project files and shared documents'),`project-files:${id}`);repos.querySelector('input').checked=true;
    for(const r of (getData().repositories||[]).filter(r=>r.projectId===id))checkbox(repos,r.name||r.key,r.id);
    const previewBody=el('div','source-sync-preview');let enable;
    content.addEventListener('change',()=>{preview=null;enable.disabled=true;previewBody.replaceChildren();warning.hidden=content.value!=='source-and-outputs';});
    detection.addEventListener('change',()=>{preview=null;enable.disabled=true;previewBody.replaceChildren();for(const i of nodes.querySelectorAll('input')){i.disabled=device(i.value)?.capabilities?.sourceSyncDirectory!==1||detection.value==='metadata'&&device(i.value)?.capabilities?.sourceSyncMetadataMode!==1;if(i.disabled)i.checked=false;}note.textContent=detection.value==='metadata'?t('Simple mode requires exactly two upgraded devices. Unavailable devices need a Worker update.'):'';});
    display.addEventListener('change',()=>{preview=null;enable.disabled=true;previewBody.replaceChildren();});
    const scan=button('Preview scope',async b=>{if(pending)return;pending=true;b.disabled=true;enable.disabled=true;const nodeIds=selected(nodes),repositoryIds=selected(repos);for(const i of body.querySelectorAll('input'))i.disabled=true;
      try{display.disabled=true;content.disabled=true;detection.disabled=true;let batch=await api(endpoint(id)+'/preview',{requestId:crypto.randomUUID(),nodeIds,repositoryIds,scopeKind:'directory',mode:'continuous',contentMode:content.value,displayNodeId:display.value,...(detection.value?{detection:detection.value}:{})});
        while(valid(id,v)&&!terminal.has(batch.status)){note.textContent=status(batch.status);await new Promise(r=>setTimeout(r,1000));const result=await api(endpoint(id)+'/batches/'+batch.id);batch=result.batch;}
        if(!valid(id,v))return;
        const result=await api(endpoint(id)+'/batches/'+batch.id);if(!valid(id,v))return;previewBody.replaceChildren();
        for(const c of result.captures){const section=el('details'),summary=el('summary','',`${name(c.nodeId)} · ${c.repositoryId} · ${Object.keys(c.entries||{}).length}`);section.append(summary);if(c.reason)section.append(el('p','workspace-note',issue(c.reason,c.limit)));const pre=el('pre','artifact-code',JSON.stringify({root:c.root,newlyIncluded:c.newlyIncluded,files:Object.keys(c.entries||{}),excluded:c.excluded},null,2));pre.setAttribute('translate','no');section.append(pre);previewBody.append(section);}
        if(batch.status!=='preview_ready')throw Error(issue(batch.reason,batch.limit)||status(batch.status));preview=batch;note.textContent=t('Scope ready');enable.disabled=false;
      }catch(e){if(valid(id,v))note.textContent=e.message;}finally{pending=false;if(valid(id,v)){display.disabled=false;content.disabled=false;detection.disabled=false;b.disabled=false;for(const i of repos.querySelectorAll('input'))i.disabled=false;for(const i of nodes.querySelectorAll('input'))i.disabled=device(i.value)?.capabilities?.sourceSyncDirectory!==1||detection.value==='metadata'&&device(i.value)?.capabilities?.sourceSyncMetadataMode!==1;}}
    });
    enable=button('Enable reviewed scope',async b=>{if(!preview||pending)return;pending=true;b.disabled=true;try{await api(endpoint(id)+'/config',{enabled:true,revision:config.revision,previewBatchId:preview.id},'PUT');if(valid(id,v)){dialog.close();await load(true);}}catch(e){if(valid(id,v)){note.textContent=e.message;b.disabled=false;}}finally{pending=false;}});enable.disabled=true;body.append(scan,previewBody,enable);
  }
  async function detail(conflictId){
    const {body,note,id,v}=modal('Source conflict');let pageVersion=0;
    try{const c=await api(endpoint(id)+'/conflicts/'+conflictId);if(!valid(id,v))return;
      const path=el('h3','',c.path);path.setAttribute('translate','no');body.append(path,el('p','',status(c.status)),el('p','workspace-note',t('Repair owner: {name}',{name:(getData().roles||[]).find(r=>r.id===c.ownerRoleId)?.name||c.ownerRoleId||t('Not assigned')})));
      if(c.reason)body.append(el('p','workspace-note',c.reason));
      const field=el('label','',t('File version')),select=el('select');select.setAttribute('aria-label',t('File version'));for(const side of [{nodeId:'base'},...c.sides,...(c.proposal?[{nodeId:'proposal'}]:[])]){
        const label=side.nodeId==='base'?t('Common base'):side.nodeId==='proposal'?t('Proposed resolution'):`${name(side.nodeId)} · ${t(side.sourceRunId?'Isolated output':'Project folder')}${side.sourceRunId?' · '+side.sourceRunId.slice(0,8):''}`;
        const o=el('option','',label);o.value=side.endpointId||side.nodeId;if(side.root)o.title=side.root;select.append(o);
      }field.append(select);const pre=el('pre','artifact-code');pre.setAttribute('translate','no');let offset=0;
      const more=button('Load more',()=>read(true));async function read(append=false){const serial=++pageVersion;if(!append)offset=0;more.disabled=true;try{const r=await api(endpoint(id)+'/conflicts/'+conflictId+'/read',{side:select.value,offset,limit:12000});if(!valid(id,v)||serial!==pageVersion)return;pre.textContent=(append?pre.textContent:'')+(r.deleted?t('File deleted'):r.binary?t('Binary file; compare the recorded hashes.'):r.content||'');offset=r.nextOffset;more.hidden=offset===null||r.deleted||r.binary;more.disabled=false;}catch(e){if(valid(id,v)&&serial===pageVersion)note.textContent=e.message;}}
      select.addEventListener('change',()=>void read());body.append(field,pre,more);await read();
      if(!valid(id,v))return;
      if(c.detection==='metadata'){
        if(['initializing','resolved','cancelled'].includes(c.status))return;
        body.append(el('p','workspace-note',t('Choose a saved side only after reviewing it. The current files will be checked again before applying.')));
        for(const side of c.sides)body.append(button(t('Use version from {name}',{name:name(side.nodeId)}),async b=>{if(!window.confirm(t('Apply this reviewed version to both devices? Unreferenced conflict copies will be removed after confirmation.')))return;b.disabled=true;try{await api(endpoint(id)+'/conflicts/'+c.id+'/resolve',{confirmed:true,generation:c.generation,sourceNodeId:side.nodeId});if(valid(id,v)){dialog.close();await load(true);}}catch(e){if(valid(id,v)){note.textContent=e.message;b.disabled=false;}}}));return;
      }
      const ownerLabel=el('label','',t('Assign repair owner')),roles=el('select');roles.setAttribute('aria-label',t('Assign repair owner'));for(const r of [...getData().roles||[],...getData().supervisorRoles||[]].filter(r=>r.projectId===id&&r.enabled&&!r.archivedAt)){const o=el('option','',r.name);o.value=r.id;roles.append(o);}ownerLabel.append(roles);body.append(ownerLabel,button('Assign',async b=>{b.disabled=true;try{await api(endpoint(id)+'/conflicts/'+conflictId+'/assign',{generation:c.generation,roleId:roles.value});if(valid(id,v)){await detail(conflictId);await load(true);}}catch(e){if(valid(id,v)){note.textContent=e.message;b.disabled=false;}}}));
      if(c.proposal){const evidence=el('pre','artifact-code',JSON.stringify({candidate:c.proposal.entry,rationale:c.proposal.rationale,evidence:c.proposal.evidence},null,2));evidence.setAttribute('translate','no');body.append(evidence);}
      if(c.reason==='independent_review_required'&&c.proposal)body.append(button('Accept independently reviewed candidate',async b=>{b.disabled=true;try{await api(endpoint(id)+'/conflicts/'+conflictId+'/review',{generation:c.generation,proposalId:c.proposal.id});if(valid(id,v)){await detail(conflictId);await load(true);}}catch(e){if(valid(id,v)){note.textContent=e.message;b.disabled=false;}}}));
    }catch(e){if(valid(id,v))note.textContent=e.message;}
  }
  document.querySelector('#configure-project-source-sync')?.addEventListener('click',()=>void configure());
  onLanguageChange(()=>{draw();if(dialog.open)dialog.close();});
  const render=()=>{const id=getProject()?.id||null;if(id!==projectId){projectId=id;epoch++;view++;state=null;loading=false;loadedAt=0;selectedSource=null;if(dialog.open)dialog.close();panel.replaceChildren();}panel.hidden=!id;if(id&&!document.querySelector('#inspector-resources').hidden)void load();};
  setInterval(()=>{if(!document.hidden)render();},2000);return {render,configure};
}
