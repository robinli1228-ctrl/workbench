import { trackLoading } from './load-bar.js';
import {copyText,bindCopyFeedback} from './role-icons.js';
import {t as globalT,dateLocale,getLanguage} from './i18n.js';
import pageZh from './locales/native-takeover-zh.js';
import {simplifiedCliOutput} from './output-language.js';
import {agentIconEl,machineIconEl,workerKind,setActionIcon,closeIcon,UI_ICON,quotaForRole,roleNameQuota} from './role-icons.js';
import {usableBucket,parseQuotaResetDate} from './quota-state.js';
import {createListOrder} from './list-order.js';
import {groupNativeSessions,readNativeSessionPages} from './native-session-groups.js';
import {createSideAsk} from './native-side-ask.js';
import {createNativeAgentSwitchUI} from './native-agent-switch.js';
import {createNativeHistoryTimeline} from './native-history-timeline.js';
import {createFolderControl} from './create-folder.js';
import {renderMarkdown} from './markdown.js';
import {linkMedia,mediaCard,mediaPathMatches,mediaKindFromName,openMediaViewer,openImageLightbox,openTextLightbox,formatBytes,copyAction,markImageOpener,fileGlyph} from './media.js';
import {createSidePreview,setSidePreviewOpener,sideButton,canOpenSide,openSide} from './side-preview.js';
import {pastesAsFile,pastedTextName,isTextName} from './pasted-text.js';
import {liveSceneRows} from './live-scene.js';
import {SEND_LABELS,uncertainSend,sendStateOf,sendLocked,lookupFailureState,sameSend} from './send-state.js';
import {stripAnsi} from './run-log-data.js';
import {taskNotificationOf,cleanUserText,commandOf,isHistoryPrompt,isCompactSummary} from './history-prompt.js';
import {cachedHistory,saveHistory,forgetHistory,compactHistoryPage} from './history-cache.js';
import {classifyStep,activityBlock,taskBlock,createPreviewSheet,elapsedText,stepTitle,stepIcon,fileChips,historyTurns,nativeInterruptionText,attachInterruptionNotices,resolveToolFile,toolFilePaths,historyContainsReply} from './native-transcript.js';

/** New takeover strings resolve from this page's own dictionary; every existing string keeps the global translation. */
const t=(text,params)=>{const own=getLanguage()==='zh'&&typeof text==='string'?pageZh[text]:undefined;return own===undefined?globalT(text,params):params?own.replace(/\{(\w+)\}/g,(m,k)=>params[k]??m):own;};
const names={codex:'Codex',claude:'Claude Code',grok:'Grok',agy:'Agy'};

/** Read bounded opaque tool-detail chunks. Successful chunks are LRU cached; failures remain retryable. */
export function createNativeToolDetailReader({api,endpoint,limit=128}){
 const cache=new Map(),inflight=new Map();
 return (item,step,ref,offset=0)=>{
  const sessionId=item.sessionId||item.id,key=JSON.stringify([item.nodeId,item.runtime,sessionId,ref,offset]);
  if(cache.has(key)){const value=cache.get(key);cache.delete(key);cache.set(key,value);return Promise.resolve(value);}
  if(inflight.has(key))return inflight.get(key);
  const url=`${endpoint(item.nodeId)}?${new URLSearchParams({runtime:item.runtime,sessionId,toolDetail:ref,detailOffset:String(offset)})}`;
  const request=Promise.resolve(api(url)).then(page=>{if(page?.callId!==step.id||page?.offset!==offset||!['tool_call','tool_result'].includes(page?.role)||typeof page?.text!=='string')throw Error('Tool detail changed; refresh this session.');cache.set(key,page);while(cache.size>limit)cache.delete(cache.keys().next().value);return page;}).finally(()=>inflight.delete(key));
  inflight.set(key,request);return request;
 };
}
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const button=(text,fn,cls='secondary')=>{const n=el('button',cls,t(text));n.type='button';n.addEventListener('click',fn);return n;};
const closeButton=fn=>{const n=button('',fn,'icon-button native-close');setActionIcon(n,'close','Close');n.dataset.close='';return n;};
/** Short utility actions in cards (refresh, edit, create, copy) are icons; the label is the tooltip and accessible name. */
const iconButton=(name,label,fn,cls='')=>{const n=el('button',`icon-button native-icon-action ${cls}`.trim());n.type='button';setActionIcon(n,name,t(label));n.addEventListener('click',fn);return n;};
/** Empty, loading and failed cards: an icon in a soft tile and a few words. A failure is amber with Retry; its reason is the tooltip. */
const stateBlock=(icon,text='',{tone='',retry=null,detail=''}={})=>{const box=el('div',`card-state${tone?` is-${tone}`:''}`),mark=el('span','card-state-icon');mark.innerHTML=UI_ICON[icon]||'';mark.querySelector('svg')?.setAttribute('aria-hidden','true');box.append(mark);
 if(text)box.append(el('p','',t(text)));if(detail)box.title=t(detail);if(retry){const again=el('button','card-state-retry',t('Retry'));again.type='button';again.addEventListener('click',retry);box.append(again);}return box;};
const failedState=(detail,retry)=>stateBlock('offline','Read failed',{tone:'warn',retry,detail});
const busyState=icon=>stateBlock(icon,'',{tone:'busy'});
const emptyState=(icon,label,busy=false)=>busy?busyState(icon):stateBlock(icon,label);

/** The session view reads native history and prepares terminal links. Only after an explicit takeover does it submit turns, resuming the same native ID. */
export function createNativeSessionUI({api,documentPreview,getData,onModeChange,onPreview,onSelect=()=>{},onStateRefresh=async()=>{}}){
 const mode=document.querySelector('#navigation-mode'),list=el('nav','project-list native-session-list'),content=el('section','native-session-content panel'),side=el('section','native-session-sidebar');
 list.id='native-session-list';content.id='native-session-content';side.id='native-session-sidebar';
 document.querySelector('#project-list').after(list);document.querySelector('main.workspace').append(content);document.querySelector('#node-sidebar').append(side);
 /** The right side mirrors the group-chat inspector: one header, three panels and the same bottom tab bar and classes. */
 // Preview (desktop only) holds one message, picture, video or file opened "on the right" for reading beside the chat.
 // Resources moved out: the session ID sits under the This page / iTerm switch, the working folder in Files, the repository
 // and AGENTS.md in Session settings.
 // Side question: a read-only chat beside the session that never reaches it (Claude and Codex only).
 const SIDE_TABS=['overview','outputs','preview','ask'],SIDE_TITLES={overview:'Overview',outputs:'Files',preview:'Preview',ask:'Side question'};
 const SIDE_ICONS={overview:UI_ICON.overview,outputs:UI_ICON.original,preview:UI_ICON.sideOpen,ask:UI_ICON.sideAsk};
 let sideTab='overview';
 const sideHeader=el('header','inspector-header native-side-header'),sideTitle=el('h2',''),sideBadge=el('span','native-side-badge');sideBadge.hidden=true;sideHeader.append(sideTitle,sideBadge);
 const sidePanels=Object.fromEntries(SIDE_TABS.map(name=>{const panel=el('section','inspector-panel native-side-panel');panel.id=`native-side-${name}`;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',`native-side-tab-${name}`);return [name,panel];}));
 const sideTabBar=el('div','inspector-tabs native-side-tabs');sideTabBar.setAttribute('role','tablist');sideTabBar.setAttribute('aria-label',t('Right panel sections'));
 const sideTabButtons=SIDE_TABS.map((name,index)=>{
  const tab=el('button');tab.type='button';tab.id=`native-side-tab-${name}`;tab.setAttribute('role','tab');tab.setAttribute('aria-controls',`native-side-${name}`);
  tab.setAttribute('aria-label',t(SIDE_TITLES[name]));tab.title=t(SIDE_TITLES[name]);tab.innerHTML=SIDE_ICONS[name];tab.querySelector('svg')?.setAttribute('aria-hidden','true');
  tab.addEventListener('click',()=>selectSideTab(name));
  tab.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();
   const next=event.key==='Home'?0:event.key==='End'?SIDE_TABS.length-1:(index+(event.key==='ArrowRight'?1:-1)+SIDE_TABS.length)%SIDE_TABS.length;selectSideTab(SIDE_TABS[next]);sideTabButtons[next].focus();});
  return tab;});
 sideTabBar.append(...sideTabButtons);side.append(sideHeader,...Object.values(sidePanels),sideTabBar);
 const sidePreview=createSidePreview({t,formatSize:formatBytes,stamp:value=>time(value),copyAction,emptyText:t('Use \u201cOpen on the right\u201d beside Copy on a message, or beside Download in a picture or file preview. It stays here while you read the chat or switch sessions.')});
 sidePanels.preview.classList.add('is-preview');sidePanels.preview.append(sidePreview.root);
 // The panel is offered only while the Sessions page is shown; opening shows the right column if it was hidden.
 setSidePreviewOpener({key:'sessions',available:()=>active(),open:item=>{if(document.body.dataset.inspector==='hidden')document.querySelector('#toggle-inspector')?.click();selectSideTab('preview');void sidePreview.open(item);}});
 /** The chosen tab stays selected across sessions, like the group-chat inspector. */
 function selectSideTab(name){
  sideTab=name;document.body.dataset.sessionSideTab=name;for(const [tab,panel] of Object.entries(sidePanels))panel.hidden=tab!==name;
  sideTitle.textContent=t(SIDE_TITLES[name]);side.setAttribute('aria-label',t(SIDE_TITLES[name]));
  sideTabButtons.forEach((tab,i)=>{const on=SIDE_TABS[i]===name;tab.setAttribute('aria-selected',String(on));tab.tabIndex=on?0:-1;});
  // Header actions belong to one tab each: the brush clears the side question, the folder opens the working folder.
  for(const [cls,tab] of [['.native-ask-clear','ask'],['.native-folder-open','outputs']]){const b=sideHeader.querySelector(cls);if(b)b.hidden=name!==tab;}
  if(name==='outputs')renderOutputs();
 }
 /**
  * Files named in loaded agent replies, kept per native session: the timeline also renders earlier sessions of the same
  * group, which must not clear the selected one. Only the most recent sessions are kept. Cards read only metadata (at
  * most 12 per render); file bytes are fetched when a card is opened.
  */
 const OUTPUT_SESSIONS=8;let outputs=new Map(),outputsTimer=null;
 // Declared before resetSide() runs at setup: repository cache and the in-progress rename.
 const gitCache=new Map();let gitKey=null,renaming=null;
 // A path keeps its latest mention; live replies (no timestamp yet) count as newest, unreadable times as oldest.
 const outputRank=value=>{if(!value)return Infinity;const time=Date.parse(value);return Number.isFinite(time)?time:0;};
 function noteOutputs(session,text,at,filePaths=[]){
  const context=mediaContext(session);if(!context)return;
  const paths=mediaPathMatches(text);if(!paths.length)return;
  let items=outputs.get(context.key);
  if(!items){
   items=new Map();outputs.set(context.key,items);
   // Evict the oldest other session first; the selected session's list is never the one dropped.
   const keep=selected?mediaContext(selected)?.key:null;
   for(const old of outputs.keys()){if(outputs.size<=OUTPUT_SESSIONS)break;if(old!==keep&&old!==context.key)outputs.delete(old);}
  }
  let changed=false;
  for(const ref of paths){const {path}=resolveToolFile(ref.path,filePaths),prior=items.get(path);if(prior&&outputRank(prior.at)>=outputRank(at))continue;items.set(path,{path,at:at||null,filePaths});changed=true;}
  if(changed&&sideTab==='outputs'&&selected&&mediaContext(selected)?.key===context.key){clearTimeout(outputsTimer);outputsTimer=setTimeout(renderOutputs,100);}
 }
 /**
  * Resolve the registered project for project-level controls using role identity or an unambiguous workspace binding.
  * The Files tab does not load that project's artifacts or scan the session working folder.
  */
 function sessionProject(item){
  const data=getData();if(!item)return null;
  if(item.roleBinding?.projectId)return data.projects?.find(p=>p.id===item.roleBinding.projectId)||null;
  const id=nativeId(item);if(!id)return null;
  const known=new Set((data.roleSessions||[]).filter(s=>!s.historyClearedAt&&s.runtime===item.runtime&&s.nativeSessionId===id&&s.nodeId===item.nodeId).map(s=>s.projectId));
  if(known.size)return known.size===1?data.projects?.find(p=>p.id===[...known][0])||null:null;
  // A working folder inside a project's bound folder on this device is a Workbench record too; the deepest binding wins, ties stay unlinked.
  const ws=item.workspace;if(typeof ws!=='string'||!ws)return null;
  const within=(root,path)=>path===root||path.startsWith(root.endsWith('/')?root:`${root}/`);
  const hits=(data.workspaces||[]).filter(w=>w.nodeId===item.nodeId&&typeof w.localRoot==='string'&&w.localRoot&&within(w.localRoot,ws)).sort((a,b)=>b.localRoot.length-a.localRoot.length);
  if(!hits.length)return null;const ids=new Set(hits.filter(w=>w.localRoot.length===hits[0].localRoot.length).map(w=>w.projectId));
  return ids.size===1?data.projects?.find(p=>p.id===[...ids][0])||null:null;
 }
 /** The working folder is browsed only when its header button is opened. */
 const folderState=new Map();
 const fileName=path=>String(path||'').replace(/[\\/]+$/,'').split(/[\\/]/).pop()||String(path||'');
 const fileDir=path=>{const name=fileName(path);return String(path||'').slice(0,Math.max(0,String(path||'').length-name.length));};
 const documentContext=session=>({kind:'native',nodeId:session?.nodeId,runtime:session?.runtime,sessionId:session?nativeId(session):null,entryId:session?.entryId});
 async function openFile(session,path){
  if(/\.(?:md|markdown|txt)$/i.test(path)){void documentPreview.open(path,documentContext(session));return;}
  const context=mediaContext(session);
  if(mediaKindFromName(path)!=='file'&&context){void openMediaViewer(path,context).catch(()=>{});return;}
  preview.loading(path);
  try{const file=await api(`${endpoint(session.nodeId)}/file?${new URLSearchParams({runtime:session.runtime,sessionId:nativeId(session)||'',...(session.entryId?{entryId:session.entryId}:{}),path})}`);
   const meta=[formatBytes(file.size),file.modifiedAt?time(file.modifiedAt):''].filter(Boolean).join(' · ');
   preview.openText(path,{content:file.preview==='text'?file.content:null,kind:meta,note:file.preview==='binary'?t('Binary file; no text preview.'):file.preview==='too_large'?t('File is larger than 600 KB; open it on the device.'):''});
  }catch(error){preview.openText(path,{note:t(error.message)});}
 }
 function fileRow(session,path,step,extra=''){
  const row=el('button','native-file-row');row.type='button';row.title=path;row.translate=false;
  row.append(stepIcon(step?step.kind:'read'));const text=el('span','native-file-text');text.append(el('span','native-file-name',fileName(path)),el('span','native-file-dir',fileDir(path)));row.append(text);
  if(extra)row.append(el('span','native-file-extra',extra));
  row.addEventListener('click',()=>{if(step)preview.open(step,path,{actions:[{label:t('Current file'),onClick:()=>void openFile(session,path)}]});else void openFile(session,path);});
  return row;
 }
 async function loadFolder(session,path,offset=0){
  const id=key(session),st=folderState.get(id);if(!st||st.path!==path)return;st.loading=true;st.error=null;renderFolder();
  try{const result=await api(`${endpoint(session.nodeId)}/folders?${new URLSearchParams({path,offset:String(offset)})}`);if(folderState.get(id)!==st||st.path!==path)return;
   const entries=(result.entries||[]).filter(e=>e.type==='folder'||e.type==='file');st.entries=offset?[...(st.entries||[]),...entries]:entries;st.hasMore=Boolean(result.hasMore);st.nextOffset=result.nextOffset||0;st.parent=result.parent||null;}
  catch(error){st.error=error.message;st.errorAt=Date.now();}
  finally{st.loading=false;if(selected&&key(selected)===id)renderFolder();}
 }
 function folderCard(session){
  // Shown in the working-folder dialog: the path crumbs head the card, the dialog carries the title.
  const card=el('section','native-side-card native-folder-card'),root=session.workspace,folderHead=el('div','native-card-head');card.append(folderHead);
  if(!root){card.append(stateBlock('folder','No folder yet'));return card;}
  // Files this session read, edited or created in page turns, latest state per path, right above the folder they live in.
  const touched=takeover.files();
  if(touched.length){const changes=el('div','native-folder-changes'),list=el('div','native-file-list');changes.append(el('div','native-subhead',t('Touched in this session')),list);for(const {path,step} of touched.slice(0,20))list.append(fileRow(session,path,step,step.kind==='edit'&&(step.added||step.removed)?`+${step.added||0} −${step.removed||0}`:''));card.append(changes);}
  const id=key(session);let st=folderState.get(id);if(!st||st.root!==root){st={root,path:root,entries:null,loading:false,error:null,hasMore:false,nextOffset:0};folderState.set(id,st);}
  const reloadFolder=iconButton('refresh','Refresh',()=>{st.entries=null;st.error=null;st.hasMore=false;renderFolder();});reloadFolder.disabled=st.loading;folderHead.append(reloadFolder);
  const crumbs=el('div','native-folder-crumbs'),rel=st.path.startsWith(root)?st.path.slice(root.length).split('/').filter(Boolean):[];
  const crumb=(label,path,last)=>{const b=el('button',`native-folder-crumb${last?' is-current':''}`,label);b.type='button';b.title=path;b.translate=false;b.disabled=last;b.addEventListener('click',()=>{st.path=path;st.entries=null;renderFolder();});return b;};
  crumbs.append(crumb(fileName(root)||root,root,!rel.length));let acc=root;rel.forEach((part,i)=>{acc=`${acc}/${part}`;crumbs.append(el('span','native-folder-sep','/'),crumb(part,acc,i===rel.length-1));});folderHead.prepend(crumbs);
  if(!st.entries&&!st.loading&&!st.error)void loadFolder(session,st.path);
  if(st.error)card.append(failedState(st.error,()=>{st.entries=null;st.error=null;renderFolder();}));
  const list=el('div','native-file-list');
  for(const entry of st.entries||[]){
   if(entry.type==='folder'){const row=el('button','native-file-row is-folder');row.type='button';row.title=entry.path;row.translate=false;row.append(stepIcon('folder'));const text=el('span','native-file-text');text.append(el('span','native-file-name',`${entry.name}/`));row.append(text);row.addEventListener('click',()=>{st.path=entry.path;st.entries=null;renderFolder();});list.append(row);}
   else list.append(fileRow(session,entry.path,null));
  }
  if(st.entries&&!st.entries.length)list.append(stateBlock('folder','Empty folder'));
  card.append(list);
  if(st.loading&&!st.entries)card.append(busyState('folder'));else if(st.loading)card.append(el('p','native-side-hint',t('Loading…')));
  else if(st.hasMore)card.append(button('Load more',()=>void loadFolder(session,st.path,st.nextOffset),'secondary native-card-action'));
  return card;
 }
 /** AGENTS.md: the project memory every CLI loads from this folder (nearest one upwards). Shown on Resources, edited in a dialog. */
 const agentsCache=new Map();
 const agentsQuery=value=>{const id=nativeId(value);return new URLSearchParams({runtime:value.runtime,...(id?{sessionId:id}:{}),...(value.entryId?{entryId:value.entryId}:{})});};
 async function loadAgents(value,force=false){const k=key(value),cached=agentsCache.get(k);if(!value.workspace||cached?.loading||!force&&cached)return;agentsCache.set(k,{loading:true});renderAgents(value);
  let state;try{state=await api(`${endpoint(value.nodeId)}/agents-md?${agentsQuery(value)}`);}catch(error){state={error:error.message};}
  agentsCache.set(k,{state,at:Date.now()});if(selected&&key(selected)===k)renderAgents(selected);}
 function agentsCard(value){
  const card=el('section','native-side-card native-agents-card');card.dataset.nativeAgents='';const head=el('div','native-card-head');head.append(el('h3','','AGENTS.md'));card.append(head);
  const cached=agentsCache.get(key(value));
  if(!value.workspace){card.append(stateBlock('original','No folder yet'));return card;}
  const reloadAgents=iconButton('refresh','Refresh',()=>void loadAgents(value,true));reloadAgents.disabled=Boolean(cached?.loading);head.append(reloadAgents);
  if(!cached||cached.loading){card.append(busyState('original'));return card;}
  const st=cached.state;if(st.error){card.append(failedState(st.error,()=>void loadAgents(value,true)));return card;}
  if(!st.found){card.append(stateBlock('original','No AGENTS.md yet'));head.append(iconButton('plus','Create AGENTS.md',()=>openAgentsEditor(value,st)));return card;}
  const where=el('div','native-agents-path',st.path);where.title=st.path;where.translate=false;card.append(where);
  const preview=el('pre','native-agents-preview',st.tooLarge?t('File is larger than 600 KB; open it on the device.'):(st.content||'').trim()||t('(empty)'));preview.translate=false;preview.title=t('Edit');card.append(preview);
  const edit=iconButton('edit','Edit AGENTS.md',()=>openAgentsEditor(value,st));edit.disabled=Boolean(st.tooLarge);head.append(edit);
  if(!st.tooLarge)preview.addEventListener('click',()=>openAgentsEditor(value,st));
  return card;
 }
 function renderAgents(value){const prior=dialog.querySelector('[data-native-agents]');if(prior&&side.dataset.sessionKey===key(value))prior.replaceWith(agentsCard(value));}
 let agentsDialog=null;
 function openAgentsEditor(value,st){
  if(!agentsDialog){agentsDialog=el('dialog','settings-edit-dialog native-session-dialog native-agents-dialog');document.body.append(agentsDialog);}
  const heading=el('div','dialog-heading');heading.append(el('h2','',t(st.found?'Edit AGENTS.md':'Create AGENTS.md')),closeButton(()=>agentsDialog.close()));
  const where=el('p','native-side-hint native-agents-path',st.found?st.path:t('A new AGENTS.md goes to the project folder on this device, or to the working folder.'));where.translate=!st.found;
  const area=el('textarea','native-agents-editor');area.value=st.found?(st.content||''):'';area.rows=22;area.spellcheck=false;area.setAttribute('aria-label','AGENTS.md');
  const feedback=el('p','native-form-feedback'),actions=el('div','native-session-actions'),cancel=button('Cancel',()=>agentsDialog.close(),'secondary');
  const save=button('Save',async()=>{save.disabled=cancel.disabled=true;feedback.textContent=t('Saving…');
   try{await api(`${endpoint(value.nodeId)}/agents-md?${agentsQuery(value)}`,{method:'PUT',json:{path:st.found?st.path:null,content:area.value,expectedModifiedAt:st.found?st.modifiedAt:null,create:!st.found}});agentsDialog.close();await loadAgents(value,true);}
   catch(error){feedback.textContent=t(error.message);save.disabled=cancel.disabled=false;}},'primary');
  actions.append(cancel,save);agentsDialog.replaceChildren(heading,where,area,feedback,actions);agentsDialog.showModal();area.focus();
 }
 /** A read that failed (often while the device was reconnecting) is retried on the next state refresh once the device is online,
  *  at most every 8 seconds and only for the cards that failed; successful reads stay cached. */
 function retryFailedReads(value){
  if(!value||side.dataset.sessionKey!==key(value)||!getData().workers?.find(w=>w.id===value.nodeId)?.online)return;
  const k=key(value),now=Date.now();
  const agents=agentsCache.get(k);if(agents?.state?.error&&!agents.loading&&now-(agents.at||0)>8000)void loadAgents(value,true);
  const git=gitCache.get(k);if(git?.state&&!git.loading&&!git.state.available&&['source_offline','git_read_failed'].includes(git.state.reason)&&now-Date.parse(git.at||0)>8000)void loadGit(value,true);
  const folder=folderState.get(k);if(folder?.error&&!folder.loading&&now-(folder.errorAt||0)>8000){folder.error=null;folder.entries=null;renderFolder();}
 }
 /** The working folder browser sits on the Resources tab; navigating it redraws only that card. */
 /** The working folder opens in a dialog from the folder icon in the Files header. */
 const folderDialog=el('dialog','settings-edit-dialog native-session-dialog native-folder-dialog');document.body.append(folderDialog);
 {const heading=el('div','dialog-heading');heading.append(el('h2','',t('Working folder')),closeButton(()=>folderDialog.close()));folderDialog.append(heading,el('div','native-folder-slot'));}
 // A text file opens in the sheet over the transcript, which a modal dialog would cover: close it first. Pictures open above it.
 folderDialog.addEventListener('click',event=>{const row=event.target.closest?.('.native-file-row:not(.is-folder)');if(row&&mediaKindFromName(row.title)==='file')folderDialog.close();},true);
 function openFolder(){if(!selected)return;folderDialog.querySelector('.native-folder-slot').replaceChildren(folderCard(selected));if(!folderDialog.open)folderDialog.showModal();}
 function renderFolder(){const prior=folderDialog.open&&folderDialog.querySelector('.native-folder-card');if(prior&&selected&&side.dataset.sessionKey===key(selected))prior.replaceWith(folderCard(selected));}
 function renderOutputs(){
  const panel=sidePanels.outputs;
  if(!selected){if(folderDialog.open)folderDialog.close();panel.replaceChildren(el('p','native-side-hint',t('Select a native session to view its details.')));return;}
  const context=mediaContext(selected);
  // Replace the complete view once: only files named in this session's loaded replies belong here.
  const mentioned=el('section','native-side-card native-files-half'),head=el('div','native-card-head'),body=el('div','native-files-body');head.append(el('h3','',t('Named in replies')));mentioned.append(head,body);
  const items=context&&outputs.has(context.key)?[...outputs.get(context.key).values()].sort((a,b)=>outputRank(b.at)-outputRank(a.at)):[];
  if(!items.length)body.append(emptyState('quote','No files mentioned yet'));
  else{const list=el('div','native-output-list');items.slice(0,50).forEach((item,index)=>list.append(mediaCard(item.path,{...context,filePaths:()=>item.filePaths||[]},{describe:index<12})));body.append(list);}
  panel.replaceChildren(mentioned);renderFolder();
 }
 resetSide();
 // Session settings live behind a gear at the right end of the top bar, where the connection note sits in other modes.
 const gear=el('button','icon-button native-session-gear');gear.id='native-session-settings';gear.type='button';gear.disabled=true;setActionIcon(gear,'gear',t('Session settings'));
 gear.addEventListener('click',()=>{if(selected)openSessionSettings(selected);});gear.hidden=true;(document.querySelector('#toggle-inspector')||document.querySelector('#connection-note'))?.before(gear);
 const filters=el('div','native-session-filters'),device=el('select'),tool=el('select');device.setAttribute('aria-label',t('Session device'));tool.setAttribute('aria-label',t('Agent tool'));filters.append(device,tool);list.before(filters);
 const note=el('p','workspace-note');list.before(note);note.classList.add('native-session-note');
 // A narrowed left column (dragged below ~230px, or collapsed) drops the device/tool filters; the list keeps the width.
 const sidebar=document.querySelector('#project-sidebar');if(sidebar&&'ResizeObserver' in window)new ResizeObserver(()=>{filters.classList.toggle('is-narrow',sidebar.getBoundingClientRect().width<205);}).observe(sidebar);
 let selected=null,items=[],version=0,detailVersion=0,lastCatalog='',loading=false,pendingRefresh=false,modeValue=(()=>{try{const saved=sessionStorage.getItem('agent-workbench.navigation-mode');return saved==='groups'||saved==='sessions'?saved:'sessions';}catch{return 'sessions';}})(),lastRefresh=0,listSignature='',detailSignature='',detailMeta='';
 const active=()=>modeValue==='sessions';
 const endpoint=nodeId=>`/api/native-sessions/${encodeURIComponent(nodeId)}`;
 const key=item=>item?`${item.nodeId}/${item.runtime}/${item.entryId||item.id}`:'';
 const historyReadStamps=new Map();let historyLoading=null;
 const historyStamp=item=>JSON.stringify([nativeId(item),item.historyRevision||item.modifiedAt||null,item.hasHistory,item.previewAvailable,item.workspace]);
 const SELECTION_KEY='agent-workbench.native-session'; // per tab, like agent-workbench.project for the group chat
 // Which side the left column shows; a reload keeps it (per tab), a new tab starts on Sessions.
 const MODE_KEY='agent-workbench.navigation-mode';
 const listOrder=createListOrder({container:list,scope:'native-sessions',onEnd:()=>{listSignature='';renderList();},onError:message=>{note.textContent=message;}});
 const nativeId=item=>item.entryId?item.sessionId:item.sessionId||item.id;
 const toolPreview=item=>getData().workers?.find(worker=>worker.id===item?.nodeId)?.capabilities?.nativeToolDetails===1;
 const toolDetail=createNativeToolDetailReader({api,endpoint});
 const workerName=id=>getData().workers?.find(w=>w.id===id)?.name||id;
 const time=value=>{const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleString(dateLocale(),{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});};
 /** Transcript rows show the clock time; the day sits on the centred date lines between them, the full stamp in the tooltip. */
 const clock=value=>{const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleTimeString(dateLocale(),{hour:'2-digit',minute:'2-digit'});};
 const dayLabel=date=>{const now=new Date(),start=d=>new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime(),days=Math.round((start(now)-start(date))/864e5);
  return `${days===0?t('Today'):days===1?t('Yesterday'):date.toLocaleDateString(dateLocale(),{...(date.getFullYear()===now.getFullYear()?{}:{year:'numeric'}),month:'2-digit',day:'2-digit'})} ${clock(date)}`;};
 let returningClaim=null,controlFeedback=null,sessionIdRow=null;
 /** 只用已有状态快照绘制占用，不新增轮询；归还始终指向保存的接管记录。 */
 function renderSessionControls(item){
  if(!item||!active())return;
  const data=getData(),id=nativeId(item),worker=data.workers?.find(w=>w.id===item.nodeId),runs=data.runs||[];
  const sessions=data.roleSessions||[],byId=new Map(sessions.map(s=>[s.id,s])),ownership=new Map();
  const ownersFor=(runtime,sessionId)=>{
   const key=JSON.stringify([runtime,sessionId]);if(ownership.has(key))return ownership.get(key);
   const known=new Set(),unknown=new Set();
   if(sessionId){
    for(const s of sessions)if(s.runtime===runtime&&s.nativeSessionId===sessionId){if(s.nodeId===item.nodeId)known.add(s.projectId);else if(!s.nodeId)unknown.add(s.projectId);}
    for(const run of runs)if(run.nativeSession?.runtime===runtime&&run.nativeSession.id===sessionId){const saved=byId.get(run.roleSessionId),nodeId=run.nodeId||(saved?.projectId===run.projectId?saved.nodeId:null);if(nodeId===item.nodeId)known.add(run.projectId);else if(!nodeId)unknown.add(run.projectId);}
   }
   const result={known,unknown};ownership.set(key,result);return result;
  };
  const selectedOwners=ownersFor(item.runtime,id),owners=selectedOwners.known;
  const leases=(data.terminalSessions||[]).filter(c=>c.nodeId===item.nodeId&&!['released','cancelled'].includes(c.status));
  const matches=leases.filter(c=>{const run=runs.find(r=>r.id===c.runId),runtime=c.runtime||c.nativeSession?.runtime||run?.nativeSession?.runtime,sessionId=c.sessionId||c.nativeSession?.id||run?.nativeSession?.id;return item.entryId&&c.catalogEntryId===item.entryId||id&&runtime===item.runtime&&sessionId===id;});
  if(pageOpened.has(key(item))&&nativeId(item)&&item.hasHistory&&!matches.length){pageOpened.delete(key(item));takeover.adopt({...item,sessionId:nativeId(item)});void read(item);return;}
  const claim=matches.length===1?matches[0]:null,other=leases.find(c=>owners.has(c.projectId)||c.kind==='native'&&[...ownersFor(c.runtime||c.nativeSession?.runtime,c.sessionId||c.nativeSession?.id).known].some(projectId=>owners.has(projectId)));
  const uncertain=selectedOwners.unknown.size>0||leases.some(c=>c.kind==='native'&&[...ownersFor(c.runtime||c.nativeSession?.runtime,c.sessionId||c.nativeSession?.id).unknown].some(projectId=>owners.has(projectId)));
  const managedBusy=runs.some(r=>r.nodeId===item.nodeId&&!['succeeded','failed','interrupted'].includes(r.status)&&(owners.has(r.projectId)||id&&r.nativeSession?.runtime===item.runtime&&r.nativeSession.id===id));
  const panel=sidePanels.overview.querySelector('[data-native-controls]');if(!panel)return;
  const nativeTurn=claim?.kind==='native-turn',online=Boolean(worker?.online),canTakeover=worker?.capabilities?.nativeTakeover===1,chatOn=takeover.isOn(item)||takeover.canChat(item);
  // One state, one sentence, the actions that make sense for it.
  let state,detail='';
  if(matches.length>1){state='busy';detail='Several terminal reservations match this session; use role details to check them';}
  else if(!online)state='offline';
  else if(nativeTurn||chatOn&&!claim)state=claim?.status==='stopping'||takeover.isReleasing(item)?'ending':'page';
  else if(claim?.kind==='native'&&claim.openedOn==='page')state='starting';
  else if(claim){state=claim.status==='stopping'?'stopping':claim.status==='prepared'?'prepared':claim.status==='finished'||claim.processState==='released'?'returning':'terminal';if(claim.processState==='unknown')detail='Terminal process state unverified';}
  else if(other||uncertain||managedBusy){state='busy';detail=uncertain?'Native session device ownership is unknown; check the original role session':managedBusy?'Managed CLI is running; takeover is unavailable':'Another terminal has taken over this group chat';}
  else if(item.canReopen)state='unstarted';
  else if(!id||item.hasHistory===false)state='nohistory';
  else state='idle';
  // Coming back from iTerm without pressing anything here: once its claim is gone, chatting on this page is allowed again.
  const prevState=connectionStates.get(key(item));connectionStates.set(key(item),state);
  if(['terminal','prepared','returning','stopping'].includes(prevState)&&state==='idle')takeover.returned(item);
  const mode=['page','ending','starting'].includes(state)?'page':['terminal','prepared','returning','stopping'].includes(state)?'terminal':null,switchingTo=switching.get(key(item))||null;
  const copyCommand=side.querySelector('.native-copy-command');if(copyCommand)copyCommand.disabled=takeover.releaseDisabled(item)||copyCommand.dataset.pending==='true';
  const signature=JSON.stringify([key(item),state,detail,mode,switchingTo,worker?.name,worker?.nodeKind,worker?.platform,claim?.id,claim?.status,claim?.url,claim?.command,claim?.lastCheckedAt,claim?.processError,returningClaim,controlFeedback,takeover.isReleasing(item),takeover.releaseDisabled(item),canTakeover,worker?.capabilities?.terminalControl,takeover.feedback(item),item.conversationBinding,agentSwitchUI.busy(item),takeover.switchBusy(item)]);
  const LABEL={page:'Chatting on this page',ending:'Ending page takeover…',starting:'Starting on this page…',terminal:'Running in iTerm',prepared:'iTerm is opening…',returning:'Returning to Workbench…',stopping:'Stopping the terminal CLI…',busy:'Occupied',offline:'Device offline',unstarted:'Not started',nohistory:'No history yet',idle:'Not connected'};
  sideBadge.hidden=true;
  if(panel.dataset.signature===signature)return;panel.dataset.signature=signature;panel.replaceChildren();
  // Who and where, in one strip: the device with its machine icon, the CLI with its agent icon.
  const roster=data.workers||[],cloudNumber=new Map(roster.filter(w=>workerKind(w)==='cloud').map((w,index)=>[w.id,index+1])).get(item.nodeId);
  const identity=el('div','native-identity'),deviceChip=el('span','native-identity-item');
  if(worker)deviceChip.append(machineIconEl(worker,cloudNumber));const deviceName=el('span','native-identity-name',workerName(item.nodeId));deviceName.translate=false;deviceChip.append(deviceName);deviceChip.title=`${t('Device')} · ${workerName(item.nodeId)}`;
  identity.append(deviceChip,agentSwitchUI.render({item,worker,busy:takeover.switchBusy(item)||!['page','idle'].includes(state)}));panel.append(identity);
  // One row: the two-way switch and, as an icon, the one action the state allows. Moving the switch opens the hand-over dialog.
  const row=el('div','native-connect-row'),seg=el('div','native-mode-switch');seg.setAttribute('role','group');seg.setAttribute('aria-label',t('Where the session runs'));
  const switchable=online&&canTakeover&&!switchingTo&&!agentSwitchUI.busy(item)&&!takeover.releaseDisabled(item)&&!['busy','offline','nohistory','ending','returning','stopping','starting','prepared'].includes(state);
  const move=value=>{if(value==='terminal'||mode==='terminal')openHandover(item,value,{claim,worker});else void switchMode(item,value);};
  const modeButton=(value,title)=>{const b=el('button',`native-mode${mode===value?' is-on':''}${switchingTo===value?' is-pending':''}`);b.type='button';b.append(el('span','native-mode-title',title));b.disabled=!switchable||mode===value;b.setAttribute('aria-pressed',String(mode===value));b.addEventListener('click',()=>move(value));return b;};
  seg.append(modeButton('page',t('This page')),modeButton('terminal','iTerm'));row.append(seg);
  const perform=async action=>{
   if(!claim||returningClaim)return;
   if(action==='stop'&&!confirm(t('Stop this terminal CLI and return control to Workbench? Unfinished terminal work will be interrupted.')))return;
   returningClaim=claim.id;controlFeedback=null;renderSessionControls(selected);
   try{
    const result=await terminalAction(claim,action);
    if(result?.released===true)takeover.returned(item);
    await onStateRefresh();void load({quiet:true});
   }catch(error){controlFeedback={key:key(item),text:error.message};}
   finally{returningClaim=null;renderSessionControls(selected);}
  };
  const iconButton=(name,label,fn,cls='')=>{const b=el('button',`icon-button native-connect-action ${cls}`.trim());b.type='button';setActionIcon(b,name,t(label));b.addEventListener('click',fn);return b;};
  if(state==='page'){const end=iconButton('close','End takeover',()=>void takeover.release(item));end.disabled=takeover.releaseDisabled(item);row.append(end);}
  else if(state==='ending'){const end=iconButton('close','Ending…',()=>{});end.disabled=true;row.append(end);}
  else if(state==='prepared'&&claim){if(claim.url){const open=el('a','primary native-card-action',t('Open iTerm'));open.href=claim.url;row.append(open);}const cancel=iconButton('close','Cancel',()=>void perform('release'));cancel.disabled=Boolean(returningClaim);row.append(cancel);}
  else if(claim&&state==='starting'){const cancel=iconButton('close','Cancel start',()=>void perform('release'));cancel.disabled=Boolean(returningClaim)||!online;row.append(cancel);}
  else if(claim&&['terminal','returning','stopping'].includes(state)){const stop=iconButton('stop','Stop CLI',()=>void perform('stop'),'is-danger');stop.disabled=Boolean(returningClaim)||!online||worker?.capabilities?.terminalControl!==1||claim.processState==='unknown';if(worker?.capabilities?.terminalControl!==1)stop.title=t('Upgrade this Worker to check or stop terminal processes.');row.append(stop);}
  else if(state==='unstarted'){const open=button('Open on this page',()=>openForm(item),'primary native-card-action');open.disabled=!canTakeover;row.append(open);}
  panel.append(row);
  // Right under the switch: the session ID with its copy buttons (built in renderSide, kept across rebuilds).
  if(sessionIdRow?.dataset.key===key(item))panel.append(sessionIdRow);
  const project=state==='busy'?data.projects?.find(p=>p.id===(claim?.projectId||other?.projectId))||((claim||other)&&owners.size===1?data.projects?.find(p=>owners.has(p.id)):null):null;
  if(detail)panel.append(el('p','native-side-hint',project?`${t(detail)} · ${project.name}`:t(detail)));
  if(claim?.processError)panel.append(el('p','native-side-hint',t(claim.processError)));
  if(state==='page'){const feedback=takeover.feedback(item);if(feedback)panel.append(el('p','global-error',feedback));}
  if(online&&!canTakeover&&['idle','unstarted'].includes(state))panel.append(el('p','native-side-hint',t('Upgrade this Worker to safely take over native sessions')));
  if(controlFeedback?.key===key(item))panel.append(el('p','global-error',t(controlFeedback.text)));
 }
 /** Each lease kind retains its own validated action endpoint and identifier contract. */
 function terminalAction(claim,action){
  const path=claim.kind==='native'?`${endpoint(claim.nodeId)}/terminal`:claim.kind==='new'?`/api/projects/${encodeURIComponent(claim.projectId)}/roles/${encodeURIComponent(claim.roleId)}/terminal`:`/api/runs/${encodeURIComponent(claim.runId)}/terminal`;
  return api(path,{method:'POST',json:claim.kind==='native'?{action,operationId:claim.id}:{action,id:claim.id}});
 }
 const connectionStates=new Map(),switching=new Map();
 const waitUntil=(check,ms)=>new Promise(resolve=>{const started=Date.now();const tick=()=>{if(check()||Date.now()-started>ms)return resolve(check());setTimeout(tick,300);};tick();});
 const nativeClaimOf=item=>(getData().terminalSessions||[]).find(c=>c.kind==='native'&&c.nodeId===item.nodeId&&!['released','cancelled'].includes(c.status)&&(item.entryId&&c.catalogEntryId===item.entryId||nativeId(item)&&c.nativeSession?.runtime===item.runtime&&c.nativeSession?.id===nativeId(item)));
 /** Prepare the one-time terminal link for an existing session (reusing a link that is already prepared). */
 async function prepareTerminal(item){
  const existing=nativeClaimOf(item);if(existing?.status==='prepared'&&existing.command)return existing;
  return api(`/api/native-sessions/${encodeURIComponent(item.nodeId)}/terminal`,{method:'POST',json:{runtime:item.runtime,sessionId:nativeId(item),...(item.entryId?{entryId:item.entryId}:{}),workspace:item.workspace||'',allowAll:false,useLocalSshKey:true,operationId:crypto.randomUUID()}});
 }
 /** Open iTerm at once; the link stays on the claim for "Open iTerm" / "Copy" if iTerm did not come up. */
 async function openInTerminal(item){const result=await prepareTerminal(item);if(result?.url)window.location.assign(result.url);return result;}
 /** Copy the ready-to-run command (ssh + launcher for a remote device). A page takeover must end first, since the link claims the session. */
 async function copyTerminalCommand(item,button){
  if(takeover.releaseDisabled(item))throw Error('Wait for the current reply, send or upload to finish');
  if(takeover.isOn(item)||takeover.canChat(item)){if(!confirm(t('End the page takeover and prepare a terminal link for this session?')))throw Error(t('Cancelled'));await takeover.release(item);if(!await waitUntil(()=>!takeover.isReleasing(item),20000))throw Error('The page takeover is still closing; try again in a moment');}
  const result=await prepareTerminal(item);if(!result?.command)throw Error('No terminal command was prepared');
  await copyText(button,result.command);await onStateRefresh();void load({quiet:true});return result.command;
 }
 /**
  * Hand-over dialog: confirm first, then every step with its progress. To iTerm: end the page takeover, prepare the link,
  * open iTerm (link and command stay available). To this page: stop the terminal CLI, return the session, open the composer.
  */
 let handoverDialog=null;
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 async function settleUntil(check,ms){const started=Date.now();while(Date.now()-started<ms){await onStateRefresh().catch(()=>{});if(check())return true;await sleep(1000);}return check();}
 function openHandover(item,target,{claim=null,worker=null}={}){
  if(!handoverDialog){handoverDialog=el('dialog','settings-edit-dialog native-session-dialog native-handover');document.body.append(handoverDialog);}
  const toTerminal=target==='terminal',chatting=takeover.isOn(item)||takeover.canChat(item),running=Boolean(claim)&&claim.processState!=='released'&&!['released','cancelled','finished'].includes(claim.status);
  const canStop=worker?.capabilities?.terminalControl===1&&claim?.processState!=='unknown';
  const capturedClaim=()=>claim&&(getData().terminalSessions||[]).find(c=>c.id===claim.id&&c.nodeId===claim.nodeId);
  const plan=toTerminal?[...(chatting?[['release','End page takeover']]:[]),['prepare','Prepare the iTerm link'],['open','Open iTerm']]
   :[...(running?[[canStop?'stop':'quit',canStop?'Stop the terminal CLI':'Wait for the terminal CLI to exit']]:[]),['return','Return the session to Workbench'],['enable','Open the composer here']];
  const heading=el('div','dialog-heading');heading.append(el('h2','',t(toTerminal?'Open in iTerm':'Take over on this page')));
  const intro=el('p','native-side-hint',t(toTerminal?(chatting?'The page takeover ends and the session continues in iTerm.':'The session opens in iTerm.'):(running?'The CLI running in iTerm will be interrupted; unfinished terminal work is lost.':'The session returns to this page.')));
  const list=el('ol','native-handover-steps'),rows=new Map();
  for(const [id,label] of plan){const li=el('li','');li.dataset.step=id;li.append(el('span','native-handover-mark'),el('span','',t(label)));rows.set(id,li);list.append(li);}
  const message=el('p','global-error');message.hidden=true;const after=el('div','native-handover-after');after.hidden=true;
  const actions=el('div','native-session-actions'),cancel=button('Cancel',()=>handoverDialog.close(),'secondary'),confirm=button('Confirm',()=>void run(),'primary');
  actions.append(cancel,confirm);
  handoverDialog.replaceChildren(heading,intro,list,message,after,actions);handoverDialog.showModal();
  const mark=(id,state)=>{const li=rows.get(id);if(!li)return;li.className=`is-${state}`;const m=li.querySelector('.native-handover-mark');m.replaceChildren();if(state==='running')m.append(el('span','nt-pulse'));else if(state==='done')m.innerHTML=UI_ICON.check;else if(state==='failed')m.innerHTML=UI_ICON.close;};
  async function run(){
   confirm.disabled=cancel.disabled=true;message.hidden=true;const id=key(item);switching.set(id,target);controlFeedback=null;renderSessionControls(item);
   let current=null;
   try{
    for(const [step] of plan){current=step;mark(step,'running');
     if(step==='release'){if(takeover.releaseDisabled(item))throw Error('Wait for the current reply, send or upload to finish');await takeover.release(item);if(!await waitUntil(()=>!takeover.isReleasing(item),20000))throw Error('The page takeover is still closing; try again in a moment');}
     else if(step==='prepare'){const result=await prepareTerminal(item);if(!result?.url&&!result?.command)throw Error('No terminal command was prepared');after.replaceChildren();
      if(result.url){const open=el('a','secondary',t('Open iTerm'));open.href=result.url;after.append(open);}
      if(result.command){const copy=button('Copy terminal command',async b=>{await copyText(b.currentTarget,result.command).catch(()=>{});});after.append(copy);}
      after.prepend(el('span','native-side-hint',t('If iTerm did not open, use the link or copy the command.')));after.hidden=false;handoverDialog.dataset.url=result.url||'';}
     else if(step==='open'){const url=handoverDialog.dataset.url;if(url)window.location.assign(url);}
     else if(step==='stop'||step==='quit'){
      if(step==='stop')await terminalAction(claim,'stop');
      const gone=()=>{const c=capturedClaim();return !c||['released','cancelled','finished'].includes(c.status)||c.processState==='released';};
      if(!await settleUntil(gone,step==='stop'?60000:120000))throw Error(step==='stop'?'The terminal CLI has not stopped yet; quit it in iTerm and try again':'The terminal CLI is still running; quit it in iTerm and try again');}
     else if(step==='return'){const c=capturedClaim();if(c){const result=await terminalAction(claim,'release');if(result?.released!==true)throw Error('The terminal CLI has not exited yet; quit it in iTerm and try again');}takeover.returned(item);await onStateRefresh();}
     else if(step==='enable'){takeover.enable(item);}
     mark(step,'done');}
    confirm.hidden=true;cancel.disabled=false;cancel.textContent=t('Done');
   }catch(error){if(current)mark(current,'failed');message.textContent=t(error.message);message.hidden=false;confirm.hidden=true;cancel.disabled=false;cancel.textContent=t('Close');}
   finally{switching.delete(id);await onStateRefresh().catch(()=>{});void load({quiet:true});if(selected)renderSessionControls(selected);}
  }
 }
 /** Move the session between this page and iTerm, doing every step in between: end the page takeover, prepare and open iTerm; or return the terminal and reopen the composer here. */
 async function switchMode(item,target){
  const id=key(item);if(switching.has(id))return;
  if(item.canReopen){openForm(item);return;}
  switching.set(id,target);controlFeedback=null;renderSessionControls(item);
  try{
   if(takeover.releaseDisabled(item))throw Error('Wait for the current reply, send or upload to finish');
   if(target==='terminal'){
    if(takeover.isOn(item)||takeover.canChat(item)){await takeover.release(item);if(!await waitUntil(()=>!takeover.isReleasing(item),20000))throw Error('The page takeover is still closing; try again in a moment');}
    await openInTerminal(item);
   }else{
    const claim=nativeClaimOf(item);
    if(claim){const result=await api(`${endpoint(claim.nodeId)}/terminal`,{method:'POST',json:{action:'release',operationId:claim.id}});if(result?.released!==true)throw Error('The terminal CLI has not exited yet; quit it in iTerm or press Stop CLI');}
    takeover.returned(item);await onStateRefresh();takeover.enable(item);
   }
  }catch(error){controlFeedback={key:id,text:error.message};}
  finally{switching.delete(id);await onStateRefresh().catch(()=>{});void load({quiet:true});if(selected)renderSessionControls(selected);}
 }
 function options(select,values){const old=select.value;select.replaceChildren(...values.map(([value,label])=>{const o=el('option','',label);o.value=value;return o;}));if(values.some(([v])=>v===old))select.value=old;}
 // First visit shows dialog-created sessions; options() preserves any explicit choice on later refreshes.
 function populate(){const signature=JSON.stringify((getData().workers||[]).map(w=>[w.id,w.name,w.online,w.nodeKind,w.runtimes?.map(r=>[r.type,r.available,r.supported])]));if(signature===lastCatalog)return false;lastCatalog=signature;options(device,[['created',t('Created sessions')],['all',t('All sessions')],['group',t('Group chats')],['local',t('Local machine')],['cloud',t('Servers')],['other',t('Other devices')]]);options(tool,[['all',t('All Agents')],...Object.entries(names)]);return true;}
 function workers(){return(getData().workers||[]).filter(w=>['all','created','group'].includes(device.value)||(device.value==='other'?!['local','cloud'].includes(w.nodeKind):w.nodeKind===device.value));}
 /** Keep the selected name in the shared header, including after state refreshes and selection resets. */
 function renderTitle(){onSelect();if(!active()||document.body.dataset.workspaceView==='settings')return;const title=document.querySelector('#workspace-title');title.translate=!selected;title.textContent=selected?displayTitle(selected):t('Native sessions');gear.disabled=!selected;}
 function resetDetail(){detailVersion++;selected=null;renderTitle();detailSignature=detailMeta='';timeline.clear();takeover.detach();content.replaceChildren(el('div','native-empty',t('Select a native session to view its details.')));resetSide();}
 function resetSide(){
  delete side.dataset.sessionKey;sideBadge.hidden=true;outputs.clear();gitKey=null;renaming=null;
  sidePanels.overview.replaceChildren(el('p','native-side-hint',t('Select a native session to view its details.')));
  selectSideTab(sideTab);
 }
 /** Reuse role-card device identities; cloud numbering follows the full roster, not the filtered session list. */
 function renderList(){
  if(listOrder.active())return;
  const activity=getData().sidebarExecutions||[];
  const isRunning=item=>Boolean(nativeId(item))&&activity.some(run=>run.nodeId===item.nodeId&&run.runtime===item.runtime&&run.sessionId===nativeId(item));
  const roster=getData().workers||[],ordered=listOrder.ordered(groupNativeSessions(items),group=>group.id.startsWith('conversation:')?group.id:key(group.latest)),signature=JSON.stringify([key(selected),ordered,activity,roster.map(w=>[w.id,w.name,w.platform,w.nodeKind])]);
  if(signature===listSignature)return;listSignature=signature;
  const byId=new Map(roster.map(w=>[w.id,w])),cloudNumbers=new Map(roster.filter(w=>workerKind(w)==='cloud').map((w,index)=>[w.id,index+1]));
  const scroll=list.scrollTop;list.replaceChildren();
  const row=(item,latest)=>{
   const running=isRunning(item);
   const b=el('button',`project-item${key(selected)===key(item)?' active':''}${running?' is-running':''}`);b.type='button';b.dataset.orderId=key(item);b.title=`${displayTitle(item)}\n${workerName(item.nodeId)}${running?` · ${t('In progress')}`:''}`;
   b.setAttribute('aria-label',`${displayTitle(item)}${running?` · ${t('In progress')}`:''}`);
   // Two lines with a right column: title | device, time | running spinner (drawn by CSS when the row is running).
   const copy=el('span','project-item-copy has-status'),title=el('strong','',displayTitle(item));title.translate=false;
   const worker=byId.get(item.nodeId),deviceIcon=worker?machineIconEl(worker,cloudNumbers.get(item.nodeId)):el('span','');deviceIcon.classList.add('native-session-device','list-device-slot');
   const when=el('small','native-session-time',time(item.createdAt||item.modifiedAt));when.translate=false;
   const status=el('span','list-run-status');status.setAttribute('aria-hidden','true');copy.append(title,deviceIcon,when,status);b.append(agentIconEl(item.runtime),copy);b.addEventListener('click',()=>read(item));if(!latest)delete b.dataset.orderId;return b;
  };
  for(const group of ordered){
   const entry=row(group.latest,true);
   if(group.id.startsWith('conversation:'))entry.dataset.orderId=group.id;
   if(group.history.some(item=>key(item)===key(selected)))entry.classList.add('active');
   if(group.history.some(isRunning)){entry.classList.add('is-running');entry.title+=` · ${t('An older session is running')}`;}
   if(entry.classList.contains('active'))entry.setAttribute('aria-current','true');
   list.append(entry);
  }
  list.scrollTop=scroll;
 }
 /** Fetch at most two device catalogues at a time; one unavailable device must not hide the others. */
 /** A visible reload of the list shows the top bar; quiet background refreshes do not. */
 function load(options={}){return options.quiet?loadList(options):trackLoading(loadList(options));}
 async function loadList({quiet=false}={}){if(!active())return;if(quiet&&loading){pendingRefresh=true;return;}pendingRefresh=false;const ticket=++version;loading=true;lastRefresh=Date.now();if(!quiet)note.textContent=t('Loading native sessions…');
  // Both device filters and All include registered independent entries plus managed role history.
  const scopes=['created','group'].includes(device.value)?[device.value]:['all','group'];
  const jobs=workers().flatMap(w=>(tool.value==='all'?Object.keys(names):[tool.value]).filter(runtime=>device.value==='created'||w.runtimes?.some(r=>r.type===runtime&&r.available&&r.supported!==false)).flatMap(runtime=>scopes.map(scope=>({nodeId:w.id,runtime,scope})))),results=[],errors=[],failedJobs=new Set();let partial=false,index=0;
  // Publish complete catalogue snapshots as they arrive; a slow peer cannot block selecting already-read history.
  const owned=item=>['dialog','managed','takeover'].includes(item.origin);
  const matchesJob=(item,job)=>item.nodeId===job.nodeId&&item.runtime===job.runtime&&(job.scope==='group'?item.origin==='managed':job.scope==='created'?item.origin==='dialog':item.origin!=='managed');
  const previous=items.filter(item=>owned(item)&&jobs.some(job=>matchesJob(item,job))),ordered=values=>[...new Map(values.filter(owned).map(item=>[key(item),item])).values()].sort((a,b)=>String(b.modifiedAt||b.createdAt||'').localeCompare(String(a.modifiedAt||a.createdAt||''))||key(a).localeCompare(key(b)));
  items=ordered(previous);if(selected&&!jobs.some(job=>matchesJob(selected,job)))resetDetail();renderList();
  const updateLineage=()=>{if(!selected)return;const group=groupNativeSessions(items).find(g=>[g.latest,...g.history].some(row=>key(row)===key(selected)));if(group){const chain=[group.latest,...group.history];timeline.setOlder(selected,chain.slice(chain.findIndex(row=>key(row)===key(selected))+1));}};
  // Like the group chat: reopen the session viewed last in this tab; only a settled list with nothing remembered falls
  // back to its top row. A selection already made is never replaced, and a partial catalogue never pre-empts the remembered one.
  const autoSelect=(settled=false)=>{if(selected||dialog.open||!items.length||ticket!==version)return;
   let wanted=null;try{wanted=sessionStorage.getItem(SELECTION_KEY);}catch{}
   const next=(wanted&&items.find(item=>key(item)===wanted))||(settled?listOrder.ordered(groupNativeSessions(items),group=>group.id.startsWith('conversation:')?group.id:key(group.latest))[0]?.latest:null);
   if(next)void read(next);};
  // 首次/切换筛选先显示 Home 保存的目录；不等待远端，也不把预览当成新鲜的历史核验。
  if((!quiet||!previous.length)&&getData().capabilities?.nativeCatalogCache===1){
   await Promise.all(jobs.map(async job=>{try{
    const result=await api(`${endpoint(job.nodeId)}?${new URLSearchParams({runtime:job.runtime,scope:job.scope,cached:'1'})}`);
    if(ticket!==version||!active()||result.cached!==true)return;
    previous.push(...(result.items||[]).map(item=>({...item,nodeId:job.nodeId})));items=ordered(previous);updateLineage();renderList();
   }catch{/* Worker refresh below reports authoritative errors; existing rows stay visible. */}}));
   if(ticket!==version||!active())return;
  }
  await Promise.all(Array.from({length:Math.min(2,jobs.length)},async()=>{while(index<jobs.length&&ticket===version&&active()){const job=jobs[index++];try{const result=await readNativeSessionPages((offset,revision)=>api(`${endpoint(job.nodeId)}?${new URLSearchParams({runtime:job.runtime,scope:job.scope,offset:String(offset),revision})}`),()=>ticket===version&&active());if(ticket!==version||!active())return;results.push(...result.items.map(item=>({...item,nodeId:job.nodeId})));partial||=result.partial;items=ordered([...previous,...results]);updateLineage();renderList();autoSelect();}catch(e){failedJobs.add(`${job.nodeId}/${job.runtime}/${job.scope}`);errors.push(`${workerName(job.nodeId)}: ${t(e.message)}`);}}}));
  if(ticket!==version||!active())return;loading=false;
  results.push(...items.filter(item=>owned(item)&&failedJobs.has(`${item.nodeId}/${item.runtime}/${scopes.length>1?(item.origin==='managed'?'group':'all'):scopes[0]}`)&&!results.some(r=>key(r)===key(item))));
  items=ordered(results);
  note.textContent=errors.length?[t('Some devices could not be read.'),...new Set(errors)].join(' '):t(partial?'Showing recent sessions. Updates automatically.':items.length?'':'No sessions in this filter. Create one using the top-right button.');
  if(selected){const next=items.find(item=>key(item)===key(selected));if(next){const sameNative=nativeId(next)===nativeId(selected);selected={...selected,...next};renderTitle();if(!dialog.open&&!(historyLoading?.key===key(selected)&&historyLoading.sessionId===nativeId(next)&&historyLoading.ticket===detailVersion)&&(!quiet||historyReadStamps.get(key(selected))!==historyStamp(next)))void read(selected,{quiet:sameNative});}else resetDetail();}renderList();autoSelect(true);
  // A mutation/focus refresh arriving during a read must run after that older snapshot settles.
  if(pendingRefresh)void load({quiet:true});
 }
 /** History scrolls above a persistent footer, so quiet refreshes never discard a takeover draft. */
 const scroll=el('div','native-session-scroll');
 // With a snapshot the refresh asks only for rows appended since it (`delta`); a Worker that cannot answers with the latest page.
 const readPage=(item,cursor,snapshot)=>api(`${endpoint(item.nodeId)}?${new URLSearchParams({runtime:item.runtime,sessionId:nativeId(item),historyPage:'1',...(toolPreview(item)?{toolPreview:'1'}:{}),...(cursor?{cursor}:{}),...(snapshot?{snapshot,delta:'1'}:{})})}`);
 /** Settings read from appended rows refine the ones already known; a field the new rows do not mention keeps its value. */
 const mergeConfiguration=(known,fresh)=>{if(!fresh)return known;const out={...(known||{})};for(const [k,v] of Object.entries(fresh))if(v!=null)out[k]=v;return out;};
 let lastPromptAt=null;
 function renderHistoryRow(m,item){const text=m.role==='user'?cleanUserText(m.text):m.text;
   // Context compaction: one quiet line; the summary Claude carries forward opens on demand.
   if(m.role==='user'&&isCompactSummary(m.text,m.compact)){
    const row=el('details','nt-system nt-compact native-chat-row'),head=el('summary','');row.dataset.role='system';row.dataset.text=`compact:${m.timestamp||m.id||''}`;if(m.id)row.dataset.historyId=m.id;if(m.timestamp)row.dataset.at=m.timestamp;
    head.append(el('span','nt-system-mark','\u21E3'),el('span','',t('Context compacted; the session continues from a summary')),el('span','nt-compact-toggle',t('Show summary')),el('span','nt-compact-toggle is-open',t('Hide summary')));
    const body=el('div','nt-compact-body');row.addEventListener('toggle',()=>{if(row.open&&!body.childElementCount){const md=renderMarkdown(text);md.classList?.add('markdown-body');body.append(md);}},{once:false});
    row.append(head,body);return row;}
   const interruption=nativeInterruptionText(m,item.runtime);
   if(interruption){const row=el('div','nt-system native-chat-row',t('Interrupted'));row.title=interruption;row.dataset.nativeInterruption=interruption;
    // 保留原生 user 边界，避免页面回执把后续工具记录归到上一条回复。
    row.dataset.role='user';row.dataset.text=promptKey(interruption);if(m.id)row.dataset.historyId=m.id;if(m.timestamp)row.dataset.at=m.timestamp;return row;}
   // Injected context leaves nothing to show; a slash command shows as one quiet system line.
   if(m.role==='user'&&!text){const task=taskNotificationOf(m.text);if(task){const row=el('div','nt-system native-chat-row');row.dataset.role='system';row.dataset.text=`task:${task}`;if(m.id)row.dataset.historyId=m.id;if(m.timestamp)row.dataset.at=m.timestamp;row.append(el('span','nt-system-mark','\u2699'),el('span','',`${t('Background task finished')} · ${task.slice(0,8)}`));return row;}
    const command=commandOf(m.text);if(!command)return document.createComment('injected');const row=el('div','nt-system native-chat-row');row.dataset.role='system';row.dataset.text=command.replace(/^\//,'').trim();if(m.id)row.dataset.historyId=m.id;if(m.timestamp)row.dataset.at=m.timestamp;row.append(el('span','nt-system-mark','\u2318'),el('code','',command));return row;}
   const row=chatRow(m.role,text,item.runtime,m.timestamp,null,'completed',item);row.dataset.role=m.role;if(m.id)row.dataset.historyId=m.id;
   if(m.role==='user'){row.dataset.text=promptKey(text);lastPromptAt=m.timestamp||null;}
   else if(lastPromptAt&&m.timestamp){const ms=Date.parse(m.timestamp)-Date.parse(lastPromptAt);if(Number.isFinite(ms)&&ms>=0&&ms<12*3600*1000)row.dataset.duration=elapsedText(lastPromptAt,Date.parse(m.timestamp));}
   return row;}
 /**
  * Rendered turns, per session, by a signature of everything they show. A refresh that only adds rows reuses the nodes of
  * every turn it did not touch, so their pictures, open activity lists and scroll position stay as they are.
  */
 const renderedTurns=new Map(),renderedPieces=new Map();
 const historyStep=tool=>tool.toolSummary?{...tool.toolSummary,id:tool.id,name:tool.toolSummary.name||tool.name,files:Array.isArray(tool.toolSummary.files)?tool.toolSummary.files:tool.toolSummary.path?[tool.toolSummary.path]:[],failed:tool.failed,error:tool.errorSummary||'',running:false,detailRefs:[tool.callDetailRef,tool.resultDetailRef].filter(Boolean)}:classifyStep({type:'tool_use',id:tool.id,name:tool.name,input:tool.input,output:tool.output,is_error:tool.failed,status:'completed'},'succeeded');
 // A fresh snapshot can replace same-length text or tool inputs at the same offsets; equality must include their content.
 const turnSignature=(turn,startedAt)=>JSON.stringify([turn.prompt,startedAt,turn.endedAt,turn.parts]);
 /** History reads like page turns: the prompt, then the reply with its tool activity at the recorded positions and how long it took. */
 function renderHistory(rows,item,{turnStartedAt=null}={}){
  // Cached per session and language (the nodes carry translated labels and local times).
  const nodes=[],isPrompt=row=>isHistoryPrompt(row.text),sessionKey=`${key(item)}|${getLanguage()}`,before=renderedTurns.get(sessionKey)||new Map(),after=new Map();
  // Inside a turn that did change (the one still running), its prompt, text blocks and activity groups that did not change
  // are taken over from the turn's previous rendering, so a picture in a reply that is still growing is not reloaded.
  const piecesBefore=renderedPieces.get(sessionKey)||new Map(),piecesAfter=new Map();
  let own=null;const piece=(id,build)=>{const node=piecesBefore.get(id)||build();piecesBefore.delete(id);piecesAfter.set(id,node);own.set(id,node);return node;};
  for(const [index,turn] of historyTurns(rows,{isPrompt,noticeOf:row=>taskNotificationOf(row.text)}).entries()){
   // A turn whose prompt is on an older, unloaded page starts at the time the Worker looked back for (turnStartedAt).
   const startedAt=turn.prompt?.timestamp||(index===0?turnStartedAt:null),signature=turnSignature(turn,startedAt);
   const kept=before.get(signature);
   if(kept){after.set(signature,kept);for(const [id,node] of kept.pieces)piecesAfter.set(id,node);nodes.push(...kept.nodes);
    // A reused turn is not drawn again, so the files it names are noted here (the Files tab list is rebuilt after a reset).
    const last=[...turn.parts].reverse().find(part=>part.kind==='text');if(last?.text)noteOutputs(item,last.text,turn.endedAt,toolFilePaths(turn.parts.filter(p=>p.kind==='tool').map(historyStep)));continue;}
   own=new Map();const turnNodes=renderHistoryTurn(turn,item,startedAt,piece);after.set(signature,{nodes:turnNodes,pieces:own});nodes.push(...turnNodes);
  }
  // Least recently drawn sessions go first: the one being read moves to the end on every refresh.
  for(const [map,value] of [[renderedTurns,after],[renderedPieces,piecesAfter]]){map.delete(sessionKey);map.set(sessionKey,value);if(map.size>8)map.delete(map.keys().next().value);}
  return nodes;
 }
 function renderHistoryTurn(turn,item,startedAt,piece=(id,build)=>build()){
  const nodes=[],first=turn.parts[0],turnId=turn.prompt?.id||`${first?.id||first?.timestamp||''}`;
  const paths=toolFilePaths(turn.parts.filter(part=>part.kind==='tool').map(historyStep)),pathsKey=JSON.stringify(paths);
  if(turn.prompt)nodes.push(piece(`${turnId}|prompt|${JSON.stringify(turn.prompt)}`,()=>renderHistoryRow(turn.prompt,item)));
  if(!turn.parts.length)return nodes;
  const frag=document.createDocumentFragment();let group=[],process=false;
  const flush=()=>{if(!group.length)return;process=true;const steps=group;frag.append(piece(`${turnId}|steps|${JSON.stringify(steps)}`,()=>activityBlock({steps:steps.map(historyStep),notes:[],t,onPreview:(step,path)=>preview.open(step,path),onDetail:(step,ref,offset)=>toolDetail(item,step,ref,offset)})));group=[];};
  for(const [index,part] of turn.parts.entries()){if(part.kind==='tool'){group.push(part);continue;}flush();
   // A background task finished while this turn ran: one quiet line in place, the reply goes on below it.
   if(part.kind==='notice'){const line=el('div','nt-system nt-turn-notice');line.append(el('span','nt-system-mark','\u2699'),el('span','',`${t('Background task finished')} · ${part.task.slice(0,8)}`));if(part.timestamp)line.title=time(part.timestamp);frag.append(line);continue;}const text=simplifiedCliOutput(stripAnsi(part.text||''));if(!text.trim())continue;
   frag.append(piece(`${turnId}|text|${index}|${part.timestamp}|${pathsKey}|${text}`,()=>{const md=renderMarkdown(text);md.classList?.add('markdown-body');linkMedia(md,{...mediaContext(item),filePaths:()=>paths});documentPreview.decorate(md,{...documentContext(item),filePaths:()=>paths});return md;}));}
  flush();
  const last=[...turn.parts].reverse().find(part=>part.kind==='text'),row=chatRow('assistant',last?.text||'',item.runtime,turn.endedAt,null,'completed',item,{content:frag,filePaths:paths});
  row._replyTexts=turn.parts.filter(part=>part.kind==='text').map(part=>simplifiedCliOutput(stripAnsi(part.text||'')));
  row.dataset.role='assistant';if(process)row.dataset.process='1';
  if(startedAt&&turn.endedAt){const ms=Date.parse(turn.endedAt)-Date.parse(startedAt);if(Number.isFinite(ms)&&ms>=0&&ms<12*3600*1000)row.dataset.duration=elapsedText(startedAt,Date.parse(turn.endedAt));}
  nodes.push(row);
  return nodes;
 }
 const timeline=createNativeHistoryTimeline({scroll,readPage,t,onHistoryChange:()=>takeover.renderFeed({historyChanged:true}),onLatest:()=>{if(selected)void read(selected);},label:item=>`${item.conversationBinding?.segments.some(s=>s.runtime===item.runtime&&s.sessionId===nativeId(item)&&s.switchId)?t('Agent switched')+' · ':''}${time(item.createdAt||item.modifiedAt)} · ${names[item.runtime]} · ${workerName(item.nodeId)} · ${(nativeId(item)||'').slice(0,8)}`,renderMessage:renderHistoryRow,renderMessages:renderHistory});
 /** Latest pages saved in this browser, as last saved (rows appended by refreshes are added to them). */
 const savedPages=new Map();
 const SAVED_PAGE_CHARS=2*1024*1024;
 function keepPage(k,saved){
  const bounded=compactHistoryPage(saved,SAVED_PAGE_CHARS);
  // Unsupported snapshots cannot be cropped safely. Keep the previous bounded page rather than losing offline history.
  if(!bounded)return false;
  savedPages.delete(k);savedPages.set(k,bounded);if(savedPages.size>30)savedPages.delete(savedPages.keys().next().value);void saveHistory(k,bounded);return true;
 }
 function forgetPage(k){savedPages.delete(k);void forgetHistory(k);}
 function rememberPage(item,page,{appended=false,baseSnapshot=null}={}){
  const k=key(item);
  // The same snapshot again (an older Worker answers every refresh with the full page): nothing to save.
  const prior=savedPages.get(k);
  if(!appended&&prior?.historySnapshot===page.historySnapshot&&Boolean(prior.toolPreview===1)===toolPreview(item))return;
  if(!appended){const {messages,historySnapshot,nextCursor,hasMore,partial,turnStartedAt,sessionConfiguration,notice}=page;keepPage(k,{sessionId:nativeId(item),messages,historySnapshot,nextCursor,hasMore,partial,turnStartedAt,sessionConfiguration,notice,...(toolPreview(item)?{toolPreview:1}:{})});return;}
  const saved=savedPages.get(k);if(!saved)return;
  // A delta certifies only the snapshot it was requested from. Once one cannot fit, later deltas begin after a gap and
  // must not advance the old copy's snapshot; reopening it will request the complete missing suffix again.
  if(!baseSnapshot||saved.historySnapshot!==baseSnapshot)return;
  const known=new Set(saved.messages.map(m=>m.id));
  keepPage(k,{...saved,messages:[...saved.messages,...page.messages.filter(m=>!known.has(m.id))],historySnapshot:page.historySnapshot,sessionConfiguration:mergeConfiguration(saved.sessionConfiguration,page.sessionConfiguration)});
 }
 /** Errors that mean the saved snapshot no longer fits the history file. */
 const staleCopy=error=>/changed|Invalid native history cursor/i.test(error?.message||'');
 /** Placeholder turns while a session's history is read for the first time. */
 function transcriptSkeleton(){const box=el('div','chat-skeleton');box.setAttribute('aria-hidden','true');for(const side of ['out','in','in']){const row=el('div',`chat-skeleton-row is-${side}`);row.append(el('span','chat-skeleton-avatar'),el('span','chat-skeleton-bubble'));box.append(row);}return box;}
 /** Opening a session's history shows the top bar; quiet re-reads of the one on screen do not. */
 function read(item,options={}){return options.quiet?readDetail(item,options):trackLoading(readDetail(item,options));}
 async function readDetail(item,{quiet=false}={}){if(item.conversationBinding){const group=groupNativeSessions(items).find(g=>g.id===`conversation:${item.conversationBinding.id}`);if(group)item=group.latest;}
  const ticket=++detailVersion;historyLoading={key:key(item),sessionId:nativeId(item),ticket};selected=item;try{sessionStorage.setItem(SELECTION_KEY,key(item));}catch{}renderTitle();renderList();
  const group=groupNativeSessions(items).find(g=>[g.latest,...g.history].some(row=>key(row)===key(item))),chain=group?[group.latest,...group.history]:[item];
  const restart=()=>{timeline.reset(item,chain.slice(chain.findIndex(row=>key(row)===key(item))+1));detailSignature=detailMeta='';};
  if(!quiet){onPreview?.();preview.close();takeover.detach();restart();scroll.replaceChildren(transcriptSkeleton());content.replaceChildren(scroll);}
  const id=nativeId(item),readable=id&&item.hasHistory!==false,current=()=>ticket===detailVersion&&active()&&key(selected)===key(item)&&nativeId(selected)===id;
  /** Draw a page: a full one (opening, or a fallback) or rows appended since the last read (`delta`). */
  const present=(base,page,{quietly})=>{
   const delta=Boolean(page?.delta);
   const value=readable?{...base,...page,...(delta?{notice:undefined,sessionConfiguration:mergeConfiguration(base.sessionConfiguration,page.sessionConfiguration)}:{}),id:item.id,entryId:item.entryId,nodeId:item.nodeId,sessionId:id,title:item.title}:base;
   selected=value;historyReadStamps.delete(key(item));historyReadStamps.set(key(item),historyStamp(item));while(historyReadStamps.size>16)historyReadStamps.delete(historyReadStamps.keys().next().value);timeline.readSucceeded();
   // What the session looks like apart from its rows: a refresh with no new rows still redraws when this changed
   // (a rename, a new binding), and otherwise leaves everything as it is (only the snapshot moved on).
   const meta=JSON.stringify({...value,messages:undefined,historySnapshot:undefined,nextCursor:undefined,hasMore:undefined,partial:undefined,delta:undefined});
   if(quietly&&delta&&!page.messages?.length&&meta===detailMeta)return;
   const signature=delta?`${meta}\n${JSON.stringify(page.messages.map(m=>m.id))}`:JSON.stringify(value);if(quietly&&signature===detailSignature)return;detailSignature=signature;detailMeta=meta;const top=scroll.scrollTop,atBottom=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<40;
   const history=timeline.update({...value,...(!delta&&!value.messages?.length&&!value.notice?{notice:value.canReopen?'This session has not started. Open it to begin chatting.':!readable?'Native session ID has not been linked yet. Existing history is unchanged.':'No text preview is available for this session.'}:{})});
   const historyAt=Date.now();if(!scroll.contains(timeline.root))scroll.replaceChildren(timeline.root,takeover.feed);renderBranchOrigin(value);if(!content.contains(scroll))content.replaceChildren(scroll);
   takeover.attach(value,{readable,historyAt,history});
   renderSide(value,id,readable);
   if(quietly&&!atBottom)scroll.scrollTop=top;else scroll.scrollTop=scroll.scrollHeight;
  };
  try{
   if(!readable){if(current())present(item,null,{quietly:quiet});return;}
   // Opening: the copy saved in this browser shows at once; the device is then asked only for rows appended since.
   if(!quiet){
    const saved=savedPages.get(key(item))||await cachedHistory(key(item));
    if(!current())return;
    // A copy is drawn only for the same native session (an entry can be relinked to another one).
    if(saved?.historySnapshot&&Array.isArray(saved.messages)&&saved.sessionId===id&&Boolean(saved.toolPreview===1)===toolPreview(item)){
     savedPages.set(key(item),saved);present(item,saved,{quietly:false});
     let page;
     try{page=await readPage(selected,null,saved.historySnapshot);}
     catch(error){
      // The history was rewritten since the copy: forget it and read the latest page as usual. Other errors (device offline)
      // leave the copy on screen with the error under it.
      if(!staleCopy(error)){if(current()){historyReadStamps.delete(key(item));timeline.showError(error);}return;}
      if(!current())return;
      forgetPage(key(item));page=null;timeline.showUpdating();
     }
     if(!current())return;
     if(page?.delta){present(selected,page,{quietly:true});rememberPage(item,page,{appended:true,baseSnapshot:saved.historySnapshot});return;}
     if(!page){try{page=await readPage(item,null,null);}catch(error){if(current()){historyReadStamps.delete(key(item));timeline.showError(error);}return;}if(!current())return;}
     restart();scroll.replaceChildren(el('p','workspace-note',t('Loading…')));
     present(item,page,{quietly:false});rememberPage(item,page);return;
    }
   }
   const baseSnapshot=quiet?item.historySnapshot:null,page=await readPage(item,null,baseSnapshot);if(!current())return;
   // A background overflow must keep the loaded pages, cursor and snapshot. Only Refresh latest history may replace them;
   // advancing the snapshot here would make the next delta silently skip the unread burst.
   if(quiet&&page.deltaFallback){timeline.showNewer();return;}
   present(item,page,{quietly:quiet});
   if(page.delta)rememberPage(item,page,{appended:true,baseSnapshot});else rememberPage(item,page);
  }catch(e){if(staleCopy(e))forgetPage(key(item));if(ticket===detailVersion){historyReadStamps.delete(key(item));if(quiet)timeline.showError(e);else{timeline.update({messages:[]});timeline.showError(e);scroll.replaceChildren(timeline.root);content.replaceChildren(scroll);renderSide(item,nativeId(item),false);}}}finally{if(historyLoading?.ticket===ticket)historyLoading=null;}
 }
 /** Full text of one prompt in the group chat's reading layer; nothing stays on the page when it is closed. */
 let promptDialog=null;
 function openPromptFullscreen(text,at){
  if(!promptDialog){promptDialog=el('dialog','message-fullscreen');promptDialog.setAttribute('aria-label',t('Full message'));document.body.append(promptDialog);}
  const header=el('div','message-fullscreen-heading'),heading=el('strong','',at?`${t('Full message')} · ${time(at)}`:t('Full message'));
  const copy=el('button','icon-button');copy.type='button';setActionIcon(copy,'copy',t('Copy'));copy.addEventListener('click',()=>void copyText(copy,text).catch(()=>{}));
  const close=el('button','icon-button');close.type='button';setActionIcon(close,'close',t('Close'));close.autofocus=true;close.addEventListener('click',()=>promptDialog.close());
  header.append(heading,copy,sideButton('icon-button nt-prompt-side',t('Open on the right'),()=>({title:t('My message'),at,copyText:text,render:()=>el('div','nt-side-prompt',text)}),{before:()=>promptDialog.close()}),close);
  const bodyEl=el('div','message-fullscreen-body'),content=el('div','message-fullscreen-content');content.append(el('div','chat-message-text',text));bodyEl.append(content);
  promptDialog.replaceChildren(header,bodyEl);promptDialog.showModal();
 }
 /** Same row/bubble structure as the group chat, so both views share one visual language. */
 /** Paths in native replies resolve only inside that registered session's working directory, on its own device. */
 const mediaContext=session=>{const sessionId=session&&(nativeId(session)||session.sessionId);if(!session?.nodeId||!sessionId)return null;
  return {key:`native:${session.nodeId}:${session.runtime}:${sessionId}`,describe:path=>api(`${endpoint(session.nodeId)}/media?${new URLSearchParams({runtime:session.runtime,sessionId,path})}`)};};
 /** Transcript rows: assistant replies are plain prose with a small byline; prompts are a quiet block with a prompt mark. No card states or footers. */
 function chatRow(role,text,runtime,at,extra,state='completed',session,{content=null,filePaths=[]}={}){const agent=role!=='user',row=el('article',`nt-row ${agent?'nt-agent':'nt-user'} native-chat-row${state==='error'?' is-error':''}`);if(at)row.dataset.at=at;
  const body=simplifiedCliOutput(text||''),main=el('div','nt-body');let files=null;
  if(agent)row._replyTexts=[body];
  if(agent){const by=el('div','nt-byline');const avatar=el('span','nt-avatar');avatar.append(agentIconEl(runtime));const name=el('span','nt-name',names[runtime]||t('Assistant'));name.translate=false;by.append(avatar,name);if(at){const stamp=el('time','',clock(at));stamp.dateTime=at;stamp.title=time(at);by.append(stamp);}
   row.append(by);
   if(content)main.append(content);else if(body){const md=renderMarkdown(body);md.classList?.add('markdown-body');linkMedia(md,{...mediaContext(session),filePaths:()=>filePaths});documentPreview.decorate(md,{...documentContext(session),filePaths:()=>filePaths});main.append(md);}
   if(body&&session)noteOutputs(session,body,at,filePaths);}
  else{
   // Attachments sit above the bubble, outside it; the bubble holds only the text (none when the prompt is attachments alone).
   // Time, Copy and Full screen (when text is hidden) sit under the bubble, outside it.
   files=el('div','nt-prompt-files');const textEl=el('div','nt-prompt-text',body),tools=el('div','nt-prompt-tools');main.append(textEl);main.hidden=!body.trim();
   if(at){const stamp=el('time','nt-prompt-time',clock(at));stamp.dateTime=at;stamp.title=time(at);tools.append(stamp);}
   const expand=el('button','icon-button nt-prompt-expand');expand.type='button';setActionIcon(expand,'fullscreen',t('Full screen'));expand.hidden=true;expand.addEventListener('click',()=>openPromptFullscreen(body,at));
   const copy=el('button','icon-button nt-prompt-copy');copy.type='button';setActionIcon(copy,'copy',t('Copy'));copy.addEventListener('click',()=>void copyText(copy,body).catch(()=>{}));if(session&&at)bindCopyFeedback(copy,`native:${key(session)}:${role}:${at}`);
   const pin=sideButton('icon-button nt-prompt-side',t('Open on the right'),()=>({title:t('My message'),subtitle:session?.title||'',at,copyText:body,render:()=>el('div','nt-side-prompt',body)}));pin.hidden||=!body.trim();
   tools.append(copy,expand,pin);row.dataset.tools='1';row._tools=tools;
   requestAnimationFrame(()=>{expand.hidden=!(textEl.isConnected&&textEl.scrollHeight>textEl.clientHeight+1);});
  }
  if(extra){if(agent)main.append(extra);else files.append(extra);}
  if(files)row.append(files);row.append(main);if(row._tools){row.append(row._tools);delete row._tools;}
  // Finished replies end with a footer: Copy, then (on the newest reply) how long the turn took. Live replies have no footer yet.
  if(agent&&!['running','queued','waiting'].includes(state)){const foot=el('div','nt-reply-foot'),copy=el('button','icon-button nt-copy');copy.type='button';setActionIcon(copy,'copy',t('Copy'));copy.addEventListener('click',()=>void copyText(copy,body).catch(()=>{}));if(session&&at)bindCopyFeedback(copy,`native:${key(session)}:${role}:${at}`);foot.append(copy);
   // Open on the right: the same text Copy takes, rendered as in the chat, pinned beside it (and kept while another session is open).
   if(body.trim())foot.append(sideButton('icon-button nt-side',t('Open on the right'),()=>({title:names[runtime]||t('Assistant'),subtitle:session?.title||'',at,copyText:body,render:()=>{const md=renderMarkdown(body);md.classList?.add('markdown-body','nt-side-reply');linkMedia(md,{...mediaContext(session),filePaths:()=>filePaths});documentPreview.decorate(md,{...documentContext(session),filePaths:()=>filePaths});return md;}})));
   row.append(foot);}
  return row;}
 let agentDetailsSignature='';
 /** Reuse reported CLI quota and this session's recorded settings; refreshing the card never probes a model. */
 function renderAgentDetails(value){
  if(side.dataset.sessionKey!==key(value))return;
  const worker=getData().workers?.find(w=>w.id===value.nodeId),runtime=worker?.runtimes?.find(r=>r.type===value.runtime),configuration=value.sessionConfiguration||{};
  const quota=value.runtime==='agy'&&!configuration.model?null:quotaForRole(runtime,worker,configuration.model||'');
  const signature=JSON.stringify([key(value),configuration,quota,runtime?.quotaStatus,runtime?.quotaStale,runtime?.checkedAt,worker?.online]),prior=side.querySelector('[data-native-agent-details]');
  if(prior&&signature===agentDetailsSignature)return;agentDetailsSignature=signature;
  const section=el('section','native-side-card');section.dataset.nativeAgentDetails='';section.append(el('h3','',t('Quota')));
  // Two lines: "5H token 剩余" with the usual quota mark after it, and the time until that window resets (3d 4h / 2h 10m).
  const until=raw=>{const date=parseQuotaResetDate(raw);if(!date)return '';const minutes=Math.floor((date.getTime()-Date.now())/60000);if(minutes<=0)return t('resetting');const d=Math.floor(minutes/1440),h=Math.floor(minutes%1440/60),m=minutes%60;return d>0?`${d}d ${h}h`:h>0?`${h}h ${m}m`:`${m}m`;};
  const list=el('div','native-quota-lines');
  for(const [label,key] of [['5H tokens left','fiveHour'],['7D tokens left','weekly']]){
   const bucket=quota?.[key],line=el('div','native-quota-line');
   // The usual quota mark stays (same icon as the role cards); the line adds the window, the percent and the time until reset.
   const name=el('span','native-quota-label',t(label));
   if(!usableBucket(bucket)){line.append(name,el('span','native-quota-value is-unknown',t('Unknown')));}
   else{const rest=until(bucket.resetsAt);line.append(name,roleNameQuota({[key]:bucket},{stale:Boolean(runtime?.quotaStale||runtime?.quotaStatus!=='ok')}));if(rest)line.append(el('span','native-quota-reset',rest));}
   list.append(line);
  }
  section.append(list);
  if(!worker?.online||runtime?.quotaStale||runtime?.quotaStatus!=='ok')section.append(el('p','native-side-hint',t(!worker?.online?'Device offline; quota is the last recorded value.':'Latest quota is unavailable; showing recorded values when present.')));
  if(prior)prior.replaceWith(section);else sidePanels.overview.append(section);
 }
 /** Read-only Git facts of the session's registered working folder, from its own device; cached per session. */
 const GIT_SHORT={no_workspace:'No folder yet',not_git:'Not a Git repository',worker_upgrade:'Worker needs an upgrade',git_unavailable:'Git is not installed'};
 const GIT_REASONS={no_workspace:'No working folder is recorded for this session yet.',source_offline:'Device offline; Git status is unavailable.',worker_upgrade:'Upgrade this Worker to read Git status.',not_git:'The working folder is not inside a Git repository.',git_unavailable:'Git is not available for this folder on the device.',git_read_failed:'Could not read Git status.'};
 async function loadGit(value,force=false){
  const sessionKey=key(value),cached=gitCache.get(sessionKey);if(cached?.loading||!force&&cached)return;
  gitCache.set(sessionKey,{loading:true});renderGit(value);
  const id=nativeId(value),query=new URLSearchParams({runtime:value.runtime,...(id?{sessionId:id}:{}),...(value.entryId?{entryId:value.entryId}:{})});
  let state;try{state=await api(`${endpoint(value.nodeId)}/git?${query}`);}catch(error){state={available:false,reason:'git_read_failed',detail:error.message};}
  gitCache.set(sessionKey,{state,at:new Date().toISOString()});
  if(selected&&key(selected)===sessionKey)renderGit(selected);
 }
 function renderGit(value){
  const prior=dialog.querySelector('[data-native-git]');if(!prior||side.dataset.sessionKey!==key(value))return;
  const cached=gitCache.get(key(value)),section=el('section','native-side-card native-git-card');section.dataset.nativeGit='';
  const head=el('div','native-card-head'),refresh=iconButton('refresh','Refresh',()=>void loadGit(value,true));refresh.disabled=!cached||Boolean(cached.loading);
  head.append(el('h3','',t('Repository (Git)')),refresh);section.append(head);
  if(!cached||cached.loading)section.append(busyState('git'));
  else{
   const state=cached.state;
   // A working folder path alone is never shown as Git state: without a repository answer the card says why.
   if(!state.available||!state.git){if(['source_offline','git_read_failed'].includes(state.reason))section.append(failedState(state.detail||GIT_REASONS[state.reason],()=>void loadGit(value,true)));else section.append(stateBlock('git',GIT_SHORT[state.reason]||'Unknown',{detail:state.detail&&state.reason!=='not_git'?state.detail:''}));}
   else{
    const c=state.changes||{},parts=[['staged','{count} staged'],['modified','{count} modified'],['untracked','{count} untracked'],['conflicted','{count} conflicted']].filter(([k])=>c[k]>0).map(([k,label])=>t(label,{count:c[k]}));
    const changes=c.unknown?t('Unknown ({reason})',{reason:c.reason||'git'}):c.total===0?t('Clean'):parts.join(' · ')+(c.truncated?` · ${t('partial count')}`:'');
    section.append(metaList([
     ['Git root',state.root,state.root],
     ['Branch',state.branch||t('Detached HEAD')],
     ['Commit',state.commit?`${state.commit.slice(0,12)}${state.subject?` · ${state.subject}`:''}`:t('No commits yet'),state.commit||null],
     ['Upstream',state.upstream?`${state.upstream} · ${t('{ahead} ahead, {behind} behind',{ahead:state.ahead??'?',behind:state.behind??'?'})}`:t('No upstream configured')],
     ...(state.remoteUrl?[['Remote',state.remoteUrl,state.remoteUrl]]:[]),
     ['Changes',changes]]));
   }
  }
  prior.replaceWith(section);
 }
 /** Renaming changes only the display name of a Workbench-created session; native ID, history, drafts and takeover stay. */
 function renameBlock(value){
  const worker=getData().workers?.find(w=>w.id===value.nodeId);
  if(!value.entryId)return value.roleBinding?'Named after its group chat project and role.':'Only sessions created in Workbench can be renamed.';
  if(!worker?.online)return 'Device offline; reconnect it to rename this session.';
  if(worker.capabilities?.nativeSessionTitle!==1)return 'Upgrade this Worker to rename sessions.';
  return null;
 }
 /** Rename a Workbench-created session; the list, header and selected item follow at once. */
 async function renameSession(value,raw){
  const title=String(raw||'').trim();if(!title||title.length>120)throw Error('Session title is required and must be at most 120 characters');
  if(title===(value.title||''))return title;
  const updated=await api(`${endpoint(value.nodeId)}/title`,{method:'POST',json:{runtime:value.runtime,entryId:value.entryId,sessionId:value.sessionId||null,title}});
  for(const item of items)if(key(item)===key(value))item.title=updated.title;
  if(selected&&key(selected)===key(value))selected={...selected,title:updated.title};
  renderTitle();renderList();void load({quiet:true});return updated.title;
 }
 /** Session settings behind the gear in the top bar: name, folder and repository facts, and the Git account used for pushes. */
 function openSessionSettings(value){
  dialog.replaceChildren();const heading=el('div','dialog-heading');heading.append(el('h2','',t('Session settings')),closeButton(()=>dialog.close()));dialog.append(heading);
  const body=el('div','native-settings-dialog');
  const nameCard=el('section','native-settings-section');nameCard.append(el('h3','',t('Name')));
  const blocked=renameBlock(value),nameForm=el('form','native-rename-form'),nameInput=el('input'),nameSave=el('button','primary',t('Save')),nameNote=el('p','native-side-hint',blocked?t(blocked):'');
  nameInput.type='text';nameInput.maxLength=120;nameInput.value=value.title||'';nameInput.setAttribute('aria-label',t('Session name'));nameInput.disabled=Boolean(blocked);nameSave.type='submit';nameSave.disabled=Boolean(blocked);
  nameForm.append(nameInput,nameSave);nameForm.addEventListener('submit',async e=>{e.preventDefault();nameSave.disabled=true;nameNote.className='native-side-hint';nameNote.textContent=t('Saving…');try{await renameSession(value,nameInput.value);nameNote.textContent=t('Saved');}catch(error){nameNote.className='global-error';nameNote.textContent=t(error.message);}finally{nameSave.disabled=false;}});
  nameCard.append(nameForm,nameNote);
  // Repository and AGENTS.md (moved here from the old Resources tab): the same live cards, with refresh and edit.
  const repo=el('section','native-side-card native-git-card');repo.dataset.nativeGit='';
  const agents=el('section','native-side-card native-agents-card');agents.dataset.nativeAgents='';
  // Branch and delete: branch copies the folder next to it and forks the session (Claude, Codex); delete removes a folder
  // Workbench made for this session. The device answers first whether delete is allowed, and why not.
  const fork=el('section','native-settings-section native-branch-section');fork.append(el('h3','',t('Branch and delete')));
  const forkWorker=getData().workers?.find(w=>w.id===value.nodeId),supported=forkWorker?.capabilities?.nativeBranch===1;
  const branchReason=!supported?'Upgrade this Worker to branch or delete sessions':!['claude','codex'].includes(value.runtime)?'Grok and Agy sessions cannot be branched yet':!nativeId(value)?'This session has no history yet':takeover.busy()?'Wait for the current reply to finish':'';
  const forkActions=el('div','native-branch-actions'),branchButton=button('Branch',()=>{dialog.close();openBranchDialog(value);},'secondary'),deleteButton=button('Delete folder',()=>{dialog.close();openDeleteDialog(value,deleteState);},'danger');
  branchButton.disabled=Boolean(branchReason);deleteButton.disabled=true;
  const branchNote=el('p','native-side-hint',t(branchReason||'Copies the folder next to it and opens a new session that continues this conversation; the two do not touch each other’s files.'));
  const deleteNote=el('p','native-side-hint',t('Checking…'));let deleteState=null;
  forkActions.append(branchButton,deleteButton);fork.append(forkActions,branchNote,deleteNote);
  if(supported)void api(`${endpoint(value.nodeId)}/delete?${new URLSearchParams({runtime:value.runtime,...(nativeId(value)?{sessionId:nativeId(value)}:{}),...(value.entryId?{entryId:value.entryId}:{})})}`)
   .then(state=>{deleteState=state;deleteButton.disabled=!state?.ok;deleteNote.textContent=state?.ok?(state.missing?t('The folder is already gone; delete removes the session from this list.'):`${t('Deletes this folder and removes the session from this list:')} ${state.path}`):t(state?.reason||'This folder cannot be deleted here');})
   .catch(error=>{deleteNote.className='global-error';deleteNote.textContent=t(error.message);});
  else deleteNote.textContent=t('Upgrade this Worker to branch or delete sessions');
  body.append(nameCard,repo,agents,fork);dialog.append(body);renderGit(value);renderAgents(value);if(!gitCache.get(key(value)))void loadGit(value);dialog.showModal();
 }
 /** A branch says where it came from at the top of its transcript, with a way back to the original (a Codex branch shows
  * only its own turns; the conversation before the fork lives in the original). */
 function renderBranchOrigin(value){
  scroll.querySelector('.native-branch-origin')?.remove();
  const origin=value?.branchOf?.sessionId;if(!origin)return;
  const parent=items.find(item=>item.nodeId===value.nodeId&&item.runtime===value.runtime&&nativeId(item)===origin);
  const line=el('div','native-branch-origin');
  line.append(el('span','',parent?t('Branched from “{title}”',{title:displayTitle(parent)}):t('Branched from another session')));
  if(parent)line.append(button('Open the original',()=>void read(parent),'secondary compact'));
  scroll.prepend(line);
 }
 let forkDialog=null;
 /** One confirm-then-progress dialog for branch and delete, in the same step style as the handover dialog. */
 function forkFlow({title,intro,steps,confirmLabel,danger=false,ack=null,run}){
  if(!forkDialog){forkDialog=el('dialog','settings-edit-dialog native-session-dialog native-handover');document.body.append(forkDialog);}
  const heading=el('div','dialog-heading');heading.append(el('h2','',t(title)));
  const list=el('ol','native-handover-steps'),rows=new Map();
  for(const [id,label] of steps){const li=el('li','');li.append(el('span','native-handover-mark'),el('span','',t(label)));rows.set(id,li);list.append(li);}
  const message=el('p','global-error');message.hidden=true;const after=el('div','native-handover-after');after.hidden=true;
  const actions=el('div','native-session-actions'),cancel=button('Cancel',()=>forkDialog.close(),'secondary'),confirm=button(confirmLabel,()=>void go(),danger?'danger':'primary');
  let check=null;
  if(ack){check=el('input');check.type='checkbox';const label=el('label','native-branch-ack');label.append(check,el('span','',t(ack)));confirm.disabled=true;check.addEventListener('change',()=>{confirm.disabled=!check.checked;});forkDialog.replaceChildren(heading,...intro,list,label,message,after,actions);}
  else forkDialog.replaceChildren(heading,...intro,list,message,after,actions);
  actions.append(cancel,confirm);forkDialog.showModal();
  const mark=(id,state)=>{const li=rows.get(id);if(!li)return;li.className=`is-${state}`;const m=li.querySelector('.native-handover-mark');m.replaceChildren();if(state==='running')m.append(el('span','nt-pulse'));else if(state==='done')m.innerHTML=UI_ICON.check;else if(state==='failed')m.innerHTML=UI_ICON.close;};
  async function go(){
   confirm.disabled=cancel.disabled=true;if(check)check.disabled=true;message.hidden=true;
   try{await run({mark,after});cancel.textContent=t('Close');cancel.disabled=false;confirm.hidden=true;}
   catch(error){for(const li of rows.values())if(li.className==='is-running'){li.className='is-failed';li.querySelector('.native-handover-mark').innerHTML=UI_ICON.close;}
    message.textContent=t(error.message);message.hidden=false;cancel.disabled=false;cancel.textContent=t('Close');}
  }
 }
 function openBranchDialog(value){
  const intro=[el('p','native-side-hint',t('The working folder is copied next to it, then a new session continues this conversation in the copy. The CLI runs one short turn to start the branch.')),
   el('p','native-meta-value',value.workspace||'')];
  forkFlow({title:'Branch this session',intro,confirmLabel:'Branch',steps:[['copy','Copy the folder'],['fork','Start the branch session']],run:async({mark,after})=>{
   mark('copy','running');
   const progress=setTimeout(()=>{mark('copy','done');mark('fork','running');},4000);
   let result;
   try{result=await api(`${endpoint(value.nodeId)}/branch`,{method:'POST',json:{runtime:value.runtime,sessionId:nativeId(value),...(value.entryId?{entryId:value.entryId}:{})}});}
   finally{clearTimeout(progress);}
   mark('copy','done');mark('fork','done');
   const facts=el('div','native-branch-result');
   facts.append(el('p','native-meta-value',result.workspace));if(result.gitBranch)facts.append(el('p','native-side-hint',`${t('Git branch')}: ${result.gitBranch}`));
   const open=button('Open the branch',async()=>{forkDialog.close();await load({quiet:true});const next=items.find(item=>item.nodeId===value.nodeId&&item.entryId===result.entryId);if(next)void read(next);},'primary');
   facts.append(open);after.replaceChildren(facts);after.hidden=false;void load({quiet:true});
  }});
 }
 function openDeleteDialog(value,state){
  const intro=[el('p','native-side-hint',t(state?.missing?'The folder is already gone. The session is removed from this list; the CLI’s own history is kept.':'This deletes the folder and everything in it, and removes the session from this list. The CLI’s own history is kept. This cannot be undone.')),
   el('p','native-meta-value',state?.path||value.workspace||'')];
  forkFlow({title:'Delete the session folder',intro,danger:true,confirmLabel:'Delete',ack:state?.missing?null:'I understand every file in this folder will be deleted',steps:[['delete',state?.missing?'Remove the session':'Delete the folder']],run:async({mark})=>{
   mark('delete','running');
   await api(`${endpoint(value.nodeId)}/delete`,{method:'POST',json:{runtime:value.runtime,...(nativeId(value)?{sessionId:nativeId(value)}:{}),...(value.entryId?{entryId:value.entryId}:{})}});
   mark('delete','done');
   forgetPage(key(value));
   if(selected&&key(selected)===key(value)){try{sessionStorage.removeItem(SELECTION_KEY);}catch{}resetDetail();}
   void load({quiet:true});
  }});
 }
 /** Label/value rows with optional copy buttons, shared by the session, repository and runtime cards. */
 function metaList(rows){const list=el('dl','native-session-meta');for(const[label,text,copy]of rows){const term=el('dt','',t(label)),data=el('dd','');const valueText=el('span','native-meta-value',text);valueText.translate=false;if(typeof text==='string')valueText.title=text;data.append(valueText);if(copy){const b=button('',async()=>{try{await copyText(b,copy);}catch{}},'icon-button native-copy');b.title=t('Copy');b.setAttribute('aria-label',t('Copy {label}',{label:t(label)}));b.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';bindCopyFeedback(b,`native-meta:${label}:${copy}`);data.append(b);data.classList.add('has-copy');}list.append(term,data);}return list;}
 function metaCard(target,heading,rows){const section=el('section','native-side-card');section.append(el('h3','',t(heading)),metaList(rows));target.append(section);return section;}
 function renderSide(value,id,readable){
  side.dataset.sessionKey=key(value);
  sideBadge.hidden=true;
  const {overview}=sidePanels;overview.replaceChildren();agentDetailsSignature='';
  // Overview: where the session runs and its ID (under the switch), then model and context, then quota.
  const controls=el('section','native-side-card native-connect');controls.dataset.nativeControls='';
  const settingsCard=el('section','native-side-card native-settings-card');settingsCard.dataset.nativeSettings='';
  overview.append(controls);
  overview.append(settingsCard);
  // The session ID line under the This page / iTerm switch: the ID, copy it, and copy the command that opens it in iTerm.
  sessionIdRow=el('div','native-session-id-row');sessionIdRow.dataset.key=key(value);
  const idText=el('span','native-session-id-value',id||t('Not available yet'));idText.translate=false;idText.title=id?`${t('Session ID')} · ${id}`:'';sessionIdRow.append(idText);
  if(id){const copyId=iconButton('copy','Copy session ID',async e=>{const b=e.currentTarget;try{await copyText(b,id);}catch{}});bindCopyFeedback(copyId,`native:${key(value)}:id`);sessionIdRow.append(copyId);}
  // The command that opens this exact session in a terminal (ssh + launcher for a remote device): copy it into iTerm as is.
  if(id&&value.workspace){const copy=iconButton('terminal','Copy iTerm command',async e=>{const b=e.currentTarget;b.disabled=true;b.dataset.pending='true';
    try{await copyTerminalCommand(value,b);delete b.dataset.pending;b.disabled=takeover.releaseDisabled(value);}
    catch(error){delete b.dataset.pending;b.disabled=takeover.releaseDisabled(value);controlFeedback={key:key(value),text:error.message};renderSessionControls(value);}},'native-copy-command');
   copy.disabled=takeover.releaseDisabled(value);bindCopyFeedback(copy,`native:${key(value)}:terminal`);sessionIdRow.append(copy);}
  // Repository facts are read once per selected session (or on Refresh), never polled.
  void loadAgents(value);
  if(gitKey!==key(value)){gitKey=key(value);void loadGit(value,true);}else renderGit(value);
  // Resources: the device and CLI account this session runs on.
  renderAgentDetails(value);
  renderSessionControls(value);
  renderSessionSettings(value);
  const askable=sideAsk.available(value);sideTabButtons[SIDE_TABS.indexOf('ask')].hidden=!askable;if(askable)sideAsk.attach(value);else sideAsk.detach();
  selectSideTab(sideTab==='ask'&&!askable?'overview':sideTab);
 }
 const tokensText=n=>n==null?'':n>=1e6?`${(n/1e6).toFixed(n>=1e7?0:1)}M`:n>=1e3?`${(n/1e3).toFixed(n>=1e5?0:1)}k`:String(n);
 const EFFORT_LABELS={none:'None',minimal:'Minimal',low:'Low',medium:'Medium',high:'High',xhigh:'Extra high',max:'Max',ultra:'Ultra',auto:'Automatic',default:'CLI default'};
 /** Model, reasoning effort and context: the page's chosen settings win over what history recorded; context comes from the newest page turn, else history. */
 function renderSessionSettings(value){
  const card=sidePanels.overview.querySelector('[data-native-settings]');if(!card||side.dataset.sessionKey!==key(value))return;
  const data=getData(),worker=data.workers?.find(w=>w.id===value.nodeId),runtime=worker?.runtimes?.find(r=>r.type===value.runtime),configuration=value.sessionConfiguration||{};
  const chosen=takeover.settings(),model=chosen.model||configuration.model||'',effort=chosen.effort||configuration.effort||'';
  const models=runtime?.models||[],modelInfo=models.find(m=>m.id===model),efforts=modelInfo?.efforts||runtime?.efforts||(value.runtime==='claude'?['low','medium','high','xhigh','max']:[]);
  const sample=takeover.contextSample(),used=sample?sample.usedTokens:configuration.contextTokens??null,limit=sample?.limitTokens||null,pct=used!=null&&limit?Math.min(100,Math.round(used/limit*100)):null;
  const canEdit=Boolean(worker?.online)&&takeover.controls()&&Boolean(nativeId(value)),canCompact=canEdit&&['claude','codex'].includes(value.runtime)&&takeover.isOn(value)&&!takeover.busy();
  const signature=JSON.stringify([key(value),model,effort,models.map(m=>m.id),efforts,used,limit,sample?.state,sample?.compacted,canEdit,canCompact,takeover.busy()]);
  if(card.dataset.signature===signature)return;card.dataset.signature=signature;card.replaceChildren(el('h3','',t('Model and context')));
  const grid=el('div','native-settings-grid');
  const note=value.runtime==='claude'?'Claude applies a change at once, in this session.':value.runtime==='codex'?'Codex applies a change from the next message.':value.runtime==='agy'?'Agy restarts its process on the next message after a change.':'Grok applies a change from the next message.';
  const select=(label,current,options,onChange)=>{const wrap=el('label','native-setting');wrap.append(el('span','native-setting-label',t(label)));const sel=el('select');sel.title=t(note);for(const [id,name] of options){const o=el('option','',name);o.value=id;sel.append(o);}if(current&&!options.some(([id])=>id===current)){const o=el('option','',current);o.value=current;sel.prepend(o);}if(!current){const o=el('option','',t('CLI default'));o.value='';sel.prepend(o);}sel.value=current||'';sel.disabled=!canEdit||takeover.busy();sel.addEventListener('change',()=>{sel.disabled=true;void onChange(sel.value);});wrap.append(sel);return wrap;};
  grid.append(select('Model',model,models.map(m=>[m.id,m.name||m.id]),v=>takeover.saveSetting('model',v)));
  if(efforts.length||effort)grid.append(select('Effort',effort,efforts.map(e=>[e,t(EFFORT_LABELS[e]||e)]),v=>takeover.saveSetting('effort',v)));
  card.append(grid);
  // context
  const ctx=el('div','native-context');const head=el('div','native-context-head');head.append(el('span','native-context-title',t('Context')));
  // The share of the window used is the number to read at a glance, so it is bold.
  const amount=el('span','native-context-amount',used==null?t('Not measured yet'):limit?`${tokensText(used)} / ${tokensText(limit)} · `:t('{tokens} tokens',{tokens:tokensText(used)}));if(used!=null&&limit)amount.append(el('strong','native-context-pct',`${pct}%`));head.append(amount);
  ctx.append(head);
  // The bar and, after it, the compact icon on one line.
  const barRow=el('div','native-context-row'),bar=el('div',`native-context-bar${pct!=null?pct>=90?' is-high':pct>=70?' is-mid':'':' is-unknown'}`);const fill=el('span','');fill.style.width=`${pct??0}%`;bar.append(fill);barRow.append(bar);
  if(['claude','codex'].includes(value.runtime)){const compactButton=el('button','icon-button native-compact');compactButton.type='button';setActionIcon(compactButton,'compact',t('Compact'));compactButton.disabled=!canCompact;if(!takeover.isOn(value))compactButton.title=t('Take over the session to compact its context here');compactButton.addEventListener('click',()=>void takeover.compact());barRow.append(compactButton);}
  ctx.append(barRow);
  if(sample?.state==='compacted'&&sample.compacted)ctx.append(el('p','native-side-hint',t('Compacted {from} → {to}',{from:tokensText(sample.compacted.preTokens),to:tokensText(sample.compacted.postTokens)})));
  card.append(ctx);
  const feedback=takeover.feedback(value);if(feedback)card.append(el('p','global-error',feedback));
 }
 const takeover=createTakeover();
 const agentSwitchUI=createNativeAgentSwitchUI({api,t,getState:()=>({busy:!selected||takeover.switchBusy(selected)}),
  onChange:()=>{if(selected){const panel=sidePanels.overview.querySelector('[data-native-controls]');if(panel)delete panel.dataset.signature;takeover.render();renderSessionControls(selected);}},
  onError:message=>{controlFeedback={key:key(selected),text:t(message)};note.textContent=t(message);},
  onCommitted:async({source,conversation,current,segments})=>{
   const viewing=selected&&(key(selected)===key(source)||selected.conversationBinding?.id===conversation.id);
   const related=s=>s.nodeId===conversation.nodeId&&segments.some(p=>p.runtime===s.runtime&&p.sessionId===(s.sessionId||s.id));
   items=items.map(s=>related(s)?{...s,conversationBinding:conversation}:s);
   for(const s of segments)if(!items.some(i=>i.nodeId===conversation.nodeId&&i.runtime===s.runtime&&i.sessionId===s.sessionId))items.push({id:s.entryId||s.sessionId,...s,nodeId:conversation.nodeId,title:conversation.title,workspace:conversation.workspace,origin:'dialog',hasHistory:true,canResume:s.id===current.id,conversationBinding:conversation});
   const group=groupNativeSessions(items).find(g=>g.id===`conversation:${conversation.id}`);takeover.bindConversation(group.latest);listSignature='';renderList();if(viewing)await read(group.latest);
  }});
 const sideAsk=createSideAsk({api,getData,getModel:()=>takeover.settings().model});sidePanels.ask.classList.add('is-preview','is-ask');sidePanels.ask.append(sideAsk.root);sideAsk.clear.hidden=sideTab!=='ask';sideHeader.append(sideAsk.clear);
 const folderOpen=iconButton('folder','Working folder',()=>openFolder(),'native-folder-open');folderOpen.hidden=sideTab!=='outputs';sideHeader.append(folderOpen);
 // Sessions opened on this page with "Allow all": once the headless first turn has produced history, chat here without a separate takeover confirmation.
 const pageOpened=new Set();
 const IMAGE_CLIS=new Set(['codex','claude']),openProcesses=new Set();
 /** Codex records an attached image as markup with a Worker-local path; show a short placeholder instead. */
/** CLI titles can start with injected context markup (e.g. <environment_context>); show readable text or the short ID. */
const displayTitle=item=>{const text=String(item.title||'').replace(/<([a-z_-]+)\b[^>]*>[\s\S]*?(<\/\1>|$)/gi,' ').replace(/\s+/g,' ').trim();return text||`${String(item.id||'').slice(0,8)}\u2026`;};
const sizeText=n=>!Number.isFinite(n)?'':n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:`${(n/1048576).toFixed(1)} MB`;
/** Hide CLI-internal stderr logging (timestamped WARN/ERROR lines) from the run process; real errors arrive as error events. */
const cliNoise=text=>/^\s*\d{4}-\d\d-\d\dT\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\b/m.test(stripAnsi(String(text||'')));
/** Prompt identity for anchoring page turns onto history rows; whitespace differences never make a second bubble. */
const promptKey=text=>simplifiedCliOutput(String(text||'')).replace(/\s+/g,' ').trim();
/** A turn shows its process only when it holds more than the final reply: tools, runtime notes or intermediate messages. */
const norm=text=>stripAnsi(String(text||'')).replace(/\s+/g,' ').trim();
const allRows=turn=>liveSceneRows(turn.events||[],turn).rows.filter(r=>!(r.kind==='log'&&cliNoise(r.text)));
/** The reply bubble shows the last projected reply; preceding replies and tools remain in the process by identity. */
const finalReply=turn=>{const rows=allRows(turn),last=[...rows].reverse();return last.find(r=>r.phase==='final_answer'&&!r.aggregate)||last.find(r=>r.kind==='message'||r.kind==='text')||null;};
const processRows=(turn,{includeFinal=false}={})=>{const rows=allRows(turn),final=finalReply(turn);
 return rows.filter(r=>!['message','text'].includes(r.kind)||norm(r.text)&&(includeFinal||!final||r.key!==final.key));};
const replyText=turn=>{const f=finalReply(turn);return f?f.text:turn.text||'';};
const hasProcess=turn=>{const rows=processRows(turn);return rows.some(r=>r.kind==='tool'||r.kind==='log'||r.kind==='error')||rows.some(r=>r.kind==='message'||r.kind==='text');};
 /** The group-chat live-scene projection orders text, messages, logs and merged tool states for one turn. */
 const preview=createPreviewSheet(content,t,{onSide:openSide,canSide:canOpenSide});
 /** One activity line per turn: tool steps classified across CLIs, intermediate agent notes and runtime errors behind it. */
 function stepsOf(turn){const rows=processRows(turn);return {steps:rows.filter(r=>r.kind==='tool').map(r=>classifyStep(r.item,turn.status)),notes:rows.filter(r=>r.kind!=='tool'&&(r.kind==='error'||r.kind==='log'||r.kind==='message'||r.kind==='text'))};}
 function activityFor(turn,{live=false,open=false}={}){
  const {steps,notes}=stepsOf(turn);
  return activityBlock({steps,notes,t,live,open,onPreview:(step,path)=>preview.open(step,path),onToggle:isOpen=>{if(!live)isOpen?openProcesses.add(turn.id):openProcesses.delete(turn.id);}});
 }
 /** Keep prose and tools at their recorded positions, including the latest commentary while a tool is still running. */
 /** Why a turn did not finish, shown at the end of its reply's foot (after copy, open on the right and the time), never as a block in the reply. */
 const endNote=turn=>!turn||turn.status==='succeeded'?'':`${t(turn.status==='interrupted'?'Interrupted':'Failed')}${turn.error?` · ${t(turn.error)}`:''}`;
 function footNote(row,text,{anchored=false}={}){
  if(!text)return;const foot=row.querySelector('.nt-reply-foot');
  if(!foot){row.querySelector('.nt-body')?.append(el('div','nt-error',text));return;}
  foot.querySelector(':scope > .nt-foot-status')?.remove();
  const note=el('span',`nt-foot-status${anchored?' native-turn-anchored':''}`,text);note.title=text;foot.append(note);
 }
 /** Text blocks of page turns by their text: the once-a-second redraw of a live reply keeps finished blocks (and their pictures) as they are. */
 const turnBlocks=new Map();
 function turnContent(turn,session,{live=false,open=false}={}){
  const frag=document.createDocumentFragment(),all=processRows(turn,{includeFinal:true});
  const final=replyText(turn);
  if(final.trim()&&!historyContainsReply(final,all.filter(row=>row.kind==='text'||row.kind==='message').map(row=>row.text)))all.push({kind:'message',text:final});
  const paths=toolFilePaths(all.filter(row=>row.kind==='tool').map(row=>classifyStep(row.item,turn.status))),pathsKey=JSON.stringify(paths);
  const blocksBefore=turnBlocks.get(turn.id)||new Map(),blocksAfter=new Map();
  // A block still being written is drawn again, but its file cards are moved over from its previous drawing (only from
  // blocks this redraw does not keep), so a picture in it does not reload while the text around it grows.
  const texts=new Set(all.filter(r=>r.kind!=='tool'&&r.kind!=='log'&&r.kind!=='error').map(r=>simplifiedCliOutput(stripAnsi(r.text||''))));
  const donors=[...blocksBefore].filter(([blockKey])=>!texts.has(blockKey.slice(blockKey.indexOf('\u0000')+1))).flatMap(([,node])=>[...node.querySelectorAll('.media-card')]),occurrences=new Map();
  const adopt=md=>{for(const card of md.querySelectorAll('.media-card')){const i=donors.findIndex(d=>d.title===card.title);if(i>=0)card.replaceWith(donors.splice(i,1)[0]);}};
  let group=[];
  const flush=()=>{if(!group.length)return;const steps=group.filter(r=>r.kind==='tool').map(r=>classifyStep(r.item,turn.status)),notes=group.filter(r=>r.kind==='log'||r.kind==='error');
   if(steps.length||notes.length)frag.append(activityBlock({steps,notes,t,live,open,onPreview:(step,path)=>preview.open(step,path),onToggle:isOpen=>{if(!live)isOpen?openProcesses.add(turn.id):openProcesses.delete(turn.id);}}));group=[];};
  for(const row of all){
   if(row.kind==='tool'||row.kind==='log'||row.kind==='error'){group.push(row);continue;}
   flush();const text=simplifiedCliOutput(stripAnsi(row.text||''));if(!text.trim())continue;
   // The same text twice in one reply is two blocks: keyed by text and occurrence.
   const seen=(occurrences.get(text)||0)+1;occurrences.set(text,seen);const blockKey=`${seen}:${pathsKey}\u0000${text}`;
   let md=blocksBefore.get(blockKey);blocksBefore.delete(blockKey);
   if(!md){md=renderMarkdown(text);md.classList?.add('markdown-body');linkMedia(md,{...mediaContext(session),filePaths:()=>paths});documentPreview.decorate(md,{...documentContext(session),filePaths:()=>paths});adopt(md);}
   blocksAfter.set(blockKey,md);frag.append(md);
  }
  flush();
  // Background tasks go before the closing prose, where the history drawing puts them, so nothing jumps when the turn ends.
  const tasks=taskBlock(turn,t,{live});if(tasks){const last=frag.lastChild;if(!live&&last?.classList?.contains('markdown-body'))frag.insertBefore(tasks,last);else frag.append(tasks);}
  if(turn.id){turnBlocks.delete(turn.id);turnBlocks.set(turn.id,blocksAfter);if(turnBlocks.size>64)turnBlocks.delete(turnBlocks.keys().next().value);}
  return frag;
 }
 /** The single working line of a live turn: pulse, elapsed time, what the CLI is doing right now, Stop. */
 function workingLine(turn,onStop){
  const line=el('div','nt-working');const pulse=el('span','nt-pulse');pulse.setAttribute('aria-hidden','true');
  const {steps}=stepsOf(turn),running=[...steps].reverse().find(s=>s.running),now=running?stepTitle(running,t):null,tasks=(turn.tasks||[]).filter(x=>x.status==='running').length;
  const hint=turn.disconnectedAt?t('Device connection lost; waiting for it to return\u2026'):turn.status==='queued'?t('Waiting for the device\u2026'):turn.status==='stopping'?t('Stopping\u2026'):turn.question&&!turn.question.answered?t('Waiting for your answer\u2026'):turn.status==='starting'||!turn.phase?t('Starting the CLI\u2026'):now?`${now.verb} ${now.target}`.trim():tasks?t(tasks===1?'Waiting for 1 background task\u2026':'Waiting for {n} background tasks\u2026',{n:tasks}):turn.phase==='replying'?t('Replying\u2026'):t('Working\u2026');
  line.append(pulse,el('span','nt-working-time',elapsedText(turn.createdAt)),el('span','nt-working-hint',hint));if(onStop)line.append(button('Stop',onStop,'secondary compact nt-stop'));return line;
 }
 /** Takeover reuses the group-chat composer behaviour: Enter sends, Shift+Enter breaks lines, paste/drag/attach uploads files. An unconfirmed send keeps Send disabled while the same message ID is looked up; only a confirmed absence allows a retry with that ID. */
 function createTakeover(){
  const stored=(name,fallback)=>{try{return JSON.parse(sessionStorage.getItem(name)||JSON.stringify(fallback));}catch{return fallback;}};
  const consentKey='agent-workbench.native-takeover-v3-consent',on=new Set(stored(consentKey,[])),drafts=stored('agent-workbench.native-takeover-drafts',{}),operations=new Map();
  const draftKeys=new Map(),draftId=id=>draftKeys.get(id)||id;
  const returnedKey='agent-workbench.native-returned-chat',returned=new Set(stored(returnedKey,[]));
  const save=()=>{try{sessionStorage.setItem(consentKey,JSON.stringify([...on]));sessionStorage.setItem(returnedKey,JSON.stringify([...returned]));sessionStorage.setItem('agent-workbench.native-takeover-drafts',JSON.stringify(drafts));}catch{}};
  const feed=el('div','native-takeover-feed'),shell=el('div','chat-composer-shell native-session-footer'),urls=new Map(),historyAnchors=new Map();
  let current=null,turns=[],poll=null,historyAt=0,historyEl=null,supported=true,fetchTicket=0,refreshRequest=null,residentState='closed',settings={model:null,effort:null},controls=false;
  const sessionKey=value=>value?`${value.nodeId}/${value.runtime}/${value.sessionId}`:'';
  const k=()=>sessionKey(current);
  /** Draft identity follows the conversation; execution receipts continue using exact native segment identities. */
  function bindConversation(value){const c=value?.conversationBinding;if(!c)return;const target=`conversation:${c.id}`;
   const hasContent=d=>Boolean(d&&(d.text||d.attachments?.length||d.pending));
   for(const s of [...c.segments].reverse()){const id=`${c.nodeId}/${s.runtime}/${s.sessionId}`;draftKeys.set(id,target);
    if(id!==target&&hasContent(drafts[id])&&!hasContent(drafts[target])){drafts[target]=drafts[id];delete drafts[id];}
    if(on.has(id))on.add(sessionKey(value));if(returned.has(id))returned.add(sessionKey(value));}
   save();}
  const isOn=value=>on.has(sessionKey(value));
  // 归还只开启输入界面，不授予工具执行权限；仍由发送时确认和后端占用检查决定能否执行。
  const canChat=value=>returned.has(sessionKey(value))&&getData().workers?.find(w=>w.id===value?.nodeId)?.capabilities?.nativeTurns===3;
  function markReturned(value){const id=sessionKey(value);if(!value?.sessionId)return;returned.add(id);save();if(current&&k()===id){render();renderSide(current,current.sessionId,true);}}
  const operation=(id=k())=>{if(!operations.has(id))operations.set(id,{sending:false,uploads:0,releasing:false,message:''});return operations.get(id);};
  const isReleasing=value=>operation(sessionKey(value)).releasing;
  const activeTurn=()=>turns.find(x=>['queued','starting','running','waiting_user','stopping'].includes(x.status));
  // 按钮移到侧栏后仍使用当前会话的发送、上传及执行状态，避免误结束活动轮次。
  const releaseDisabled=value=>{const op=operation(sessionKey(value));return Boolean(sessionKey(value)===k()&&activeTurn()||op.sending||op.uploads>0||op.releasing||op.editing);};
  const turnsUrl=()=>`${endpoint(current.nodeId)}/turns`;
  // Same send lifecycle as the group chat (send-state.js); the takeover API is idempotent by clientTurnId.
  const sendState=(d,op)=>sendStateOf(d,Boolean(op?.sending));
  let checkedAt=0;
  /** Clear only what the confirmed send carried; text typed afterwards stays. */
  function settleTurn(id,sent){const d=drafts[draftId(id)];if(!d)return;
   if((d.text||'')===(sent.text||'')){drafts[draftId(id)]={text:'',attachments:[]};if(k()===id)input.value='';}
   else{const carried=new Set(sent.attachmentIds||[]);delete d.pending;delete d.sendState;delete d.sentAt;d.attachments=(d.attachments||[]).filter(a=>!carried.has(a.id));}
   operation(id).message='';save();}
  /** Exact read-only receipt for the frozen clientTurnId in this session; only a confirmed absence re-enables Send. */
  async function verifyTurn(id){const d=drafts[draftId(id)],op=operation(id),value=current;if(!d?.pending||op.sending||op.verifying||d.sendState==='failed'||!value||k()!==id)return;
   op.verifying=true;checkedAt=Date.now();const sent=d.pending;render();
   try{const receipt=await api(`${endpoint(value.nodeId)}/turns?${new URLSearchParams({runtime:value.runtime,sessionId:value.sessionId,clientTurnId:sent.clientTurnId})}`);
    if(drafts[draftId(id)]?.pending?.clientTurnId!==sent.clientTurnId)return;
    if(receipt?.exists===true){const d=drafts[draftId(id)];confirmedSends.set(draftId(id),{pending:sent,attachments:d.attachments,sentAt:d.sentAt,confirmed:true});settleTurn(id,sent);void refresh();}else if(receipt?.exists===false)drafts[draftId(id)].sendState='failed';}
   catch(error){
    // An unreachable Home or 401/403/429 says nothing about the original POST: stay unknown and look again later.
    if(drafts[draftId(id)]?.pending?.clientTurnId===sent.clientTurnId)drafts[draftId(id)].sendState=lookupFailureState(error);op.message=t(error.message);}
   finally{op.verifying=false;save();if(current&&k()===id)render();}}
  /** Redraws from the existing state refresh re-check an unknown send at most every few seconds; no new polling. */
  function recheck(){if(!current)return;const d=drafts[draftId(k())];if(!d?.pending||d.sendState==='failed'||operation().sending||Date.now()-checkedAt<5000)return;void verifyTurn(k());}
  const draft=(id=k())=>drafts[draftId(id)]||={text:'',attachments:[]};
  const fileUrl=(nodeId,item)=>{const id=`${nodeId}:${item.id}`;if(!urls.has(id))urls.set(id,api(`${endpoint(nodeId)}/attachments/${encodeURIComponent(item.id)}`,{blob:true}).then(blob=>URL.createObjectURL(blob)).catch(e=>{urls.delete(id);throw e;}));return urls.get(id);};
  const revokeAttachment=(nodeId,id)=>{const key=`${nodeId}:${id}`,pending=urls.get(key);urls.delete(key);if(pending)void Promise.resolve(pending).then(url=>URL.revokeObjectURL(url)).catch(()=>{});};
  const revokeUrls=()=>{for(const id of [...urls.keys()]){const split=id.indexOf(':');revokeAttachment(id.slice(0,split),id.slice(split+1));}};
  let previewDialog=null;
  /** The full original (images) or its name and size (other files); the draft thumbnail is only a crop. */
  function previewAttachment(item,from=null){if(!current)return;
   // Pictures open in the shared viewer (download, copy, close; name, size and the message time); other files keep the details dialog.
   if(item.mime?.startsWith('image/')){openImageLightbox({name:item.name,size:item.size,at:from?.closest('[data-at]')?.dataset.at||null,url:fileUrl(current.nodeId,item),from});return;}
   // Pasted text and other text files show their text in the same viewer.
   if(isTextName(item.name)){openTextLightbox({name:item.name,size:item.size,at:from?.closest('[data-at]')?.dataset.at||null,url:fileUrl(current.nodeId,item)});return;}
   if(!previewDialog){previewDialog=el('dialog','attachment-dialog');document.body.append(previewDialog);}
   const close=closeIcon(el('button','icon-button'),t('Close'));close.type='button';close.onclick=()=>previewDialog.close();
   previewDialog.setAttribute('aria-label',item.name);previewDialog.replaceChildren(close);
   if(item.mime?.startsWith('image/')){const img=el('img');img.alt=item.name;void fileUrl(current.nodeId,item).then(url=>{img.src=url;}).catch(()=>{});previewDialog.append(img);}
   previewDialog.append(el('p','attachment-text',`${item.name} · ${sizeText(item.size)}`));previewDialog.showModal();}
  function attachmentCard(item,remove){const card=el('div',`attachment-card${item.mime?.startsWith('image/')?'':' attachment-file-card'}`);card.title=item.name;
   if(remove){
    // Match group-chat draft tiles: image preview with a corner remove control, details for other files.
    const open=el('button','attachment-open');open.type='button';open.addEventListener('click',()=>previewAttachment(item));
    if(item.mime?.startsWith('image/')){const img=el('img');img.alt=item.name;void fileUrl(current.nodeId,item).then(url=>{img.src=url;}).catch(()=>{});open.append(img);}
    else open.append(fileGlyph(item.name));
    open.append(el('span','attachment-name',item.name),el('small','',sizeText(item.size)));
    card.append(open,closeIcon(button('',remove,'attachment-remove'),t('Remove attachment')));return card;
   }
   // A sent attachment opens in the preview on click (image full size, file details).
   const open=el('button','attachment-open');open.type='button';open.title=item.name;open.addEventListener('click',()=>previewAttachment(item,open));card.append(open);
   if(item.mime?.startsWith('image/')){const img=el('img');img.alt=item.name;void fileUrl(current.nodeId,item).then(url=>{img.src=url;}).catch(()=>{});open.append(img);markImageOpener(open);}else open.append(fileGlyph(item.name));
   if(remove||!item.mime?.startsWith('image/')){const info=el('span','native-file-info');info.append(el('span','attachment-name',item.name),el('small','',sizeText(item.size)));open.append(info);}
   if(remove){const x=closeIcon(button('',remove,'attachment-remove'),t('Remove attachment'));card.append(x);}return card;}
  /**
   * Undo what the feed did to history rows (placed rows and notes, hidden rows, a duration it overrode). History rows are
   * reused across refreshes now, so these marks must not outlive the feed that made them.
   */
  function clearFeedMarks(root){if(!root)return;
   for(const old of root.querySelectorAll('.native-turn-anchored,.nt-system-detail'))old.remove();
   for(const row of root.querySelectorAll('[data-native-live-hidden]')){row.hidden=false;delete row.dataset.nativeLiveHidden;}
   for(const row of root.querySelectorAll('[data-history-duration]')){if(row.dataset.historyDuration)row.dataset.duration=row.dataset.historyDuration;else delete row.dataset.duration;delete row.dataset.historyDuration;}}
  function detach(){suspend();clearFeedMarks(historyEl);current=null;turns=[];historyEl=null;historyAnchors.clear();feedSignature='';liveReplies.clear();feed.replaceChildren();shell.remove();revokeUrls();}
  // 切换导航只暂停读取，保留底部和历史布局，返回时不必等异步刷新才能显示。
  function suspend(){fetchTicket++;refreshRequest=null;clearInterval(poll);poll=null;}
  function resume(){if(current)void refresh();}
  function attach(value,{readable,historyAt:at,history}){bindConversation(value);const same=current&&k()===`${value.nodeId}/${value.runtime}/${value.sessionId}`;current=value;historyAt=at;historyEl=history;if(!same){suspend();turns=[];historyAnchors.clear();feed.replaceChildren();}
   const worker=getData().workers?.find(w=>w.id===value.nodeId);supported=worker?.capabilities?.nativeTurns===3;
   const eligible=readable&&value.canResume!==false&&!value.canReopen&&Boolean(value.workspace);
   if(!eligible){shell.remove();clearFeedMarks(historyEl);feedSignature='';markLatestDuration();return;}
   // The timeline may have moved its cached nodes and removed our saved-reply overlay even when their IDs are unchanged.
   feedSignature='';if(shell.parentNode!==content)content.append(shell);render();void refresh();
  }
  /** Turns already in native history keep their process next to the matching reply; others render as their own rows. */
  /** While a reply runs the turns are re-read every second. When only the live replies' own content changed, just those replies are
   * redrawn in place; every other row keeps its nodes, so Copy, text selection, hover and opened steps survive the refresh. */
  const liveReplies=new Map(),rowSerials=new WeakMap();let feedSignature='',rowSerial=0;
  const serialOf=row=>{if(!rowSerials.has(row))rowSerials.set(row,++rowSerial);return rowSerials.get(row);};
  const isLive=turn=>['queued','starting','running','waiting_user','stopping'].includes(turn.status);
  // A send confirmed by lookup (its response was lost) stays drawn until its turn is read back.
  const confirmedSends=new Map();
  const pendingSend=()=>{const id=draftId(k()),d=drafts[id],confirmed=confirmedSends.get(id);
   if(confirmed&&turns.some(turn=>turn.clientTurnId===confirmed.pending.clientTurnId))confirmedSends.delete(id);
   if(!d?.pending)return confirmedSends.get(id)||null;
   return !turns.some(turn=>turn.clientTurnId===d.pending.clientTurnId)?d:null;};
  // A send made while a reply runs is queued by Home, so it is drawn in the queue strip rather than the transcript.
  const queuesBehind=()=>Boolean(activeTurn());
  const signatureOf=()=>JSON.stringify([k(),queuesBehind(),(d=>d?[d.pending.clientTurnId,d.confirmed?'stored':sendState(d,operation(k()))]:null)(pendingSend()),[...(historyEl?.querySelectorAll('.native-chat-row:not(.native-turn-anchored)')||[])].map(serialOf),timeline.hasOlder(),[...openProcesses].sort(),
   turns.map(turn=>isLive(turn)&&!turn.control?[turn.id,turn.status,turn.prompt,turn.attachments,turn.createdAt]:turn)]);
  function renderFeed({historyChanged=false}={}){const signature=signatureOf();
   if(!historyChanged&&signature===feedSignature&&[...liveReplies.values()].every(row=>row.isConnected)){
    for(const [id,row] of liveReplies){const turn=turns.find(x=>x.id===id);if(!turn)continue;const content=el('div','nt-turn');content.append(turnContent(turn,current,{live:true,open:true}),workingLine(turn));row.querySelector('.nt-turn')?.replaceWith(content);}
    return;}
   feedSignature=signature;liveReplies.clear();
   feed.replaceChildren();clearFeedMarks(historyEl);
   const rows=[...(historyEl?.querySelectorAll('.native-chat-row')||[])],used=new Set();
   // A finished page turn that no history row matched (older page, or the CLI never recorded it) is placed by time among the loaded rows,
   // never under the newest history. One that belongs to a history page not loaded yet is left to that page.
   const attachFiles=(row,files)=>(row.querySelector('.nt-prompt-files')||row.querySelector('.nt-body'))?.append(files);
   const rowAt=row=>Date.parse(row.dataset.at||''),dated=rows.filter(row=>Number.isFinite(rowAt(row)));
   // Text alone cannot identify repeated prompts. Bind one timestamp-compatible history ID and reuse it only in this session.
   const promptIndex=(turn,role,text)=>{
    const known=historyAnchors.get(turn.id);
    if(known)return rows.findIndex((row,i)=>!used.has(i)&&row.dataset.role===role&&row.dataset.historyId===known);
    const start=Date.parse(turn.createdAt||''),end=Date.parse(turn.endedAt||'');if(!Number.isFinite(start))return -1;
    const matches=rows.map((row,i)=>({row,i})).filter(({row,i})=>!used.has(i)&&row.dataset.role===role&&row.dataset.text===text&&rowAt(row)>=start&&(!Number.isFinite(end)||rowAt(row)<=end));
    if(matches.length!==1)return -1;const {row,i}=matches[0];if(row.dataset.historyId)historyAnchors.set(turn.id,row.dataset.historyId);return i;
   };
   const place=(nodes,createdAt)=>{const at=Date.parse(createdAt||'');if(!Number.isFinite(at)||!dated.length){feed.append(...nodes);return;}
    if(at<rowAt(dated[0])&&timeline.hasOlder())return;
    for(const node of nodes)node.classList.add('native-turn-anchored');
    const after=[...dated].reverse().find(row=>rowAt(row)<=at);if(!after){dated[0].before(...nodes);return;}
    let anchor=after;while(anchor.nextElementSibling?.classList.contains('native-chat-row')&&(anchor.nextElementSibling.dataset.role!=='user'||anchor.nextElementSibling.classList.contains('native-turn-anchored')))anchor=anchor.nextElementSibling;
    anchor.after(...nodes);};
   for(const turn of turns){
    if(turn.status==='waiting')continue;
    if(turn.status==='cancelled'){
     // A message the user deleted or took back to edit is gone, not "not sent".
     if(turn.withdrawn)continue;
     // A queued message dropped before it was sent (device reconnect, takeover ended). When the same text reached the CLI afterwards
     // (resent, or queued by the CLI itself) that delivered copy is the message: the dropped one is not drawn again.
     const text=promptKey(turn.prompt),at=Date.parse(turn.createdAt||''),later=value=>{const when=Date.parse(value||'');return !Number.isFinite(at)||!Number.isFinite(when)||when>=at-60000;};
     if(rows.some(row=>row.dataset.role==='user'&&row.dataset.text===text&&later(row.dataset.at))||turns.some(other=>other!==turn&&other.status!=='cancelled'&&promptKey(other.prompt)===text&&later(other.createdAt)))continue;
     // Otherwise it stays where it was sent, never at the bottom: the bubble, then "Not sent · reason" right under it.
     const files=el('div','chat-attachments native-turn-files');for(const item of turn.attachments||[])files.append(attachmentCard(item));
     const row=chatRow('user',turn.prompt,current.runtime,turn.createdAt,files.childElementCount?files:null);row.dataset.role='user';row.dataset.text=text;row.classList.add('is-unsent');
     const note=el('span','nt-unsent-note',`${t('Not sent')}${turn.error?` · ${t(turn.error)}`:''}`),tools=row.querySelector('.nt-prompt-tools');if(tools)tools.prepend(note);else row.append(note);
     place([row],turn.createdAt);continue;}
    if(turn.control){
     const live=['queued','starting','running','waiting_user','stopping'].includes(turn.status),command=turn.control==='compact'&&turn.runtime==='codex'?'compact':(turn.prompt||'').replace(/^\//,'');
     const index=promptIndex(turn,'system',command);
     const c=turn.contextUsage?.compacted,detail=turn.status==='failed'?`${t('Failed')}${turn.error?` · ${t(turn.error)}`:''}`:c&&c.preTokens!=null&&c.postTokens!=null?`${tokensText(c.preTokens)} → ${tokensText(c.postTokens)}`:live?t('Working…'):String(turn.text||'').split('\n')[0].slice(0,160);
     if(index>=0){used.add(index);const row=rows[index];row.querySelector('.nt-system-detail')?.remove();if(detail)row.append(el('span','nt-system-detail',detail));continue;}
     const row=el('div',`nt-system native-chat-row${turn.status==='failed'?' is-error':''}`);row.dataset.role='system';row.dataset.text=command;if(turn.createdAt)row.dataset.at=turn.createdAt;row.append(el('span','nt-system-mark','\u2318'),el('code','',`/${command}`));if(detail)row.append(el('span','nt-system-detail',detail));if(live){row.append(el('span','nt-pulse'));feed.append(row);}else place([row],turn.createdAt);continue;
    }
    const state=turn.status==='failed'?'error':turn.status==='interrupted'?'stopped':turn.status==='queued'?'queued':turn.status==='waiting_user'||turn.phase==='waiting'?'waiting':['starting','running','stopping'].includes(turn.status)?'running':'completed';
    const live=['queued','starting','running','waiting_user','stopping'].includes(turn.status);
    const paths=toolFilePaths(stepsOf(turn).steps);
    if(!live&&turn.endedAt&&turn.prompt.trim()){
     const index=promptIndex(turn,'user',promptKey(turn.prompt));
     if(index>=0){used.add(index);let anchor=rows[index];const replies=[];for(let i=index+1;i<rows.length&&rows[i].dataset.role!=='user';i++){anchor=rows[i];if(anchor.dataset.role==='assistant')replies.push(anchor);}
      if(turn.attachments?.length){const files=el('div','chat-attachments native-turn-files native-turn-anchored');for(const item of turn.attachments)files.append(attachmentCard(item));attachFiles(rows[index],files);}
      // A native history snapshot can contain only the initial commentary. Keep the saved reply until that same
      // prompt's history includes its final prose; clearFeedMarks restores the original rows on the next refresh.
      const final=simplifiedCliOutput(replyText(turn));
      if(anchor.dataset.role==='user'||final.trim()&&!historyContainsReply(final,replies.flatMap(row=>row._replyTexts||[]))){
       for(const row of replies){row.hidden=true;row.dataset.nativeLiveHidden='1';}
       const content=el('div','nt-turn');content.append(turnContent(turn,current,{open:openProcesses.has(turn.id)}));
       const reply=chatRow('assistant',replyText(turn),current.runtime,turn.endedAt||turn.createdAt,null,state,current,{content,filePaths:paths});reply.dataset.role='assistant';reply.classList.add('native-turn-anchored');footNote(reply,endNote(turn));if(turn.endedAt)reply.dataset.duration=elapsedText(turn.createdAt,new Date(turn.endedAt).getTime());rows[index].after(reply);continue;}
      const extra=el('div','native-turn-anchored nt-extra');
      if(hasProcess(turn)&&anchor.dataset.process!=='1')extra.append(activityFor(turn,{open:openProcesses.has(turn.id)}));
      {const tasks=taskBlock(turn,t);if(tasks)extra.append(tasks);}
      footNote(anchor,endNote(turn),{anchored:true});
      if(extra.childElementCount){const body=anchor.querySelector('.nt-body');if(body){const md=body.querySelector('.markdown-body');md?md.before(extra):body.append(extra);}}if(turn.endedAt){if(!('historyDuration' in anchor.dataset))anchor.dataset.historyDuration=anchor.dataset.duration||'';anchor.dataset.duration=elapsedText(turn.createdAt,new Date(turn.endedAt).getTime());}continue;}
    }
    const makeFiles=()=>{if(!turn.attachments?.length)return null;const files=el('div','chat-attachments native-turn-files');for(const item of turn.attachments)files.append(attachmentCard(item));return files;};
    // A running turn whose prompt already reached the history anchors on that row: the history row stays, the feed adds only the live reply,
    // and the history's partial reply rows for this turn are hidden while the live one shows.
    const liveIndex=live?promptIndex(turn,'user',promptKey(turn.prompt)):-1;
    if(liveIndex>=0){used.add(liveIndex);const files=makeFiles();if(files){files.classList.add('native-turn-anchored');attachFiles(rows[liveIndex],files);}
     for(let i=liveIndex+1;i<rows.length&&rows[i].dataset.role!=='user';i++){rows[i].hidden=true;rows[i].dataset.nativeLiveHidden='1';}}
    const userRow=liveIndex>=0?null:chatRow('user',turn.prompt,current.runtime,turn.createdAt,makeFiles());if(userRow){userRow.dataset.role='user';userRow.dataset.text=promptKey(turn.prompt);}
    const content=el('div','nt-turn');content.append(turnContent(turn,current,{live,open:live||openProcesses.has(turn.id)}));
    if(live)content.append(workingLine(turn));
    const reply=chatRow('assistant',replyText(turn),current.runtime,live?turn.createdAt:turn.endedAt||turn.createdAt,null,state,current,{content,filePaths:paths});reply.dataset.role='assistant';if(!live)footNote(reply,endNote(turn));if(!live&&turn.endedAt)reply.dataset.duration=elapsedText(turn.createdAt,new Date(turn.endedAt).getTime());
    if(live){feed.append(...(userRow?[userRow,reply]:[reply]));liveReplies.set(turn.id,reply);}else place([userRow,reply],turn.createdAt);
   }
   // The send on its way, drawn at once under its own id with what is known about it; Home's turn replaces it.
   {const d=pendingSend();if(d&&!queuesBehind()){const ids=new Set(d.pending.attachmentIds||[]),files=el('div','chat-attachments native-turn-files');for(const item of (d.attachments||[]).filter(a=>ids.has(a.id)))files.append(attachmentCard(item));
    if(!d.sentAt){d.sentAt=new Date().toISOString();save();}
    const row=chatRow('user',d.pending.text||'',current.runtime,d.sentAt,files.childElementCount?files:null),state=d.confirmed?'stored':sendState(d,operation(k()));row.dataset.role='user';row.classList.add('is-pending-send');if(state==='failed')row.classList.add('is-unsent');
    const label={sending:'Sending…',checking:'Checking…',offline:'Waiting for network…',failed:'Not sent'}[state];if(label){const note=el('span',state==='failed'?'nt-unsent-note':'nt-unsent-note is-pending',t(label)),tools=row.querySelector('.nt-prompt-tools');if(tools)tools.prepend(note);else row.append(note);}feed.append(row);}}
   markLatestDuration();}
  /** A centred date line opens the transcript, and again on a new day or before a prompt after a pause of 30 minutes or more. */
  function markDays(){for(const old of scroll.querySelectorAll('.nt-day'))old.remove();let last=null;
   for(const row of scroll.querySelectorAll('.native-chat-row')){if(row.hidden||!row.dataset.at)continue;const at=new Date(row.dataset.at);if(Number.isNaN(at.getTime()))continue;
    if(!last||at.toDateString()!==last.toDateString()||(row.classList.contains('nt-user')&&at-last>=30*60000)){const day=el('div','nt-day',dayLabel(at));day.translate=false;row.before(day);}last=at;}}
  function groupRows(){markDays();let prev=null;for(const node of scroll.querySelectorAll('.native-chat-row, .native-history-separator, .native-history-loader, .nt-day')){if(node.hidden){node.classList.remove('is-continued');continue;}const role=node.classList.contains('nt-agent')?'agent':node.classList.contains('nt-user')?'user':null;node.classList.toggle('is-continued',Boolean(role)&&prev===role);prev=role;}}
  /** Every finished reply shows how long its turn took, next to Copy; a reply still running or without a known start shows none. */
  function markLatestDuration(){attachInterruptionNotices(scroll,t);groupRows();for(const old of scroll.querySelectorAll('.nt-duration'))old.remove();for(const row of scroll.querySelectorAll('.nt-agent')){if(row.hidden||!row.dataset.duration||row.querySelector('.nt-working'))continue;const foot=row.querySelector('.nt-reply-foot');if(foot)foot.insertBefore(el('span','nt-duration',t('Took {duration}',{duration:row.dataset.duration})),foot.querySelector(':scope > .nt-foot-status'));}}
  /** The composer is built once and kept in place: a refresh that re-created it would move the focused textarea and drop the caret (and any IME composition). */
  const form=el('form','chat-composer native-takeover-form'),barRow=el('div','chat-input-bar'),field=el('div','chat-input-field'),note=el('p','workspace-note native-takeover-note'),tray=el('div','chat-attachments native-takeover-tray');
  // Queued messages sit above the composer like the group-chat queue: steer interrupts the reply and sends that one now, × withdraws it.
  const queue=el('details','message-queue native-queue'),queueSummary=el('summary',''),queueList=el('div','message-queue-list');queue.open=true;queue.append(queueSummary,queueList);queue.hidden=true;
  const queuePending=new Set();
  /** The queue above the composer: pause/resume at the right of its title, and per message a drag grip, the text with its send
   * time on hover, then steer, edit (back to the input box) and delete. Rebuilt only when the queue itself changed, so a press on
   * one of its buttons survives the 1s refresh; a drag in progress defers the rebuild. */
  const GRIP='<svg viewBox="0 0 12 18" aria-hidden="true"><g fill="currentColor"><circle cx="3.5" cy="4" r="1.4"/><circle cx="8.5" cy="4" r="1.4"/><circle cx="3.5" cy="9" r="1.4"/><circle cx="8.5" cy="9" r="1.4"/><circle cx="3.5" cy="14" r="1.4"/><circle cx="8.5" cy="14" r="1.4"/></g></svg>';
  let queueState=null,queueSignature='',optimisticOrder=null;
  const queueRank=turn=>Number.isFinite(turn.queueRank)?turn.queueRank:(Date.parse(turn.createdAt)||0);
  const queueOrder=createListOrder({container:queueList,scope:()=>`native-queue:${k()}`,handle:'.message-queue-grip',onEnd:()=>{queueSignature='';renderQueue();},onError:message=>{operation().message=t(message);render();},
   persist:async ids=>{optimisticOrder=ids;try{await api(`${turnsUrl()}/queue`,{method:'POST',json:{runtime:current.runtime,sessionId:current.sessionId,order:ids}});}catch(error){operation().message=t(error.message);render();}finally{optimisticOrder=null;await refresh();}}});
  async function setQueuePaused(paused){try{const result=await api(`${turnsUrl()}/queue`,{method:'POST',json:{runtime:current.runtime,sessionId:current.sessionId,paused}});queueState=result.queue||queueState;renderQueue();await refresh();}catch(error){operation().message=t(error.message);render();}}
  // Delete and edit take a message out only while it still waits; an older Home without withdraw cancels it the old way.
  async function withdrawQueued(turn){queuePending.add(turn.id);renderQueue();try{await api(`${turnsUrl()}/${encodeURIComponent(turn.id)}/${queueState?'withdraw':'stop'}`,{method:'POST',json:{}});await refresh();}catch(error){operation().message=t(error.message);render();}finally{queuePending.delete(turn.id);renderQueue();}}
  /** 撤回期间只锁原会话的草稿，返回结果不能写入后来切换的会话。 */
  async function editQueued(turn){const id=k(),d=draft(id),op=operation(id);
   if(op.editing||op.sending||op.releasing||op.uploads)return;
   if(d.pending||d.text?.trim()||input.value.trim()||d.attachments?.length){op.message=t('Keep or send the current draft before editing a queued message');render();return;}
   op.editing=true;op.message='';queuePending.add(turn.id);render();
   try{await api(`${turnsUrl()}/${encodeURIComponent(turn.id)}/withdraw`,{method:'POST',json:{}});d.text=turn.prompt||'';d.attachments=(turn.attachments||[]).map(a=>({...a,reused:true}));save();if(k()===id)await refresh();}
   catch(error){op.message=t(error.message);}
   finally{op.editing=false;queuePending.delete(turn.id);if(k()===id){render();input.focus();}}}
  /** The CLI's question card above the composer: the question, its numbered options, a free-text reply, Skip and Send; several
   * questions page through with "1/2" and are answered together. Built once per question, so typing survives the 1s refresh. */
  const ask=el('section','native-ask');ask.hidden=true;ask.setAttribute('aria-label',t('Question'));
  let askState=null,askBuilt='';
  const askIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8.5 8.5 0 0 1-12.6 7.4L4 21l1.6-4.4A8.5 8.5 0 1 1 21 12Z"/><path d="M9.8 9.5a2.3 2.3 0 0 1 4.4.8c0 1.5-2.2 2-2.2 3.2"/><path d="M12 16.6h.01"/></svg>';
  async function sendAnswer(live,body){const id=live.id;askState=null;askBuilt='';ask.hidden=true;ask.replaceChildren();
   try{await api(`${turnsUrl()}/${encodeURIComponent(id)}/answer`,{method:'POST',json:body});await refresh();}catch(error){operation().message=t(error.message);render();}}
  function renderAsk(){
   const live=activeTurn(),q=live?.question&&!live.question.answered?live.question:null;
   if(!q||!current){ask.hidden=true;if(askBuilt){ask.replaceChildren();askBuilt='';}askState=null;return;}
   if(askState?.turnId!==live.id||askState.questionId!==q.id)askState={turnId:live.id,questionId:q.id,index:0,picked:{},typed:{}};
   const st=askState,total=q.questions.length,question=q.questions[st.index]||q.questions[0],built=JSON.stringify([live.id,q.id,st.index]);
   ask.hidden=false;if(built===askBuilt)return;askBuilt=built;
   const picked=new Set(st.picked[question.id]||[]);
   const head=el('div','native-ask-head'),title=el('span','native-ask-title');title.innerHTML=askIcon;title.append(el('span','',t('Question')));head.append(title);
   if(total>1)head.append(el('span','native-ask-pager',`${st.index+1}/${total}`));
   const close=iconButton('close','Skip all questions',()=>void sendAnswer(live,{questionId:q.id,skip:true}),'native-ask-close');head.append(close);
   const text=el('p','native-ask-text',question.question);text.translate=false;
   const list=el('div','native-ask-options');
   const answerOf=()=>{const typed=(st.typed[question.id]||'').trim();return [...(st.picked[question.id]||[]),...(typed?[typed]:[])];};
   const paint=()=>{for(const row of list.children)row.classList.toggle('is-picked',(st.picked[question.id]||[]).includes(row.dataset.label));send.disabled=!answerOf().length;};
   question.options.forEach((option,i)=>{const row=el('button','native-ask-option');row.type='button';row.dataset.label=option.label;row.append(el('span','native-ask-key',String(i+1)),el('span','native-ask-label',option.label));
    if(option.description)row.append(el('span','native-ask-desc',option.description));row.translate=false;
    row.addEventListener('click',()=>{const now=new Set(question.multiSelect?st.picked[question.id]||[]:[]);if(now.has(option.label))now.delete(option.label);else now.add(option.label);st.picked[question.id]=[...now];paint();if(!question.multiSelect)other.value='';st.typed[question.id]='';});
    list.append(row);});
   const foot=el('div','native-ask-foot'),other=el('input','native-ask-other');other.type=question.secret?'password':'text';other.placeholder=t('Or write your own reply');other.value=st.typed[question.id]||'';other.setAttribute('aria-label',other.placeholder);
   other.addEventListener('input',()=>{st.typed[question.id]=other.value;if(!question.multiSelect&&other.value.trim()){st.picked[question.id]=[];}paint();});
   const skip=el('button','secondary compact native-ask-skip',t('Skip')),send=el('button','primary compact native-ask-send',t('Send'));skip.type=send.type='button';
   const advance=()=>{if(st.index<total-1){st.index+=1;askBuilt='';renderAsk();ask.querySelector('.native-ask-other')?.focus({preventScroll:true});return;}
    const answers={};for(const item of q.questions){const typed=(st.typed[item.id]||'').trim(),values=[...(st.picked[item.id]||[]),...(typed?[typed]:[])];if(values.length)answers[item.id]=values;}
    void sendAnswer(live,Object.keys(answers).length?{questionId:q.id,answers}:{questionId:q.id,skip:true});};
   skip.addEventListener('click',()=>{st.picked[question.id]=[];st.typed[question.id]='';advance();});
   send.addEventListener('click',()=>{if(answerOf().length)advance();});
   other.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();if(answerOf().length)advance();}});
   ask.addEventListener('keydown',e=>{if(e.target===other||e.ctrlKey||e.metaKey||e.altKey)return;const n=Number(e.key);if(n>=1&&n<=question.options.length){e.preventDefault();list.children[n-1].click();}else if(e.key==='Enter'&&answerOf().length){e.preventDefault();advance();}});
   foot.append(other,skip,send);ask.replaceChildren(head,text,list,foot);paint();
   if(!input.matches(':focus'))other.focus({preventScroll:true});
  }
  function renderQueue(){
   const pos=optimisticOrder?new Map(optimisticOrder.map((id,i)=>[id,i])):null;
   const provisional=queuesBehind()?pendingSend():null;
   const waiting=turns.filter(x=>x.status==='waiting').sort((a,b)=>Number(Boolean(b.steer))-Number(Boolean(a.steer))||(pos?(pos.get(a.id)??Infinity)-(pos.get(b.id)??Infinity):0)||queueRank(a)-queueRank(b));
   const signature=JSON.stringify([k(),waiting.map(x=>[x.id,x.prompt,Boolean(x.steer),x.createdAt,(x.attachments||[]).map(a=>a.id)]),queueState,[...queuePending],provisional?[provisional.pending.clientTurnId,provisional.confirmed?'stored':sendState(provisional,operation(k()))]:null]);
   if(queueOrder.active()||signature===queueSignature)return;queueSignature=signature;
   const count=waiting.length+(provisional?1:0);
   queue.hidden=!count;queueList.replaceChildren();if(!count)return;
   const paused=Boolean(queueState?.paused),head=[el('span','message-queue-title',t('Queue · {v}',{v:count}))];queue.classList.toggle('is-paused',paused);
   if(paused)head.push(el('span','message-queue-paused',t('Paused')));
   if(queueState){const toggle=iconButton(paused?'play':'pause',paused?'Resume the queue':'Pause the queue: keep these messages after the reply ends',e=>{e.preventDefault();e.stopPropagation();void setQueuePaused(!paused);},`message-queue-pause${paused?' is-paused':''}`);head.push(toggle);}
   queueSummary.replaceChildren(...head);
   const orderable=Boolean(queueState)&&waiting.filter(x=>!x.steer).length>1;queueList.classList.toggle('is-orderable',orderable);
   waiting.forEach((turn,i)=>{const row=el('div','message-queue-item'),info=el('div','message-queue-info');
    if(orderable&&!turn.steer){row.dataset.orderId=turn.id;const grip=el('span','message-queue-grip');grip.innerHTML=GRIP;grip.title=t('Drag to reorder');row.append(grip);}
    const text=turn.prompt||(turn.attachments||[]).map(a=>a.name).join(', '),title=el('strong','',`${i+1}. ${text}`);title.title=text;title.translate=false;info.append(title);
    if(turn.createdAt){const when=el('time','message-queue-time',clock(turn.createdAt));when.dateTime=turn.createdAt;when.title=time(turn.createdAt);when.translate=false;info.append(when);}row.append(info);
    const busy=queuePending.has(turn.id),steer=el('button',`icon-button message-queue-steer${busy||turn.steer?' is-active':''}`);steer.type='button';steer.innerHTML="<svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M12 13v8\"/><path d=\"M12 3v3\"/><path d=\"M18 6a2 2 0 0 1 1.387.56l2.307 2.22a1 1 0 0 1 0 1.44l-2.307 2.22A2 2 0 0 1 18 13H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z\"/></svg>";steer.title=t(busy?'Interrupting and starting this message':turn.steer?'Refresh session state and retry this message':'Interrupt the current reply and send this message now');steer.setAttribute('aria-label',steer.title);steer.disabled=busy;
    steer.onclick=async()=>{queuePending.add(turn.id);queueSignature='';renderQueue();try{await api(`${turnsUrl()}/${encodeURIComponent(turn.id)}/steer`,{method:'POST',json:{}});await refresh();}catch(error){operation().message=t(error.message);render();}finally{queuePending.delete(turn.id);renderQueue();}};
    row.append(steer);
    if(queueState){const edit=iconButton('edit','Edit: back to the input box',()=>void editQueued(turn),'message-queue-edit');edit.disabled=busy||Boolean(operation().editing);row.append(edit);}
    const remove=iconButton('trash','Delete',()=>void withdrawQueued(turn),'message-queue-delete');remove.disabled=queuePending.has(turn.id);row.append(remove);
    queueList.append(row);});
   // The send on its way, last in line, with no controls until Home has stored it.
   if(provisional){const row=el('div','message-queue-item is-pending'),info=el('div','message-queue-info'),text=provisional.pending.text||(provisional.attachments||[]).map(a=>a.name).join(', '),title=el('strong','',`${count}. ${text}`);title.title=text;title.translate=false;
    const state=provisional.confirmed?null:sendState(provisional,operation(k())),label={sending:'Sending…',checking:'Checking…',offline:'Waiting for network…',failed:'Not sent'}[state];info.append(title);if(label)info.append(el('span','message-queue-time',t(label)));row.append(info);queueList.append(row);}}
  /** Stop only while a reply runs and nothing is typed; with text or files the button sends, and Home queues the message. */
  function syncSendButton(){if(!current)return;const d=draft(),op=operation(),state=sendState(d,op),live=activeTurn(),stopping=live?.status==='stopping',typing=Boolean(input.value.trim())||Boolean(d.attachments?.length)||Boolean(d.pending);
   const stopMode=Boolean(live)&&!typing;
   if(stopMode){sendButton.disabled=stopping||op.releasing||op.editing;setSend('stop',stopping?'Stopping…':'Stop');}
   else{sendButton.disabled=op.sending||op.releasing||op.editing||op.uploads>0||sendLocked(state)||Boolean(op.verifying);setSend('send',SEND_LABELS[state]||'Send');}
   input.placeholder=live?t('Reply in progress; Enter queues your message, Stop interrupts'):t('Message {tool}; replies continue this native session',{tool:names[current.runtime]||current.runtime});}
  let refocus=false;
  function render(){
   if(!current)return;const value=current,taken=isOn(value);renderFeed();renderSessionControls(value);
   if(!taken&&!(supported&&canChat(value))){const bar=el('div','native-takeover-bar');const copy=el('div','native-takeover-copy');copy.append(el('strong','',t('Read-only preview')),el('span','',t(supported?'Take over to keep chatting in this exact native session here.':'Upgrade this Worker to take over native sessions')));const b=button('Take over session',()=>enable(value),'primary native-takeover-button');b.disabled=!supported;bar.append(copy,b);shell.replaceChildren(bar);return;}
   const id=k(),d=draft(id),op=operation(id);
   // A pending send is drawn in the transcript as its own message, so the box shows neither its text nor its files.
   const boxText=d.pending?'':d.text||'';if(input.value!==boxText)input.value=boxText;
   note.textContent=op.message||'';note.hidden=!note.textContent;note.classList.toggle('chat-bubble',Boolean(op.message));note.classList.toggle('is-error-card',Boolean(op.message));const state=sendState(d,op);
   tray.replaceChildren();for(const item of d.pending?[]:d.attachments||[])tray.append(attachmentCard(item,()=>{if(!d.pending)void removeAttachment(id,value.nodeId,item);}));
   if(op.uploads)tray.append(el('span','attachment-uploading',t('Uploading attachments…')));tray.hidden=!tray.childElementCount;
   syncSendButton();renderQueue();renderAsk();
   // Disabling the textarea while a send is in flight drops focus; give it back once typing is possible again.
   const locked=op.sending||op.releasing||op.editing||Boolean(d.pending)||agentSwitchUI.busy(value);if(locked&&!input.disabled&&[input,sendButton].includes(document.activeElement))refocus=true;
   input.disabled=locked;attachButton.disabled=locked;
   if(!shell.contains(form))shell.replaceChildren(queue,ask,form);resize();
   if(refocus&&!locked){refocus=false;if(document.activeElement===document.body||document.activeElement===sendButton)input.focus({preventScroll:true});}
  }
  async function endTakeover(value){const id=sessionKey(value),op=operation(id);if(op.releasing)return;op.releasing=true;op.message='';if(k()===id){render();renderSide(value,value.sessionId,true);}try{await api(`${endpoint(value.nodeId)}/takeover/release`,{method:'POST',json:{runtime:value.runtime,sessionId:value.sessionId}});if(k()===id)await refresh();else await onStateRefresh();}catch(error){op.releasing=false;op.message=t(error.message);if(k()===id){render();renderSide(value,value.sessionId,true);}}}
  async function removeAttachment(id,nodeId,item){const op=operation(id);op.message='';if(k()===id)render();try{
   // A file brought back by editing a queued message still belongs to that message's record; dropping it from the draft is enough.
   if(!item.reused)await api(`${endpoint(nodeId)}/attachments/${encodeURIComponent(item.id)}`,{method:'DELETE'});const d=draft(id);d.attachments=(d.attachments||[]).filter(a=>a.id!==item.id);revokeAttachment(nodeId,item.id);save();}catch(error){op.message=t(error.message);}finally{if(k()===id)render();}}
  const input=el('textarea');input.rows=1;input.setAttribute('aria-label',t('Chat message'));
  const sendButton=el('button','primary chat-send');sendButton.type='submit';
  /** Send and Stop are one icon button inside the field; the label lives in the tooltip and accessible name. */
  const setSend=(kind,label)=>{sendButton.className=`${kind==='stop'?'danger':'primary'} chat-send`;sendButton.innerHTML=UI_ICON[kind];sendButton.title=t(label);sendButton.setAttribute('aria-label',t(label));};setSend('send','Send');
  sendButton.addEventListener('click',e=>{const live=activeTurn(),d=draft();if(!live||input.value.trim()||d.attachments?.length||d.pending)return;e.preventDefault();if(live.status!=='stopping')void stop(live);});
  const fileInput=el('input');fileInput.type='file';fileInput.multiple=true;fileInput.hidden=true;document.body.append(fileInput);
  const attachButton=el('button','native-attach');attachButton.type='button';attachButton.title=t('Upload an image or file');attachButton.setAttribute('aria-label',t('Upload file'));attachButton.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8M7 13l7-7"/></svg>';
  attachButton.addEventListener('click',()=>fileInput.click());fileInput.addEventListener('change',()=>{void upload(fileInput.files);fileInput.value='';});
  field.append(tray,attachButton,input,sendButton);barRow.append(field);form.append(note,barRow);form.addEventListener('submit',e=>{e.preventDefault();void submit();});
  /** Same limits as the group chat: at most 6 files per message, 20 MB each; images only for CLIs with image input. */
  async function upload(list,{onFailed=null}={}){if(!current)return;const id=k(),nodeId=current.nodeId,runtime=current.runtime,d=draft(id),op=operation(id),files=[...list];if(op.sending||op.releasing||op.editing||d.pending)return;op.message='';
   if((d.attachments?.length||0)+op.uploads+files.length>6){op.message=t('At most 6 attachments per message');render();return;}
   if(files.some(f=>!f.size||f.size>20*1024*1024)){op.message=t('Attachments cannot be empty; each file is limited to 20 MB');render();return;}
   if(!IMAGE_CLIS.has(runtime)&&files.some(f=>f.type.startsWith('image/'))){op.message=t('{tool} cannot receive images here; files are passed as paths',{tool:names[runtime]});render();return;}
   op.uploads+=files.length;render();
   for(const file of files){let uploaded=null;try{uploaded=await api(`${endpoint(nodeId)}/attachments`,{method:'POST',body:file,headers:{'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(file.name||'pasted-image.png')}});if(!IMAGE_CLIS.has(runtime)&&uploaded.mime.startsWith('image/'))throw Error('This CLI cannot receive images in a takeover; send files or use iTerm');(d.attachments||=[]).push({id:uploaded.id,name:uploaded.name,mime:uploaded.mime,size:uploaded.size});save();}catch(error){if(uploaded)void api(`${endpoint(nodeId)}/attachments/${encodeURIComponent(uploaded.id)}`,{method:'DELETE'}).catch(()=>{});op.message=t(error.message);onFailed?.(error);}finally{op.uploads--;if(k()===id)render();}}}
  /** Pasted text over 200 characters goes in as a text attachment so the box stays short; a failed upload puts the text back where it was pasted. */
  function pasteAsFile(text){if(!current||!pastesAsFile(text))return false;const id=k(),d=draft(id),op=operation(id);if(op.sending||op.releasing||op.editing||d.pending)return false;
   if((d.attachments?.length||0)+op.uploads>=6){op.message=t('Attachments are full; the long text stays in the input box. Remove an attachment first');render();return false;}
   const file=new File([text],pastedTextName(text),{type:'text/markdown'});if(file.size>20*1024*1024){op.message=t('Text exceeds the 20 MB per-attachment limit; the original is kept, please split it before sending');render();return false;}
   const start=input.selectionStart??input.value.length,end=input.selectionEnd??start,before=input.value.slice(0,start),after=input.value.slice(end);
   input.value=before+after;input.setSelectionRange(start,start);d.text=input.value;save();resize();
   void upload([file],{onFailed:error=>{const now=draft(id);now.text=now.text===before+after?before+text+after:`${now.text?`${now.text}\n`:''}${text}`;save();if(k()===id){input.value=now.text;resize();}op.message=t('The pasted text could not become an attachment ({message}); it is back in the input box',{message:t(error.message)});}});
   return true;}
  input.addEventListener('paste',e=>{const files=[...(e.clipboardData?.files||[])];if(files.length){e.preventDefault();void upload(files);return;}if(pasteAsFile(e.clipboardData?.getData('text/plain')||''))e.preventDefault();});
  shell.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files')){e.preventDefault();shell.classList.add('is-dragging');}});
  shell.addEventListener('dragleave',()=>shell.classList.remove('is-dragging'));
  shell.addEventListener('drop',e=>{shell.classList.remove('is-dragging');if(e.dataTransfer?.files.length&&current&&(isOn(current)||canChat(current))){e.preventDefault();void upload(e.dataTransfer.files);}});
  const resize=()=>{input.style.height='auto';input.style.height=`${Math.min(120,Math.max(36,input.scrollHeight))}px`;};
  input.addEventListener('input',()=>{draft().text=input.value;save();resize();syncSendButton();});
  input.addEventListener('keydown',e=>{if(window.matchMedia('(max-width: 1000px)').matches)return;if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&!sendButton.disabled){e.preventDefault();input.form?.requestSubmit();}});
  async function submit(){if(!current||agentSwitchUI.busy(current))return;const id=k(),value=current,d=draft(id),op=operation(id);if(op.sending||op.releasing||op.editing||op.uploads)return;
   // An in-flight or unknown send is only looked up again (click, double click, Enter); it is never resent with a new ID.
   if(d.pending&&d.sendState!=='failed'){void verifyTurn(id);return;}
   if(!d.pending&&!input.value.trim()&&!d.attachments?.length)return;op.message='';
   if(!isOn(value)){on.add(id);save();}
   if(!d.pending){const payload={text:input.value,attachmentIds:(d.attachments||[]).map(a=>a.id)};
    // A retry of exactly the content Home rejected keeps its id; any edit gets a new id, never the old one.
    d.pending={clientTurnId:sameSend(d.rejected?.payload,payload)?d.rejected.clientTurnId:crypto.randomUUID(),...payload};}
   delete d.rejected;d.sendState='sending';d.sentAt||=new Date().toISOString();const sent=d.pending;save();op.sending=true;render();if(k()===id)scroll.scrollTop=scroll.scrollHeight;
   try{const turn=await api(`${endpoint(value.nodeId)}/turns`,{method:'POST',json:{runtime:value.runtime,sessionId:value.sessionId,allowAll:true,...d.pending}});drafts[draftId(id)]={text:'',attachments:[]};if(k()===id){fetchTicket++;input.value='';turns=[...turns.filter(x=>x.id!==turn.id),turn];}}
   catch(error){if(uncertainSend(error))d.sendState='checking';else{const {clientTurnId,...payload}=sent;d.rejected={clientTurnId,payload};delete d.pending;delete d.sendState;delete d.sentAt;}op.message=t(error.message);}
   finally{op.sending=false;save();if(current){render();schedule();if(k()===id)scroll.scrollTop=scroll.scrollHeight;if(drafts[draftId(id)]?.pending&&drafts[draftId(id)].sendState==='checking')void verifyTurn(id);}}}
  async function stop(turn){const op=operation();try{const next=await api(`${turnsUrl()}/${encodeURIComponent(turn.id)}/stop`,{method:'POST',json:{}});turns=turns.map(x=>x.id===next.id?next:x);render();}catch(error){op.message=t(error.message);render();}}
  /** 同一会话代次只保留一个在途读取，慢请求完成前的轮询不再作废它。 */
  async function refresh(){if(!current||!active())return;const id=k();if(refreshRequest?.id===id&&refreshRequest.ticket===fetchTicket)return;
   const ticket=++fetchTicket,request=refreshRequest={id,ticket},op=operation(id);try{const result=await api(`${turnsUrl()}?${new URLSearchParams({runtime:current.runtime,sessionId:current.sessionId})}`);if(ticket!==fetchTicket||k()!==id)return;const wasActive=Boolean(activeTurn()),bottom=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<80;supported=result.supported!==false;controls=result.controls===true;settings=result.settings||{model:null,effort:null};residentState=result.process||'closed';turns=result.items||[];queueState=result.queue||null;{const d=drafts[draftId(id)];if(d?.pending&&!op.sending&&turns.some(x=>x.clientTurnId===d.pending.clientTurnId))settleTurn(id,d.pending);}if(op.releasing&&result.process==='closed'){op.releasing=false;on.delete(id);returned.add(id);save();await onStateRefresh();if(ticket!==fetchTicket||k()!==id)return;}render();renderSide(current,current.sessionId,true);if(wasActive&&!activeTurn()&&selected)void read(selected,{quiet:true});if(bottom)scroll.scrollTop=scroll.scrollHeight;}catch(error){if(ticket!==fetchTicket||k()!==id)return;op.message=t(error.message);render();}
   finally{if(refreshRequest===request){refreshRequest=null;if(ticket===fetchTicket&&k()===id)schedule();}}}
  function schedule(){clearInterval(poll);poll=null;if(active()&&current&&(activeTurn()||turns.some(x=>x.status==='waiting')||operation().releasing||confirmedSends.has(draftId(k()))))poll=setInterval(()=>{if(!document.hidden)void refresh();},1000);}
  /** Start chatting here without an extra permission prompt; terminal handover keeps its separate ownership checks. */
  function enable(value,{focus=true}={}){if(!value?.sessionId)return false;const id=sessionKey(value);if(!on.has(id)){on.add(id);save();}if(current&&k()===id){render();renderSide(value,value.sessionId,true);if(focus)input.focus();}return true;}
  /** Files touched by this session's page turns, newest turn first; an edit or write wins over a read of the same path. */
  function files(){const seen=new Map();for(const turn of [...turns].reverse()){if(turn.control)continue;for(const chip of fileChips(stepsOf(turn).steps)){const prior=seen.get(chip.path);if(!prior||prior.step.kind==='read'&&chip.step.kind!=='read')seen.set(chip.path,chip);}}return [...seen.values()];}
  /** Latest context snapshot of the current session from its page turns. */
  function contextSample(){for(const turn of [...turns].reverse())if(turn.contextUsage)return turn.contextUsage;return null;}
  async function saveSetting(field,value,extra={}){if(!current)return null;const id=k(),op=operation(id);op.message='';try{const result=await api(`${endpoint(current.nodeId)}/settings`,{method:'POST',json:{runtime:current.runtime,sessionId:current.sessionId,[field]:value||null,...extra}});settings={...settings,model:result.model||null,effort:result.effort||null,hostingAccountId:result.hostingAccountId||null,repoUrl:result.repoUrl||null};await refresh();return result;}catch(error){op.message=t(error.message);render();renderSide(current,current.sessionId,true);return null;}}
  async function compact(){if(!current||activeTurn())return;const id=k(),op=operation(id);op.message='';try{const turn=await api(`${turnsUrl()}`,{method:'POST',json:{runtime:current.runtime,sessionId:current.sessionId,allowAll:true,clientTurnId:crypto.randomUUID(),control:'compact'}});turns=[...turns.filter(x=>x.id!==turn.id),turn];render();schedule();}catch(error){op.message=t(error.message);render();}}
  return {feed,attach,detach,suspend,resume,isOn,enable,bindConversation,render,switchBusy:value=>{const id=sessionKey(value),op=operation(id);return releaseDisabled(value)||Boolean(drafts[draftId(id)]?.pending)||Boolean(op.verifying)||Boolean(id===k()&&turns.some(x=>x.status==='waiting'));},adopt:value=>{if(!value?.sessionId)return;on.add(sessionKey(value));save();},canChat,renderFeed,returned:markReturned,isReleasing,releaseDisabled,feedback:value=>operation(sessionKey(value)).message,release:endTakeover,refresh,recheck,
   files,contextSample,settings:()=>settings,controls:()=>controls,busy:()=>Boolean(activeTurn()),saveSetting,compact,turns:()=>turns};
 }
 const dialog=el('dialog','settings-edit-dialog native-session-dialog');dialog.id='native-session-dialog';document.body.append(dialog);
 const picker=el('dialog','settings-edit-dialog native-file-picker');picker.id='native-file-picker';document.body.append(picker);let pickerVersion=0;
 /** Metadata-only browsing: selecting a file returns its parent folder, never its contents or a CLI prompt. */
 function openFilePicker({nodeId,path,locked,onUse}){
  picker.replaceChildren();const heading=el('div','dialog-heading');heading.append(el('h2','',t('Select file or folder')),closeButton(()=>picker.close()));
  const toolbar=el('div','native-picker-toolbar'),location=el('div','native-picker-path'),rows=el('div','native-picker-list'),message=el('p','native-picker-note'),selection=el('div','native-picker-selection'),actions=el('div','native-picker-actions');let current=null,chosen=null,parent=null,nextOffset=0;
  location.translate=false;selection.translate=false;message.setAttribute('role','status');
  const use=button('Use',()=>{if(!chosen||locked&&chosen.workspace!==locked)return;onUse(chosen.workspace);picker.close();},'primary');
  const select=item=>{chosen=item;selection.textContent=item?.path||'';use.disabled=!item||Boolean(locked&&item.workspace!==locked);message.textContent=t(locked&&item?.workspace!==locked?'An existing session keeps its original working folder.':item?.type==='file'?'Only the containing folder is used; the file is not read.':'Select an item, then choose Use.');for(const row of rows.querySelectorAll('[data-path]'))row.setAttribute('aria-pressed',String(row.dataset.path===item?.path));};
  const up=button('Parent folder',()=>browse(parent)),roots=button('Allowed folders',()=>browse(null)),more=button('Load more',()=>browse(current,nextOffset,true));toolbar.append(up,roots);more.hidden=true;
  const newFolder=createFolderControl({api,onCreated:result=>browse(result.path)});toolbar.append(newFolder.button);
  const pathRow=el('div','native-workspace-row'),directPath=el('input');let pathInputVersion=0;directPath.addEventListener('input',()=>pathInputVersion++);directPath.placeholder=t('Absolute folder path');directPath.setAttribute('aria-label',t('Absolute folder path'));const openPath=button('Open',()=>browse(directPath.value.trim()));pathRow.append(directPath,openPath);directPath.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();void browse(directPath.value.trim());}});
  async function browse(target,offset=0,append=false){const ticket=++pickerVersion,inputVersion=pathInputVersion;newFolder.update();use.disabled=true;more.disabled=true;message.textContent=t('Loading…');if(!append)rows.replaceChildren();
   try{const result=await api(`${endpoint(nodeId)}/folders?${new URLSearchParams({...target?{path:target}:{},offset:String(offset)})}`);if(ticket!==pickerVersion||!picker.open)return;current=result.path;parent=result.parent;up.disabled=!parent;location.textContent=current||t('Allowed folders');nextOffset=result.nextOffset||0;more.hidden=!result.hasMore;
    for(const item of result.entries||(result.folders||[]).map(f=>({...f,type:'folder',workspace:f.path}))){const row=el('div','native-picker-row'),pick=button('',()=>select(item),'native-picker-item');pick.dataset.path=item.path;pick.setAttribute('aria-label',t('Select {name}',{name:item.name}));const icon=el('span','native-picker-glyph');icon.setAttribute('aria-hidden','true');icon.innerHTML=item.type==='folder'?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 6h7l2 3h9v11H3Z"/></svg>':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h4M9 12h6m-6 4h6"/></svg>';const name=el('span','',item.name);name.translate=false;pick.append(icon,name);pick.title=item.path;row.append(pick);
     if(item.type==='folder'){pick.addEventListener('dblclick',()=>browse(item.path));const enter=button('›',()=>browse(item.path),'icon-button native-picker-enter');enter.setAttribute('aria-label',t('Open folder {name}',{name:item.name}));row.append(enter);}rows.append(row);
    }if(inputVersion===pathInputVersion)directPath.value=current||'';select(append&&chosen?chosen:current?{path:current,workspace:current,type:'folder'}:null);
    newFolder.update({nodeId,path:current,enabled:getData().workers?.find(w=>w.id===nodeId)?.capabilities?.directoryCreate===1});
   }catch(error){if(ticket===pickerVersion){chosen=null;message.textContent=t(error.message);use.disabled=true;}}finally{if(ticket===pickerVersion)more.disabled=false;}
  }
  actions.append(button('Cancel',()=>picker.close()),use);picker.append(heading,toolbar,newFolder.panel,pathRow,location,rows,more,selection,message,actions);
  const closeWithParent=()=>picker.close();dialog.addEventListener('close',closeWithParent);picker.addEventListener('close',()=>{pickerVersion++;dialog.removeEventListener('close',closeWithParent);},{once:true});picker.showModal();void browse(path||null);
 }
 function openForm(session=null,defaults={}){populate();dialog.replaceChildren();const heading=el('div','dialog-heading');heading.append(el('h2','',t(session?.canReopen?'Open unstarted session':session?'Continue native session':'New native session')),closeButton(()=>dialog.close()));dialog.append(heading);
  const form=el('form','native-session-form'),d=el('select'),r=el('select'),project=el('select'),folder=el('input'),all=el('input'),title=el('input');d.required=r.required=folder.required=title.required=true;title.type='text';title.maxLength=120;title.placeholder=t('Give this session a title');title.value=session?.title||'';title.readOnly=Boolean(session);folder.type='text';folder.value=session?.workspace||'';folder.placeholder=t('Select a working folder');all.type='checkbox';all.id='native-allow-all';all.checked=false;
  const field=(label,input,full=false)=>{const l=el('label',`native-field${full?' native-full':''}`,t(label));input.setAttribute('aria-label',t(label));l.append(input);form.append(l);return l;};
  options(d,(getData().workers||[]).map(w=>[w.id,`${w.name||w.id}${w.online?'':` · ${t('Offline')}`}`]));if(session?.nodeId)d.value=session.nodeId;else if(defaults.nodeId)d.value=defaults.nodeId;else if(workers()[0])d.value=workers()[0].id;
  const updateTools=()=>{options(r,(getData().workers?.find(w=>w.id===d.value)?.runtimes||[]).filter(x=>x.available&&x.supported!==false&&names[x.type]).map(x=>[x.type,names[x.type]]));};updateTools();if(session?.runtime)r.value=session.runtime;else if(defaults.runtime)r.value=defaults.runtime;else if(tool.value!=='all'&&[...r.options].some(o=>o.value===tool.value))r.value=tool.value;d.disabled=r.disabled=Boolean(session);if(session?.workspace)folder.readOnly=true;
  field('Session title',title,true);field('Device',d);field('Agent tool',r);
  // Projects bound on the chosen device; picking one keeps the session's files with the project in native-sessions/<title>.
  const slug=value=>{const name=String(value||'').trim().replace(/[\\/\0:*?"<>|]+/g,'-').replace(/\s+/g,' ').slice(0,80).replace(/^[-. ]+|[-. ]+$/g,'');return name&&name!=='.'&&name!=='..'?name:'session';};
  const boundProjects=()=>{const data=getData(),bound=new Map((data.workspaces||[]).filter(w=>w.nodeId===d.value&&w.localRoot).map(w=>[w.projectId,w.localRoot]));return (data.projects||[]).filter(p=>bound.has(p.id)).map(p=>({id:p.id,name:p.name,root:bound.get(p.id)}));};
  const updateProjects=()=>{const list=boundProjects();options(project,[['',t('No project (device folder)')],...list.map(p=>[p.id,p.name])]);if(!project.value&&defaults.projectId&&list.some(p=>p.id===defaults.projectId))project.value=defaults.projectId;else if(!project.value&&list.length===1)project.value=list[0].id;};
  const projectRootOf=()=>boundProjects().find(p=>p.id===project.value)?.root||null;
  const previewProjectFolder=()=>{const root=projectRootOf();if(!root)return;folder.value=`${root.replace(/\/+$/,'')}/native-sessions/${slug(title.value)}`;folder.dataset.auto='1';};
  if(!session){updateProjects();field('Project',project,true);project.disabled=!boundProjects().length;}
  const folderField=field('Working folder',folder,true),pathRow=el('div','native-workspace-row');
  const feedback=el('p','native-form-feedback native-full'),launch=el('div','native-launch-result native-full');feedback.setAttribute('role','status');
  const browseButton=button('Select file or folder',()=>openFilePicker({nodeId:d.value,path:folder.value,locked:session?.workspace||null,onUse:path=>{folder.value=path;delete folder.dataset.auto;folder.dispatchEvent(new Event('change',{bubbles:true}));}}));setActionIcon(browseButton,'folder');pathRow.append(folder,browseButton);folderField.append(pathRow);
  if(session?.workspace)form.append(el('p','workspace-note native-full',t('An existing session keeps its original working folder.')));
  const permissions=el('label','native-permissions native-full');permissions.append(all,el('span','',t('Allow all operations (bypass native permission prompts)')));form.append(permissions,el('p','workspace-note native-full',t('Allow all operations applies to the headless start and to iTerm; chatting on this page always bypasses permission prompts. A related group chat waits while this session owns its folder; closing the CLI returns it automatically.')));
  // A new (or unstarted) session opens on this page by default: the Worker starts the CLI headlessly with "Hi"; iTerm stays as the alternative.
  const pageOpen=!session||Boolean(session.canReopen);
  const submit=el('button','primary',t(pageOpen?'Open on this page':'Prepare iTerm launch')),viaTerminal=pageOpen?el('button','secondary',t('Prepare iTerm launch')):null,actions=el('div','native-session-actions native-full');submit.type='submit';actions.append(submit);if(viaTerminal){viaTerminal.type='submit';actions.append(viaTerminal);}form.append(feedback,actions,launch);dialog.append(form);
  let defaultFolderVersion=0;
  // 设备切换或用户手选之后，旧回复不能覆盖新的目录；续接会话始终保留原目录。
  async function fillDefaultFolder(){
   if(session)return;const ticket=++defaultFolderVersion,nodeId=d.value;
   if(!getData().workers?.find(w=>w.id===nodeId)?.online)return;
   feedback.textContent=t('Preparing default session folder…');
   try{const result=await api(`${endpoint(nodeId)}/default-folder`,{method:'POST',json:{}});if(ticket!==defaultFolderVersion||!dialog.open||!dialog.contains(form)||d.value!==nodeId||folder.value)return;folder.value=result.path;feedback.textContent='';}
   catch(error){if(ticket===defaultFolderVersion&&dialog.open&&dialog.contains(form)&&d.value===nodeId&&!folder.value)feedback.textContent=t(error.message);}
  }
  folder.addEventListener('input',()=>{defaultFolderVersion++;delete folder.dataset.auto;feedback.textContent='';});
  folder.addEventListener('change',()=>{defaultFolderVersion++;feedback.textContent='';});
  const chooseFolder=()=>{defaultFolderVersion++;launch.replaceChildren();if(projectRootOf()){previewProjectFolder();feedback.textContent='';}else{folder.value='';delete folder.dataset.auto;void fillDefaultFolder();}};
  d.addEventListener('change',()=>{updateTools();updateProjects();project.disabled=!boundProjects().length;chooseFolder();});
  project.addEventListener('change',chooseFolder);
  title.addEventListener('input',()=>{if(folder.dataset.auto==='1'&&projectRootOf())previewProjectFolder();});
  let operationId=null,lastInput='',prepared=null,opened=false;
  const releaseUnused=async()=>{if(!prepared||opened)return;const previous=prepared;prepared=null;operationId=null;lastInput='';await api(`/api/native-sessions/${encodeURIComponent(previous.nodeId)}/terminal`,{method:'POST',json:{action:'release',operationId:previous.operationId}});};
  const discard=()=>{launch.replaceChildren();submit.disabled=true;return releaseUnused().catch(error=>{feedback.textContent=t(error.message);}).finally(()=>{submit.disabled=false;});};
  for(const input of[d,r,folder,all,title])input.addEventListener('change',discard);
  dialog.addEventListener('close',()=>{void discard().then(()=>load({quiet:true}));},{once:true});
  form.addEventListener('submit',async e=>{e.preventDefault();if(!title.value.trim()){title.focus();feedback.textContent=t('Enter a session title.');return;}const onPage=pageOpen&&e.submitter!==viaTerminal;submit.disabled=true;if(viaTerminal)viaTerminal.disabled=true;for(const input of[d,r,folder,all,title,browseButton])input.disabled=true;feedback.textContent=t('Preparing…');launch.replaceChildren();
   // The project session folder is created only now, so an abandoned dialog leaves nothing behind.
   if(!session&&folder.dataset.auto==='1'&&projectRootOf()){try{const made=await api(`${endpoint(d.value)}/default-folder`,{method:'POST',json:{projectId:project.value,name:slug(title.value)}});folder.value=made.path;}catch(error){feedback.textContent=t(error.message);submit.disabled=false;if(viaTerminal)viaTerminal.disabled=false;for(const input of[d,r,folder,all,title,browseButton])input.disabled=false;return;}}
   const input={runtime:r.value,sessionId:session&&!session.canReopen?nativeId(session):null,...(session?.entryId?{entryId:session.entryId}:{}),title:title.value.trim(),workspace:folder.value.trim(),allowAll:all.checked,useLocalSshKey:true},signature=JSON.stringify([d.value,input]);if(signature!==lastInput){operationId=crypto.randomUUID();lastInput=signature;}
   try{const result=await api(`/api/native-sessions/${encodeURIComponent(d.value)}/terminal`,{method:'POST',json:{...input,operationId}});prepared={nodeId:d.value,operationId};opened=false;if(!dialog.open||!dialog.contains(form)){await releaseUnused();return;}
    if(onPage){feedback.textContent=t('Starting the session…');await api(`/api/native-sessions/${encodeURIComponent(d.value)}/terminal`,{method:'POST',json:{action:'start',operationId}});opened=true;const created={nodeId:d.value,runtime:r.value,entryId:result.entryId||result.catalogEntryId};if(all.checked)pageOpened.add(key(created));dialog.close();await load();const item=items.find(x=>key(x)===key(created));if(item)void read(item);return;}
    feedback.textContent=t('Ready. Open iTerm to start or resume the native CLI.');const a=el('a','primary',t('Open iTerm'));a.href=result.url;a.addEventListener('click',()=>{opened=true;});launch.append(a,button('Copy terminal command',async e=>{await copyText(e.currentTarget,result.command);opened=true;feedback.textContent=t('Copied');}));void load({quiet:true});}catch(error){if(error.folderPreparationReleased){operationId=null;lastInput='';}feedback.textContent=t(error.message);}finally{submit.disabled=false;if(viaTerminal)viaTerminal.disabled=false;d.disabled=r.disabled=Boolean(session);folder.disabled=all.disabled=title.disabled=browseButton.disabled=false;}
  });dialog.showModal();if(!session&&projectRootOf())previewProjectFolder();else void fillDefaultFolder();
 }
 /** Segmented buttons share one mode transition; selecting the active side does not reload history. */
 const switches=[...mode.querySelectorAll('button[data-mode]')];
 // 会话整体由导航隐藏；保留已显示的底部，避免返回时先露出没有底部的旧正文。
 function selectMode(value){if(!['groups','sessions'].includes(value)||value===modeValue)return;modeValue=value;try{sessionStorage.setItem(MODE_KEY,value);}catch{}for(const control of switches)control.setAttribute('aria-pressed',String(control.dataset.mode===value));document.body.dataset.navigationMode=value;if(active()){populate();takeover.resume();}else{version++;detailVersion++;loading=pendingRefresh=false;takeover.suspend();dialog.close();}onModeChange();if(active())void load();}
 for(const control of switches)control.setAttribute('aria-pressed',String(control.dataset.mode===modeValue));document.body.dataset.navigationMode=modeValue;
 for(const control of switches)control.addEventListener('click',()=>selectMode(control.dataset.mode));
 mode.addEventListener('keydown',event=>{const index=event.key==='ArrowLeft'||event.key==='Home'?0:event.key==='ArrowRight'||event.key==='End'?1:null;if(index===null)return;event.preventDefault();switches[index].focus();selectMode(switches[index].dataset.mode);});
 device.addEventListener('change',()=>load());tool.addEventListener('change',()=>load());
 const refresh=()=>{if(active()&&!document.hidden&&!dialog.open&&document.body.dataset.workspaceView!=='settings')void load({quiet:true});};
 window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
 // Only the visible Sessions page polls; returning from iTerm also refreshes immediately.
 setInterval(()=>{if(Date.now()-lastRefresh>=30000)refresh();},30000);
 list.hidden=filters.hidden=note.hidden=content.hidden=side.hidden=true;
 return {active,// undefined: no session selected; null: the selected session is in no project.
  currentProjectId:()=>selected?sessionProject(selected)?.id||null:undefined,openNew:(defaults={})=>openForm(null,defaults),sync(){const changed=populate(),visible=active();list.hidden=filters.hidden=note.hidden=side.hidden=gear.hidden=!visible;document.querySelector('#show-project-settings')?.toggleAttribute('hidden',visible);content.hidden=!visible||document.body.dataset.workspaceView==='settings';if(visible&&document.body.dataset.workspaceView!=='settings'){renderTitle();renderList();document.querySelector('#show-project-form').setAttribute('aria-label',t('New native session'));if(selected){renderSessionControls(selected);renderAgentDetails(selected);retryFailedReads(selected);}if(changed)refresh();takeover.recheck();}else document.querySelector('#show-project-form').setAttribute('aria-label',t('New project'));},refresh};
}
