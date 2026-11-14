import {auditQuery,auditSummary,auditFields} from './source-sync-audit.js';
import {t,onLanguageChange,dateLocale} from './i18n.js';
import {formatBytes} from './media.js';
import {setActionIcon} from './role-icons.js';

const el=(tag,cls,text)=>Object.assign(document.createElement(tag),{className:cls||'',...(text===undefined?{}:{textContent:text})});
const labels={running:'Initializing',paused:'Paused',initializing:'Saving initial versions',queued:'Queued',capturing:'Scanning files',reading:'Reading changed files',staging:'Reading changed files',cleaning:'Clearing transfer staging',applying:'Applying files',completed:'Synchronized',partial_conflict:'Conflicts detected',blocked:'Blocked',cancelling:'Cancelling',cancelled:'Cancelled',preview_ready:'Scope ready',evidence_ready:'Evidence ready',open:'Conflict open',resolving:'Repair in progress',verifying:'Verifying',resolved_pending_sync:'Waiting for device receipts',resolved:'Resolved',needs_input:'Needs attention'};
const watchLabels={reconciling:'Too many folders to watch; checked every 30 seconds',blocked:'Blocked'};
const terminal=new Set(['completed','partial_conflict','blocked','cancelled','preview_ready','evidence_ready']);
const limitCodes=new Set(['file_too_large','batch_too_large','manifest_too_large','storage_full']);
const reasons={metadata_two_devices:'Simple mode requires exactly two devices and a directory scope.',metadata_baseline_required:'Pending sync baseline',metadata_conflict:'Both devices changed this file.',worker_unsupported:'Worker update required'};
const issue=(reason,limit)=>limitCodes.has(reason)?`${t('Over sync limit')}${limit?.path?' · '+limit.path:''}${limit?' · '+limit.actual.toLocaleString()+' / '+limit.maximum.toLocaleString()+' '+t(['files','scan_entries'].includes(limit.kind)?'entries':'bytes'):''}`:t(reasons[reason]||reason||'');
const button=(text,fn,cls='secondary')=>{const b=el('button',cls,t(text));b.type='button';b.addEventListener('click',()=>void fn(b));return b;};

/** Source bodies are loaded on demand. Project/dialog epochs fence all delayed responses. */
export function sourceSyncPanel({api:request,getData,getProject,refreshState=()=>{}}){
  const api=(path,json,method='POST')=>request(path,json===undefined?{}:{method,json});
  const panel=document.querySelector('#source-sync-panel'),dialog=el('dialog','source-sync-dialog');dialog.id='source-sync-dialog';dialog.setAttribute('aria-labelledby','source-sync-title');document.body.append(dialog);
  let projectId=null,epoch=0,view=0,state=null,loading=false,loadedAt=0,action=false,selectedSource=null,changes=null,changesBox=null,changesLoading=false,changesAt=0;
  const endpoint=(id=projectId)=>`/api/projects/${encodeURIComponent(id)}/source-sync`;
  const valid=(id,v)=>id===projectId&&v===view&&dialog.open;
  const device=id=>getData().workers?.find(w=>w.id===id),name=id=>device(id)?.name||id;
  const status=value=>t(labels[value]||value);
  const scopeName=id=>String(id||'').startsWith('project-files:')?t('Project folder'):getData().repositories?.find(r=>r.id===id)?.name||String(id||'').split(':').at(-1);
  const stamp=value=>value?new Date(value).toLocaleString(dateLocale(),{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'—';
  /** Files waiting to sync, fetched only while the panel is visible; nothing is kept beyond this page. */
  async function loadChanges(){
    if(!projectId||changesLoading||Date.now()-changesAt<5000||state?.config?.scopeKind!=='directory'||!state.config.enabled)return;const id=projectId,e=epoch;changesLoading=true;
    try{const result=await api(endpoint(id)+'/changes',undefined,'GET');if(e!==epoch)return;changes={...result,at:Date.now()};}catch(error){if(e===epoch)changes={error:error.message,at:Date.now()};}
    finally{if(e===epoch){changesLoading=false;changesAt=Date.now();drawChanges();}}
  }
  function changeRow({path,repositoryId,change,size,previousSize,modifiedAt},direction,{when=stamp(modifiedAt),warning=''}={}){
    const row=el('div','source-sync-change'),file=el('span','source-sync-change-file');
    const title=el('strong','',path.split('/').at(-1)),where=el('small','',`${scopeName(repositoryId)} / ${path}`);title.setAttribute('translate','no');where.setAttribute('translate','no');file.append(title,where);
    const sizeText=change==='deleted'?t('Deleted'):`${change==='modified'&&Number.isFinite(previousSize)&&formatBytes(previousSize)!==formatBytes(size)?t('{size} (was {previous})',{size:formatBytes(size),previous:formatBytes(previousSize)}):formatBytes(size)}${change==='added'?' · '+t('New file'):change==='moved'?' · '+t('Moved file'):''}`;
    row.append(file,el('span','source-sync-change-direction',direction),el('span','',sizeText),el('span','',when));
    if(warning)row.append(el('small','source-sync-change-note',warning));
    return row;
  }
  /**
   * Files waiting to sync, newest first. "Conflicts" shows each file changed on more than one device (or with an open conflict
   * record) once, with every device's time; ticked files are synchronized from one chosen device, or from whichever device
   * changed the file last. The list is redrawn only when its content changes, so a selection or an open menu survives.
   */
  let filter='all',strategy='',drawnChanges='',lastResult=[];const picked=new Set();
  const keyOf=(repositoryId,path)=>`${repositoryId}\n${path}`;
  function drawChanges(force=false){
    const box=changesBox;if(!box?.isConnected)return;
    const signature=JSON.stringify([changes&&{...changes,at:0},filter,(state.conflicts||[]).map(c=>[c.id,c.status,c.generation])]);
    if(!force&&signature===drawnChanges&&box.childElementCount){box.querySelector('.source-sync-updated')?.replaceChildren(t('Updated {time}',{time:stamp(changes?.at)}));return;}
    drawnChanges=signature;box.replaceChildren();
    if(!changes){box.append(el('h4','',t('Files waiting to sync')),el('p','workspace-note',t('Loading…')));return;}
    if(changes.error){box.append(el('h4','',t('Files waiting to sync')),el('p','workspace-note',changes.error));return;}
    const rows=[],notes=[],nodes=state.config.nodeIds||[],files=new Map();
    if(changes.applying?.length){
      for(const item of changes.applying)rows.push({at:Infinity,row:changeRow(item,`${name(item.from)} → ${name(item.to)}`,{when:t(item.done?'Written':'Writing…')})});
      if(changes.applyingTotal>changes.applying.length)notes.push(t('This sync writes {total} files; the first {shown} are shown',{total:changes.applyingTotal,shown:changes.applying.length}));
    }
    for(const device of changes.devices||[])for(const scope of device.status==='ok'?device.scopes||[]:[])for(const item of scope.status==='ok'?scope.items||[]:[]){
      const k=keyOf(scope.repositoryId,item.path),file=files.get(k)||{repositoryId:scope.repositoryId,path:item.path,devices:[]};file.devices.push({nodeId:device.nodeId,item});files.set(k,file);}
    const open=(state.conflicts||[]).filter(c=>!['resolved','cancelled'].includes(c.status)&&c.syncGeneration===state.config.generation),records=new Map(open.map(c=>[keyOf(c.repositoryId,c.path),c]));
    const conflicts=[...new Set([...[...files].filter(([,f])=>f.devices.length>1).map(([k])=>k),...records.keys()])].map(k=>{const file=files.get(k),record=records.get(k);return {key:k,file,record,repositoryId:file?.repositoryId??record.repositoryId,path:file?.path??record.path};});
    for(const device of changes.devices||[]){
      const others=nodes.filter(id=>id!==device.nodeId).map(name).join(t(', '))||'—';
      if(device.status==='offline'){notes.push(t('{name} is offline; its changes cannot be listed',{name:name(device.nodeId)}));continue;}
      if(device.status==='worker_unsupported'){notes.push(t('{name} needs a Worker update to list its changes',{name:name(device.nodeId)}));continue;}
      if(device.status==='error'){notes.push(`${name(device.nodeId)} · ${device.error}`);continue;}
      for(const scope of device.scopes||[]){
        if(scope.status==='not_observed'){notes.push(t('{name} · {scope}: first scan not finished yet',{name:name(device.nodeId),scope:scopeName(scope.repositoryId)}));continue;}
        if(scope.status==='too_large'){notes.push(t('{name} · {scope}: too many files to list until the next sync completes',{name:name(device.nodeId),scope:scopeName(scope.repositoryId)}));continue;}
        if(scope.status==='blocked'){notes.push(t('{name} · {scope}: the last scan failed, so its changes are unknown',{name:name(device.nodeId),scope:scopeName(scope.repositoryId)}));continue;}
        if(scope.status!=='ok'){notes.push(t('{name} · {scope}: changes could not be listed this time',{name:name(device.nodeId),scope:scopeName(scope.repositoryId)}));continue;}
        for(const item of scope.items){const k=keyOf(scope.repositoryId,item.path);rows.push({at:item.modifiedAt?Date.parse(item.modifiedAt):-Infinity,row:changeRow({...item,repositoryId:scope.repositoryId},`${name(device.nodeId)} → ${others}`,{warning:conflicts.some(c=>c.key===k)?t('Changed on more than one device; this will be a conflict'):''})});}
        if(scope.total>scope.items.length)notes.push(t('{name} · {scope}: {total} changed files; the first {shown} are shown',{name:name(device.nodeId),scope:scopeName(scope.repositoryId),total:scope.total,shown:scope.items.length}));
      }
    }
    if(changes.detection==='metadata')notes.push(t('Simple mode does not list waiting files; they are compared when a sync runs.'));
    else if(changes.mode!=='continuous')notes.push(t('Manual sync scans files only when you start a sync.'));
    // Title and the filter: all files, or only the conflicts.
    const head=el('div','source-sync-changes-head'),tabs=el('div','source-sync-filter');tabs.setAttribute('role','group');tabs.setAttribute('aria-label',t('Show'));
    for(const [value,label,count] of [['all','All',rows.length],['conflict','Conflicts',conflicts.length]]){const b=el('button',`source-sync-filter-option${filter===value?' is-active':''}`,`${t(label)} ${count}`);b.type='button';b.setAttribute('aria-pressed',String(filter===value));
      b.addEventListener('click',()=>{filter=value;lastResult=[];drawChanges(true);});tabs.append(b);}
    head.append(el('h4','',t('Files waiting to sync')),tabs);box.append(head);
    if(filter==='conflict')drawConflicts(box,conflicts);
    else if(rows.length){const top=el('div','source-sync-change source-sync-change-head');for(const label of ['File','Direction','Size','Time'])top.append(el('span','',t(label)));box.append(top,...rows.sort((a,b)=>b.at-a.at).map(r=>r.row));}
    else box.append(el('p','workspace-note',t('No files waiting to sync')));
    for(const note of notes)box.append(el('p','workspace-note',note));
    const foot=el('div','source-sync-foot');foot.append(el('small','workspace-note source-sync-updated',t('Updated {time}',{time:stamp(changes.at)})),button('Sync records',auditRecords,'link-button'));box.append(foot);
  }
  /** Each conflicting file once: a tick box, every device's time, then one way to sync the ticked ones. */
  function drawConflicts(box,conflicts){
    const keys=new Set(conflicts.map(c=>c.key));for(const k of [...picked])if(!keys.has(k))picked.delete(k);
    if(!conflicts.length){if(lastResult.length)box.append(el('p','workspace-note source-sync-result',lastResult.join('\n')));box.append(el('p','workspace-note',t('No conflicts')));return;}
    const nodes=state.config.nodeIds||[],choices=[...nodes.map(id=>[`device:${id}`,t('Keep the version on {name}',{name:name(id)})]),['newer',t('Keep the newer version')]];
    if(!choices.some(([value])=>value===strategy))strategy=choices[0][0];
    const bar=el('div','source-sync-resolve'),allLabel=el('label','source-sync-choice'),all=el('input');all.type='checkbox';all.checked=conflicts.every(c=>picked.has(c.key));all.indeterminate=!all.checked&&conflicts.some(c=>picked.has(c.key));
    allLabel.append(all,el('span','',t('Select all')));
    const select=el('select');select.setAttribute('aria-label',t('Sync with'));for(const [value,label] of choices){const o=el('option','',label);o.value=value;select.append(o);}select.value=strategy;select.addEventListener('change',()=>{strategy=select.value;});
    const apply=button('Sync selected',b=>resolvePicked(conflicts,b),'primary compact');
    const count=()=>{apply.disabled=!picked.size;apply.textContent=picked.size?t('Sync {count} selected',{count:picked.size}):t('Sync selected');};
    bar.append(allLabel,select,apply);box.append(bar);
    // What the last Sync selected did stays under the bar until the next one, across redraws.
    if(lastResult.length){const note=el('p','workspace-note source-sync-result',lastResult.join('\n'));note.setAttribute('role','status');box.append(note);}
    const boxes=[];
    for(const c of conflicts){
      const row=el('label','source-sync-change source-sync-conflict'),tick=el('input');tick.type='checkbox';tick.checked=picked.has(c.key);boxes.push([tick,c.key]);
      const {repositoryId,path}=c,file=el('span','source-sync-change-file'),title=el('strong','',path.split('/').at(-1)),where=el('small','',`${scopeName(repositoryId)} / ${path}`);title.setAttribute('translate','no');where.setAttribute('translate','no');file.append(title,where);
      const times=el('span','source-sync-conflict-times');for(const d of c.file?.devices||[])times.append(el('span','',`${name(d.nodeId)} · ${d.item.change==='deleted'?t('Deleted'):formatBytes(d.item.size)} · ${stamp(d.item.modifiedAt)}`));
      if(!c.file?.devices?.length)times.append(el('span','',c.record?status(c.record.status):''));
      row.append(tick,file,times);
      tick.addEventListener('change',()=>{if(tick.checked)picked.add(c.key);else picked.delete(c.key);all.checked=conflicts.every(x=>picked.has(x.key));all.indeterminate=!all.checked&&picked.size>0;count();});
      box.append(row);
    }
    all.addEventListener('change',()=>{for(const [tick,k] of boxes){tick.checked=all.checked;if(all.checked)picked.add(k);else picked.delete(k);}all.indeterminate=false;count();});
    count();
  }
  /** Sends the ticked files with the chosen device, or asks Home for the newer copy of each. */
  async function resolvePicked(conflicts,b){
    const chosen=conflicts.filter(c=>picked.has(c.key));if(!chosen.length)return;
    const items=[];
    // Home reads each device's modification time when the newer copy is asked for.
    for(const {repositoryId,path} of chosen){items.push(strategy==='newer'?{repositoryId,path,newer:true}:{repositoryId,path,sourceNodeId:strategy.slice(7)});}
    const label=strategy==='newer'?t('Keep the newer version'):t('Keep the version on {name}',{name:name(strategy.slice(7))});
    if(!window.confirm(t('Sync {count} files: {how}. The copies on the other devices will be overwritten.',{count:items.length,how:label})))return;
    await act(async()=>{const r=await api(endpoint()+'/conflicts/choose',{confirmed:true,items});
      const started=r.items.filter(x=>x.status==='applying').length,failed=r.items.filter(x=>x.status!=='applying');
      for(const x of r.items)if(x.status==='applying')picked.delete(keyOf(x.repositoryId,x.path));
      showResult([t('Started syncing {count} files',{count:started}),...failed.map(x=>`${x.path} · ${t(chooseReasons[x.status]||x.status)}`)]);
      changesAt=0;},b);
  }
  const chooseReasons={not_ready:'No conflict record yet; it can be chosen after the next sync',busy:'Already being synced',owner_running:'A role is repairing it right now',side_missing:'That device has no saved version of it',newer_unknown:'The newer version is not known',paused:'File sync is paused',conflict_changed:'Changed in the meantime; check it again'};
  function showResult(lines){lastResult=lines;drawChanges(true);}
  function modal(title){view++;dialog.replaceChildren();const h=el('header','source-sync-heading'),heading=el('h2','',t(title));heading.id='source-sync-title';h.append(heading,setActionIcon(button('Close',()=>dialog.close(),'icon-button'),'close',t('Close')));const body=el('div','source-sync-body'),note=el('p','workspace-note');note.setAttribute('role','status');dialog.append(h,body,note);if(!dialog.open)dialog.showModal();return {body,note,id:projectId,v:view};}
  dialog.addEventListener('close',()=>view++);
  async function load(force=false){
    if(!projectId||loading||(!force&&Date.now()-loadedAt<2000))return;const id=projectId,e=epoch;loading=true;
    try{const result=await api(endpoint(id));if(e!==epoch)return;state=result;loadedAt=Date.now();draw();}catch(error){if(e===epoch){drawnState='';panel.replaceChildren(el('p','workspace-note',error.message));}}finally{if(e===epoch)loading=false;}
  }
  async function act(fn,b){if(action)return;action=true;if(b)b.disabled=true;const e=epoch;try{await fn();if(e===epoch){await load(true);await refreshState();}}catch(error){if(e===epoch){const note=el('p','workspace-note source-sync-error',error.message);note.setAttribute('role','alert');panel.querySelector('.source-sync-error')?.remove();(panel.querySelector('.source-sync-heading')||panel.firstChild)?.after(note);}}finally{action=false;if(b?.isConnected)b.disabled=false;}}
  /**
   * One switch for the project's file sync and the list of files waiting to sync. Setup still goes through the configure
   * dialog (the switch opens it when sync is off); a problem that stops syncing is the only extra line.
   */
  let drawnState='';
  function draw(force=false){
    if(!state)return;
    const active=state.batches.filter(b=>!terminal.has(b.status)),waiting=active.map(b=>[b.id,b.revision,b.nodeIds.filter(id=>!device(id)?.online)]).filter(([, ,offline])=>offline.length);
    // Only what the panel shows: watcher scans and batch progress would otherwise redraw it (closing an open menu) every few seconds.
    const signature=JSON.stringify([state.config,state.batches.at(-1)?.status,state.batches.at(-1)?.reason,active.length,waiting,(state.conflicts||[]).map(c=>[c.id,c.status,c.generation,c.path]),action]);
    if(!force&&signature===drawnState&&panel.childElementCount)return;drawnState=signature;
    panel.replaceChildren();
    const h=el('div','source-sync-heading'),toggle=el('label','settings-switch'),input=el('input');input.type='checkbox';input.checked=Boolean(state.config.enabled);input.disabled=action;
    input.setAttribute('aria-label',t('Project file sync'));toggle.title=t('Project file sync');toggle.append(input,el('span'));toggle.lastChild.setAttribute('aria-hidden','true');
    input.addEventListener('change',()=>{input.checked=Boolean(state.config.enabled);
      if(!state.config.enabled){void configure();return;}
      if(!window.confirm(t('Stop project file sync? Files stay as they are on each device.')))return;
      void act(()=>api(endpoint()+'/config',{enabled:false,revision:state.config.revision},'PUT'));});
    h.append(el('h3','',t('Project file sync')),toggle);panel.append(h);
    if(state.config.enabled&&state.config.paused)panel.append(el('p','workspace-note',t('File sync is paused: nothing is synchronized until it is resumed from Device Management.')));
    const last=state.batches.at(-1);if(state.config.enabled&&last?.status==='blocked')panel.append(el('p','workspace-note source-sync-problem',`${status(last.status)}${last.reason?' · '+issue(last.reason,last.limit):''}`));
    // A sync waiting for an offline device would otherwise hold everything (even switching sync off) with no reason shown.
    for(const [id,revision,offline] of waiting){const row=el('div','source-sync-problem-row');row.append(el('span','workspace-note source-sync-problem',t('Waiting for devices: {names}',{names:offline.map(name).join(', ')})),button('Cancel sync',btn=>act(()=>api(endpoint()+'/batches/'+id+'/cancel',{revision}),btn)));panel.append(row);}
    if(state.config.enabled&&state.config.mode!=='continuous'){
      const busy=state.batches.some(b=>!terminal.has(b.status)),source=state.config.nodeIds.find(id=>device(id)?.online)||state.config.nodeIds[0];
      const sync=button('Sync now',b=>act(()=>api(endpoint()+'/batches',{requestId:crypto.randomUUID(),sourceNodeId:source,targetNodeIds:state.config.nodeIds.filter(id=>id!==source)}),b));sync.disabled=action||Boolean(state.config.paused)||busy;panel.append(sync);
    }
    if(state.config.enabled&&state.config.detection==='metadata')panel.append(button('Establish sync baseline',initialize),button('Initialization jobs',initializationJobs));
    if(state.config.enabled&&state.config.scopeKind==='directory'){changesBox=el('div','source-sync-changes');panel.append(changesBox);drawChanges(true);}
    else if(state.config.enabled)for(const c of state.conflicts.filter(c=>!['resolved','cancelled'].includes(c.status))){const row=el('div','source-sync-row');const open=button(c.path,()=>detail(c.id));open.setAttribute('translate','no');row.append(open,el('small','workspace-note',status(c.status)));panel.append(row);}
  }
  async function initializationJobs(){
    const {body,note,id,v}=modal('Initialization jobs');const list=el('div');let after='',next=null,busy=false;
    const more=button('Next page',()=>{after=next||'';return page();});more.disabled=true;
    body.append(button('Refresh',()=>{after='';return page();}),list,more);
    async function page(){if(busy)return;busy=true;more.disabled=true;try{const r=await api(endpoint(id)+'/initializations?'+new URLSearchParams({after}));if(!valid(id,v))return;next=r.next;list.replaceChildren();
      for(const j of r.items){const row=el('div','source-sync-row');row.append(el('span','',`${status(j.status)} · ${j.processed||0} ${t('paths processed')}`),el('small','workspace-note',j.createdAt||''));
        if(j.reason)row.append(el('small','workspace-note',issue(j.reason)));
        if(j.status==='paused')row.append(button('Resume initialization',async b=>{if(!window.confirm(t('Resume this initialization? Remaining paths may overwrite files using the original selection.')))return;b.disabled=true;try{const c=await api(endpoint(id)+'/config');if(!valid(id,v))return;await api(endpoint(id)+'/initializations/'+j.id+'/resume',{confirmed:true,revision:c.revision,requestId:crypto.randomUUID()});if(valid(id,v))await page();}catch(e){if(valid(id,v))note.textContent=e.message;}finally{b.disabled=false;}}));list.append(row);
      }note.textContent=r.items.length?'':t('No records');
    }catch(e){if(valid(id,v))note.textContent=e.message;}finally{busy=false;if(valid(id,v))more.disabled=!next;}}
    await page();
  }
  async function auditRecords(){
    const {body,note,id,v}=modal('Sync records'),filters=el('form'),list=el('div');let after='',next=null,sequence=0;
    const controls={};for(const [key,label,type] of [['path','Relative path (exact)','text'],['device','Device ID','text'],['from','From (local time)','datetime-local'],['to','To (local time)','datetime-local']]){const field=el('label','',t(label)),input=el('input');input.type=type;input.setAttribute('aria-label',t(label));controls[key]=input;field.append(input);filters.append(field);}
    const field=el('label','',t('Status')),select=el('select');select.setAttribute('aria-label',t('Status'));for(const [value,label] of [['','All'],['syncing','Syncing'],['succeeded','Succeeded'],['failed','Failed']]){const option=el('option','',t(label));option.value=value;select.append(option);}controls.status=select;field.append(select);filters.append(field);
    const more=button('Next page',()=>{after=next||'';return page();});more.disabled=true;
    filters.addEventListener('submit',e=>{e.preventDefault();after='';void page();});filters.append(button('Apply filters',()=>{after='';return page();}));
    body.append(el('p','workspace-note',t('Records expire after 30 days. Times use Home; file times are shown unchanged.')),filters,list,more);
    async function page(){const request=++sequence;more.disabled=true;const q=Object.fromEntries(Object.entries(controls).map(([k,input])=>[k,['from','to'].includes(k)&&input.value?new Date(input.value).toISOString():input.value]));try{const r=await api(endpoint(id)+'/audit?'+auditQuery(q,after));if(!valid(id,v)||request!==sequence)return;next=r.next;list.replaceChildren();for(const item of r.items){const summary=auditSummary(item),row=el('div','source-sync-row');const open=button(summary.path,()=>auditDetail(item.recordId));open.setAttribute('translate','no');row.append(open,el('span','',`${t(summary.action)} · ${t(summary.status)}`),el('small','workspace-note',`${name(item.sourceDevice)} → ${name(item.targetDevice)} · ${item.recordedAt}`));list.append(row);}note.textContent=r.items.length?'':t('No records');more.disabled=!next;}catch(e){if(valid(id,v)&&request===sequence)note.textContent=e.message;}}
    await page();
  }
  async function auditDetail(recordId){
    const {body,note,id,v}=modal('Sync record details');let after='',next=null,sequence=0;
    const fields=el('div'),chain=el('div'),more=button('More attempts',()=>{after=next||'';return page();});more.disabled=true;
    body.append(button('Back to records',auditRecords),fields,el('h3','',t('Retry chain')),chain,more);
    async function page(){const request=++sequence;try{const r=await api(endpoint(id)+'/audit/'+encodeURIComponent(recordId)+'?'+new URLSearchParams({after}));if(!valid(id,v)||request!==sequence)return;
      const summary=auditSummary(r.record);fields.replaceChildren(el('p','',`${t(summary.action)} · ${t(summary.status)} · ${name(r.record.sourceDevice)} → ${name(r.record.targetDevice)}`));
      for(const [label,value] of auditFields(r.record)){const section=el('div');section.append(el('strong','',t(label)));const text=el('pre','artifact-code',typeof value==='object'?JSON.stringify(value,null,2):t(String(value??'—')));text.style.whiteSpace='pre-wrap';text.style.overflowWrap='anywhere';text.setAttribute('translate','no');section.append(text);fields.append(section);}
      if(r.record.conflictId)fields.append(button('Open conflict',()=>detail(r.record.conflictId)));
      if(r.record.retryOf)fields.append(button('Previous attempt',()=>auditDetail(r.record.retryOf)));
      chain.replaceChildren();for(const attempt of r.retries.items)chain.append(button(`${attempt.attempt} · ${attempt.recordedAt} · ${t(auditSummary(attempt).status)}`,()=>auditDetail(attempt.recordId)));
      next=r.retries.next;more.disabled=!next;note.textContent=t('Expired attempts may no longer be available.');
    }catch(e){if(valid(id,v))note.textContent=e.message;}}
    await page();
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
  onLanguageChange(()=>{draw(true);if(dialog.open)dialog.close();});
  const render=()=>{const id=getProject()?.id||null;if(id!==projectId){projectId=id;epoch++;view++;state=null;loading=false;loadedAt=0;selectedSource=null;changes=null;changesLoading=false;changesAt=0;filter='all';strategy='';lastResult=[];picked.clear();drawnState='';drawnChanges='';if(dialog.open)dialog.close();panel.replaceChildren();}panel.hidden=!id;if(id&&panel.getClientRects().length){void load();void loadChanges();}};
  setInterval(()=>{if(!document.hidden)render();},2000);return {render,configure};
}
