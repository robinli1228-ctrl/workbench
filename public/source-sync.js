import {t,onLanguageChange} from './i18n.js';

const el=(tag,cls,text)=>Object.assign(document.createElement(tag),{className:cls||'',...(text===undefined?{}:{textContent:text})});
const labels={queued:'Queued',capturing:'Scanning files',applying:'Applying files',completed:'Synchronized',partial_conflict:'Conflicts detected',blocked:'Blocked',cancelling:'Cancelling',cancelled:'Cancelled',preview_ready:'Scope ready',evidence_ready:'Evidence ready',open:'Conflict open',resolving:'Repair in progress',verifying:'Verifying',resolved_pending_sync:'Waiting for device receipts',resolved:'Resolved',needs_input:'Needs attention'};
const terminal=new Set(['completed','partial_conflict','blocked','cancelled','preview_ready','evidence_ready']);
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
  function modal(title){view++;dialog.replaceChildren();const h=el('header','source-sync-heading'),heading=el('h2','',t(title));heading.id='source-sync-title';h.append(heading,button('Close',()=>dialog.close()));const body=el('div','source-sync-body'),note=el('p','workspace-note');note.setAttribute('role','status');dialog.append(h,body,note);if(!dialog.open)dialog.showModal();return {body,note,id:projectId,v:view};}
  dialog.addEventListener('close',()=>view++);
  async function load(force=false){
    if(!projectId||loading||(!force&&Date.now()-loadedAt<2000))return;const id=projectId,e=epoch;loading=true;
    try{const result=await api(endpoint(id));if(e!==epoch)return;state=result;loadedAt=Date.now();draw();}catch(error){if(e===epoch)panel.replaceChildren(el('p','workspace-note',error.message));}finally{if(e===epoch)loading=false;}
  }
  async function act(fn,b){if(action)return;action=true;if(b)b.disabled=true;const e=epoch;try{await fn();if(e===epoch){await load(true);await refreshState();}}catch(error){if(e===epoch){const note=el('p','workspace-note',error.message);note.setAttribute('role','alert');panel.append(note);}}finally{action=false;if(b?.isConnected)b.disabled=false;}}
  function draw(){
    panel.replaceChildren();if(!state)return;
    const h=el('div','source-sync-heading');h.append(el('h3','',t('Source sync')),button('Configure source sync',configure));panel.append(h,el('p','workspace-note',t(state.config.enabled?'Enabled':'Disabled')));
    panel.append(el('p','workspace-note',t('Saved source files, including uncommitted edits. Git delivery remains separate.')));
    if(state.config.enabled){
      const field=el('label','',t('Source device')),select=el('select');select.setAttribute('aria-label',t('Source device'));
      for(const id of state.config.nodeIds||[]){const w=device(id),o=el('option','',`${name(id)} · ${t(!w?.online?'Offline':w.capabilities?.sourceSync!==1?'Worker update required':'Online')}`);o.value=id;select.append(o);}
      if(!state.config.nodeIds.includes(selectedSource))selectedSource=state.config.nodeIds[0];select.value=selectedSource;select.addEventListener('change',()=>selectedSource=select.value);field.append(select);panel.append(field);
      const sync=button('Sync now',b=>act(()=>api(endpoint()+'/batches',{requestId:crypto.randomUUID(),sourceNodeId:selectedSource,targetNodeIds:state.config.nodeIds.filter(id=>id!==selectedSource)}),b));sync.disabled=action||getData().settings?.paused||state.batches.some(b=>!terminal.has(b.status));panel.append(sync);
      if(getData().settings?.paused)panel.append(el('p','workspace-note',t('Execution is paused')));
    }
    for(const b of state.batches.slice(-4).reverse()){
      const row=el('div','source-sync-row');row.append(el('span','',status(b.status)));const meta=el('small','workspace-note',`${b.id.slice(0,8)}${b.reason?' · '+b.reason:''}`);meta.setAttribute('translate','no');row.append(meta);
      if(!terminal.has(b.status)){const offline=b.nodeIds.filter(id=>!device(id)?.online);if(offline.length)row.append(el('small','workspace-note',t('Waiting for devices: {names}',{names:offline.map(name).join(', ')})));row.append(button('Cancel sync',btn=>act(()=>api(endpoint()+'/batches/'+b.id+'/cancel',{revision:b.revision}),btn)));}
      panel.append(row);
    }
    for(const c of state.conflicts.filter(c=>!['resolved','cancelled'].includes(c.status))){const row=el('div','source-sync-row');const open=button(c.path,()=>detail(c.id));open.setAttribute('translate','no');row.append(open,el('small','workspace-note',status(c.status)));panel.append(row);}
  }
  async function configure(){
    await load(true);if(!state)return;const ctx=modal('Configure source sync'),{body,note,id,v}=ctx,config=state.config;let preview=null,pending=false;
    body.append(el('p','workspace-note',t('Choose bound repositories and at least two devices. Preview scans without changing files. Disable sync before changing its scope.')));
    if(config.enabled){body.append(button('Disable source sync',async b=>{b.disabled=true;try{await api(endpoint(id)+'/config',{enabled:false,revision:config.revision},'PUT');if(valid(id,v)){dialog.close();await load(true);}}catch(e){if(valid(id,v)){note.textContent=e.message;b.disabled=false;}}}));return;}
    const nodes=el('fieldset'),repos=el('fieldset');nodes.append(el('legend','',t('Devices')));repos.append(el('legend','',t('Repositories')));body.append(nodes,repos);
    const selected=(set)=>[...set.querySelectorAll('input:checked')].map(i=>i.value);
    const checkbox=(parent,text,value,disabled=false)=>{const label=el('label','source-sync-choice'),input=el('input');input.type='checkbox';input.value=value;input.disabled=disabled;label.append(input,el('span','',text));parent.append(label);input.addEventListener('change',()=>{preview=null;enable.disabled=true;previewBody.replaceChildren();});};
    for(const w of getData().workers||[]){const supported=w.capabilities?.sourceSync===1;checkbox(nodes,`${w.name||w.id} · ${t(!supported?'Worker update required':w.online?'Online':'Offline')}`,w.id,!supported);}
    for(const r of (getData().repositories||[]).filter(r=>r.projectId===id))checkbox(repos,r.name||r.key,r.id);
    const previewBody=el('div','source-sync-preview');let enable;
    const scan=button('Preview scope',async b=>{if(pending)return;pending=true;b.disabled=true;enable.disabled=true;const nodeIds=selected(nodes),repositoryIds=selected(repos);for(const i of body.querySelectorAll('input'))i.disabled=true;
      try{let batch=await api(endpoint(id)+'/preview',{requestId:crypto.randomUUID(),nodeIds,repositoryIds});
        while(valid(id,v)&&!terminal.has(batch.status)){note.textContent=status(batch.status);await new Promise(r=>setTimeout(r,1000));const result=await api(endpoint(id)+'/batches/'+batch.id);batch=result.batch;}
        if(!valid(id,v))return;if(batch.status!=='preview_ready')throw Error(batch.reason||status(batch.status));
        const result=await api(endpoint(id)+'/batches/'+batch.id);if(!valid(id,v))return;preview=batch;previewBody.replaceChildren();
        for(const c of result.captures){const section=el('details'),summary=el('summary','',`${name(c.nodeId)} · ${c.repositoryId} · ${Object.keys(c.entries||{}).length}`);section.append(summary);const pre=el('pre','artifact-code',JSON.stringify({root:c.root,files:Object.keys(c.entries||{}),excluded:c.excluded},null,2));pre.setAttribute('translate','no');section.append(pre);previewBody.append(section);}note.textContent=t('Scope ready');enable.disabled=false;
      }catch(e){if(valid(id,v))note.textContent=e.message;}finally{pending=false;if(valid(id,v)){b.disabled=false;for(const i of repos.querySelectorAll('input'))i.disabled=false;for(const i of nodes.querySelectorAll('input'))i.disabled=device(i.value)?.capabilities?.sourceSync!==1;}}
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
      if(!valid(id,v))return;const ownerLabel=el('label','',t('Assign repair owner')),roles=el('select');roles.setAttribute('aria-label',t('Assign repair owner'));for(const r of [...getData().roles||[],...getData().supervisorRoles||[]].filter(r=>r.projectId===id&&r.enabled&&!r.archivedAt)){const o=el('option','',r.name);o.value=r.id;roles.append(o);}ownerLabel.append(roles);body.append(ownerLabel,button('Assign',async b=>{b.disabled=true;try{await api(endpoint(id)+'/conflicts/'+conflictId+'/assign',{generation:c.generation,roleId:roles.value});if(valid(id,v)){await detail(conflictId);await load(true);}}catch(e){if(valid(id,v)){note.textContent=e.message;b.disabled=false;}}}));
      if(c.proposal){const evidence=el('pre','artifact-code',JSON.stringify({candidate:c.proposal.entry,rationale:c.proposal.rationale,evidence:c.proposal.evidence},null,2));evidence.setAttribute('translate','no');body.append(evidence);}
      if(c.reason==='independent_review_required'&&c.proposal)body.append(button('Accept independently reviewed candidate',async b=>{b.disabled=true;try{await api(endpoint(id)+'/conflicts/'+conflictId+'/review',{generation:c.generation,proposalId:c.proposal.id});if(valid(id,v)){await detail(conflictId);await load(true);}}catch(e){if(valid(id,v)){note.textContent=e.message;b.disabled=false;}}}));
    }catch(e){if(valid(id,v))note.textContent=e.message;}
  }
  document.querySelector('#configure-project-source-sync')?.addEventListener('click',()=>void configure());
  onLanguageChange(()=>{draw();if(dialog.open)dialog.close();});
  const render=()=>{const id=getProject()?.id||null;if(id!==projectId){projectId=id;epoch++;view++;state=null;loading=false;loadedAt=0;selectedSource=null;if(dialog.open)dialog.close();panel.replaceChildren();}panel.hidden=!id;if(id&&!document.querySelector('#inspector-resources').hidden)void load();};
  setInterval(()=>{if(!document.hidden)render();},2000);return {render,configure};
}
