import { t, dateLocale } from './i18n.js';
import {renderMarkdown} from './markdown.js';
import {UI_ICON,deviceIconEl,workerDisplayName,workerKind} from './role-icons.js';
import {sourceSyncPanel} from './source-sync.js';

const el=(tag,className,text)=>Object.assign(document.createElement(tag),{className:className||'',...(text!==undefined?{textContent:text}:{})});
const date=value=>value?new Date(value).toLocaleString(dateLocale(),{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'Modified time unknown';

/** Reuses existing file reading; late responses must not overwrite new content after switching projects or closing the dialog. */
export function createWorkspaceInspector({api,getProject,getData,openDevices,openProjectFolder}) {
  const sourceSync=sourceSyncPanel({api,getProject,getData});
  const names=['roles','artifacts','resources'],titles={roles:'Role Settings',artifacts:'Recent Outputs',resources:'Resources'};
  const panels=Object.fromEntries(names.map(name=>[name,document.querySelector(`#inspector-${name}`)]));
  const tabs=[...document.querySelectorAll('.inspector-tabs [role="tab"]')],list=document.querySelector('#recent-artifact-list'),note=document.querySelector('#artifacts-note');
  const tabIcons={roles:UI_ICON.roles,artifacts:UI_ICON.original,resources:UI_ICON.project};
  tabs.forEach((tab,i)=>{tab.innerHTML=tabIcons[names[i]];tab.querySelector('svg').setAttribute('aria-hidden','true');});
  const dialog=document.querySelector('#artifact-detail-dialog'),content=document.querySelector('#artifact-detail-content');
  const refresh=document.querySelector('#refresh-artifacts');refresh.innerHTML=UI_ICON.refresh;
  const manage=document.querySelector('#manage-inspector-devices');manage.innerHTML=UI_ICON.settings||UI_ICON.project;manage.addEventListener('click',openDevices);
  let selected='roles',projectId=null,generation=0,detailVersion=0,loadedAt=0,busy=false;
  document.querySelector('#close-artifact-detail').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{detailVersion++;});
  async function detail(file){
    const version=++detailVersion;
    document.querySelector('#artifact-detail-title').textContent=file.name;
    const worker=getData().workers.find(w=>w.id===file.nodeId);
    document.querySelector('#artifact-detail-meta').textContent=`${file.type} · ${file.runtime||t('Modifying CLI unknown')} · ${date(file.modifiedAt)} · ${worker?.name||file.nodeId}\n${file.path}`;
    content.textContent='Reading file…';dialog.showModal();
    // An older Worker may only lack the metadata query; the existing content API still works, so details are not blocked.
    const markdown=/\.(md|markdown)$/i.test(file.path),text=/\.(md|markdown|txt)$/i.test(file.path);
    try{
      const result=await api(`/api/runs/${encodeURIComponent(file.runId)}/${text?'document':'file'}?path=${encodeURIComponent(file.path)}`);
      if(version!==detailVersion||!dialog.open)return;
      content.replaceChildren(markdown?renderMarkdown(result.content):el('pre','artifact-code',result.content));
    }catch(error){if(version===detailVersion&&dialog.open)content.textContent=t('Unable to preview online: {message}. File info is kept; view it in the workspace of the corresponding device.', { message: error.message });}
  }
  async function load(force=false){
    if(selected!=='artifacts'||!projectId||busy||(!force&&Date.now()-loadedAt<30000))return;
    const version=generation,id=projectId;busy=true;refresh.disabled=true;note.textContent='Checking recent outputs and device files…';
    try{
      const result=await api(`/api/projects/${encodeURIComponent(id)}/artifacts`);
      if(version!==generation)return;
      list.replaceChildren();loadedAt=Date.now();
      note.textContent=result.partial?'Showing partial outputs from recent runs · see the conversation log for earlier records':'Sorted by file modified time · unknown sources are not attributed to a modifier';
      for(const file of result.items){
        const button=el('button','artifact-row');button.type='button';
        const type=el('span','artifact-filetype',file.type.slice(0,6));type.dataset.kind=/MD|TXT|DOCX|PDF/.test(file.type)?'document':'code';
        const body=el('span','artifact-row-body');body.append(el('strong','',file.name),el('small','',`${file.runtime||t('CLI unknown')} · ${date(file.modifiedAt)}`));
        if(file.error)body.append(el('small','artifact-warning',file.error));
        button.title=`${file.path}\n${file.source}${file.roleName?` · ${file.roleName}`:''}`;
        button.append(type,body);button.addEventListener('click',()=>void detail(file));list.append(button);
      }
      if(!result.items.length)list.append(el('div','inspector-empty','No recognizable outputs yet. File write records and file links in replies will appear here.'));
    }catch(error){if(version===generation){note.textContent=t('Read failed: {message}', { message: error.message });loadedAt=Date.now();}}
    finally{if(version===generation){busy=false;refresh.disabled=false;}}
  }
  function select(name){
    selected=name;for(const [key,panel] of Object.entries(panels))panel.hidden=key!==name;
    document.querySelector('#inspector-title').textContent=titles[name];
    document.querySelector('#node-sidebar').setAttribute('aria-label',titles[name]);
    document.querySelector('#inspector-role-actions').hidden=name!=='roles';
    refresh.hidden=name!=='artifacts';
    tabs.forEach((tab,i)=>{const active=names[i]===name;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;});
    void load();sourceSync.render();
  }
  tabs.forEach((tab,i)=>{tab.addEventListener('click',()=>select(names[i]));tab.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?names.length-1:(i+(event.key==='ArrowRight'?1:-1)+names.length)%names.length;select(names[next]);tabs[next].focus();}});});
  refresh.addEventListener('click',()=>void load(true));
  return {render(){
    sourceSync.render();
    const next=getProject()?.id||null;
    if(next!==projectId){projectId=next;generation++;detailVersion++;if(dialog.open)dialog.close();loadedAt=0;busy=false;refresh.disabled=false;list.replaceChildren();note.textContent=next?'':'Please select a project';}
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
  let sizes={left:216,right:320};try{const saved=JSON.parse(localStorage.getItem(key));if(Number.isFinite(saved?.left)&&Number.isFinite(saved?.right))sizes=saved;}catch{}
  function apply(){
    if(!media.matches)return;
    const leftMax=Math.min(380,innerWidth-320-420),rightMax=Math.min(500,innerWidth-sizes.left-420);
    sizes.left=Math.max(180,Math.min(leftMax,sizes.left));sizes.right=Math.max(280,Math.min(rightMax,sizes.right));
    shell.style.setProperty('--project-width',`${sizes.left}px`);shell.style.setProperty('--inspector-width',`${sizes.right}px`);
    for(const [name,side,node] of [['project','left',left],['inspector','right',right]]){const bar=document.querySelector(`#${name}-splitter`);bar.setAttribute('aria-valuenow',String(Math.round(sizes[side])));bar.setAttribute('aria-valuemin',side==='left'?'180':'280');bar.setAttribute('aria-valuemax',String(Math.round(side==='left'?leftMax:rightMax)));bar.style.left=side==='left'?`${node.getBoundingClientRect().right}px`:`${node.getBoundingClientRect().left}px`;}
  }
  for(const [name,side] of [['project','left'],['inspector','right']]){
    const bar=document.querySelector(`#${name}-splitter`);let drag;
    const save=()=>{try{localStorage.setItem(key,JSON.stringify(sizes));}catch{}};
    const end=()=>{if(!drag)return;drag=null;document.body.classList.remove('resizing-columns');save();};
    bar.addEventListener('pointerdown',e=>{if(!media.matches||e.button!==0)return;e.preventDefault();drag={x:e.clientX,width:sizes[side]};bar.setPointerCapture(e.pointerId);document.body.classList.add('resizing-columns');});
    bar.addEventListener('pointermove',e=>{if(!drag)return;sizes[side]=drag.width+(e.clientX-drag.x)*(side==='left'?1:-1);apply();});
    bar.addEventListener('pointerup',end);bar.addEventListener('lostpointercapture',end);
    bar.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();sizes[side]+=(e.key==='ArrowRight'?16:-16)*(side==='left'?1:-1);apply();save();});
    bar.addEventListener('dblclick',()=>{sizes[side]=side==='left'?216:320;apply();save();});
  }
  new ResizeObserver(apply).observe(shell);
  new ResizeObserver(apply).observe(left);window.addEventListener('resize',apply);apply();
}
