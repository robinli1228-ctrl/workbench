import {createGroupSideAsk} from './group-side-ask.js';
import { t, dateLocale } from './i18n.js';
import {renderMarkdown} from './markdown.js';
import {UI_ICON,deviceIconEl,workerDisplayName,workerKind} from './role-icons.js';
import {sourceSyncPanel} from './source-sync.js';
import {sideButton,canOpenSide} from './side-preview.js';

const el=(tag,className,text)=>Object.assign(document.createElement(tag),{className:className||'',...(text!==undefined?{textContent:text}:{})});
const date=value=>value?new Date(value).toLocaleString(dateLocale(),{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'Modified time unknown';
const sourceVersion=file=>file.readMode==='recorded'?[t(file.versionEvidence==='recorded_commit'?'Recorded commit':'Source workspace snapshot; execution-time version not recorded'),file.sourceCommit?.slice(0,12),file.sha256?`SHA256 ${file.sha256.slice(0,12)}`:''].filter(Boolean).join(' · '):'';
const fileState=file=>file.error?t('Read failed'):file.readMode==='recorded'?t('Read-only source file'):file.syncState==='conflict'?t('Sync conflict'):file.path
  ?[t('Available on Mac'),file.syncState==='disabled'?t('Sync disabled'):file.syncState==='pending'?t('Sync pending'):null].filter(Boolean).join(' · ')
  :t(file.syncState==='disabled'?'Sync disabled':file.syncState==='pending'?'Waiting for local synchronization':'Local file not found.');

/** Reuses existing file reading; late responses must not overwrite new content after switching projects or closing the dialog. */
export function createWorkspaceInspector({api,getProject,getData,openDevices,openProjectFolder,onError=()=>{},onSideAskOpen=()=>{},getConversationId=()=>getProject()?.id}) {
  const sourceSync=sourceSyncPanel({api,getProject,getData});
  const names=['roles','artifacts','resources','ask'],titles={roles:'Role Settings',artifacts:'Recent Outputs',resources:'Resources',ask:'Side question'};
  const panels=Object.fromEntries(names.map(name=>[name,document.querySelector(`#inspector-${name}`)]));
  const tabs=[...document.querySelectorAll('.inspector-tabs [role="tab"]')],list=document.querySelector('#recent-artifact-list'),note=document.querySelector('#artifacts-note');
  const tabIcons={roles:UI_ICON.roles,artifacts:UI_ICON.original,resources:UI_ICON.project,ask:UI_ICON.sideAsk};
  tabs.forEach((tab,i)=>{tab.innerHTML=tabIcons[names[i]];tab.querySelector('svg').setAttribute('aria-hidden','true');});
  const dialog=document.querySelector('#artifact-detail-dialog'),content=document.querySelector('#artifact-detail-content');
  const refresh=document.querySelector('#refresh-artifacts');refresh.innerHTML=UI_ICON.refresh;
  const manage=document.querySelector('#manage-inspector-devices');manage.innerHTML=UI_ICON.settings||UI_ICON.project;manage.addEventListener('click',openDevices);
  const sideAsk=createGroupSideAsk({api,getData,onError,getScope:()=>[getProject()?.id,getConversationId()],show(){select('ask');onSideAskOpen();}});
  let selected='roles',projectId=null,generation=0,detailVersion=0,loadedAt=0,busy=false;
  document.querySelector('#close-artifact-detail').addEventListener('click',()=>dialog.close());
  // Sessions page (desktop): "Open on the right" pins the file text beside the chat; shown once the text has loaded.
  let sideItem=null;const side=sideButton('icon-button artifact-detail-side',t('Open on the right'),()=>sideItem,{before:()=>dialog.close()});side.hidden=true;
  document.querySelector('#close-artifact-detail').before(side);
  dialog.addEventListener('close',()=>{detailVersion++;});
  async function detail(file){
    const version=++detailVersion;
    document.querySelector('#artifact-detail-title').textContent=file.name;
    const worker=getData().workers.find(w=>w.id===file.nodeId);
    document.querySelector('#artifact-detail-meta').textContent=`${file.type} · ${fileState(file)}${worker?` · ${worker.name}`:''}\n${file.path||''}${sourceVersion(file)?`\n${sourceVersion(file)}`:''}`;
    content.textContent='Reading file…';side.hidden=true;sideItem=null;dialog.showModal();
    if(!file.shared&&!file.path){content.textContent=file.error||t('Local file not found.');return;}
    // An older Worker may only lack the metadata query; the existing content API still works, so details are not blocked.
    const path=file.relativePath||file.path,markdown=/\.(md|markdown)$/i.test(path),text=/\.(md|markdown|txt)$/i.test(path);
    try{
      const result=await api(file.shared?`/api/projects/${encodeURIComponent(file.projectId)}/local-file?${new URLSearchParams({scopeId:file.scopeId,path})}`:`/api/runs/${encodeURIComponent(file.runId)}/${text?'document':'file'}?${new URLSearchParams({path,...(file.readMode==='recorded'?{source:'recorded',sha256:file.sha256,...(file.sourceCommit?{commit:file.sourceCommit}:{})}:{})})}`);
      if(version!==detailVersion||!dialog.open)return;
      if(result.shared){document.querySelector('#artifact-detail-meta').textContent=`${fileState(result)}\n${result.path||''}`;
        if(result.content===null){content.textContent=t(result.preview==='binary'?'Binary file; preview unavailable.':result.preview==='too_large'?(result.reason==='serialized_response_limit'?'Text preview exceeds the serialized response size limit.':'Local file exceeds the 600 KB text preview limit.'):result.syncState==='pending'?'Waiting for local synchronization':'Local file not found.');return;}}
      content.replaceChildren(markdown?renderMarkdown(result.content):el('pre','artifact-code',result.content));
      sideItem={title:file.name,subtitle:file.path||'',copyText:result.content,render:()=>{const box=el('div','artifact-side-content');box.append(markdown?renderMarkdown(result.content):el('pre','artifact-code',result.content));return box;}};
      side.hidden=!canOpenSide();
      if(result.syncState==='conflict'||result.syncState==='pending')content.prepend(el('p','workspace-note',t(result.syncState==='conflict'?'Conflict detected; showing actual local file.':'Showing local changes; synchronization pending.')));
    }catch(error){if(version===detailVersion&&dialog.open)content.textContent=t('Unable to preview online: {message}. File info is kept; view it in the workspace of the corresponding device.', { message: error.message });}
  }
  /** One project-output row; the Sessions panel reuses it so both views open files through the same detail dialog. */
  function artifactRow(file){
    const button=el('button','artifact-row');button.type='button';
    const type=el('span','artifact-filetype',file.type.slice(0,6));type.dataset.kind=/MD|TXT|DOCX|PDF/.test(file.type)?'document':'code';
    const body=el('span','artifact-row-body');body.append(el('strong','',file.name),el('small','',`${t(file.sourceKind==='write'?'File write record':'Mentioned in reply')}${file.runtime?` · ${file.runtime}`:''}${file.recordedAt?` · ${date(file.recordedAt)}`:''}`));
    if(file.modifiedAt)body.append(el('small','',t('Local modified: {time}',{time:date(file.modifiedAt)})));
    if(file.path){const path=el('small','artifact-local-path',file.path);path.setAttribute('translate','no');body.append(path);}
    body.append(el('small',file.error||file.syncState==='conflict'?'artifact-warning':'',fileState(file)));
    if(sourceVersion(file))body.append(el('small','artifact-local-path',`${getData().workers.find(w=>w.id===file.nodeId)?.name||file.nodeId} · ${sourceVersion(file)}`));
    if(file.error)body.append(el('small','artifact-warning',t(file.error)));
    button.title=`${file.path||''}\n${file.source}${file.roleName?` · ${file.roleName}`:''}`;
    button.append(type,body);button.addEventListener('click',()=>void detail(file));
    return button;
  }
  async function load(force=false){
    if(selected!=='artifacts'||!projectId||busy||(!force&&Date.now()-loadedAt<30000))return;
    const version=generation,id=projectId;busy=true;refresh.disabled=true;note.textContent='Checking recent outputs and device files…';
    try{
      const result=await api(`/api/projects/${encodeURIComponent(id)}/artifacts`);
      if(version!==generation)return;
      list.replaceChildren();loadedAt=Date.now();
      note.textContent=t(result.partial?'Showing partial outputs from recent runs · see the conversation log for earlier records':'Write records and reply references are shown separately; contents come from the bound Mac.');
      for(const file of result.items)list.append(artifactRow(file));
      if(!result.items.length)list.append(el('div','inspector-empty','No recognizable outputs yet. File write records and file links in replies will appear here.'));
    }catch(error){if(version===generation){note.textContent=t('Read failed: {message}', { message: error.message });loadedAt=Date.now();}}
    finally{if(version===generation){busy=false;refresh.disabled=false;}}
  }
  function select(name){
    selected=name;sideAsk.clear.hidden=name!=='ask';for(const [key,panel] of Object.entries(panels))panel.hidden=key!==name;
    document.querySelector('#inspector-title').textContent=titles[name];
    document.querySelector('#node-sidebar').setAttribute('aria-label',titles[name]);
    document.querySelector('#inspector-role-actions').hidden=name!=='roles';
    refresh.hidden=name!=='artifacts';
    tabs.forEach((tab,i)=>{const active=names[i]===name;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;});
    void load();sourceSync.render();
  }
  tabs.forEach((tab,i)=>{tab.addEventListener('click',()=>select(names[i]));tab.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?names.length-1:(i+(event.key==='ArrowRight'?1:-1)+names.length)%names.length;select(names[next]);tabs[next].focus();}});});
  refresh.addEventListener('click',()=>void load(true));
  return {artifactRow,openSideAsk:message=>sideAsk.open(message),render(){
    sourceSync.render();sideAsk.syncScope();
    const next=getProject()?.id||null;
    if(next!==projectId){if(selected==='ask')select('roles');projectId=next;generation++;detailVersion++;if(dialog.open)dialog.close();loadedAt=0;busy=false;refresh.disabled=false;list.replaceChildren();note.textContent=next?'':'Please select a project';}
    const devices=document.querySelector('#inspector-device-list');devices.replaceChildren();
    for(const worker of getData().workers||[]){
      const row=el('button','inspector-device-row'),local=workerKind(worker)==='local';row.type='button';
      const name=workerDisplayName(worker);
      row.title=local?t('Open project folder on {name}',{name}):name;
      row.append(deviceIconEl(worker),el('span','',name),el('small',worker.online?'is-online':'',worker.online?'Online':'Offline'));
      row.addEventListener('click',()=>local?void openProjectFolder(worker,row):openDevices());devices.append(row);
    }
    if(!devices.childElementCount)devices.append(el('p','artifact-list-note','No devices registered'));
    void load();
  }};
}

/** The divider is enabled on desktop only; width is bounded and persisted, and the touch drawer still uses its original 90vw. */
export function initWorkspaceColumns(){
  const shell=document.querySelector('.app-shell'),left=document.querySelector('.project-sidebar'),right=document.querySelector('.node-sidebar');
  const media=matchMedia('(min-width: 1001px)'),key='agent-workbench.column-widths';
  let sizes={left:260,right:320};try{const saved=JSON.parse(localStorage.getItem(key));if(Number.isFinite(saved?.left)&&Number.isFinite(saved?.right))sizes={left:saved.left,right:saved.right};}catch{}
  // Every right-side tab shares one width (the user widens it by hand when reading a preview), so the column never jumps.
  const slot=side=>side;
  function apply(){
    if(!media.matches)return;
    const slotRight=slot('right'),leftMax=Math.min(380,innerWidth-320-420),rightMax=Math.min(960,innerWidth-sizes.left-420);
    sizes.left=Math.max(180,Math.min(leftMax,sizes.left));sizes[slotRight]=Math.max(280,Math.min(rightMax,sizes[slotRight]));
    shell.style.setProperty('--project-width',`${sizes.left}px`);shell.style.setProperty('--inspector-width',`${sizes[slotRight]}px`);
    for(const [name,side,node] of [['project','left',left],['inspector','right',right]]){const bar=document.querySelector(`#${name}-splitter`);bar.setAttribute('aria-valuenow',String(Math.round(sizes[slot(side)])));bar.setAttribute('aria-valuemin',side==='left'?'180':'280');bar.setAttribute('aria-valuemax',String(Math.round(side==='left'?leftMax:rightMax)));bar.style.left=side==='left'?`${node.getBoundingClientRect().right}px`:`${node.getBoundingClientRect().left}px`;}
  }
  for(const [name,side] of [['project','left'],['inspector','right']]){
    const bar=document.querySelector(`#${name}-splitter`);let drag;
    const save=()=>{try{localStorage.setItem(key,JSON.stringify(sizes));}catch{}};
    const end=()=>{if(!drag)return;drag=null;document.body.classList.remove('resizing-columns');save();};
    bar.addEventListener('pointerdown',e=>{if(!media.matches||e.button!==0)return;e.preventDefault();drag={x:e.clientX,slot:slot(side),width:sizes[slot(side)]};bar.setPointerCapture(e.pointerId);document.body.classList.add('resizing-columns');});
    bar.addEventListener('pointermove',e=>{if(!drag)return;sizes[drag.slot]=drag.width+(e.clientX-drag.x)*(side==='left'?1:-1);apply();});
    bar.addEventListener('pointerup',end);bar.addEventListener('lostpointercapture',end);
    bar.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();sizes[slot(side)]+=(e.key==='ArrowRight'?16:-16)*(side==='left'?1:-1);apply();save();});
    bar.addEventListener('dblclick',()=>{const target=slot(side);sizes[target]=target==='left'?216:320;apply();save();});
  }
  new ResizeObserver(apply).observe(shell);
  new ResizeObserver(apply).observe(left);window.addEventListener('resize',apply);apply();
}
