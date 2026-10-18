import {t as globalT,dateLocale,getLanguage} from './i18n.js';
import pageZh from './locales/native-takeover-zh.js';
import {simplifiedCliOutput} from './output-language.js';
import {agentIconEl,machineIconEl,workerKind,setActionIcon,closeIcon,UI_ICON} from './role-icons.js';
import {createListOrder} from './list-order.js';
import {groupNativeSessions,readNativeSessionPages} from './native-session-groups.js';
import {createNativeHistoryTimeline} from './native-history-timeline.js';
import {createFolderControl} from './create-folder.js';
import {renderMarkdown} from './markdown.js';
import {linkMedia} from './media.js';
import {liveSceneRows} from './live-scene.js';
import {SEND_LABELS,uncertainSend,sendStateOf,sendLocked,lookupFailureState,sameSend} from './send-state.js';
import {toolStatusLabel,stripAnsi} from './run-log-data.js';

/** New takeover strings resolve from this page's own dictionary; every existing string keeps the global translation. */
const t=(text,params)=>{const own=getLanguage()==='zh'&&typeof text==='string'?pageZh[text]:undefined;return own===undefined?globalT(text,params):params?own.replace(/\{(\w+)\}/g,(m,k)=>params[k]??m):own;};
const names={codex:'Codex',claude:'Claude Code',grok:'Grok',agy:'Agy'};
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const button=(text,fn,cls='secondary')=>{const n=el('button',cls,t(text));n.type='button';n.addEventListener('click',fn);return n;};
const closeButton=fn=>{const n=button('',fn,'icon-button native-close');setActionIcon(n,'close','Close');n.dataset.close='';return n;};

/** The session view reads native history and prepares terminal links. Only after an explicit takeover does it submit turns, resuming the same native ID. */
export function createNativeSessionUI({api,getData,onModeChange,onPreview,onStateRefresh=async()=>{}}){
 const mode=document.querySelector('#navigation-mode'),list=el('nav','project-list native-session-list'),content=el('section','native-session-content panel'),side=el('section','native-session-sidebar');
 list.id='native-session-list';content.id='native-session-content';side.id='native-session-sidebar';
 document.querySelector('#project-list').after(list);document.querySelector('main.workspace').append(content);document.querySelector('#node-sidebar').append(side);
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
  const claim=matches.length===1?matches[0]:null,other=leases.find(c=>owners.has(c.projectId)||c.kind==='native'&&[...ownersFor(c.runtime||c.nativeSession?.runtime,c.sessionId||c.nativeSession?.id).known].some(projectId=>owners.has(projectId)));
  const uncertain=selectedOwners.unknown.size>0||leases.some(c=>c.kind==='native'&&[...ownersFor(c.runtime||c.nativeSession?.runtime,c.sessionId||c.nativeSession?.id).unknown].some(projectId=>owners.has(projectId)));
  const managedBusy=runs.some(r=>r.nodeId===item.nodeId&&!['succeeded','failed','interrupted'].includes(r.status)&&(owners.has(r.projectId)||id&&r.nativeSession?.runtime===item.runtime&&r.nativeSession.id===id));
  let panel=side.querySelector('[data-native-controls]');if(!panel){panel=el('section','native-session-controls');panel.dataset.nativeControls='';side.append(panel);}
  const signature=JSON.stringify([key(item),matches.map(c=>[c.id,c.status,c.processState,c.lastCheckedAt,c.processError]),other?.id,uncertain,managedBusy,worker?.online,worker?.capabilities,returningClaim,controlFeedback]);
  if(panel.dataset.signature===signature)return;panel.dataset.signature=signature;panel.replaceChildren(el('h3','',t('Terminal occupancy')));
  const nativeTurn=claim?.kind==='native-turn';
  const status=matches.length>1?'Several terminal reservations match this session; use role details to check them':nativeTurn?claim.status==='stopping'||takeover.isReleasing(item)?'Ending page takeover; waiting for the CLI to exit…':'Taken over on the Sessions page':!worker?.online?'Device offline; terminal process state unknown':claim?claim.processState==='unknown'?'Terminal process state unverified':claim.status==='stopping'?'Stopping terminal CLI…':claim.status==='active'||claim.processState==='active'?'Terminal CLI is running':claim.status==='finished'?'Waiting for verified return':claim.status==='prepared'?'Waiting to open terminal':'Terminal reserved; refresh to check the process':uncertain?'Native session device ownership is unknown; check the original role session':other?'Another terminal has taken over this group chat':managedBusy?'Managed CLI is running; takeover is unavailable':'Not taken over';
  const state=el('p','workspace-note',t(status));state.setAttribute('role','status');panel.append(state);
  if(claim?.lastCheckedAt)panel.append(el('p','workspace-note',t('Checked at: {time}',{time:time(claim.lastCheckedAt)})));
  if(claim?.processError)panel.append(el('p','workspace-note',t(claim.processError)));
  const project=data.projects?.find(p=>p.id===(claim?.projectId||other?.projectId))||((claim||other)&&owners.size===1?data.projects?.find(p=>owners.has(p.id)):null);if(project)panel.append(el('p','workspace-note',t('Group chat paused on this device: {project}',{project:project.name})));
  if(nativeTurn){
   const pending=claim.status==='stopping'||takeover.isReleasing(item),actions=el('div','native-session-actions'),release=button(pending?'Ending takeover…':'End takeover',()=>void takeover.release(item),'secondary');release.disabled=pending;actions.append(release);panel.append(actions);const feedback=takeover.feedback(item);if(feedback)panel.append(el('p','global-error',feedback));
  }else if(claim){
   panel.append(el('p','workspace-note',t('Exited terminals return automatically within about 15 seconds. Unopened links expire after 5 minutes.')));
   const actions=el('div','native-session-actions');
   const perform=async action=>{
    if(returningClaim)return;
    if(action==='stop'&&!confirm(t('Stop this terminal CLI and return control to Workbench? Unfinished terminal work will be interrupted.')))return;
    returningClaim=claim.id;controlFeedback=null;renderSessionControls(selected);
    try{
     const path=claim.kind==='native'?`${endpoint(claim.nodeId)}/terminal`:claim.kind==='new'?`/api/projects/${encodeURIComponent(claim.projectId)}/roles/${encodeURIComponent(claim.roleId)}/terminal`:`/api/runs/${encodeURIComponent(claim.runId)}/terminal`;
     await api(path,{method:'POST',json:claim.kind==='native'?{action,operationId:claim.id}:{action,id:claim.id}});
     await onStateRefresh();void load({quiet:true});
    }catch(error){controlFeedback={key:key(item),text:error.message};}
    finally{returningClaim=null;renderSessionControls(selected);}
   };
   const release=button('Return to platform',()=>void perform('release')),stop=button('Stop CLI and return',()=>void perform('stop'),'danger');
   release.disabled=Boolean(returningClaim)||!worker?.online;
   stop.disabled=release.disabled||worker?.capabilities?.terminalControl!==1||claim.processState==='unknown';
   if(!worker?.online)release.title=stop.title=t('Device offline; reconnect before stopping the CLI');
   else if(worker?.capabilities?.terminalControl!==1)stop.title=t('Upgrade this Worker to check or stop terminal processes.');
   actions.append(release,stop);panel.append(actions);
  }else if(!matches.length&&!other&&!uncertain&&!managedBusy&&!takeover.isOn(item)&&(item.canReopen||id&&item.hasHistory!==false&&item.canResume!==false)){
   const resume=button(item.canReopen?'Open unstarted session':'Continue in iTerm',()=>openForm(item),'primary');resume.disabled=!worker?.online||worker?.capabilities?.nativeTakeover!==1;panel.append(resume);
   if(worker?.online&&worker.capabilities?.nativeTakeover!==1)panel.append(el('p','workspace-note',t('Upgrade this Worker to safely take over native sessions')));
  }
  if(controlFeedback?.key===key(item))panel.append(el('p','global-error',t(controlFeedback.text)));
 }
 function options(select,values){const old=select.value;select.replaceChildren(...values.map(([value,label])=>{const o=el('option','',label);o.value=value;return o;}));if(values.some(([v])=>v===old))select.value=old;}
 function populate(){const signature=JSON.stringify((getData().workers||[]).map(w=>[w.id,w.name,w.online,w.nodeKind,w.runtimes?.map(r=>[r.type,r.available,r.supported])]));if(signature===lastCatalog)return false;lastCatalog=signature;options(device,[['all',t('All sessions')],['created',t('Created sessions')],['group',t('Group chats')],['local',t('Local machine')],['cloud',t('Servers')],['other',t('Other devices')]]);options(tool,[['all',t('All Agents')],...Object.entries(names)]);return true;}
 function workers(){return(getData().workers||[]).filter(w=>['all','created','group'].includes(device.value)||(device.value==='other'?!['local','cloud'].includes(w.nodeKind):w.nodeKind===device.value));}
 /** Keep the selected name in the shared header, including after state refreshes and selection resets. */
 function renderTitle(){if(!active()||document.body.dataset.workspaceView==='settings')return;const title=document.querySelector('#workspace-title');title.translate=!selected;title.textContent=selected?displayTitle(selected):t('Native sessions');}
 function resetDetail(){detailVersion++;selected=null;renderTitle();detailSignature='';timeline.clear();takeover.detach();content.replaceChildren(el('div','native-empty',t('Select a native session to view its details.')));side.replaceChildren(el('h2','native-side-title',t('Session details')),el('p','native-side-hint',t('Read-only preview. Take over at the bottom to continue here, or open iTerm.')));}
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
 const timeline=createNativeHistoryTimeline({scroll,readPage,t,onLatest:()=>{if(selected)void read(selected);},label:item=>`${time(item.createdAt||item.modifiedAt)} · ${names[item.runtime]} · ${workerName(item.nodeId)} · ${(nativeId(item)||'').slice(0,8)}`,renderMessage(m,item){const text=m.role==='user'?cleanUserText(m.text):m.text,row=chatRow(m.role,text,item.runtime,m.timestamp,null,item);row.dataset.role=m.role;if(m.role==='user')row.dataset.text=text.trim();return row;}});
 async function read(item,{quiet=false}={}){const ticket=++detailVersion;selected=item;renderTitle();renderList();if(!quiet){onPreview?.();takeover.detach();const group=groupNativeSessions(items).find(g=>[g.latest,...g.history].some(row=>key(row)===key(item))),chain=group?[group.latest,...group.history]:[item];timeline.reset(item,chain.slice(chain.findIndex(row=>key(row)===key(item))+1));scroll.replaceChildren(el('p','workspace-note',t('Loading…')));content.replaceChildren(scroll);detailSignature='';}
  try{const id=nativeId(item),readable=id&&item.hasHistory!==false,value=readable?{...item,...await readPage(item,null,quiet?item.historySnapshot:null),id:item.id,entryId:item.entryId,nodeId:item.nodeId,sessionId:id,title:item.title}:item;if(ticket!==detailVersion||!active()||key(selected)!==key(item))return;selected=value;const signature=JSON.stringify(value);if(quiet&&signature===detailSignature)return;detailSignature=signature;const top=scroll.scrollTop,atBottom=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<40;
   const history=timeline.update({...value,...(!value.messages?.length&&!value.notice?{notice:value.canReopen?'This session has not started. Open it to begin chatting.':!readable?'Native session ID has not been linked yet. Existing history is unchanged.':'No text preview is available for this session.'}:{})});
   const historyAt=Date.now();if(!scroll.contains(timeline.root))scroll.replaceChildren(timeline.root,takeover.feed);if(!content.contains(scroll))content.replaceChildren(scroll);
   takeover.attach(value,{readable,historyAt,history});
   renderSide(value,id,readable);
   if(quiet&&!atBottom)scroll.scrollTop=top;else scroll.scrollTop=scroll.scrollHeight;timeline.syncScroll();
  }catch(e){if(ticket===detailVersion){if(quiet)timeline.showError(e);else{timeline.update({messages:[],notice:e.message});timeline.showError(e);scroll.replaceChildren(timeline.root);content.replaceChildren(scroll);renderSide(item,nativeId(item),false);}}}
 }
 /** Same row/bubble structure as the group chat, so both views share one visual language. */
 /** Paths in native replies resolve only inside that registered session's working directory, on its own device. */
 const mediaContext=session=>{const sessionId=session&&(nativeId(session)||session.sessionId);if(!session?.nodeId||!sessionId)return null;
  return {key:`native:${session.nodeId}:${session.runtime}:${sessionId}`,describe:path=>api(`${endpoint(session.nodeId)}/media?${new URLSearchParams({runtime:session.runtime,sessionId,path})}`)};};
 function chatRow(role,text,runtime,at,extra,session){const agent=role!=='user',row=el('article',`chat-row ${agent?'agent':'human'} native-chat-row`);if(agent){const avatar=el('span','chat-avatar');avatar.append(agentIconEl(runtime));row.append(avatar);}
  const col=el('div','chat-col'),header=el('div','chat-message-header'),name=el('div','chat-name',agent?names[runtime]||t('Assistant'):t('Me'));name.translate=false;name.title=name.textContent;header.append(name);col.append(header);
  // Same card anatomy as the group chat: send time on the name line, a status line with its actions at the bottom.
  if(at){const stamp=el('time','',time(at));stamp.dateTime=at;header.append(stamp);}
  const bubble=el('div','chat-bubble'),body=simplifiedCliOutput(text||'');
  if(agent){const md=renderMarkdown(body);md.classList?.add('markdown-body');linkMedia(md,mediaContext(session));bubble.append(md);}else bubble.append(el('div','chat-message-text',body));if(extra)bubble.append(extra);
  const footer=el('div','chat-card-footer'),actions=el('div','chat-card-actions'),copy=el('button','chat-icon-btn');copy.type='button';copy.setAttribute('aria-label',t('Copy'));setActionIcon(copy,'copy',t('Copy'));
  copy.addEventListener('click',()=>void navigator.clipboard?.writeText(body).catch(()=>{}));actions.append(copy);
  footer.append(el('span','chat-card-kind',`${t(agent?'Reply':'Message')} · ${t('Completed')}`),actions);bubble.append(footer);col.append(bubble);row.append(col);return row;}
 function renderSide(value,id,readable){
  side.replaceChildren();const head=el('div','native-side-head'),title=el('h2','native-side-title',t('Session details')),badge=el('span',`native-side-badge ${takeover.isOn(value)?'is-live':''}`,t(takeover.isOn(value)?'Taken over':'Read-only'));head.append(title,badge);side.append(head);
  const card=(heading,rows)=>{const section=el('section','native-side-card');section.append(el('h3','',t(heading)));const list=el('dl','native-session-meta');for(const[label,text,copy]of rows){const term=el('dt','',t(label)),data=el('dd','');const valueText=el('span','native-meta-value',text);valueText.translate=false;data.append(valueText);if(copy){const b=button('',async()=>{try{await navigator.clipboard.writeText(copy);b.classList.add('is-copied');b.title=t('Copied');setTimeout(()=>{b.classList.remove('is-copied');b.title=t('Copy');},1500);}catch{}},'icon-button native-copy');b.title=t('Copy');b.setAttribute('aria-label',t('Copy {label}',{label:t(label)}));b.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';data.append(b);data.classList.add('has-copy');}list.append(term,data);}section.append(list);side.append(section);};
  const agentLine=el('span','native-agent-line');agentLine.append(agentIconEl(value.runtime),el('span','',names[value.runtime]||value.runtime));
  card('Runtime',[['Device',workerName(value.nodeId)],['Agent tool',names[value.runtime]]]);
  side.querySelector('.native-side-card:last-of-type dd:nth-of-type(2) .native-meta-value')?.replaceChildren(agentLine);
  card('Native session',[['Session ID',id||t('Not available yet'),id||null],['Working folder',value.workspace||t('Choose a folder when opening'),value.workspace||null]]);
  const actions=el('section','native-side-card native-side-actions');actions.append(el('h3','',t('Continue')));
  actions.append(el('p','native-side-hint',t(takeover.isOn(value)?'Messages sent below resume this exact native session on its device.':'Read-only preview. Take over at the bottom to continue here, or open iTerm.')));
  side.append(actions);renderSessionControls(value);
 }
 const takeover=createTakeover();
 const IMAGE_CLIS=new Set(['codex','claude']),openTools=new Set();
 const permissionPrompt=value=>value.runtime==='codex'?'Take over with automatic tool approval? Codex can change files inside this session workspace.':'Take over with permission prompts bypassed? {tool} can make changes without asking again.';
 const phaseLabel=turn=>turn.status==='queued'?'Waiting for the device…':turn.status==='stopping'?'Stopping…':turn.phase==='starting'||(!turn.phase||turn.phase==='queued')&&turn.status==='starting'?'Starting the CLI…':turn.phase==='tool'?'Running a tool':turn.phase==='waiting'||turn.status==='waiting_user'?'Waiting':turn.phase==='replying'?'Replying…':turn.phase==='working'?'Working…':'Thinking…';
 /** Codex records an attached image as markup with a Worker-local path; show a short placeholder instead. */
/** CLI titles can start with injected context markup (e.g. <environment_context>); show readable text or the short ID. */
const displayTitle=item=>{const text=String(item.title||'').replace(/<([a-z_-]+)\b[^>]*>[\s\S]*?(<\/\1>|$)/gi,' ').replace(/\s+/g,' ').trim();return text||`${String(item.id||'').slice(0,8)}\u2026`;};
const sizeText=n=>!Number.isFinite(n)?'':n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:`${(n/1048576).toFixed(1)} MB`;
/** Hide CLI-internal stderr logging (timestamped WARN/ERROR lines) from the run process; real errors arrive as error events. */
const cliNoise=text=>/^\s*\d{4}-\d\d-\d\dT\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\b/m.test(stripAnsi(String(text||'')));
const cleanUserText=text=>String(text||'').replace(/<image\b[^>]*>[\s\S]*?<\/image>/gi,'').replace(/\n*Attached files for this message \(local paths\):[\s\S]*$/,'').trim();
/** A turn shows its process only when it holds more than the final reply: tools, runtime notes or intermediate messages. */
const norm=text=>stripAnsi(String(text||'')).replace(/\s+/g,' ').trim();
const allRows=turn=>liveSceneRows(turn.events||[],{status:turn.status}).rows.filter(r=>!(r.kind==='log'&&cliNoise(r.text)));
/** The reply bubble shows the final message; the process keeps intermediate messages once each (streamed text that equals a message is dropped). */
const finalReply=turn=>{const rows=allRows(turn),last=[...rows].reverse().find(r=>r.kind==='message'||r.kind==='text');return last||null;};
const processRows=turn=>{const rows=allRows(turn),messages=new Set(rows.filter(r=>r.kind==='message').map(r=>norm(r.text))),final=finalReply(turn),seen=new Set();
 return rows.filter(r=>{if(r===final)return false;if(r.kind!=='message'&&r.kind!=='text')return true;const n=norm(r.text);if(!n||(r.kind==='text'&&messages.has(n))||seen.has(n)||(final&&n===norm(final.text)))return false;seen.add(n);return true;});};
const replyText=turn=>{const f=finalReply(turn);return f?f.text:turn.text||'';};
const hasProcess=turn=>{const rows=processRows(turn);return rows.some(r=>r.kind==='tool'||r.kind==='log'||r.kind==='error')||rows.some(r=>r.kind==='message'||r.kind==='text');};
const valueText=value=>typeof value==='string'?value:value==null?'':JSON.stringify(value,null,2);
 /** The group-chat live-scene projection orders text, messages, logs and merged tool states for one turn. */
 function processBlock(turn,{open=false}={}){
  const model={rows:processRows(turn)},tools=model.rows.filter(r=>r.kind==='tool').length,live=['queued','starting','running','waiting_user','stopping'].includes(turn.status);
  const box=el('details','native-turn-process');box.open=open;box.dataset.turn=turn.id;
  const summary=el('summary','');summary.append(el('span','native-process-title',t('Run process')),el('span','native-process-count',t('{count} tool calls',{count:tools})));
  const hidden=liveSceneRows(turn.events||[],{status:turn.status}).rows.filter(r=>r.kind==='log'&&cliNoise(r.text)).length;if(hidden){const note=el('span','native-process-hidden',t('{count} CLI notices hidden',{count:hidden}));note.title=t('Timestamped CLI stderr lines (configuration and sandbox notices) are not shown here');summary.append(note);}
  if(live)summary.append(el('span','native-process-phase',`${t(phaseLabel(turn))}${turn.phase==='tool'&&turn.toolName?` · ${turn.toolName}`:''}`));
  box.append(summary);const body=el('div','native-process-body');
  for(const row of model.rows){
   if(row.kind==='tool'){const item=row.item,card=el('details',`live-scene-event is-tool native-process-tool is-${item.status||'call'}`);card.dataset.key=row.key;const openKey=`${turn.id}:${row.key}`;card.open=openTools.has(openKey);card.addEventListener('toggle',()=>card.open?openTools.add(openKey):openTools.delete(openKey));
    const head=el('summary','');const name=el('span','live-scene-tool-name',valueText(item.name||item.command||item.tool||item.title||item.type||t('Tool')).slice(0,160));name.translate=false;head.append(name,el('span','live-scene-tool-state',t(toolStatusLabel(item,turn.status))));card.append(head);
    for(const[label,value]of[['Arguments',item.input??item.arguments??item.parameters],['Changes',item.changes],['Output',item.aggregatedOutput??item.output??item.results??item.result],['Error',item.error]]){if(value===undefined||value===null||value==='')continue;card.append(el('h4','',t(label)),el('pre','',stripAnsi(valueText(value))));}
    if(item.exitCode!=null)card.append(el('small','',t('Exit code {exitCode}',{exitCode:item.exitCode})));body.append(card);}
   else{const card=el('section',`live-scene-event is-${row.kind}`);card.append(el('header','',t(row.kind==='log'||row.kind==='error'?'Runtime event':'Agent output')));card.append(el('pre','',row.kind==='text'||row.kind==='message'?simplifiedCliOutput(stripAnsi(row.text)):stripAnsi(row.text)));body.append(card);}
  }
  if(!model.rows.length)body.append(el('p','live-scene-empty',t('Waiting for recorded execution events…')));
  box.append(body);return box;
 }
 /** Takeover reuses the group-chat composer behaviour: Enter sends, Shift+Enter breaks lines, paste/drag/attach uploads files. An unconfirmed send keeps Send disabled while the same message ID is looked up; only a confirmed absence allows a retry with that ID. */
 function createTakeover(){
  const stored=(name,fallback)=>{try{return JSON.parse(sessionStorage.getItem(name)||JSON.stringify(fallback));}catch{return fallback;}};
  const consentKey='agent-workbench.native-takeover-v3-consent',on=new Set(stored(consentKey,[])),drafts=stored('agent-workbench.native-takeover-drafts',{}),operations=new Map();
  const save=()=>{try{sessionStorage.setItem(consentKey,JSON.stringify([...on]));sessionStorage.setItem('agent-workbench.native-takeover-drafts',JSON.stringify(drafts));}catch{}};
  const feed=el('div','native-takeover-feed'),shell=el('div','chat-composer-shell native-session-footer'),urls=new Map(),openProcesses=new Set();
  let current=null,turns=[],poll=null,historyAt=0,historyEl=null,supported=true,fetchTicket=0,residentState='closed';
  const sessionKey=value=>value?`${value.nodeId}/${value.runtime}/${value.sessionId}`:'';
  const k=()=>sessionKey(current);
  const isOn=value=>on.has(sessionKey(value));
  const operation=(id=k())=>{if(!operations.has(id))operations.set(id,{sending:false,uploads:0,releasing:false,message:''});return operations.get(id);};
  const isReleasing=value=>operation(sessionKey(value)).releasing;
  const activeTurn=()=>turns.find(x=>['queued','starting','running','waiting_user','stopping'].includes(x.status));
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
    const live=['queued','starting','running','waiting_user','stopping'].includes(turn.status);
    if(!live&&turn.endedAt&&turn.prompt.trim()){
     const prompt=turn.prompt.trim(),index=rows.findIndex((row,i)=>!used.has(i)&&row.dataset.role==='user'&&row.dataset.text===prompt);
     if(index>=0){used.add(index);let anchor=rows[index];for(let i=index+1;i<rows.length&&rows[i].dataset.role!=='user';i++)anchor=rows[i];
      if(turn.attachments?.length){const files=el('div','chat-attachments native-turn-files native-turn-anchored');for(const item of turn.attachments)files.append(attachmentCard(item));rows[index].querySelector('.chat-col')?.append(files);}
      const extra=el('div','native-turn-anchored');
      if(hasProcess(turn)){const block=processBlock(turn,{open:openProcesses.has(turn.id)});block.addEventListener('toggle',()=>block.open?openProcesses.add(turn.id):openProcesses.delete(turn.id));extra.append(block);}
      if(turn.status!=='succeeded')extra.append(el('span','native-turn-error',`${t(turn.status==='interrupted'?'Interrupted':'Failed')}${turn.error?` \u00b7 ${t(turn.error)}`:''}`));
      if(extra.childElementCount)anchor.after(extra);continue;}
    }
    let files=null;if(turn.attachments?.length){files=el('div','chat-attachments native-turn-files');for(const item of turn.attachments)files.append(attachmentCard(item));}
    feed.append(chatRow('user',turn.prompt,current.runtime,turn.createdAt,files));
    const meta=el('div','native-turn-state');
    if(live){const dots=el('span','native-turn-live');dots.setAttribute('aria-hidden','true');meta.append(dots,el('span','',`${t(phaseLabel(turn))}${turn.phase==='tool'&&turn.toolName?` · ${turn.toolName}`:''}`),button('Stop',()=>stop(turn),'secondary compact'));}
    else if(turn.status!=='succeeded')meta.append(el('span','native-turn-error',`${t(turn.status==='interrupted'?'Interrupted':'Failed')}${turn.error?` · ${t(turn.error)}`:''}`));
    const extra=el('div','native-turn-extra');const block=processBlock(turn,{open:live||openProcesses.has(turn.id)});block.addEventListener('toggle',()=>{if(!live)block.open?openProcesses.add(turn.id):openProcesses.delete(turn.id);});
    if(live||hasProcess(turn))extra.append(block);if(meta.childElementCount)extra.append(meta);
    feed.append(chatRow('assistant',replyText(turn),current.runtime,null,extra,current));
   }}
  function render(){
   if(!current)return;const value=current,taken=isOn(value);shell.replaceChildren();renderFeed();
   if(!taken){const bar=el('div','native-takeover-bar');const copy=el('div','native-takeover-copy');copy.append(el('strong','',t('Read-only preview')),el('span','',t(supported?'Take over to keep chatting in this exact native session here.':'Upgrade this Worker to take over native sessions')));const b=button('Take over session',()=>{if(!confirm(t(permissionPrompt(value),{tool:names[value.runtime]||value.runtime})))return;on.add(k());save();render();renderSide(value,value.sessionId,true);input.focus();},'primary native-takeover-button');b.disabled=!supported;bar.append(copy,b);shell.append(bar);return;}
   const id=k(),d=draft(id),op=operation(id),busy=Boolean(activeTurn());
   const form=el('form','chat-composer native-takeover-form'),barRow=el('div','chat-input-bar'),field=el('div','chat-input-field'),note=el('p','workspace-note native-takeover-note'),tray=el('div','chat-attachments native-takeover-tray');
   input.placeholder=t('Message {tool}; replies continue this native session',{tool:names[value.runtime]||value.runtime});if(input.value!==d.text)input.value=d.text||'';
   note.textContent=op.message||'';note.hidden=!note.textContent;const state=sendState(d,op);
   for(const item of d.attachments||[])tray.append(attachmentCard(item,()=>{if(!d.pending)void removeAttachment(id,value.nodeId,item);}));
   if(op.uploads)tray.append(el('span','attachment-uploading',t('Uploading attachments…')));tray.hidden=!tray.childElementCount;
   sendButton.disabled=op.sending||op.releasing||busy||op.uploads>0||sendLocked(state)||Boolean(op.verifying);sendButton.textContent=t(SEND_LABELS[state]||'Send');input.disabled=op.sending||op.releasing||Boolean(d.pending);attachButton.disabled=op.sending||op.releasing||Boolean(d.pending);
   field.append(tray,attachButton,input);barRow.append(field,sendButton);
   const release=button(op.releasing?'Ending takeover…':'End takeover',()=>void endTakeover(value),'secondary compact native-release');release.disabled=busy||op.sending||op.uploads>0||op.releasing;
   const status=el('div','native-takeover-status');status.append(el('span',`native-takeover-dot${residentState==='open'?' is-resident':''}`),el('span','',t(op.releasing?'Ending page takeover; waiting for the CLI to exit…':busy?'This session is replying…':residentState==='open'?'Taken over · CLI is resident; messages continue this native session':'Taken over · the next message starts the CLI')),release);
   if(!IMAGE_CLIS.has(value.runtime))status.append(el('span','native-takeover-limit',t('{tool} cannot receive images here; files are passed as paths',{tool:names[value.runtime]})));
   form.append(status,note,barRow);form.addEventListener('submit',e=>{e.preventDefault();void submit();});shell.append(form);resize();
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
  shell.addEventListener('drop',e=>{shell.classList.remove('is-dragging');if(e.dataTransfer?.files.length&&current&&isOn(current)){e.preventDefault();void upload(e.dataTransfer.files);}});
  const resize=()=>{input.style.height='auto';input.style.height=`${Math.min(120,Math.max(40,input.scrollHeight))}px`;};
  input.addEventListener('input',()=>{draft().text=input.value;save();resize();});
  input.addEventListener('keydown',e=>{if(window.matchMedia('(max-width: 1000px)').matches)return;if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&!sendButton.disabled){e.preventDefault();input.form?.requestSubmit();}});
  async function submit(){if(!current||activeTurn())return;const id=k(),value=current,d=draft(id),op=operation(id);if(op.sending||op.releasing||op.uploads)return;
   // An in-flight or unknown send is only looked up again (click, double click, Enter); it is never resent with a new ID.
   if(d.pending&&d.sendState!=='failed'){void verifyTurn(id);return;}
   if(!d.pending&&!input.value.trim()&&!d.attachments?.length)return;op.message='';
   if(!d.pending){const payload={text:input.value,attachmentIds:(d.attachments||[]).map(a=>a.id)};
    // A retry of exactly the content Home rejected keeps its id; any edit gets a new id, never the old one.
    d.pending={clientTurnId:sameSend(d.rejected?.payload,payload)?d.rejected.clientTurnId:crypto.randomUUID(),...payload};}
   delete d.rejected;d.sendState='sending';const sent=d.pending;save();op.sending=true;render();
   try{const turn=await api(`${endpoint(value.nodeId)}/turns`,{method:'POST',json:{runtime:value.runtime,sessionId:value.sessionId,allowAll:true,...d.pending}});drafts[id]={text:'',attachments:[]};if(k()===id){input.value='';turns=[...turns.filter(x=>x.id!==turn.id),turn];}}
   catch(error){if(uncertainSend(error))d.sendState='checking';else{const {clientTurnId,...payload}=sent;d.rejected={clientTurnId,payload};delete d.pending;delete d.sendState;}op.message=t(error.message);}
   finally{op.sending=false;save();if(current){render();schedule();if(k()===id)scroll.scrollTop=scroll.scrollHeight;if(drafts[id]?.pending&&drafts[id].sendState==='checking')void verifyTurn(id);}}}
  async function stop(turn){const op=operation();try{const next=await api(`${turnsUrl()}/${encodeURIComponent(turn.id)}/stop`,{method:'POST',json:{}});turns=turns.map(x=>x.id===next.id?next:x);render();}catch(error){op.message=t(error.message);render();}}
  async function refresh(){if(!current)return;const ticket=++fetchTicket,id=k(),op=operation(id);try{const result=await api(`${turnsUrl()}?${new URLSearchParams({runtime:current.runtime,sessionId:current.sessionId})}`);if(ticket!==fetchTicket||k()!==id)return;const wasActive=Boolean(activeTurn()),bottom=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<80;supported=result.supported!==false;residentState=result.process||'closed';turns=result.items||[];{const d=drafts[id];if(d?.pending&&!op.sending&&turns.some(x=>x.clientTurnId===d.pending.clientTurnId))settleTurn(id,d.pending);}if(op.releasing&&residentState==='closed'){op.releasing=false;on.delete(id);save();await onStateRefresh();}render();renderSide(current,current.sessionId,true);if(wasActive&&!activeTurn()&&selected)void read(selected,{quiet:true});schedule();if(bottom)scroll.scrollTop=scroll.scrollHeight;}catch(error){op.message=t(error.message);render();schedule();}}
  function schedule(){clearInterval(poll);poll=null;if(current&&(activeTurn()||operation().releasing))poll=setInterval(()=>{if(!document.hidden)void refresh();},1000);}
  return {feed,attach,detach,isOn,isReleasing,feedback:value=>operation(sessionKey(value)).message,release:endTakeover,refresh,recheck};
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
  async function browse(target,offset=0,append=false){const ticket=++pickerVersion;newFolder.update();use.disabled=true;more.disabled=true;message.textContent=t('Loading…');if(!append)rows.replaceChildren();
   try{const result=await api(`${endpoint(nodeId)}/folders?${new URLSearchParams({...target?{path:target}:{},offset:String(offset)})}`);if(ticket!==pickerVersion||!picker.open)return;current=result.path;parent=result.parent;up.disabled=!parent;location.textContent=current||t('Allowed folders');nextOffset=result.nextOffset||0;more.hidden=!result.hasMore;
    for(const item of result.entries||(result.folders||[]).map(f=>({...f,type:'folder',workspace:f.path}))){const row=el('div','native-picker-row'),pick=button('',()=>select(item),'native-picker-item');pick.dataset.path=item.path;pick.setAttribute('aria-label',t('Select {name}',{name:item.name}));const icon=el('span','native-picker-glyph');icon.setAttribute('aria-hidden','true');icon.innerHTML=item.type==='folder'?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 6h7l2 3h9v11H3Z"/></svg>':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h4M9 12h6m-6 4h6"/></svg>';const name=el('span','',item.name);name.translate=false;pick.append(icon,name);pick.title=item.path;row.append(pick);
     if(item.type==='folder'){pick.addEventListener('dblclick',()=>browse(item.path));const enter=button('›',()=>browse(item.path),'icon-button native-picker-enter');enter.setAttribute('aria-label',t('Open folder {name}',{name:item.name}));row.append(enter);}rows.append(row);
    }select(append&&chosen?chosen:current?{path:current,workspace:current,type:'folder'}:null);
    newFolder.update({nodeId,path:current,enabled:getData().workers?.find(w=>w.id===nodeId)?.capabilities?.directoryCreate===1});
   }catch(error){if(ticket===pickerVersion){chosen=null;message.textContent=t(error.message);use.disabled=true;}}finally{if(ticket===pickerVersion)more.disabled=false;}
  }
  actions.append(button('Cancel',()=>picker.close()),use);picker.append(heading,toolbar,newFolder.panel,location,rows,more,selection,message,actions);
  const closeWithParent=()=>picker.close();dialog.addEventListener('close',closeWithParent);picker.addEventListener('close',()=>{pickerVersion++;dialog.removeEventListener('close',closeWithParent);},{once:true});picker.showModal();void browse(path||null);
 }
 function openForm(session=null,defaults={}){populate();dialog.replaceChildren();const heading=el('div','dialog-heading');heading.append(el('h2','',t(session?.canReopen?'Open unstarted session':session?'Continue native session':'New native session')),closeButton(()=>dialog.close()));dialog.append(heading);
  const form=el('form','native-session-form'),d=el('select'),r=el('select'),folder=el('input'),all=el('input'),title=el('input');d.required=r.required=folder.required=title.required=true;title.type='text';title.maxLength=120;title.placeholder=t('Give this session a title');title.value=session?.title||'';title.readOnly=Boolean(session);folder.type='text';folder.value=session?.workspace||'';folder.placeholder=t('Select a working folder');all.type='checkbox';all.id='native-allow-all';all.checked=false;
  const field=(label,input,full=false)=>{const l=el('label',`native-field${full?' native-full':''}`,t(label));input.setAttribute('aria-label',t(label));l.append(input);form.append(l);return l;};
  options(d,(getData().workers||[]).map(w=>[w.id,`${w.name||w.id}${w.online?'':` · ${t('Offline')}`}`]));if(session?.nodeId)d.value=session.nodeId;else if(defaults.nodeId)d.value=defaults.nodeId;else if(workers()[0])d.value=workers()[0].id;
  const updateTools=()=>{options(r,(getData().workers?.find(w=>w.id===d.value)?.runtimes||[]).filter(x=>x.available&&x.supported!==false&&names[x.type]).map(x=>[x.type,names[x.type]]));};updateTools();if(session?.runtime)r.value=session.runtime;else if(defaults.runtime)r.value=defaults.runtime;else if(tool.value!=='all'&&[...r.options].some(o=>o.value===tool.value))r.value=tool.value;d.disabled=r.disabled=Boolean(session);if(session?.workspace)folder.readOnly=true;
  field('Session title',title,true);field('Device',d);field('Agent tool',r);const folderField=field('Working folder',folder,true),pathRow=el('div','native-workspace-row');
  const feedback=el('p','native-form-feedback native-full'),launch=el('div','native-launch-result native-full');feedback.setAttribute('role','status');
  const browseButton=button('Select file or folder',()=>openFilePicker({nodeId:d.value,path:folder.value,locked:session?.workspace||null,onUse:path=>{folder.value=path;folder.dispatchEvent(new Event('change',{bubbles:true}));}}));setActionIcon(browseButton,'folder');pathRow.append(folder,browseButton);folderField.append(pathRow);
  if(session?.workspace)form.append(el('p','workspace-note native-full',t('An existing session keeps its original working folder.')));
  const permissions=el('label','native-permissions native-full');permissions.append(all,el('span','',t('Allow all operations (bypass native permission prompts)')));form.append(permissions,el('p','workspace-note native-full',t('Default uses native permissions. A related group chat waits while this terminal owns its folder; closing the CLI returns it automatically.')));
  const submit=el('button','primary',t('Prepare iTerm launch')),actions=el('div','native-session-actions native-full');submit.type='submit';actions.append(submit);form.append(feedback,actions,launch);dialog.append(form);
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
  form.addEventListener('submit',async e=>{e.preventDefault();if(!title.value.trim()){title.focus();feedback.textContent=t('Enter a session title.');return;}submit.disabled=true;for(const input of[d,r,folder,all,title,browseButton])input.disabled=true;feedback.textContent=t('Preparing…');launch.replaceChildren();
   const input={runtime:r.value,sessionId:session&&!session.canReopen?nativeId(session):null,...(session?.entryId?{entryId:session.entryId}:{}),title:title.value.trim(),workspace:folder.value.trim(),allowAll:all.checked,useLocalSshKey:true},signature=JSON.stringify([d.value,input]);if(signature!==lastInput){operationId=crypto.randomUUID();lastInput=signature;}
   try{const result=await api(`/api/native-sessions/${encodeURIComponent(d.value)}/terminal`,{method:'POST',json:{...input,operationId}});prepared={nodeId:d.value,operationId};opened=false;if(!dialog.open||!dialog.contains(form)){await releaseUnused();return;}feedback.textContent=t('Ready. Open iTerm to start or resume the native CLI.');const a=el('a','primary',t('Open iTerm'));a.href=result.url;a.addEventListener('click',()=>{opened=true;});launch.append(a,button('Copy terminal command',async()=>{await navigator.clipboard.writeText(result.command);opened=true;feedback.textContent=t('Copied');}));void load({quiet:true});}catch(error){feedback.textContent=t(error.message);}finally{submit.disabled=false;d.disabled=r.disabled=Boolean(session);folder.disabled=all.disabled=title.disabled=browseButton.disabled=false;}
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
 return {active,openNew:(defaults={})=>openForm(null,defaults),sync(){const changed=populate(),visible=active();list.hidden=filters.hidden=note.hidden=side.hidden=!visible;content.hidden=!visible||document.body.dataset.workspaceView==='settings';if(visible&&document.body.dataset.workspaceView!=='settings'){renderTitle();renderList();document.querySelector('#show-project-form').setAttribute('aria-label',t('New native session'));if(selected)renderSessionControls(selected);if(changed)refresh();takeover.recheck();}else document.querySelector('#show-project-form').setAttribute('aria-label',t('New project'));},refresh};
}
