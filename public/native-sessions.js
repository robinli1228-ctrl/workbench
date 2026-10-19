import {t as globalT,dateLocale,getLanguage} from './i18n.js';
import pageZh from './locales/native-takeover-zh.js';
import {simplifiedCliOutput} from './output-language.js';
import {agentIconEl,machineIconEl,workerKind,setActionIcon,closeIcon,UI_ICON,quotaForRole,roleNameQuota} from './role-icons.js';
import {createListOrder} from './list-order.js';
import {groupNativeSessions,readNativeSessionPages} from './native-session-groups.js';
import {createNativeHistoryTimeline} from './native-history-timeline.js';
import {createFolderControl} from './create-folder.js';
import {renderMarkdown} from './markdown.js';
import {linkMedia,mediaCard,mediaPathMatches,mediaKindFromName,openMediaViewer,formatBytes} from './media.js';
import {liveSceneRows} from './live-scene.js';
import {SEND_LABELS,uncertainSend,sendStateOf,sendLocked,lookupFailureState,sameSend} from './send-state.js';
import {stripAnsi} from './run-log-data.js';
import {classifyStep,activityBlock,createPreviewSheet,elapsedText,stepTitle,stepIcon,fileChips} from './native-transcript.js';

/** New takeover strings resolve from this page's own dictionary; every existing string keeps the global translation. */
const t=(text,params)=>{const own=getLanguage()==='zh'&&typeof text==='string'?pageZh[text]:undefined;return own===undefined?globalT(text,params):params?own.replace(/\{(\w+)\}/g,(m,k)=>params[k]??m):own;};
const names={codex:'Codex',claude:'Claude Code',grok:'Grok',agy:'Agy'};
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const button=(text,fn,cls='secondary')=>{const n=el('button',cls,t(text));n.type='button';n.addEventListener('click',fn);return n;};
const closeButton=fn=>{const n=button('',fn,'icon-button native-close');setActionIcon(n,'close','Close');n.dataset.close='';return n;};

/** The session view reads native history and prepares terminal links. Only after an explicit takeover does it submit turns, resuming the same native ID. */
export function createNativeSessionUI({api,getData,artifactRow=null,onModeChange,onPreview,onStateRefresh=async()=>{}}){
 const mode=document.querySelector('#navigation-mode'),list=el('nav','project-list native-session-list'),content=el('section','native-session-content panel'),side=el('section','native-session-sidebar');
 list.id='native-session-list';content.id='native-session-content';side.id='native-session-sidebar';
 document.querySelector('#project-list').after(list);document.querySelector('main.workspace').append(content);document.querySelector('#node-sidebar').append(side);
 /** The right side mirrors the group-chat inspector: one header, three panels and the same bottom tab bar and classes. */
 const SIDE_TABS=['session','outputs','resources'],SIDE_TITLES={session:'Session details',outputs:'Files',resources:'Resources'};
 const SIDE_ICONS={session:UI_ICON.terminal,outputs:UI_ICON.original,resources:UI_ICON.project};
 let sideTab='session';
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
 /** The chosen tab stays selected across sessions, like the group-chat inspector. */
 function selectSideTab(name){
  sideTab=name;for(const [tab,panel] of Object.entries(sidePanels))panel.hidden=tab!==name;
  sideTitle.textContent=t(SIDE_TITLES[name]);side.setAttribute('aria-label',t(SIDE_TITLES[name]));
  sideTabButtons.forEach((tab,i)=>{const on=SIDE_TABS[i]===name;tab.setAttribute('aria-selected',String(on));tab.tabIndex=on?0:-1;});
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
 function noteOutputs(session,text,at){
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
  for(const {path} of paths){const prior=items.get(path);if(prior&&outputRank(prior.at)>=outputRank(at))continue;items.set(path,{path,at:at||null});changed=true;}
  if(changed&&sideTab==='outputs'&&selected&&mediaContext(selected)?.key===context.key){clearTimeout(outputsTimer);outputsTimer=setTimeout(renderOutputs,100);}
 }
 /**
  * Project outputs come only from a trusted link: the group-chat role binding of a managed session, or exactly one
  * project whose role session on this device recorded this native ID. Standalone sessions are never guessed or scanned.
  */
 function sessionProject(item){
  const data=getData();if(!item)return null;
  if(item.roleBinding?.projectId)return data.projects?.find(p=>p.id===item.roleBinding.projectId)||null;
  const id=nativeId(item);if(!id)return null;
  const known=new Set((data.roleSessions||[]).filter(s=>!s.historyClearedAt&&s.runtime===item.runtime&&s.nativeSessionId===id&&s.nodeId===item.nodeId).map(s=>s.projectId));
  return known.size===1?data.projects?.find(p=>p.id===[...known][0])||null:null;
 }
 const projectOutputs=new Map();
 async function loadProjectOutputs(projectId,force=false){
  const cached=projectOutputs.get(projectId);if(cached?.loading||!force&&cached?.at&&Date.now()-cached.at<30000)return;
  projectOutputs.set(projectId,{...cached,loading:true});if(sideTab==='outputs')renderOutputs();
  try{const result=await api(`/api/projects/${encodeURIComponent(projectId)}/artifacts`);projectOutputs.set(projectId,{items:result.items||[],partial:Boolean(result.partial),at:Date.now()});}
  catch(error){projectOutputs.set(projectId,{items:[],error:error.message,at:Date.now()});}
  if(sideTab==='outputs')renderOutputs();
 }
 function projectOutputsCard(){
  const section=el('section','native-side-card native-project-outputs'),project=sessionProject(selected),head=el('div','native-card-head');head.append(el('h3','',t('Project outputs')));section.append(head);
  if(!project||!artifactRow){section.append(el('p','native-side-hint',t('This session is not linked to a project, so only the files mentioned in its loaded replies are listed above.')));return section;}
  const cached=projectOutputs.get(project.id),refresh=button('Refresh',()=>void loadProjectOutputs(project.id,true),'secondary native-card-action');refresh.disabled=Boolean(cached?.loading);head.append(refresh);
  const source=el('p','native-side-hint',t('From project “{project}”, the same list as its group chat Recent Outputs; files open through the project’s file access.',{project:project.name}));source.translate=false;section.append(source);
  if(!cached?.at)section.append(el('p','native-side-hint',t('Reading project outputs…')));
  else if(cached.error)section.append(el('p','native-side-hint',t('Project outputs unavailable: {message}',{message:cached.error})));
  else if(!cached.items.length)section.append(el('p','native-side-hint',t('No recognizable project outputs yet.')));
  else{const list=el('div','native-project-output-list');for(const file of cached.items.slice(0,30))list.append(artifactRow(file));section.append(list);if(cached.partial||cached.items.length>30)section.append(el('p','native-side-hint',t('Showing part of the project outputs; the group chat lists the rest.')));}
  if(!cached?.at||Date.now()-cached.at>=30000)void loadProjectOutputs(project.id);
  return section;
 }
 /** Files tab: what the CLI touched in page turns, files named in replies, the working folder itself, and project outputs. */
 const folderState=new Map();
 const fileName=path=>String(path||'').replace(/[\\/]+$/,'').split(/[\\/]/).pop()||String(path||'');
 const fileDir=path=>{const name=fileName(path);return String(path||'').slice(0,Math.max(0,String(path||'').length-name.length));};
 async function openFile(session,path){
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
  const id=key(session),st=folderState.get(id);if(!st||st.path!==path)return;st.loading=true;st.error=null;if(sideTab==='outputs')renderOutputs();
  try{const result=await api(`${endpoint(session.nodeId)}/folders?${new URLSearchParams({path,offset:String(offset)})}`);if(folderState.get(id)!==st||st.path!==path)return;
   const entries=(result.entries||[]).filter(e=>e.type==='folder'||e.type==='file');st.entries=offset?[...(st.entries||[]),...entries]:entries;st.hasMore=Boolean(result.hasMore);st.nextOffset=result.nextOffset||0;st.parent=result.parent||null;}
  catch(error){st.error=error.message;}
  finally{st.loading=false;if(sideTab==='outputs'&&selected&&key(selected)===id)renderOutputs();}
 }
 function folderCard(session){
  const card=el('section','native-side-card native-folder-card'),root=session.workspace;card.append(el('h3','',t('Working folder')));
  if(!root){card.append(el('p','native-side-hint',t('Choose a folder when opening')));return card;}
  const id=key(session);let st=folderState.get(id);if(!st||st.root!==root){st={root,path:root,entries:null,loading:false,error:null,hasMore:false,nextOffset:0};folderState.set(id,st);}
  const crumbs=el('div','native-folder-crumbs'),rel=st.path.startsWith(root)?st.path.slice(root.length).split('/').filter(Boolean):[];
  const crumb=(label,path,last)=>{const b=el('button',`native-folder-crumb${last?' is-current':''}`,label);b.type='button';b.title=path;b.translate=false;b.disabled=last;b.addEventListener('click',()=>{st.path=path;st.entries=null;renderOutputs();});return b;};
  crumbs.append(crumb(fileName(root)||root,root,!rel.length));let acc=root;rel.forEach((part,i)=>{acc=`${acc}/${part}`;crumbs.append(el('span','native-folder-sep','/'),crumb(part,acc,i===rel.length-1));});card.append(crumbs);
  if(!st.entries&&!st.loading&&!st.error)void loadFolder(session,st.path);
  if(st.error)card.append(el('p','native-side-hint',t(st.error)));
  const list=el('div','native-file-list');
  for(const entry of st.entries||[]){
   if(entry.type==='folder'){const row=el('button','native-file-row is-folder');row.type='button';row.title=entry.path;row.translate=false;row.append(stepIcon('other'));const text=el('span','native-file-text');text.append(el('span','native-file-name',`${entry.name}/`));row.append(text);row.addEventListener('click',()=>{st.path=entry.path;st.entries=null;renderOutputs();});list.append(row);}
   else list.append(fileRow(session,entry.path,null));
  }
  if(st.entries&&!st.entries.length)list.append(el('p','native-side-hint',t('Empty folder')));
  card.append(list);
  if(st.loading)card.append(el('p','native-side-hint',t('Loading…')));
  else if(st.hasMore)card.append(button('Load more',()=>void loadFolder(session,st.path,st.nextOffset),'secondary native-card-action'));
  return card;
 }
 function renderOutputs(){
  const panel=sidePanels.outputs;panel.replaceChildren();
  if(!selected){panel.append(el('p','native-side-hint',t('Select a native session to view its details.')));return;}
  const context=mediaContext(selected);
  // 1. Files the CLI read, edited or created in page turns of this session (latest state per path).
  const touched=takeover.files(),changed=el('section','native-side-card');changed.append(el('h3','',t('Touched in this session')));
  if(!touched.length)changed.append(el('p','native-side-hint',t('Files the CLI reads, edits or creates in page turns appear here.')));
  else{const list=el('div','native-file-list');for(const {path,step} of touched.slice(0,40))list.append(fileRow(selected,path,step,step.kind==='edit'&&(step.added||step.removed)?`+${step.added||0} −${step.removed||0}`:''));changed.append(list);}
  // 2. Media paths named in loaded replies.
  const mentioned=el('section','native-side-card');mentioned.append(el('h3','',t('Named in replies')));
  const items=context&&outputs.has(context.key)?[...outputs.get(context.key).values()].sort((a,b)=>outputRank(b.at)-outputRank(a.at)):[];
  if(!items.length)mentioned.append(el('p','native-side-hint',t('No files have been mentioned in the loaded replies yet.')));
  else{const list=el('div','native-output-list');items.slice(0,50).forEach((item,index)=>list.append(mediaCard(item.path,context,{describe:index<12})));mentioned.append(list);}
  panel.append(changed,folderCard(selected),mentioned,projectOutputsCard());
 }
 resetSide();
 const filters=el('div','native-session-filters'),device=el('select'),tool=el('select');device.setAttribute('aria-label',t('Session device'));tool.setAttribute('aria-label',t('Agent tool'));filters.append(device,tool);list.before(filters);
 const note=el('p','workspace-note');list.before(note);note.classList.add('native-session-note');
 let selected=null,items=[],version=0,detailVersion=0,lastCatalog='',loading=false,pendingRefresh=false,modeValue='groups',lastRefresh=0,listSignature='',detailSignature='';
 const active=()=>modeValue==='sessions';
 const endpoint=nodeId=>`/api/native-sessions/${encodeURIComponent(nodeId)}`;
 const key=item=>item?`${item.nodeId}/${item.runtime}/${item.entryId||item.id}`:'';
 const listOrder=createListOrder({container:list,scope:'native-sessions',onEnd:()=>{listSignature='';renderList();},onError:message=>{note.textContent=message;}});
 const nativeId=item=>item.entryId?item.sessionId:item.sessionId||item.id;
 const workerName=id=>getData().workers?.find(w=>w.id===id)?.name||id;
 const time=value=>{const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleString(dateLocale(),{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});};
 let returningClaim=null,controlFeedback=null;
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
  const panel=sidePanels.session.querySelector('[data-native-controls]');if(!panel)return;
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
  const signature=JSON.stringify([key(item),state,detail,claim?.id,claim?.status,claim?.lastCheckedAt,claim?.processError,returningClaim,controlFeedback,takeover.isReleasing(item),takeover.releaseDisabled(item),canTakeover,worker?.capabilities?.terminalControl,takeover.feedback(item)]);
  const LABEL={page:'Chatting on this page',ending:'Ending page takeover…',starting:'Starting on this page…',terminal:'Running in iTerm',prepared:'Waiting for iTerm to open',returning:'Returning to Workbench…',stopping:'Stopping the terminal CLI…',busy:'Occupied',offline:'Device offline',unstarted:'Not started',nohistory:'No history yet',idle:'Not connected'};
  sideBadge.hidden=false;sideBadge.className=`native-side-badge is-${state}`;sideBadge.textContent=t(LABEL[state]);
  if(panel.dataset.signature===signature)return;panel.dataset.signature=signature;panel.replaceChildren(el('h3','',t('Connection')));
  const head=el('div','native-connect-head');head.append(el('span',`native-connect-dot is-${state}`),el('strong','',t(LABEL[state])));panel.append(head);
  const hint={page:'Messages sent below continue this exact native session on its device.',ending:'Waiting for the resident CLI to exit.',starting:'The CLI is answering its first message; chat opens here in a moment.',terminal:'The CLI is open in iTerm. Return it to chat here.',prepared:'Open the prepared iTerm link, or return it to chat here.',returning:'Waiting for the CLI process to exit.',stopping:'Waiting for the CLI process to exit.',idle:'Take over to chat here, or open the session in iTerm.',unstarted:'Open it on this page or in iTerm to start.',nohistory:'This session has no readable history yet.',offline:'Reconnect the device to continue this session.'}[state];
  if(hint)panel.append(el('p','native-side-hint',t(hint)));
  if(detail)panel.append(el('p','native-side-hint',t(detail)));
  if(state==='page'&&!IMAGE_CLIS.has(item.runtime))panel.append(el('p','native-side-hint',t('{tool} cannot receive images here; files are passed as paths',{tool:names[item.runtime]})));
  if(claim?.processError)panel.append(el('p','native-side-hint',t(claim.processError)));
  const project=data.projects?.find(p=>p.id===(claim?.projectId||other?.projectId))||((claim||other)&&owners.size===1?data.projects?.find(p=>owners.has(p.id)):null);if(project)panel.append(el('p','native-side-hint',t('Group chat paused on this device: {project}',{project:project.name})));
  const actions=el('div','native-session-actions');
  if(state==='page'||state==='ending'){
   const pending=state==='ending',release=button(pending?'Ending takeover…':'End takeover',()=>void takeover.release(item),'secondary');release.disabled=pending||takeover.releaseDisabled(item);
   const toTerminal=button('Move to iTerm',async()=>{await takeover.release(item);openForm(item);},'secondary');toTerminal.disabled=release.disabled;
   actions.append(release,toTerminal);const feedback=takeover.feedback(item);if(feedback)panel.append(el('p','global-error',feedback));
  }else if(claim&&['terminal','prepared','returning','stopping','starting'].includes(state)){
   const perform=async action=>{
    if(returningClaim)return;
    if(action==='stop'&&!confirm(t('Stop this terminal CLI and return control to Workbench? Unfinished terminal work will be interrupted.')))return;
    returningClaim=claim.id;controlFeedback=null;renderSessionControls(selected);
    try{
     const path=claim.kind==='native'?`${endpoint(claim.nodeId)}/terminal`:claim.kind==='new'?`/api/projects/${encodeURIComponent(claim.projectId)}/roles/${encodeURIComponent(claim.roleId)}/terminal`:`/api/runs/${encodeURIComponent(claim.runId)}/terminal`;
     const result=await api(path,{method:'POST',json:claim.kind==='native'?{action,operationId:claim.id}:{action,id:claim.id}});
     if(result?.released===true)takeover.returned(item);
     await onStateRefresh();void load({quiet:true});
    }catch(error){controlFeedback={key:key(item),text:error.message};}
    finally{returningClaim=null;renderSessionControls(selected);}
   };
   const release=button(state==='starting'?'Cancel start':'Return to platform',()=>void perform('release')),stop=button('Stop CLI and return',()=>void perform('stop'),'danger');
   release.disabled=Boolean(returningClaim)||!worker?.online;stop.disabled=release.disabled||worker?.capabilities?.terminalControl!==1||claim.processState==='unknown';
   if(worker?.capabilities?.terminalControl!==1)stop.title=t('Upgrade this Worker to check or stop terminal processes.');
   actions.append(release);if(state!=='starting')actions.append(stop);
  }else if(state==='idle'){
   const take=button('Take over on this page',()=>takeover.enable(item),'primary'),terminal=button('Open in iTerm',()=>openForm(item),'secondary');take.disabled=terminal.disabled=!canTakeover;actions.append(take,terminal);
  }else if(state==='unstarted'){const open=button('Open on this page',()=>openForm(item),'primary');open.disabled=!canTakeover;actions.append(open);}
  if(actions.childElementCount)panel.append(actions);
  if(online&&!canTakeover&&['idle','unstarted'].includes(state))panel.append(el('p','native-side-hint',t('Upgrade this Worker to safely take over native sessions')));
  if(controlFeedback?.key===key(item))panel.append(el('p','global-error',t(controlFeedback.text)));
 }
 function options(select,values){const old=select.value;select.replaceChildren(...values.map(([value,label])=>{const o=el('option','',label);o.value=value;return o;}));if(values.some(([v])=>v===old))select.value=old;}
 // First visit shows dialog-created sessions; options() preserves any explicit choice on later refreshes.
 function populate(){const signature=JSON.stringify((getData().workers||[]).map(w=>[w.id,w.name,w.online,w.nodeKind,w.runtimes?.map(r=>[r.type,r.available,r.supported])]));if(signature===lastCatalog)return false;lastCatalog=signature;options(device,[['created',t('Created sessions')],['all',t('All sessions')],['group',t('Group chats')],['local',t('Local machine')],['cloud',t('Servers')],['other',t('Other devices')]]);options(tool,[['all',t('All Agents')],...Object.entries(names)]);return true;}
 function workers(){return(getData().workers||[]).filter(w=>['all','created','group'].includes(device.value)||(device.value==='other'?!['local','cloud'].includes(w.nodeKind):w.nodeKind===device.value));}
 /** Keep the selected name in the shared header, including after state refreshes and selection resets. */
 function renderTitle(){if(!active()||document.body.dataset.workspaceView==='settings')return;const title=document.querySelector('#workspace-title');title.translate=!selected;title.textContent=selected?displayTitle(selected):t('Native sessions');}
 function resetDetail(){detailVersion++;selected=null;renderTitle();detailSignature='';timeline.clear();takeover.detach();content.replaceChildren(el('div','native-empty',t('Select a native session to view its details.')));resetSide();}
 function resetSide(){
  delete side.dataset.sessionKey;sideBadge.hidden=true;outputs.clear();gitKey=null;renaming=null;
  sidePanels.session.replaceChildren(el('p','native-side-hint',t('Read-only preview. Take over at the bottom to continue here, or open iTerm.')));
  sidePanels.resources.replaceChildren(el('p','native-side-hint',t('Select a native session to view its details.')));
  selectSideTab(sideTab);
 }
 /** Reuse role-card device identities; cloud numbering follows the full roster, not the filtered session list. */
 function renderList(){
  if(listOrder.active())return;
  const activity=getData().sidebarExecutions||[];
  const isRunning=item=>Boolean(nativeId(item))&&activity.some(run=>run.nodeId===item.nodeId&&run.runtime===item.runtime&&run.sessionId===nativeId(item));
  const roster=getData().workers||[],ordered=listOrder.ordered(groupNativeSessions(items),group=>key(group.latest)),signature=JSON.stringify([key(selected),ordered,activity,roster.map(w=>[w.id,w.name,w.platform,w.nodeKind])]);
  if(signature===listSignature)return;listSignature=signature;
  const byId=new Map(roster.map(w=>[w.id,w])),cloudNumbers=new Map(roster.filter(w=>workerKind(w)==='cloud').map((w,index)=>[w.id,index+1]));
  const scroll=list.scrollTop;list.replaceChildren();
  const row=(item,latest)=>{
   const running=isRunning(item);
   const b=el('button',`project-item${key(selected)===key(item)?' active':''}${running?' is-running':''}`);b.type='button';b.dataset.orderId=key(item);b.title=`${displayTitle(item)}\n${workerName(item.nodeId)}${running?` · ${t('In progress')}`:''}`;
   b.setAttribute('aria-label',`${displayTitle(item)}${running?` · ${t('In progress')}`:''}`);
   const copy=el('span','project-item-copy'),heading=el('span','native-session-title'),title=el('strong','',displayTitle(item));title.translate=false;heading.append(title);
   const worker=byId.get(item.nodeId);
   if(worker){const deviceIcon=machineIconEl(worker,cloudNumbers.get(item.nodeId));deviceIcon.classList.add('native-session-device');heading.append(deviceIcon);}
   copy.append(heading,el('small','',`${names[item.runtime]} · ${time(item.createdAt||item.modifiedAt)}`));b.append(agentIconEl(item.runtime),copy);b.addEventListener('click',()=>read(item));if(!latest)delete b.dataset.orderId;return b;
  };
  for(const group of ordered){
   const entry=row(group.latest,true);
   if(group.history.some(item=>key(item)===key(selected)))entry.classList.add('active');
   if(group.history.some(isRunning)){entry.classList.add('is-running');entry.title+=` · ${t('An older session is running')}`;}
   if(entry.classList.contains('active'))entry.setAttribute('aria-current','true');
   list.append(entry);
  }
  list.scrollTop=scroll;
 }
 /** Fetch at most two device catalogues at a time; one unavailable device must not hide the others. */
 async function load({quiet=false}={}){if(!active())return;if(quiet&&loading){pendingRefresh=true;return;}pendingRefresh=false;const ticket=++version;loading=true;lastRefresh=Date.now();if(!quiet){items=[];resetDetail();renderList();note.textContent=t('Loading native sessions…');}
  // Both device filters and All include registered independent entries plus managed role history.
  const scopes=['created','group'].includes(device.value)?[device.value]:['all','group'];
  const jobs=workers().flatMap(w=>(tool.value==='all'?Object.keys(names):[tool.value]).filter(runtime=>device.value==='created'||w.runtimes?.some(r=>r.type===runtime&&r.available&&r.supported!==false)).flatMap(runtime=>scopes.map(scope=>({nodeId:w.id,runtime,scope})))),results=[],errors=[],failedJobs=new Set();let partial=false,index=0;
  // Publish complete catalogue snapshots as they arrive; a slow peer cannot block selecting already-read history.
  const owned=item=>['dialog','managed','takeover'].includes(item.origin);
  const previous=quiet?items.filter(owned):[],ordered=values=>[...new Map(values.filter(owned).map(item=>[key(item),item])).values()].sort((a,b)=>String(b.modifiedAt||b.createdAt||'').localeCompare(String(a.modifiedAt||a.createdAt||''))||key(a).localeCompare(key(b)));
  const updateLineage=()=>{if(!selected)return;const group=groupNativeSessions(items).find(g=>[g.latest,...g.history].some(row=>key(row)===key(selected)));if(group){const chain=[group.latest,...group.history];timeline.setOlder(selected,chain.slice(chain.findIndex(row=>key(row)===key(selected))+1));}};
  await Promise.all(Array.from({length:Math.min(2,jobs.length)},async()=>{while(index<jobs.length&&ticket===version&&active()){const job=jobs[index++];try{const result=await readNativeSessionPages((offset,revision)=>api(`${endpoint(job.nodeId)}?${new URLSearchParams({runtime:job.runtime,scope:job.scope,offset:String(offset),revision})}`),()=>ticket===version&&active());if(ticket!==version||!active())return;results.push(...result.items.map(item=>({...item,nodeId:job.nodeId})));partial||=result.partial;items=ordered([...previous,...results]);updateLineage();renderList();}catch(e){failedJobs.add(`${job.nodeId}/${job.runtime}/${job.scope}`);errors.push(`${workerName(job.nodeId)}: ${t(e.message)}`);}}}));
  if(ticket!==version||!active())return;loading=false;
  if(quiet)results.push(...items.filter(item=>owned(item)&&failedJobs.has(`${item.nodeId}/${item.runtime}/${scopes.length>1?(item.origin==='managed'?'group':'all'):scopes[0]}`)&&!results.some(r=>key(r)===key(item))));
  items=ordered(results);
  note.textContent=errors.length?[t('Some devices could not be read.'),...new Set(errors)].join(' '):t(partial?'Showing recent sessions. Updates automatically.':items.length?'':'No sessions in this filter. Create one using the top-right button.');
  if(selected){const next=items.find(item=>key(item)===key(selected));if(next){selected={...selected,...next};if(quiet&&!dialog.open)void read(selected,{quiet:true});}else resetDetail();}renderList();
  // A mutation/focus refresh arriving during a read must run after that older snapshot settles.
  if(pendingRefresh)void load({quiet:true});
 }
 /** History scrolls above a persistent footer, so quiet refreshes never discard a takeover draft. */
 const scroll=el('div','native-session-scroll');
 const readPage=(item,cursor,snapshot)=>api(`${endpoint(item.nodeId)}?${new URLSearchParams({runtime:item.runtime,sessionId:nativeId(item),historyPage:'1',...(cursor?{cursor}:{}),...(snapshot?{snapshot}:{})})}`);
 const timeline=createNativeHistoryTimeline({scroll,readPage,t,onHistoryChange:()=>takeover.renderFeed(),onLatest:()=>{if(selected)void read(selected);},label:item=>`${time(item.createdAt||item.modifiedAt)} · ${names[item.runtime]} · ${workerName(item.nodeId)} · ${(nativeId(item)||'').slice(0,8)}`,renderMessage(m,item){const text=m.role==='user'?cleanUserText(m.text):m.text;
   // Injected context leaves nothing to show; a slash command shows as one quiet system line.
   if(m.role==='user'&&!text){const command=commandOf(m.text);if(!command)return document.createComment('injected');const row=el('div','nt-system native-chat-row');row.dataset.role='system';row.dataset.text=command.replace(/^\//,'').trim();row.append(el('span','nt-system-mark','\u2318'),el('code','',command));return row;}
   const row=chatRow(m.role,text,item.runtime,m.timestamp,null,'completed',item);row.dataset.role=m.role;if(m.role==='user')row.dataset.text=text.trim();return row;}});
 async function read(item,{quiet=false}={}){const ticket=++detailVersion;selected=item;renderTitle();renderList();if(!quiet){onPreview?.();preview.close();takeover.detach();const group=groupNativeSessions(items).find(g=>[g.latest,...g.history].some(row=>key(row)===key(item))),chain=group?[group.latest,...group.history]:[item];timeline.reset(item,chain.slice(chain.findIndex(row=>key(row)===key(item))+1));scroll.replaceChildren(el('p','workspace-note',t('Loading…')));content.replaceChildren(scroll);detailSignature='';}
  try{const id=nativeId(item),readable=id&&item.hasHistory!==false,value=readable?{...item,...await readPage(item,null,quiet?item.historySnapshot:null),id:item.id,entryId:item.entryId,nodeId:item.nodeId,sessionId:id,title:item.title}:item;if(ticket!==detailVersion||!active()||key(selected)!==key(item))return;selected=value;timeline.readSucceeded();const signature=JSON.stringify(value);if(quiet&&signature===detailSignature)return;detailSignature=signature;const top=scroll.scrollTop,atBottom=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<40;
   const history=timeline.update({...value,...(!value.messages?.length&&!value.notice?{notice:value.canReopen?'This session has not started. Open it to begin chatting.':!readable?'Native session ID has not been linked yet. Existing history is unchanged.':'No text preview is available for this session.'}:{})});
   const historyAt=Date.now();if(!scroll.contains(timeline.root))scroll.replaceChildren(timeline.root,takeover.feed);if(!content.contains(scroll))content.replaceChildren(scroll);
   takeover.attach(value,{readable,historyAt,history});
   renderSide(value,id,readable);
   if(quiet&&!atBottom)scroll.scrollTop=top;else scroll.scrollTop=scroll.scrollHeight;
  }catch(e){if(ticket===detailVersion){if(quiet)timeline.showError(e);else{timeline.update({messages:[]});timeline.showError(e);scroll.replaceChildren(timeline.root);content.replaceChildren(scroll);renderSide(item,nativeId(item),false);}}}
 }
 /** Same row/bubble structure as the group chat, so both views share one visual language. */
 /** Paths in native replies resolve only inside that registered session's working directory, on its own device. */
 const mediaContext=session=>{const sessionId=session&&(nativeId(session)||session.sessionId);if(!session?.nodeId||!sessionId)return null;
  return {key:`native:${session.nodeId}:${session.runtime}:${sessionId}`,describe:path=>api(`${endpoint(session.nodeId)}/media?${new URLSearchParams({runtime:session.runtime,sessionId,path})}`)};};
 /** Transcript rows: assistant replies are plain prose with a small byline; prompts are a quiet block with a prompt mark. No card states or footers. */
 function chatRow(role,text,runtime,at,extra,state='completed',session){const agent=role!=='user',row=el('article',`nt-row ${agent?'nt-agent':'nt-user'} native-chat-row${state==='error'?' is-error':''}`);
  const body=simplifiedCliOutput(text||''),main=el('div','nt-body');
  if(agent){const by=el('div','nt-byline');const avatar=el('span','nt-avatar');avatar.append(agentIconEl(runtime));const name=el('span','nt-name',names[runtime]||t('Assistant'));name.translate=false;by.append(avatar,name);if(at){const stamp=el('time','',time(at));stamp.dateTime=at;by.append(stamp);}
   const copy=el('button','nt-copy');copy.type='button';copy.setAttribute('aria-label',t('Copy'));setActionIcon(copy,'copy',t('Copy'));copy.addEventListener('click',()=>void navigator.clipboard?.writeText(body).catch(()=>{}));by.append(copy);row.append(by);
   if(body){const md=renderMarkdown(body);md.classList?.add('markdown-body');linkMedia(md,mediaContext(session));main.append(md);if(session)noteOutputs(session,body,at);}}
  else{const mark=el('span','nt-prompt-mark','\u276f');mark.setAttribute('aria-hidden','true');main.append(mark,el('div','nt-prompt-text',body));if(at){const stamp=el('time','nt-prompt-time',time(at));stamp.dateTime=at;main.append(stamp);}}
  if(extra)main.append(extra);row.append(main);return row;}
 let agentDetailsSignature='';
 /** Reuse reported CLI quota and this session's recorded settings; refreshing the card never probes a model. */
 function renderAgentDetails(value){
  if(side.dataset.sessionKey!==key(value))return;
  const worker=getData().workers?.find(w=>w.id===value.nodeId),runtime=worker?.runtimes?.find(r=>r.type===value.runtime),configuration=value.sessionConfiguration||{};
  const quota=value.runtime==='agy'&&!configuration.model?null:quotaForRole(runtime,worker,configuration.model||'');
  const signature=JSON.stringify([key(value),configuration,quota,runtime?.quotaStatus,runtime?.quotaStale,runtime?.checkedAt,worker?.online]),prior=side.querySelector('[data-native-agent-details]');
  if(prior&&signature===agentDetailsSignature)return;agentDetailsSignature=signature;
  const section=el('section','native-side-card');section.dataset.nativeAgentDetails='';section.append(el('h3','',t('Quota')));
  const list=el('dl','native-session-meta'),field=(label,content)=>{const data=el('dd','');data.append(content);list.append(el('dt','',t(label)),data);};
  for(const [label,key]of [['5-hour quota remaining','fiveHour'],['Weekly quota remaining','weekly']]){
   const bucket=quota?.[key],value=bucket?.remainingPercent??bucket?.usedPercent,known=value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value));
   field(label,known?roleNameQuota({[key]:bucket}):el('span','',t('Unknown')));
  }
  section.append(list,el('p','native-side-hint',t('Quota is shared by this CLI account on this device.')));
  if(!worker?.online||runtime?.quotaStale||runtime?.quotaStatus!=='ok')section.append(el('p','native-side-hint',t(!worker?.online?'Device offline; quota is the last recorded value.':'Latest quota is unavailable; showing recorded values when present.')));
  if(runtime?.checkedAt&&Number.isFinite(Date.parse(runtime.checkedAt)))section.append(el('p','native-side-hint',t('Last checked: {time}',{time:time(runtime.checkedAt)})));
  if(prior)prior.replaceWith(section);else sidePanels.resources.append(section);
 }
 /** Read-only Git facts of the session's registered working folder, from its own device; cached per session. */
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
  const prior=sidePanels.session.querySelector('[data-native-git]');if(!prior||side.dataset.sessionKey!==key(value))return;
  const cached=gitCache.get(key(value)),section=el('section','native-side-card native-git-card');section.dataset.nativeGit='';
  const head=el('div','native-card-head'),refresh=button('Refresh',()=>void loadGit(value,true),'secondary native-card-action');refresh.disabled=!cached||Boolean(cached.loading);
  head.append(el('h3','',t('Repository (Git)')),refresh);section.append(head);
  if(!cached||cached.loading)section.append(el('p','native-side-hint',t('Reading Git status…')));
  else{
   const state=cached.state;
   // A working folder path alone is never shown as Git state: without a repository answer the card says why.
   if(!state.available||!state.git){section.append(el('p','native-side-hint',t(GIT_REASONS[state.reason]||'Git status is unknown.')));if(state.detail)section.append(el('p','native-side-hint native-git-detail',state.detail));}
   else{
    const c=state.changes||{},parts=[['staged','{count} staged'],['modified','{count} modified'],['untracked','{count} untracked'],['conflicted','{count} conflicted']].filter(([k])=>c[k]>0).map(([k,label])=>t(label,{count:c[k]}));
    const changes=c.unknown?t('Unknown ({reason})',{reason:c.reason||'git'}):c.total===0?t('Clean'):parts.join(' · ')+(c.truncated?` · ${t('partial count')}`:'');
    section.append(metaList([
     ['Git root',state.root,state.root],
     ['Branch',state.branch||t('Detached HEAD')],
     ['Commit',state.commit?`${state.commit.slice(0,12)}${state.subject?` · ${state.subject}`:''}`:t('No commits yet'),state.commit||null],
     ['Upstream',state.upstream?`${state.upstream} · ${t('{ahead} ahead, {behind} behind',{ahead:state.ahead??'?',behind:state.behind??'?'})}`:t('No upstream configured')],
     ['Changes',changes]]));
    section.append(el('p','native-side-hint',t('Read on the device without fetching; compared with local refs only.')));
   }
   section.append(el('p','native-side-hint',t('Checked at: {time}',{time:time(cached.at)})));
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
 function renderNameCard(value){
  const panel=sidePanels.session,prior=panel.querySelector('[data-native-name]');
  if(renaming&&renaming.key!==key(value)&&!renaming.saving)renaming=null;
  const section=el('section','native-side-card native-session-name');section.dataset.nativeName='';section.append(el('h3','',t('Session name')));
  const blocked=renameBlock(value);
  if(renaming?.key===key(value)){
   const form=el('form','native-rename-form'),input=el('input');input.type='text';input.maxLength=120;input.value=renaming.draft;input.setAttribute('aria-label',t('Session name'));input.disabled=renaming.saving;
   input.addEventListener('input',()=>{if(renaming)renaming.draft=input.value;});
   input.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();cancelRename(value);}});
   const save=el('button','primary',t(renaming.saving?'Saving…':'Save'));save.type='submit';save.disabled=renaming.saving;
   const cancel=button('Cancel',()=>cancelRename(value));cancel.disabled=renaming.saving;
   const actions=el('div','native-session-actions');actions.append(save,cancel);form.append(input,actions);
   if(renaming.error)form.append(el('p','global-error',renaming.error));
   form.addEventListener('submit',event=>{event.preventDefault();void saveRename(value);});
   section.append(form);if(!renaming.saving)queueMicrotask(()=>{if(input.isConnected&&document.activeElement!==input)input.focus();});
  }else{
   const line=el('div','native-card-head'),name=el('span','native-meta-value native-session-title',value.title||t('Untitled session'));name.translate=false;line.append(name);
   if(!blocked)line.append(button('Rename',()=>{renaming={key:key(value),draft:value.title||'',saving:false,error:null};renderNameCard(value);},'secondary native-card-action'));
   section.append(line);if(blocked)section.append(el('p','native-side-hint',t(blocked)));
  }
  if(prior)prior.replaceWith(section);
  else{const anchor=panel.querySelector('[data-native-controls]');if(anchor)anchor.after(section);else panel.append(section);}
 }
 function cancelRename(value){renaming=null;renderNameCard(value);}
 async function saveRename(value){
  const edit=renaming;if(!edit||edit.key!==key(value)||edit.saving)return;
  const title=edit.draft.trim();
  if(!title||title.length>120){edit.error=t('Session title is required and must be at most 120 characters');renderNameCard(value);return;}
  if(title===(value.title||'')){cancelRename(value);return;}
  edit.saving=true;edit.error=null;renderNameCard(value);
  try{
   const updated=await api(`${endpoint(value.nodeId)}/title`,{method:'POST',json:{runtime:value.runtime,entryId:value.entryId,sessionId:value.sessionId||null,title}});
   // The response belongs to this edit, not whichever session or draft the user has since opened.
   if(renaming===edit)renaming=null;
   for(const item of items)if(key(item)===key(value))item.title=updated.title;
   if(selected&&key(selected)===key(value))selected={...selected,title:updated.title};
   renderTitle();renderList();if(selected&&key(selected)===edit.key)renderNameCard(selected);
   void load({quiet:true});
  }catch(error){if(renaming===edit){edit.saving=false;edit.error=error.message;if(selected&&key(selected)===edit.key)renderNameCard(selected);}}
 }
 /** Label/value rows with optional copy buttons, shared by the session, repository and runtime cards. */
 function metaList(rows){const list=el('dl','native-session-meta');for(const[label,text,copy]of rows){const term=el('dt','',t(label)),data=el('dd','');const valueText=el('span','native-meta-value',text);valueText.translate=false;data.append(valueText);if(copy){const b=button('',async()=>{try{await navigator.clipboard.writeText(copy);b.classList.add('is-copied');b.title=t('Copied');setTimeout(()=>{b.classList.remove('is-copied');b.title=t('Copy');},1500);}catch{}},'icon-button native-copy');b.title=t('Copy');b.setAttribute('aria-label',t('Copy {label}',{label:t(label)}));b.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';data.append(b);data.classList.add('has-copy');}list.append(term,data);}return list;}
 function metaCard(target,heading,rows){const section=el('section','native-side-card');section.append(el('h3','',t(heading)),metaList(rows));target.append(section);return section;}
 function renderSide(value,id,readable){
  side.dataset.sessionKey=key(value);
  const live=takeover.isOn(value);sideBadge.hidden=false;sideBadge.className=`native-side-badge ${live?'is-live':''}`;sideBadge.textContent=t(live?'Taken over':takeover.canChat(value)?'Platform chat':'Read-only');
  const {session,resources}=sidePanels;session.replaceChildren();resources.replaceChildren();agentDetailsSignature='';
  // Session: how this session is connected first, then model and context, then its name and identity.
  const controls=el('section','native-side-card native-connect');controls.dataset.nativeControls='';
  const settingsCard=el('section','native-side-card native-settings-card');settingsCard.dataset.nativeSettings='';
  session.append(controls,settingsCard);
  renderNameCard(value);
  metaCard(session,'Native session',[['Session ID',id||t('Not available yet'),id||null],['Working folder',value.workspace||t('Choose a folder when opening'),value.workspace||null]]);
  // Repository facts are read once per selected session (or on Refresh), never polled.
  const repository=el('section','native-side-card native-git-card');repository.dataset.nativeGit='';session.append(repository);
  if(gitKey!==key(value)){gitKey=key(value);void loadGit(value,true);}else renderGit(value);
  // Resources: the device and CLI account this session runs on.
  const agentLine=el('span','native-agent-line');agentLine.append(agentIconEl(value.runtime),el('span','',names[value.runtime]||value.runtime));
  metaCard(resources,'Runtime',[['Device',workerName(value.nodeId)],['Agent tool',names[value.runtime]]]).querySelector('dd:nth-of-type(2) .native-meta-value')?.replaceChildren(agentLine);
  renderAgentDetails(value);
  renderSessionControls(value);
  renderSessionSettings(value);
  selectSideTab(sideTab);
 }
 const tokensText=n=>n==null?'':n>=1e6?`${(n/1e6).toFixed(n>=1e7?0:1)}m`:n>=1e3?`${(n/1e3).toFixed(n>=1e5?0:1)}k`:String(n);
 const EFFORT_LABELS={none:'None',minimal:'Minimal',low:'Low',medium:'Medium',high:'High',xhigh:'Extra high',max:'Max',ultra:'Ultra',auto:'Automatic',default:'CLI default'};
 /** Model, reasoning effort and context: the page's chosen settings win over what history recorded; context comes from the newest page turn, else history. */
 function renderSessionSettings(value){
  const card=sidePanels.session.querySelector('[data-native-settings]');if(!card||side.dataset.sessionKey!==key(value))return;
  const data=getData(),worker=data.workers?.find(w=>w.id===value.nodeId),runtime=worker?.runtimes?.find(r=>r.type===value.runtime),configuration=value.sessionConfiguration||{};
  const chosen=takeover.settings(),model=chosen.model||configuration.model||'',effort=chosen.effort||configuration.effort||'';
  const models=runtime?.models||[],modelInfo=models.find(m=>m.id===model),efforts=modelInfo?.efforts||runtime?.efforts||(value.runtime==='claude'?['low','medium','high','xhigh','max']:[]);
  const sample=takeover.contextSample(),used=sample?sample.usedTokens:configuration.contextTokens??null,limit=sample?.limitTokens||null,pct=used!=null&&limit?Math.min(100,Math.round(used/limit*100)):null;
  const canEdit=Boolean(worker?.online)&&takeover.controls()&&Boolean(nativeId(value)),canCompact=canEdit&&['claude','codex'].includes(value.runtime)&&takeover.isOn(value)&&!takeover.busy();
  const signature=JSON.stringify([key(value),model,effort,models.map(m=>m.id),efforts,used,limit,sample?.state,sample?.compacted,canEdit,canCompact,takeover.busy()]);
  if(card.dataset.signature===signature)return;card.dataset.signature=signature;card.replaceChildren(el('h3','',t('Model and context')));
  const grid=el('div','native-settings-grid');
  const select=(label,current,options,onChange)=>{const wrap=el('label','native-setting');wrap.append(el('span','native-setting-label',t(label)));const sel=el('select');for(const [id,name] of options){const o=el('option','',name);o.value=id;sel.append(o);}if(current&&!options.some(([id])=>id===current)){const o=el('option','',current);o.value=current;sel.prepend(o);}if(!current){const o=el('option','',t('CLI default'));o.value='';sel.prepend(o);}sel.value=current||'';sel.disabled=!canEdit||takeover.busy();sel.addEventListener('change',()=>{sel.disabled=true;void onChange(sel.value);});wrap.append(sel);return wrap;};
  grid.append(select('Model',model,models.map(m=>[m.id,m.name||m.id]),v=>takeover.saveSetting('model',v)));
  if(efforts.length||effort)grid.append(select('Reasoning effort',effort,efforts.map(e=>[e,t(EFFORT_LABELS[e]||e)]),v=>takeover.saveSetting('effort',v)));
  card.append(grid);
  const note=value.runtime==='claude'?'Claude applies a change at once, in this session.':value.runtime==='codex'?'Codex applies a change from the next message.':value.runtime==='agy'?'Agy restarts its process on the next message after a change.':'Grok applies a change from the next message.';
  card.append(el('p','native-side-hint',t(note)));
  // context
  const ctx=el('div','native-context');const head=el('div','native-context-head');head.append(el('span','native-context-title',t('Context')));
  const amount=used==null?t('Not measured yet'):limit?`${tokensText(used)} / ${tokensText(limit)} · ${pct}%`:t('{tokens} tokens',{tokens:tokensText(used)});head.append(el('span','native-context-amount',amount));ctx.append(head);
  const bar=el('div',`native-context-bar${pct!=null?pct>=90?' is-high':pct>=70?' is-mid':'':' is-unknown'}`);const fill=el('span','');fill.style.width=`${pct??0}%`;bar.append(fill);ctx.append(bar);
  if(sample?.state==='compacted'&&sample.compacted)ctx.append(el('p','native-side-hint',t('Compacted {from} → {to}',{from:tokensText(sample.compacted.preTokens),to:tokensText(sample.compacted.postTokens)})));
  if(['claude','codex'].includes(value.runtime)){const compactButton=button('Compact context',()=>void takeover.compact(),'secondary native-card-action');compactButton.disabled=!canCompact;if(!takeover.isOn(value))compactButton.title=t('Take over the session to compact its context here');ctx.append(compactButton);}
  card.append(ctx);
  const feedback=takeover.feedback(value);if(feedback)card.append(el('p','global-error',feedback));
 }
 const takeover=createTakeover();
 // Sessions opened on this page with "Allow all": once the headless first turn has produced history, chat here without a separate takeover confirmation.
 const pageOpened=new Set();
 const IMAGE_CLIS=new Set(['codex','claude']),openProcesses=new Set();
 const permissionPrompt=value=>value.runtime==='codex'?'Take over with automatic tool approval? Codex can change files inside this session workspace.':'Take over with permission prompts bypassed? {tool} can make changes without asking again.';
 /** Codex records an attached image as markup with a Worker-local path; show a short placeholder instead. */
/** CLI titles can start with injected context markup (e.g. <environment_context>); show readable text or the short ID. */
const displayTitle=item=>{const text=String(item.title||'').replace(/<([a-z_-]+)\b[^>]*>[\s\S]*?(<\/\1>|$)/gi,' ').replace(/\s+/g,' ').trim();return text||`${String(item.id||'').slice(0,8)}\u2026`;};
const sizeText=n=>!Number.isFinite(n)?'':n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:`${(n/1048576).toFixed(1)} MB`;
/** Hide CLI-internal stderr logging (timestamped WARN/ERROR lines) from the run process; real errors arrive as error events. */
const cliNoise=text=>/^\s*\d{4}-\d\d-\d\dT\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\b/m.test(stripAnsi(String(text||'')));
/** CLIs write injected context (system reminders, environment blocks, slash-command receipts) into history as "user" messages; only the words the person typed are a prompt. */
const INJECTED=/<(system-reminder|user_info|environment_context|local-command-stdout|local-command-caveat|command-message|command-args|skill_metadata|available_skills)\b[^>]*>[\s\S]*?(<\/\1>|$)/gi;
const cleanUserText=text=>String(text||'').replace(/<image\b[^>]*>[\s\S]*?<\/image>/gi,'').replace(INJECTED,'').replace(/<command-name>[\s\S]*?<\/command-name>/gi,'').replace(/^\s*<user_query>\s*([\s\S]*?)\s*<\/user_query>\s*$/i,'$1').replace(/\n*Attached files for this message \(local paths\):[\s\S]*$/,'').trim();
const commandOf=text=>String(text||'').match(/<command-name>\s*([^<]+?)\s*<\/command-name>/i)?.[1]||'';
/** A turn shows its process only when it holds more than the final reply: tools, runtime notes or intermediate messages. */
const norm=text=>stripAnsi(String(text||'')).replace(/\s+/g,' ').trim();
const allRows=turn=>liveSceneRows(turn.events||[],{status:turn.status}).rows.filter(r=>!(r.kind==='log'&&cliNoise(r.text)));
/** The reply bubble shows the final message; the process keeps intermediate messages once each (streamed text that equals a message is dropped). */
const finalReply=turn=>{const rows=allRows(turn),last=[...rows].reverse().find(r=>r.kind==='message'||r.kind==='text');return last||null;};
const processRows=turn=>{const rows=allRows(turn),messages=new Set(rows.filter(r=>r.kind==='message').map(r=>norm(r.text))),final=finalReply(turn),seen=new Set();
 return rows.filter(r=>{if(r===final)return false;if(r.kind!=='message'&&r.kind!=='text')return true;const n=norm(r.text);if(!n||(r.kind==='text'&&messages.has(n))||seen.has(n)||(final&&n===norm(final.text)))return false;seen.add(n);return true;});};
const replyText=turn=>{const f=finalReply(turn);return f?f.text:turn.text||'';};
const hasProcess=turn=>{const rows=processRows(turn);return rows.some(r=>r.kind==='tool'||r.kind==='log'||r.kind==='error')||rows.some(r=>r.kind==='message'||r.kind==='text');};
 /** The group-chat live-scene projection orders text, messages, logs and merged tool states for one turn. */
 const preview=createPreviewSheet(content,t);
 /** One activity line per turn: tool steps classified across CLIs, intermediate agent notes and runtime errors behind it. */
 function stepsOf(turn){const rows=processRows(turn);return {steps:rows.filter(r=>r.kind==='tool').map(r=>classifyStep(r.item,turn.status)),notes:rows.filter(r=>r.kind!=='tool'&&(r.kind==='error'||r.kind==='log'||r.kind==='message'||r.kind==='text'))};}
 function activityFor(turn,{live=false,open=false}={}){
  const {steps,notes}=stepsOf(turn),duration=!live&&turn.endedAt?elapsedText(turn.createdAt,new Date(turn.endedAt).getTime()):'';
  return activityBlock({steps,notes,t,live,duration,open,onPreview:(step,path)=>preview.open(step,path),onToggle:isOpen=>{if(!live)isOpen?openProcesses.add(turn.id):openProcesses.delete(turn.id);}});
 }
 /** The single working line of a live turn: pulse, elapsed time, what the CLI is doing right now, Stop. */
 function workingLine(turn,onStop){
  const line=el('div','nt-working');const pulse=el('span','nt-pulse');pulse.setAttribute('aria-hidden','true');
  const {steps}=stepsOf(turn),running=[...steps].reverse().find(s=>s.running),now=running?stepTitle(running,t):null;
  const hint=turn.status==='queued'?t('Waiting for the device\u2026'):turn.status==='stopping'?t('Stopping\u2026'):turn.status==='starting'||!turn.phase?t('Starting the CLI\u2026'):now?`${now.verb} ${now.target}`.trim():turn.phase==='replying'?t('Replying\u2026'):t('Working\u2026');
  line.append(pulse,el('span','nt-working-time',elapsedText(turn.createdAt)),el('span','nt-working-hint',hint));if(onStop)line.append(button('Stop',onStop,'secondary compact nt-stop'));return line;
 }
 /** Takeover reuses the group-chat composer behaviour: Enter sends, Shift+Enter breaks lines, paste/drag/attach uploads files. An unconfirmed send keeps Send disabled while the same message ID is looked up; only a confirmed absence allows a retry with that ID. */
 function createTakeover(){
  const stored=(name,fallback)=>{try{return JSON.parse(sessionStorage.getItem(name)||JSON.stringify(fallback));}catch{return fallback;}};
  const consentKey='agent-workbench.native-takeover-v3-consent',on=new Set(stored(consentKey,[])),drafts=stored('agent-workbench.native-takeover-drafts',{}),operations=new Map();
  const returnedKey='agent-workbench.native-returned-chat',returned=new Set(stored(returnedKey,[]));
  const save=()=>{try{sessionStorage.setItem(consentKey,JSON.stringify([...on]));sessionStorage.setItem(returnedKey,JSON.stringify([...returned]));sessionStorage.setItem('agent-workbench.native-takeover-drafts',JSON.stringify(drafts));}catch{}};
  const feed=el('div','native-takeover-feed'),shell=el('div','chat-composer-shell native-session-footer'),urls=new Map();
  let current=null,turns=[],poll=null,historyAt=0,historyEl=null,supported=true,fetchTicket=0,residentState='closed',settings={model:null,effort:null},controls=false;
  const sessionKey=value=>value?`${value.nodeId}/${value.runtime}/${value.sessionId}`:'';
  const k=()=>sessionKey(current);
  const isOn=value=>on.has(sessionKey(value));
  // 归还只开启输入界面，不授予工具执行权限；仍由发送时确认和后端占用检查决定能否执行。
  const canChat=value=>returned.has(sessionKey(value))&&getData().workers?.find(w=>w.id===value?.nodeId)?.capabilities?.nativeTurns===3;
  function markReturned(value){const id=sessionKey(value);if(!value?.sessionId)return;returned.add(id);save();if(current&&k()===id){render();renderSide(current,current.sessionId,true);}}
  const operation=(id=k())=>{if(!operations.has(id))operations.set(id,{sending:false,uploads:0,releasing:false,message:''});return operations.get(id);};
  const isReleasing=value=>operation(sessionKey(value)).releasing;
  const activeTurn=()=>turns.find(x=>['queued','starting','running','waiting_user','stopping'].includes(x.status));
  // 按钮移到侧栏后仍使用当前会话的发送、上传及执行状态，避免误结束活动轮次。
  const releaseDisabled=value=>{const op=operation(sessionKey(value));return Boolean(sessionKey(value)===k()&&activeTurn()||op.sending||op.uploads>0||op.releasing);};
  const turnsUrl=()=>`${endpoint(current.nodeId)}/turns`;
  // Same send lifecycle as the group chat (send-state.js); the takeover API is idempotent by clientTurnId.
  const sendState=(d,op)=>sendStateOf(d,Boolean(op?.sending));
  let checkedAt=0;
  /** Clear only what the confirmed send carried; text typed afterwards stays. */
  function settleTurn(id,sent){const d=drafts[id];if(!d)return;
   if((d.text||'')===(sent.text||'')){drafts[id]={text:'',attachments:[]};if(k()===id)input.value='';}
   else{const carried=new Set(sent.attachmentIds||[]);delete d.pending;delete d.sendState;d.attachments=(d.attachments||[]).filter(a=>!carried.has(a.id));}
   operation(id).message='';save();}
  /** Exact read-only receipt for the frozen clientTurnId in this session; only a confirmed absence re-enables Send. */
  async function verifyTurn(id){const d=drafts[id],op=operation(id),value=current;if(!d?.pending||op.sending||op.verifying||d.sendState==='failed'||!value||k()!==id)return;
   op.verifying=true;checkedAt=Date.now();const sent=d.pending;render();
   try{const receipt=await api(`${endpoint(value.nodeId)}/turns?${new URLSearchParams({runtime:value.runtime,sessionId:value.sessionId,clientTurnId:sent.clientTurnId})}`);
    if(drafts[id]?.pending?.clientTurnId!==sent.clientTurnId)return;
    if(receipt?.exists===true)settleTurn(id,sent);else if(receipt?.exists===false)drafts[id].sendState='failed';}
   catch(error){
    // An unreachable Home or 401/403/429 says nothing about the original POST: stay unknown and look again later.
    if(drafts[id]?.pending?.clientTurnId===sent.clientTurnId)drafts[id].sendState=lookupFailureState(error);op.message=t(error.message);}
   finally{op.verifying=false;save();if(current&&k()===id)render();}}
  /** Redraws from the existing state refresh re-check an unknown send at most every few seconds; no new polling. */
  function recheck(){if(!current)return;const d=drafts[k()];if(!d?.pending||d.sendState==='failed'||operation().sending||Date.now()-checkedAt<5000)return;void verifyTurn(k());}
  const draft=(id=k())=>drafts[id]||={text:'',attachments:[]};
  const fileUrl=(nodeId,item)=>{const id=`${nodeId}:${item.id}`;if(!urls.has(id))urls.set(id,api(`${endpoint(nodeId)}/attachments/${encodeURIComponent(item.id)}`,{blob:true}).then(blob=>URL.createObjectURL(blob)).catch(e=>{urls.delete(id);throw e;}));return urls.get(id);};
  const revokeAttachment=(nodeId,id)=>{const key=`${nodeId}:${id}`,pending=urls.get(key);urls.delete(key);if(pending)void Promise.resolve(pending).then(url=>URL.revokeObjectURL(url)).catch(()=>{});};
  const revokeUrls=()=>{for(const id of [...urls.keys()]){const split=id.indexOf(':');revokeAttachment(id.slice(0,split),id.slice(split+1));}};
  let previewDialog=null;
  /** The full original (images) or its name and size (other files); the draft thumbnail is only a crop. */
  function previewAttachment(item){if(!current)return;
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
    else{const icon=el('span','native-file-icon');icon.innerHTML=UI_ICON.original;open.append(icon);}
    open.append(el('span','attachment-name',item.name),el('small','',sizeText(item.size)));
    card.append(open,closeIcon(button('',remove,'attachment-remove'),t('Remove attachment')));return card;
   }
   if(item.mime?.startsWith('image/')){const img=el('img');img.alt=item.name;void fileUrl(current.nodeId,item).then(url=>{img.src=url;}).catch(()=>{});card.append(img);}else card.append(el('span','native-file-icon','\u{1F4C4}'));
   if(remove||!item.mime?.startsWith('image/')){const info=el('span','native-file-info');info.append(el('span','attachment-name',item.name),el('small','',sizeText(item.size)));card.append(info);}
   if(remove){const x=closeIcon(button('',remove,'attachment-remove'),t('Remove attachment'));card.append(x);}return card;}
  function detach(){current=null;turns=[];historyEl=null;feed.replaceChildren();shell.remove();clearInterval(poll);poll=null;revokeUrls();}
  function attach(value,{readable,historyAt:at,history}){const same=current&&k()===`${value.nodeId}/${value.runtime}/${value.sessionId}`;current=value;historyAt=at;historyEl=history;if(!same){turns=[];feed.replaceChildren();}
   const worker=getData().workers?.find(w=>w.id===value.nodeId);supported=worker?.capabilities?.nativeTurns===3;
   const eligible=readable&&value.canResume!==false&&!value.canReopen&&Boolean(value.workspace);
   if(!eligible){shell.remove();return;}
   content.append(shell);render();void refresh();
  }
  /** Turns already in native history keep their process next to the matching reply; others render as their own rows. */
  function renderFeed(){feed.replaceChildren();for(const old of historyEl?.querySelectorAll('.native-turn-anchored')||[])old.remove();
   const rows=[...(historyEl?.querySelectorAll('.native-chat-row')||[])],used=new Set();
   for(const turn of turns){
    if(turn.control){
     const live=['queued','starting','running','waiting_user','stopping'].includes(turn.status),command=turn.control==='compact'&&turn.runtime==='codex'?'compact':(turn.prompt||'').replace(/^\//,'');
     const index=rows.findIndex((row,i)=>!used.has(i)&&row.dataset.role==='system'&&row.dataset.text===command);
     const c=turn.contextUsage?.compacted,detail=turn.status==='failed'?`${t('Failed')}${turn.error?` · ${t(turn.error)}`:''}`:c&&c.preTokens!=null&&c.postTokens!=null?`${tokensText(c.preTokens)} → ${tokensText(c.postTokens)}`:live?t('Working…'):String(turn.text||'').split('\n')[0].slice(0,160);
     if(index>=0){used.add(index);const row=rows[index];row.querySelector('.nt-system-detail')?.remove();if(detail)row.append(el('span','nt-system-detail',detail));continue;}
     const row=el('div',`nt-system${turn.status==='failed'?' is-error':''}`);row.append(el('span','nt-system-mark','\u2318'),el('code','',`/${command}`));if(detail)row.append(el('span','nt-system-detail',detail));if(live)row.append(el('span','nt-pulse'));feed.append(row);continue;
    }
    const state=turn.status==='failed'?'error':turn.status==='interrupted'?'stopped':turn.status==='queued'?'queued':turn.status==='waiting_user'||turn.phase==='waiting'?'waiting':['starting','running','stopping'].includes(turn.status)?'running':'completed';
    const live=['queued','starting','running','waiting_user','stopping'].includes(turn.status);
    if(!live&&turn.endedAt&&turn.prompt.trim()){
     const prompt=turn.prompt.trim(),index=rows.findIndex((row,i)=>!used.has(i)&&row.dataset.role==='user'&&row.dataset.text===prompt);
     if(index>=0){used.add(index);let anchor=rows[index];for(let i=index+1;i<rows.length&&rows[i].dataset.role!=='user';i++)anchor=rows[i];
      if(turn.attachments?.length){const files=el('div','chat-attachments native-turn-files native-turn-anchored');for(const item of turn.attachments)files.append(attachmentCard(item));rows[index].querySelector('.nt-body')?.append(files);}
      const extra=el('div','native-turn-anchored nt-extra');
      if(hasProcess(turn))extra.append(activityFor(turn,{open:openProcesses.has(turn.id)}));
      if(turn.status!=='succeeded')extra.append(el('div','nt-error',`${t(turn.status==='interrupted'?'Interrupted':'Failed')}${turn.error?` \u00b7 ${t(turn.error)}`:''}`));
      if(extra.childElementCount){if(anchor.dataset.role==='user'&&state==='error'){const errorRow=chatRow('assistant','',current.runtime,turn.endedAt,extra,state);errorRow.classList.add('native-turn-anchored');anchor.after(errorRow);}else{const body=anchor.querySelector('.nt-body');if(body){const md=body.querySelector('.markdown-body');md?md.before(extra):body.append(extra);}}}continue;}
    }
    let files=null;if(turn.attachments?.length){files=el('div','chat-attachments native-turn-files');for(const item of turn.attachments)files.append(attachmentCard(item));}
    feed.append(chatRow('user',turn.prompt,current.runtime,turn.createdAt,files));
    const extra=el('div','nt-extra');
    if(live||hasProcess(turn))extra.append(activityFor(turn,{live,open:live||openProcesses.has(turn.id)}));
    if(live)extra.append(workingLine(turn,()=>stop(turn)));
    else if(turn.status!=='succeeded')extra.append(el('div','nt-error',`${t(turn.status==='interrupted'?'Interrupted':'Failed')}${turn.error?` · ${t(turn.error)}`:''}`));
    feed.append(chatRow('assistant',replyText(turn),current.runtime,null,extra,state,current));
   }}
  function render(){
   if(!current)return;const value=current,taken=isOn(value);shell.replaceChildren();renderFeed();renderSessionControls(value);
   if(!taken&&!(supported&&canChat(value))){const bar=el('div','native-takeover-bar');const copy=el('div','native-takeover-copy');copy.append(el('strong','',t('Read-only preview')),el('span','',t(supported?'Take over to keep chatting in this exact native session here.':'Upgrade this Worker to take over native sessions')));const b=button('Take over session',()=>enable(value),'primary native-takeover-button');b.disabled=!supported;bar.append(copy,b);shell.append(bar);return;}
   const id=k(),d=draft(id),op=operation(id),busy=Boolean(activeTurn());
   const form=el('form','chat-composer native-takeover-form'),barRow=el('div','chat-input-bar'),field=el('div','chat-input-field'),note=el('p','workspace-note native-takeover-note'),tray=el('div','chat-attachments native-takeover-tray');
   input.placeholder=t('Message {tool}; replies continue this native session',{tool:names[value.runtime]||value.runtime});if(input.value!==d.text)input.value=d.text||'';
   note.textContent=op.message||'';note.hidden=!note.textContent;note.classList.toggle('chat-bubble',Boolean(op.message));note.classList.toggle('is-error-card',Boolean(op.message));const state=sendState(d,op);
   for(const item of d.attachments||[])tray.append(attachmentCard(item,()=>{if(!d.pending)void removeAttachment(id,value.nodeId,item);}));
   if(op.uploads)tray.append(el('span','attachment-uploading',t('Uploading attachments…')));tray.hidden=!tray.childElementCount;
   sendButton.disabled=op.sending||op.releasing||busy||op.uploads>0||sendLocked(state)||Boolean(op.verifying);sendButton.textContent=t(SEND_LABELS[state]||'Send');input.disabled=op.sending||op.releasing||Boolean(d.pending);attachButton.disabled=op.sending||op.releasing||Boolean(d.pending);
   field.append(tray,attachButton,input);barRow.append(field,sendButton);
   form.append(note,barRow);form.addEventListener('submit',e=>{e.preventDefault();void submit();});shell.append(form);resize();
  }
  async function endTakeover(value){const id=sessionKey(value),op=operation(id);if(op.releasing)return;op.releasing=true;op.message='';if(k()===id){render();renderSide(value,value.sessionId,true);}try{await api(`${endpoint(value.nodeId)}/takeover/release`,{method:'POST',json:{runtime:value.runtime,sessionId:value.sessionId}});if(k()===id)await refresh();else await onStateRefresh();}catch(error){op.releasing=false;op.message=t(error.message);if(k()===id){render();renderSide(value,value.sessionId,true);}}}
  async function removeAttachment(id,nodeId,item){const op=operation(id);op.message='';if(k()===id)render();try{await api(`${endpoint(nodeId)}/attachments/${encodeURIComponent(item.id)}`,{method:'DELETE'});const d=draft(id);d.attachments=(d.attachments||[]).filter(a=>a.id!==item.id);revokeAttachment(nodeId,item.id);save();}catch(error){op.message=t(error.message);}finally{if(k()===id)render();}}
  const input=el('textarea');input.rows=1;input.setAttribute('aria-label',t('Chat message'));
  const sendButton=el('button','primary',t('Send'));sendButton.type='submit';
  const fileInput=el('input');fileInput.type='file';fileInput.multiple=true;fileInput.hidden=true;document.body.append(fileInput);
  const attachButton=el('button','native-attach');attachButton.type='button';attachButton.title=t('Upload an image or file');attachButton.setAttribute('aria-label',t('Upload file'));attachButton.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8M7 13l7-7"/></svg>';
  attachButton.addEventListener('click',()=>fileInput.click());fileInput.addEventListener('change',()=>{void upload(fileInput.files);fileInput.value='';});
  /** Same limits as the group chat: at most 6 files per message, 20 MB each; images only for CLIs with image input. */
  async function upload(list){if(!current)return;const id=k(),nodeId=current.nodeId,runtime=current.runtime,d=draft(id),op=operation(id),files=[...list];if(op.sending||op.releasing||d.pending)return;op.message='';
   if((d.attachments?.length||0)+op.uploads+files.length>6){op.message=t('At most 6 attachments per message');render();return;}
   if(files.some(f=>!f.size||f.size>20*1024*1024)){op.message=t('Attachments cannot be empty; each file is limited to 20 MB');render();return;}
   if(!IMAGE_CLIS.has(runtime)&&files.some(f=>f.type.startsWith('image/'))){op.message=t('{tool} cannot receive images here; files are passed as paths',{tool:names[runtime]});render();return;}
   op.uploads+=files.length;render();
   for(const file of files){let uploaded=null;try{uploaded=await api(`${endpoint(nodeId)}/attachments`,{method:'POST',body:file,headers:{'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(file.name||'pasted-image.png')}});if(!IMAGE_CLIS.has(runtime)&&uploaded.mime.startsWith('image/'))throw Error('This CLI cannot receive images in a takeover; send files or use iTerm');(d.attachments||=[]).push({id:uploaded.id,name:uploaded.name,mime:uploaded.mime,size:uploaded.size});save();}catch(error){if(uploaded)void api(`${endpoint(nodeId)}/attachments/${encodeURIComponent(uploaded.id)}`,{method:'DELETE'}).catch(()=>{});op.message=t(error.message);}finally{op.uploads--;if(k()===id)render();}}}
  input.addEventListener('paste',e=>{const files=[...(e.clipboardData?.files||[])];if(files.length){e.preventDefault();void upload(files);}});
  shell.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files')){e.preventDefault();shell.classList.add('is-dragging');}});
  shell.addEventListener('dragleave',()=>shell.classList.remove('is-dragging'));
  shell.addEventListener('drop',e=>{shell.classList.remove('is-dragging');if(e.dataTransfer?.files.length&&current&&(isOn(current)||canChat(current))){e.preventDefault();void upload(e.dataTransfer.files);}});
  const resize=()=>{input.style.height='auto';input.style.height=`${Math.min(120,Math.max(40,input.scrollHeight))}px`;};
  input.addEventListener('input',()=>{draft().text=input.value;save();resize();});
  input.addEventListener('keydown',e=>{if(window.matchMedia('(max-width: 1000px)').matches)return;if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&!sendButton.disabled){e.preventDefault();input.form?.requestSubmit();}});
  async function submit(){if(!current||activeTurn())return;const id=k(),value=current,d=draft(id),op=operation(id);if(op.sending||op.releasing||op.uploads)return;
   // An in-flight or unknown send is only looked up again (click, double click, Enter); it is never resent with a new ID.
   if(d.pending&&d.sendState!=='failed'){void verifyTurn(id);return;}
   if(!d.pending&&!input.value.trim()&&!d.attachments?.length)return;op.message='';
   if(!isOn(value)){if(!confirm(t(permissionPrompt(value),{tool:names[value.runtime]||value.runtime})))return;on.add(id);save();}
   if(!d.pending){const payload={text:input.value,attachmentIds:(d.attachments||[]).map(a=>a.id)};
    // A retry of exactly the content Home rejected keeps its id; any edit gets a new id, never the old one.
    d.pending={clientTurnId:sameSend(d.rejected?.payload,payload)?d.rejected.clientTurnId:crypto.randomUUID(),...payload};}
   delete d.rejected;d.sendState='sending';const sent=d.pending;save();op.sending=true;render();
   try{const turn=await api(`${endpoint(value.nodeId)}/turns`,{method:'POST',json:{runtime:value.runtime,sessionId:value.sessionId,allowAll:true,...d.pending}});drafts[id]={text:'',attachments:[]};if(k()===id){input.value='';turns=[...turns.filter(x=>x.id!==turn.id),turn];}}
   catch(error){if(uncertainSend(error))d.sendState='checking';else{const {clientTurnId,...payload}=sent;d.rejected={clientTurnId,payload};delete d.pending;delete d.sendState;}op.message=t(error.message);}
   finally{op.sending=false;save();if(current){render();schedule();if(k()===id)scroll.scrollTop=scroll.scrollHeight;if(drafts[id]?.pending&&drafts[id].sendState==='checking')void verifyTurn(id);}}}
  async function stop(turn){const op=operation();try{const next=await api(`${turnsUrl()}/${encodeURIComponent(turn.id)}/stop`,{method:'POST',json:{}});turns=turns.map(x=>x.id===next.id?next:x);render();}catch(error){op.message=t(error.message);render();}}
  async function refresh(){if(!current)return;const ticket=++fetchTicket,id=k(),op=operation(id);try{const result=await api(`${turnsUrl()}?${new URLSearchParams({runtime:current.runtime,sessionId:current.sessionId})}`);if(ticket!==fetchTicket||k()!==id)return;const wasActive=Boolean(activeTurn()),bottom=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<80;supported=result.supported!==false;controls=result.controls===true;settings=result.settings||{model:null,effort:null};residentState=result.process||'closed';turns=result.items||[];{const d=drafts[id];if(d?.pending&&!op.sending&&turns.some(x=>x.clientTurnId===d.pending.clientTurnId))settleTurn(id,d.pending);}if(op.releasing&&result.process==='closed'){op.releasing=false;on.delete(id);returned.add(id);save();await onStateRefresh();}render();renderSide(current,current.sessionId,true);if(wasActive&&!activeTurn()&&selected)void read(selected,{quiet:true});schedule();if(bottom)scroll.scrollTop=scroll.scrollHeight;}catch(error){op.message=t(error.message);render();schedule();}}
  function schedule(){clearInterval(poll);poll=null;if(current&&(activeTurn()||operation().releasing))poll=setInterval(()=>{if(!document.hidden)void refresh();},1000);}
  /** Start chatting here: the one confirmation of bypassed permissions, then the composer. */
  function enable(value,{focus=true}={}){if(!value?.sessionId)return false;const id=sessionKey(value);if(!on.has(id)){if(!confirm(t(permissionPrompt(value),{tool:names[value.runtime]||value.runtime})))return false;on.add(id);save();}if(current&&k()===id){render();renderSide(value,value.sessionId,true);if(focus)input.focus();}return true;}
  /** Files touched by this session's page turns, newest turn first; an edit or write wins over a read of the same path. */
  function files(){const seen=new Map();for(const turn of [...turns].reverse()){if(turn.control)continue;for(const chip of fileChips(stepsOf(turn).steps)){const prior=seen.get(chip.path);if(!prior||prior.step.kind==='read'&&chip.step.kind!=='read')seen.set(chip.path,chip);}}return [...seen.values()];}
  /** Latest context snapshot of the current session from its page turns. */
  function contextSample(){for(const turn of [...turns].reverse())if(turn.contextUsage)return turn.contextUsage;return null;}
  async function saveSetting(field,value){if(!current)return null;const id=k(),op=operation(id);op.message='';try{const result=await api(`${endpoint(current.nodeId)}/settings`,{method:'POST',json:{runtime:current.runtime,sessionId:current.sessionId,[field]:value||null}});settings={model:result.model||null,effort:result.effort||null};await refresh();return result;}catch(error){op.message=t(error.message);render();renderSide(current,current.sessionId,true);return null;}}
  async function compact(){if(!current||activeTurn())return;const id=k(),op=operation(id);op.message='';try{const turn=await api(`${turnsUrl()}`,{method:'POST',json:{runtime:current.runtime,sessionId:current.sessionId,allowAll:true,clientTurnId:crypto.randomUUID(),control:'compact'}});turns=[...turns.filter(x=>x.id!==turn.id),turn];render();schedule();}catch(error){op.message=t(error.message);render();}}
  return {feed,attach,detach,isOn,enable,adopt:value=>{if(!value?.sessionId)return;on.add(sessionKey(value));save();},canChat,renderFeed,returned:markReturned,isReleasing,releaseDisabled,feedback:value=>operation(sessionKey(value)).message,release:endTakeover,refresh,recheck,
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
  const form=el('form','native-session-form'),d=el('select'),r=el('select'),folder=el('input'),all=el('input'),title=el('input');d.required=r.required=folder.required=title.required=true;title.type='text';title.maxLength=120;title.placeholder=t('Give this session a title');title.value=session?.title||'';title.readOnly=Boolean(session);folder.type='text';folder.value=session?.workspace||'';folder.placeholder=t('Select a working folder');all.type='checkbox';all.id='native-allow-all';all.checked=true;
  const field=(label,input,full=false)=>{const l=el('label',`native-field${full?' native-full':''}`,t(label));input.setAttribute('aria-label',t(label));l.append(input);form.append(l);return l;};
  options(d,(getData().workers||[]).map(w=>[w.id,`${w.name||w.id}${w.online?'':` · ${t('Offline')}`}`]));if(session?.nodeId)d.value=session.nodeId;else if(defaults.nodeId)d.value=defaults.nodeId;else if(workers()[0])d.value=workers()[0].id;
  const updateTools=()=>{options(r,(getData().workers?.find(w=>w.id===d.value)?.runtimes||[]).filter(x=>x.available&&x.supported!==false&&names[x.type]).map(x=>[x.type,names[x.type]]));};updateTools();if(session?.runtime)r.value=session.runtime;else if(defaults.runtime)r.value=defaults.runtime;else if(tool.value!=='all'&&[...r.options].some(o=>o.value===tool.value))r.value=tool.value;d.disabled=r.disabled=Boolean(session);if(session?.workspace)folder.readOnly=true;
  field('Session title',title,true);field('Device',d);field('Agent tool',r);const folderField=field('Working folder',folder,true),pathRow=el('div','native-workspace-row');
  const feedback=el('p','native-form-feedback native-full'),launch=el('div','native-launch-result native-full');feedback.setAttribute('role','status');
  const browseButton=button('Select file or folder',()=>openFilePicker({nodeId:d.value,path:folder.value,locked:session?.workspace||null,onUse:path=>{folder.value=path;folder.dispatchEvent(new Event('change',{bubbles:true}));}}));setActionIcon(browseButton,'folder');pathRow.append(folder,browseButton);folderField.append(pathRow);
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
  folder.addEventListener('input',()=>{defaultFolderVersion++;feedback.textContent='';});
  folder.addEventListener('change',()=>{defaultFolderVersion++;feedback.textContent='';});
  d.addEventListener('change',()=>{updateTools();folder.value='';launch.replaceChildren();void fillDefaultFolder();});
  let operationId=null,lastInput='',prepared=null,opened=false;
  const releaseUnused=async()=>{if(!prepared||opened)return;const previous=prepared;prepared=null;operationId=null;lastInput='';await api(`/api/native-sessions/${encodeURIComponent(previous.nodeId)}/terminal`,{method:'POST',json:{action:'release',operationId:previous.operationId}});};
  const discard=()=>{launch.replaceChildren();submit.disabled=true;return releaseUnused().catch(error=>{feedback.textContent=t(error.message);}).finally(()=>{submit.disabled=false;});};
  for(const input of[d,r,folder,all,title])input.addEventListener('change',discard);
  dialog.addEventListener('close',()=>{void discard().then(()=>load({quiet:true}));},{once:true});
  form.addEventListener('submit',async e=>{e.preventDefault();if(!title.value.trim()){title.focus();feedback.textContent=t('Enter a session title.');return;}const onPage=pageOpen&&e.submitter!==viaTerminal;submit.disabled=true;if(viaTerminal)viaTerminal.disabled=true;for(const input of[d,r,folder,all,title,browseButton])input.disabled=true;feedback.textContent=t('Preparing…');launch.replaceChildren();
   const input={runtime:r.value,sessionId:session&&!session.canReopen?nativeId(session):null,...(session?.entryId?{entryId:session.entryId}:{}),title:title.value.trim(),workspace:folder.value.trim(),allowAll:all.checked,useLocalSshKey:true},signature=JSON.stringify([d.value,input]);if(signature!==lastInput){operationId=crypto.randomUUID();lastInput=signature;}
   try{const result=await api(`/api/native-sessions/${encodeURIComponent(d.value)}/terminal`,{method:'POST',json:{...input,operationId}});prepared={nodeId:d.value,operationId};opened=false;if(!dialog.open||!dialog.contains(form)){await releaseUnused();return;}
    if(onPage){feedback.textContent=t('Starting the session…');await api(`/api/native-sessions/${encodeURIComponent(d.value)}/terminal`,{method:'POST',json:{action:'start',operationId}});opened=true;const created={nodeId:d.value,runtime:r.value,entryId:result.entryId||result.catalogEntryId};if(all.checked)pageOpened.add(key(created));dialog.close();await load();const item=items.find(x=>key(x)===key(created));if(item)void read(item);return;}
    feedback.textContent=t('Ready. Open iTerm to start or resume the native CLI.');const a=el('a','primary',t('Open iTerm'));a.href=result.url;a.addEventListener('click',()=>{opened=true;});launch.append(a,button('Copy terminal command',async()=>{await navigator.clipboard.writeText(result.command);opened=true;feedback.textContent=t('Copied');}));void load({quiet:true});}catch(error){if(error.folderPreparationReleased){operationId=null;lastInput='';}feedback.textContent=t(error.message);}finally{submit.disabled=false;if(viaTerminal)viaTerminal.disabled=false;d.disabled=r.disabled=Boolean(session);folder.disabled=all.disabled=title.disabled=browseButton.disabled=false;}
  });dialog.showModal();void fillDefaultFolder();
 }
 /** Segmented buttons share one mode transition; selecting the active side does not reload history. */
 const switches=[...mode.querySelectorAll('button[data-mode]')];
 function selectMode(value){if(!['groups','sessions'].includes(value)||value===modeValue)return;modeValue=value;for(const control of switches)control.setAttribute('aria-pressed',String(control.dataset.mode===value));document.body.dataset.navigationMode=value;if(active())populate();else{version++;detailVersion++;loading=pendingRefresh=false;takeover.detach();dialog.close();}onModeChange();if(active())void load();}
 for(const control of switches)control.addEventListener('click',()=>selectMode(control.dataset.mode));
 mode.addEventListener('keydown',event=>{const index=event.key==='ArrowLeft'||event.key==='Home'?0:event.key==='ArrowRight'||event.key==='End'?1:null;if(index===null)return;event.preventDefault();switches[index].focus();selectMode(switches[index].dataset.mode);});
 device.addEventListener('change',()=>load());tool.addEventListener('change',()=>load());
 const refresh=()=>{if(active()&&!document.hidden&&!dialog.open&&document.body.dataset.workspaceView!=='settings')void load({quiet:true});};
 window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
 // Only the visible Sessions page polls; returning from iTerm also refreshes immediately.
 setInterval(()=>{if(Date.now()-lastRefresh>=30000)refresh();},30000);
 list.hidden=filters.hidden=note.hidden=content.hidden=side.hidden=true;
 return {active,openNew:(defaults={})=>openForm(null,defaults),sync(){const changed=populate(),visible=active();list.hidden=filters.hidden=note.hidden=side.hidden=!visible;content.hidden=!visible||document.body.dataset.workspaceView==='settings';if(visible&&document.body.dataset.workspaceView!=='settings'){renderTitle();renderList();document.querySelector('#show-project-form').setAttribute('aria-label',t('New native session'));if(selected){renderSessionControls(selected);renderAgentDetails(selected);}if(changed)refresh();takeover.recheck();}else document.querySelector('#show-project-form').setAttribute('aria-label',t('New project'));},refresh};
}
