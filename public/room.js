import { t, dateLocale } from './i18n.js';
import { agentIconEl, UI_ICON, workerDisplayName } from './role-icons.js';
import { renderMarkdown, linkRunDocuments } from './markdown.js';
import { createHistoryViewer } from './history-view.js';
import {createRoleSwitchUI} from './role-switch.js';
import {createRoleHistoryTabs} from './role-history.js';

/** Long text only changes its carrier; the file content keeps the original line breaks, whitespace and trailing characters. */
export function longTextFileName(text) {
  if (text.length <= 8000 && text.split(/\r\n|\r|\n/).length <= 80) return null;
  const title = text.split(/\r\n|\r|\n/).find(line => line.trim()) || 'Pasted text';
  const stem = [...title.replace(/^\s*#+\s*/, '').replace(/[\x00-\x1f/\\:*?"<>|]/g, '_').trim()].slice(0, 48).join('') || 'Pasted text';
  return `${stem.replace(/\.(md|markdown|txt)$/i, '')}.md`;
}

/** Merge device probes per project; only queries status and never restarts, resumes or dispatches any role task. */
export function createRoleRefresh({api,refreshState,getData,getProject,button,feedback,onUpdate=()=>{}}) {
  let busy=false;
  const notices=new Map(),checks=new Map();
  const binding=role=>JSON.stringify([role.nodeId,role.runtime,role.model]);
  const setCheck=(role,state)=>checks.set(role.id,{...state,binding:binding(role),checkedAt:new Date().toISOString()});
  const transient=error=>![401,403,429].includes(error.status)&&(error.isNetworkError||error.status>=500||/timed? ?out|disconnect|ECONNRESET|ETIMEDOUT|temporarily unavailable|超时|断开|暂时不可用/i.test(error.message||''));
  const rolesFor=id=>(getData().roles||[]).filter(role=>role.projectId===id&&!role.archivedAt);
  function update() {
    const project=getProject(),notice=notices.get(project?.id);
    button.disabled=busy||!project||!rolesFor(project.id).length;
    button.classList.toggle('is-refreshing',busy);button.setAttribute('aria-busy',String(busy));
    button.title=busy?'Querying CLI status and remaining quota…':'Refresh role status and remaining quota';
    feedback.hidden=!notice;feedback.textContent=notice||'';
  }
  async function refresh() {
    const project=getProject();
    if(busy||!project||!rolesFor(project.id).length)return;
    const roles=rolesFor(project.id),workers=getData().workers||[],groups=new Map();
    for(const role of roles){const group=groups.get(role.nodeId)||[];group.push(role);groups.set(role.nodeId,group);}
    busy=true;notices.set(project.id,'Refreshing CLI status and remaining quota…');for(const role of roles)setCheck(role,{state:'checking'});update();onUpdate();
    const warnings=[];let checked=0,retried=0;
    try {
      await Promise.all([...groups].map(async([nodeId,members])=>{
        const worker=workers.find(item=>item.id===nodeId),label=worker?.name||members.map(role=>role.name).join(t(', '));
        if(!worker?.online){warnings.push(t('{label}: device offline or not connected', { label }));for(const role of members)setCheck(role,{state:'failed',error:'Device offline or not connected'});return;}
        if(!worker.capabilities?.runtimeDiscovery){warnings.push(t('{label}: Worker does not support status refresh', { label }));for(const role of members)setCheck(role,{state:'failed',error:'Worker does not support status refresh; please update the device'});return;}
        try {
          let result;
          for(let attempt=0;attempt<2;attempt++){
            try{
              result=await api(`/api/workers/${encodeURIComponent(nodeId)}/runtimes`,{method:'POST',json:{},signal:AbortSignal.timeout(30000)});
              const temporary=result.runtimes?.find(r=>members.some(role=>role.runtime===r.type)&&!r.available&&transient({message:r.reason}));
              if(!attempt&&temporary){retried++;continue;}
              break;
            }catch(error){if(attempt||!transient(error))throw error;retried++;}
          }
          checked++;
          for(const role of members){const report=result.runtimes?.find(r=>r.type===role.runtime);setCheck(role,report?{state:'checked',report}:{state:'failed',error:'No check result returned for this CLI'});}
          for(const runtime of new Set(members.map(role=>role.runtime))) {
            const report=result.runtimes?.find(item=>item.type===runtime);
            const names=members.filter(role=>role.runtime===runtime).map(role=>role.name).join(t(', '));
            if(!report?.available)warnings.push(t('{names}: CLI unavailable', { names }));
            else if(report.quotaStatus!=='ok'||report.quotaStale||!report.quota)warnings.push(t('{names}: latest quota not obtained', { names }));
          }
        }catch(error){warnings.push(t('{label}: {message}', { label, message: error.message }));for(const role of members)setCheck(role,{state:'failed',error:error.message});}
      }));
      await refreshState({quiet:true});
      const devices = t(checked===1?'{count} device':'{count} devices', { count: checked });
      notices.set(project.id,`${warnings.length?t('Checked {devices}; {warnings}. Quota that could not be obtained keeps its previous value or is unknown', { devices, warnings: warnings.join(t('; ')) }):t('Refreshed role status and quota on {devices} · {time}', { devices, time: new Date().toLocaleTimeString(dateLocale()) })}${retried?t(retried===1?' · {count} transient check failure was retried':' · {count} transient check failures were retried', { count: retried }):''}${t('. Old tasks were not re-run; history is preserved.')}`);
    }catch(error){notices.set(project.id,t('Refresh incomplete: {message}', { message: error.message }));}
    finally{busy=false;update();onUpdate();}
  }
  button.addEventListener('click',()=>void refresh());
  update();
  return {refresh,update,getCheck:role=>{const check=checks.get(role.id);return check?.binding===binding(role)?check:null;}};
}

/** Keep the full streamed body; the CLI completion snapshot replaces the current segment to avoid duplicating delta and snapshot. */
export function extractLiveText(events) {
  const paragraphs=[]; let pending='', tool='';
  for(const event of events || []) {
    const p=event.payload || {}, text=p.text || p.message || '';
    if(event.type==='text')pending+=text;
    else if(event.type==='message' && text) {
      if(p.phase==='final_answer') { paragraphs.length=0; pending=text; }
      else { if(paragraphs.at(-1)!==text)paragraphs.push(text); pending=''; }
    } else if(event.type==='tool')tool=p.text || p.name || 'Working';
  }
  return [...paragraphs,pending].filter(Boolean).join('\n\n').trim() || (tool?t('{tool}…', { tool }):'');
}

/** A chat notice for a failed final state must not overwrite the streamed body already received. */
export function fullRunReply(run, text, message) { return run?.result || text || message?.text || ''; }

/** Delivery status does not mean understanding or business approval; late records can only serve as historical material. */
export function discussionDisplay(message,data) {
  if(message.kind!=='discussion'||!message.discussion?.messageId)return null;
  const meta=message.discussion,thread=data.discussionThreads?.find(t=>t.id===meta.threadId),delivery=data.discussionDeliveries?.find(d=>d.messageId===meta.messageId);
  const to=data.roles?.find(r=>r.id===meta.toRoleId)?.name||data.runs?.find(r=>r.roleId===meta.toRoleId)?.roleSnapshot?.name||meta.toRoleId;
  const historical=meta.late||(thread&&thread.currentQuestionId!==meta.questionId);
  const task=data.tasks?.find(t=>t.id===thread?.taskId),blocked=task?.discussionResumeBlocked;
  const after=blocked?data.runs?.find(r=>r.id===blocked.afterRunId):null;
  const canResume=!historical&&thread?.status==='resolved'&&!blocked?.confirmed&&blocked?.threadId===thread.id&&['failed','interrupted'].includes(after?.status)
    &&!after.stopRequested&&!after.controlLost&&after.discussionCleanup?.turnEnded===true&&after.discussionCleanup?.toolsClosed===true;
  const canStop=!historical&&task?.status!=='cancelled'&&Boolean(task?.currentRunId)
    &&(task.discussionWait?.threadId===thread?.id||blocked?.threadId===thread?.id);
  const state=historical?'Historical note; task not resumed':thread?.status==='resolved'?'Question resolved':thread?.status==='cancelled'?'Question cancelled':
    ({queued:'Awaiting delivery',dispatched:'Delivering',runtime_accepted:'Delivered; awaiting response',consumed:'Message handled',failed:'No valid reply received',reconciling:'Execution state to be reconciled',cancelled:'Cancelled',superseded:'Superseded'}[delivery?.status]||'Recorded');
  const detail=task?.status==='cancelled'?'Original task stopped':!historical&&blocked?.threadId===thread?.id?task.waitingReason:!historical&&thread?.status==='open'?(delivery?.status==='queued'?delivery.waitingReason:delivery?.error):null;
  return {to,thread,state:detail?`${state} · ${detail}`:state,canReply:!historical&&thread?.status==='open',canResume,resumeAfterRunId:canResume?after.id:null,canStop,stopRunId:canStop?task.currentRunId:null,questionId:meta.questionId};
}

/** Identify the reply target from the real call relationship; when history pagination lacks the question card, call records can still locate it. */
export function dialogueReplyDirection(message,messages,data) {
  if(message.sender!=='agent'||message.kind==='handoff'||message.id!==`result-${message.runId}`)return null;
  const call=messages.find(m=>m.id===message.replyToId&&m.projectId===message.projectId)?.handoff;
  if(call)return {from:message.senderName,to:call.fromRole};
  const run=data.runs?.find(r=>r.id===message.runId&&r.projectId===message.projectId);
  const request=data.requests?.find(r=>r.id===run?.requestId&&r.projectId===message.projectId);
  if(!request?.parentRequestId||request.kind==='continuation')return null;
  const parent=data.requests?.find(r=>r.id===request.parentRequestId&&r.projectId===message.projectId);
  const role=data.roles?.find(r=>r.id===parent?.targetRoleId&&r.projectId===message.projectId)
    ||data.runs?.find(r=>r.roleId===parent?.targetRoleId&&r.projectId===message.projectId)?.roleSnapshot;
  return role?{from:message.senderName,to:role.name}:null;
}

/** Subtasks created by the supervisor's plan may not be written to a visible message's taskIds, yet must still appear in the live chat area. */
export function unlinkedLiveTasks(messages, tasks, runs, projectId) {
  const linkedTaskIds=new Set(messages.flatMap(message=>message.taskIds || []));
  const reportedRunIds=new Set(messages.map(message=>message.runId).filter(Boolean));
  const runById=new Map(runs.map(run=>[run.id,run]));
  return tasks.filter(task=>{
    if(task.switchOperationId || task.projectId!==projectId || linkedTaskIds.has(task.id))return false;
    const run=task.currentRunId ? runById.get(task.currentRunId) : null;
    if(run && reportedRunIds.has(run.id))return false;
    if(run)return ['queued','starting','running','waiting_user','stopping','reconciling'].includes(run.status);
    return ['ready','in_progress'].includes(task.status);
  }).sort((a,b)=>String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

/** Show existing dispatches without creating a separate queue; request retries reuse the ID to avoid repeated interruptions. */
function createMessageQueue({api,refreshState,create,setError}) {
  const panel=document.querySelector('#message-queue'),summary=panel.querySelector('summary'),list=panel.querySelector('.message-queue-list');
  const commands=new Map(),pending=new Set();let currentProject=null;
  return {update(data,projectId){
    if(currentProject!==projectId){panel.open=false;currentProject=projectId;}
    const tasks=(data.tasks||[]).filter(t=>t.projectId===projectId&&t.origin==='chat'&&t.status==='ready'&&!t.currentRunId)
      .sort((a,b)=>Number(Boolean(b.steering))-Number(Boolean(a.steering)));
    panel.hidden=!tasks.length;summary.textContent=t('Queue · {v}', { v: tasks.length });list.replaceChildren();
    for(const [i,task] of tasks.entries()) {
      const row=create('div','message-queue-item'),info=create('div','message-queue-info');
      const title=create('strong','',`${i+1}. @${task.roleSnapshot?.name||t('Role')} · ${task.title||task.prompt}`);title.title=task.prompt||task.title;
      info.append(title,create('span','',task.steering?(task.waitingReason||'Continuing with the new instruction first'):(task.waitingReason||'Waiting to run')));row.append(info);
      // Supervisor plans/consultations are not messages the user just sent and must not pose as a manual steering entry.
      if(!task.planId&&!task.scheduledJobId&&!task.continuationRunId&&!task.requiresCoordination) {
        const steer=create('button','secondary compact',task.steering?'Steering':'Steer now');steer.type='button';
        steer.title='Stop this role\'s current run and continue with this message after confirmation; actions already performed are not rolled back';
        steer.disabled=Boolean(task.steering)||pending.has(task.id)||data.settings?.paused||!data.capabilities?.roleSteering;
        if(!data.capabilities?.roleSteering)steer.title='Steer now becomes available after the service is upgraded';
        steer.onclick=async()=>{
          pending.add(task.id);steer.disabled=true;
          if(!commands.has(task.id))commands.set(task.id,crypto.randomUUID());
          try {await api(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/steer`,{method:'POST',json:{commandId:commands.get(task.id)}});await refreshState({quiet:true});}
          catch(error){setError(error.message);}
          finally{pending.delete(task.id);steer.disabled=Boolean(task.steering)||data.settings?.paused;}
        };
        row.append(steer);
      }
      const cancel=create('button','icon-button','×');cancel.type='button';cancel.title='Cancel queued item';cancel.setAttribute('aria-label',t('Cancel queued item {v} {v2}', { v: task.roleSnapshot?.name||t('Role'), v2: task.title||'' }));
      cancel.disabled=pending.has(task.id);cancel.onclick=async()=>{
        cancel.disabled=true;try{await api(`/api/tasks/${encodeURIComponent(task.id)}/cancel`,{method:'POST',json:{}});await refreshState({quiet:true});}catch(error){setError(error.message);cancel.disabled=false;}
      };row.append(cancel);list.append(row);
    }
  }};
}

/** The chat only handles display and user actions; role selection, idempotency and scheduling are validated by Home. */
export function createRoomUI({ api, refreshState, openTask, stopRun, decideApproval, create, formatTime, setError, configureDevice }) {
  const historyViewer=createHistoryViewer({api});
  const messageQueue=createMessageQueue({api,refreshState,create,setError});
  const feed = document.querySelector('#chat-feed');
  // Configuration, plans and messages share one scroll area so status cards do not permanently crowd out the body.
  const scroller = document.querySelector('#chat-scroll');
  const form = document.querySelector('#chat-form');
  const input = form.elements.text;
  const send = form.querySelector('[type="submit"]');
  const quoteBar = document.querySelector('#chat-quote');
  const roleDialog = document.querySelector('#role-dialog');
  const roleForm = document.querySelector('#role-form');
  const roleHistory=createRoleHistoryTabs({host:roleDialog,settings:roleForm,getData:()=>data,getRole:()=>editingRoleSnapshot,api,refreshState,create,formatTime,openTask});
  const cliSwitch=createRoleSwitchUI({api,refreshState});
  const roleError = document.querySelector('#role-error');
  const older = document.querySelector('#load-older');
  const mentionMenu = document.querySelector('#mention-menu');
  const attachTray = document.querySelector('#chat-attachments');
  const fileInput = document.querySelector('#chat-file-input');
  const attachButton = document.querySelector('#chat-attach');
  const uploadCounts = new Map();
  const textUploads = new Map();
  const attachmentUrls = new Map();
  const previewDialog = create('dialog', 'attachment-dialog');
  document.body.append(previewDialog);
  window.addEventListener('pagehide', () => { for (const promise of attachmentUrls.values()) void promise.then(url => URL.revokeObjectURL(url)).catch(()=>{}); });

  /** Preview and download reuse the authenticated API and never put the access token in a link. */
  function attachmentUrl(item) {
    const key = `${item.projectId}:${item.id}`;
    if (!attachmentUrls.has(key)) attachmentUrls.set(key, api(`/api/projects/${encodeURIComponent(item.projectId)}/attachments/${item.id}`, { blob:true }).then(blob => URL.createObjectURL(blob)).catch(e => { attachmentUrls.delete(key); throw e; }));
    return attachmentUrls.get(key);
  }
  /** Markdown attachments reuse the safe renderer; viewing and copying both use the full body. */
  function previewText(text, name, downloadUrl = null) {
    previewDialog.className = 'message-fullscreen';
    previewDialog.setAttribute('aria-label', 'Full attachment text');
    const header = create('div', 'message-fullscreen-heading');
    header.append(create('strong', '', name), copyMessageButton(text), iconAction('back', 'Close attachment preview', () => previewDialog.close()));
    if (downloadUrl) header.insertBefore(iconAction('original', 'Download original', () => {
      const link = create('a'); link.href = downloadUrl; link.download = name; link.click();
    }), header.lastChild);
    const body = create('div', 'message-fullscreen-body');
    const content = create('div', 'message-fullscreen-content');
    content.append(/\.(md|markdown)$/i.test(name) ? renderMarkdown(text) : create('pre', 'attachment-text', text));
    body.append(content); previewDialog.replaceChildren(header, body);
    if (!previewDialog.open) previewDialog.showModal();
  }
  function restoreText(ownerId, text) {
    const d = drafts[ownerId];
    d.text = `${d.text || ''}${d.text ? '\n\n' : ''}${text}`;
    d.inlineLongText = true;
    if (ownerId === projectId) { input.value = d.text; resizeInput(); }
  }
  function attachmentCard(item, removable = false, ownerId = projectId) {
    const card = create('div', `attachment-card${removable && item.pastedText ? ' attachment-text-card' : ''}`);
    const open = button('', async () => {
      try {
        const url = await attachmentUrl(item);
        if (item.mime.startsWith('image/')) {
          previewDialog.className = 'attachment-dialog';
          previewDialog.setAttribute('aria-label', 'Image preview');
          previewDialog.replaceChildren();
          const image = create('img'); image.src = url; image.alt = item.name;
          previewDialog.append(button('Close',()=>previewDialog.close()), image, create('p','',item.name));
          previewDialog.showModal();
        } else if (/\.(md|markdown|txt)$/i.test(item.name)) {
          const response = await fetch(url);
          previewText(await response.text(), item.name, url);
        } else {
          const link = create('a'); link.href = url; link.download = item.name; link.click();
        }
      } catch (e) { setError(e.message); }
    }, 'attachment-open');
    if (item.mime.startsWith('image/')) {
      const thumb = create('img'); thumb.alt = item.name; open.append(thumb);
      void attachmentUrl(item).then(url=>{thumb.src=url;}).catch(()=>{thumb.alt='Preview failed to load; click to retry';});
    } else open.append(create('span','attachment-file-icon','▤'));
    open.append(create('span','attachment-name',item.name),create('small','',item.size<1024?`${item.size} B`:`${(item.size/1024).toFixed(1)} KB`));
    card.append(open);
    if (removable && item.pastedText) card.append(button('Show in text box', async b => {
      const d = drafts[ownerId];
      if (!d || d.pending || sendingProject === ownerId) return;
      b.disabled = true;
      try {
        const text = await (await fetch(await attachmentUrl(item))).text();
        if (d.pending || sendingProject === ownerId || !d.attachments?.some(a => a.id === item.id)) return;
        restoreText(ownerId, text);
        d.attachments = d.attachments.filter(a => a.id !== item.id); saveDrafts();
        if (ownerId === projectId) composer();
      } catch (error) { setError(error.message); }
      finally { b.disabled = false; }
    }, 'attachment-restore'));
    card.append(iconAction('transfer', 'Send to device', () => openAttachmentTransfer(item)));
    if (removable) card.append(button('×', () => {
      const d = drafts[ownerId]; if (d?.pending || sendingProject === ownerId) return;
      d.attachments = (d.attachments || []).filter(a=>a.id!==item.id); saveDrafts(); composer();
    },'attachment-remove'));
    return card;
  }

  let transferDialog;
  /** File transfer is independent of dispatch: the user picks a target device and the Worker writes to the project temp folder. */
  function openAttachmentTransfer(item) {
    if(!transferDialog){transferDialog=create('dialog','attachment-transfer-dialog');transferDialog.setAttribute('aria-label','Send to device');document.body.append(transferDialog);}
    transferDialog.replaceChildren();
    const header=create('div','dialog-heading');header.append(create('h2','','Send to device'),button('Close',()=>transferDialog.close()));
    const select=create('select');select.setAttribute('aria-label','Target device');
    const bindings=(data.workspaces||[]).filter(w=>w.projectId===item.projectId);
    const workers=(data.workers||[]).filter(w=>bindings.some(b=>b.nodeId===w.id)).sort((a,b)=>Number(b.nodeKind==='cloud')-Number(a.nodeKind==='cloud'));
    for(const worker of workers){const ready=worker.online&&worker.capabilities?.attachmentTransfer===1;const option=create('option','',`${workerDisplayName(worker)}${!worker.online?t(' · Offline'):!ready?t(' · Upgrade required'):''}`);option.value=worker.id;option.disabled=!ready;select.append(option);}
    select.value=workers.find(w=>w.online&&w.capabilities?.attachmentTransfer===1)?.id||'';
    const status=create('p','workspace-note');status.setAttribute('role','status');
    const paths=create('div','attachment-transfer-paths');
    const action=button('Transfer file',async b=>{
      const nodeId=select.value;if(!nodeId)return;
      let id=requestIds.get(nodeId);
      if(!id){id=crypto.randomUUID();requestIds.set(nodeId,id);}
      b.disabled=true;select.disabled=true;status.textContent='Transferring and verifying the file, please wait…';
      try {
        const result=await api(`/api/projects/${encodeURIComponent(item.projectId)}/attachment-transfers`,{method:'POST',json:{clientTransferId:id,nodeId,attachmentIds:[item.id]}});
        await refreshState({quiet:true});
        status.textContent='Transfer complete; file size and SHA-256 verified.';showPaths(result.files);b.textContent='Send another';requestIds.delete(nodeId);
      } catch(e) {status.textContent=t('Transfer incomplete: {message}. Click retry to reuse the same batch.', { message: e.message });b.textContent='Retry transfer';}
      finally {b.disabled=false;select.disabled=false;}
    },'primary');
    const requestIds=new Map();
    function showPaths(files) {
      paths.replaceChildren();
      for(const file of files||[]) {const row=create('div','attachment-transfer-path');row.append(create('code','',file.path),copyMessageButton(file.path));paths.append(row);}
    }
    function targetChanged() {
      action.disabled=!select.value;action.textContent='Transfer file';paths.replaceChildren();
      const binding=bindings.find(b=>b.nodeId===select.value);
      status.textContent=binding?t('Target folder: {localRoot}/.workbench/tmp/attachments/. Files only; no model is started.', { localRoot: binding.localRoot }):'No device can receive files right now. Prepare a folder in Project Settings and confirm the device is online in Basic Settings.';
      const recent=(data.attachmentTransfers||[]).filter(t=>t.projectId===item.projectId&&t.nodeId===select.value&&t.attachmentIds.includes(item.id)).at(-1);
      if(recent?.status==='completed'){showPaths(recent.files);action.textContent='Send another';}
      else if(recent && recent.attachmentIds.length===1 && ['failed','transferring'].includes(recent.status)){requestIds.set(select.value,recent.id);action.textContent='Retry transfer';}
      if(!recent) {
        const run=(data.runs||[]).filter(r=>r.projectId===item.projectId&&r.nodeId===select.value&&r.attachmentFiles?.some(f=>f.id===item.id)).at(-1);
        if(run)showPaths(run.attachmentFiles.filter(f=>f.id===item.id));
      }
    }
    select.onchange=targetChanged;
    transferDialog.append(header,create('p','',item.name),select,status,paths,action);
    targetChanged();transferDialog.showModal();
  }
  async function uploadFiles(files) {
    if (!projectId || draft().pending || sendingProject === projectId) return;
    const id = projectId, d = draft(), incoming = [...files];
    if ((d.attachments?.length || 0) + (d.textFiles?.length || 0) + (uploadCounts.get(id) || 0) + incoming.length > 6) { setError('At most 6 attachments per message'); return; }
    if (incoming.some(f=>!f.size || f.size>20*1024*1024)) { setError('Attachments cannot be empty; each file is limited to 20 MB'); return; }
    uploadCounts.set(id,(uploadCounts.get(id)||0)+incoming.length); composer();
    for (const file of incoming) {
      try {
        const item = await api(`/api/projects/${encodeURIComponent(id)}/attachments`, {method:'POST',body:file,headers:{'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(file.name || 'pasted-image.png')}});
        (d.attachments ||= []).push(item); saveDrafts();
      } catch(e) { setError(e.message); }
      finally { uploadCounts.set(id,Math.max(0,(uploadCounts.get(id)||0)-1)); if (id===projectId) composer(); }
    }
  }
  /** Save a recoverable text draft first, then upload; on failure the card keeps the original text and sending without the attachment is blocked. */
  function uploadTextFile(entry, ownerId) {
    if (textUploads.has(entry.id)) return textUploads.get(entry.id);
    const d = drafts[ownerId];
    const job = Promise.resolve().then(async () => {
      entry.error = ''; if (ownerId === projectId) composer();
      try {
        const file = new File([entry.text], entry.name, { type: 'text/markdown;charset=utf-8' });
        const item = await api(`/api/projects/${encodeURIComponent(ownerId)}/attachments`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(entry.name) } });
        (d.attachments ||= []).push({ ...item, pastedText: true });
        d.textFiles = d.textFiles.filter(value => value.id !== entry.id);
      } catch (error) { entry.error = error.message; }
      finally { textUploads.delete(entry.id); saveDrafts(); if (ownerId === projectId) composer(); }
    });
    textUploads.set(entry.id, job); return job;
  }
  function textDraftCard(entry, ownerId) {
    const card = create('div', 'attachment-card attachment-text-card attachment-text-draft');
    const busy = textUploads.has(entry.id);
    const open = button('', () => previewText(entry.text, entry.name), 'attachment-open');
    open.append(create('span', 'attachment-file-icon', '▤'), create('span', 'attachment-name', entry.name), create('small', '', busy ? 'Uploading…' : entry.error ? 'Upload failed; original text kept' : 'Pending upload'));
    card.append(open);
    if (!busy) {
      card.append(button(entry.error ? 'Retry upload' : 'Upload', () => { void uploadTextFile(entry, ownerId); }, 'attachment-restore'));
      card.append(button('Show in text box', () => {
        const d = drafts[ownerId]; restoreText(ownerId, entry.text);
        d.textFiles = d.textFiles.filter(value => value.id !== entry.id); saveDrafts(); composer();
      }, 'attachment-restore'));
      card.append(button('×', () => {
        drafts[ownerId].textFiles = drafts[ownerId].textFiles.filter(value => value.id !== entry.id); saveDrafts(); composer();
      }, 'attachment-remove'));
    }
    if (entry.error) card.title = entry.error;
    return card;
  }
  function queueTextFile(text, remaining) {
    if (!projectId || draft().pending || sendingProject === projectId) return null;
    const d = draft(), ownerId = projectId;
    if ((d.attachments?.length || 0) + (d.textFiles?.length || 0) + (uploadCounts.get(ownerId) || 0) >= 6) { setError('Attachments are full; the long text stays in the input box. Remove an attachment first'); return null; }
    if (new Blob([text]).size > 20 * 1024 * 1024) { setError('Text exceeds the 20 MB per-attachment limit; the original is kept, please split it before sending'); return null; }
    const entry = { id: crypto.randomUUID(), name: longTextFileName(text) || 'Pasted text.md', text };
    const previous = d.text;
    (d.textFiles ||= []).push(entry); d.text = remaining;
    if (!saveDrafts()) { d.textFiles.pop(); d.text = previous; return null; }
    d.inlineLongText = false;
    input.value = remaining; hideMentionMenu();
    void uploadTextFile(entry, ownerId); composer(); return entry;
  }
  function attachComposerText() {
    const text = input.value;
    // Keep the explicit mention at the start of the input; the full body still goes into the attachment to avoid rerouting to the supervisor.
    const mentions = text.match(/^(?:@[\p{L}\p{N}_-]+[ \t]*)+/u)?.[0] || '';
    return queueTextFile(text, mentions);
  }
  attachButton.addEventListener('click',()=>fileInput.click());
  fileInput.addEventListener('change',()=>{void uploadFiles(fileInput.files);fileInput.value='';});
  input.addEventListener('paste',e=>{
    const items=[...(e.clipboardData?.items||[])].filter(i=>i.kind==='file').map(i=>i.getAsFile()).filter(Boolean);
    const files=items.length?items:[...(e.clipboardData?.files||[])];
    if(files.length){e.preventDefault();void uploadFiles(files);return;}
    const text = e.clipboardData?.getData('text/plain') || '';
    if (longTextFileName(text)) {
      const remaining = input.value.slice(0, input.selectionStart) + input.value.slice(input.selectionEnd);
      if (queueTextFile(text, remaining)) e.preventDefault();
    }
  });
  const inputField=document.querySelector('.chat-input-field');
  inputField.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files')){e.preventDefault();inputField.classList.add('is-dragging');}});
  inputField.addEventListener('dragleave',()=>inputField.classList.remove('is-dragging'));
  inputField.addEventListener('drop',e=>{inputField.classList.remove('is-dragging');if(e.dataTransfer?.files.length){e.preventDefault();void uploadFiles(e.dataTransfer.files);}});
  function resizeInput() { input.style.height='auto'; input.style.height=`${Math.min(120,Math.max(40,input.scrollHeight))}px`; }
  let mentionChoices = [];
  let mentionIndex = 0;
  let mentionRange = null;
  const histories = new Map();
  const pendingReads = new Set();
  const liveByRun = new Map();
  const liveFetching = new Set();
  let data = {}, projectId = null, editingProjectId = null, editingRoleId = null;
  let sendingProject = null, savingRole = false;
  let preferredModel = '', preferredRuntime = 'codex', preferredEffort = '', checkingRuntime = false;
  let drafts;
  try { drafts = JSON.parse(sessionStorage.getItem('agent-workbench.chat-drafts')) || {}; } catch { drafts = {}; }
  const saveDrafts = () => {
    try { sessionStorage.setItem('agent-workbench.chat-drafts', JSON.stringify(drafts)); return true; }
    catch { setError('Not enough browser draft storage; the original text is still on this page. Copy a backup first and do not close the page'); return false; }
  };
  const draft = () => drafts[projectId] ||= { text: '', replyToId: null, replyLabel: '' };
  const status = r => ({ queued: 'Preparing', starting: 'Starting', running: 'Running', waiting_user: 'Awaiting approval', stopping: 'Stopping', reconciling: 'Awaiting reconciliation', succeeded: 'Completed', interrupted: 'Stopped', failed: 'Failed' }[r?.status] || 'Waiting to run');
  const button = (label, action, className = 'secondary compact') => {
    const b = create('button', className, label); b.type = 'button'; b.addEventListener('click', () => action(b)); return b;
  };
  function iconAction(name, title, action) {
    const b = create('button', 'chat-icon-btn');
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = UI_ICON[name] || '';
    b.addEventListener('click', e => { e.stopPropagation(); action(b); });
    return b;
  }

  function composer() {
    if (!projectId) return;
    input.placeholder = data.projects?.find(p => p.id === projectId)?.supervisorRoleId ? 'Tell the supervisor what to do; @ one role to dispatch directly, @ several and the supervisor arranges them' : 'Type a message; @role to start work';
    const d = draft(), busy = sendingProject === projectId;
    input.disabled = busy || !!d.pending;
    send.disabled = !!sendingProject || Boolean(uploadCounts.get(projectId)) || Boolean(d.textFiles?.length);
    attachButton.disabled = busy || !!d.pending;
    send.textContent = busy ? 'Sending…' : d.pending ? 'Retry send' : 'Send';
    attachTray.replaceChildren();
    for (const item of d.attachments || []) attachTray.append(attachmentCard(item,true));
    for (const entry of d.textFiles || []) attachTray.append(textDraftCard(entry, projectId));
    if (uploadCounts.get(projectId)) attachTray.append(create('span','attachment-uploading','Uploading attachments…'));
    attachTray.hidden = !attachTray.childElementCount;
    resizeInput();
    quoteBar.replaceChildren(); quoteBar.hidden = !d.replyToId;
    if (d.replyToId) quoteBar.append(create('span', '', t('Quoting {replyLabel}', { replyLabel: d.replyLabel })), button('Cancel', () => {
      if (d.pending || busy) return;
      d.replyToId = null; d.replyLabel = ''; delete d.discussion;saveDrafts(); composer();
    }));
    const note = document.querySelector('#chat-send-note');
    if (note) {
      note.hidden = !d.pending;
      note.textContent = d.pending ? 'Sending is not yet confirmed; clicking Send retries the same message without dispatching twice.' : '';
    }
  }

  function liveText(runId) {
    return liveByRun.get(runId)?.text || '';
  }

  async function pullLive(runId) {
    if (!runId || liveFetching.has(runId)) return;
    liveFetching.add(runId);
    try {
      const prior=liveByRun.get(runId);
      const result = await api(`/api/runs/${encodeURIComponent(runId)}/events?after=${prior?.seq || 0}`);
      const events = [...new Map([...(prior?.events || []),...(Array.isArray(result?.events)?result.events:[])].map(e=>[e.seq,e])).values()].sort((a,b)=>a.seq-b.seq);
      const text = extractLiveText(events);
      const prev = liveByRun.get(runId)?.text || '';
      liveByRun.set(runId, { text, events, seq:events.at(-1)?.seq || 0, at: Date.now() });
      updateLiveFullscreen();
      if (text !== prev && projectId) renderMessages();
    } catch {
      if(fullscreenView?.runId===runId)fullscreenView.heading.textContent='Live reply · connection unavailable; content already received is kept';
    } finally { liveFetching.delete(runId); }
  }

  function quoteReply(m) {
    if (draft().pending || sendingProject === projectId) return;
    Object.assign(draft(), { replyToId: m.id, replyLabel: t('{senderName}: {v}', { senderName: m.senderName, v: m.text.slice(0, 100) }) });
    delete draft().discussion;
    saveDrafts(); composer(); input.focus();
  }

  function avatarFor(roleOrRuntime, name) {
    const runtime = typeof roleOrRuntime === 'string' ? roleOrRuntime : roleOrRuntime?.runtime;
    const wrap = create('span', 'chat-avatar');
    wrap.append(agentIconEl(runtime, name));
    return wrap;
  }

  function chatMeta(timeText, actions) {
    const meta = create('div', 'chat-meta');
    if (timeText) meta.append(create('time', '', timeText));
    for (const node of actions || []) meta.append(node);
    return meta;
  }

  /** Copy the original message text without the rendered action buttons, time or quote summary. */
  function copyMessageButton(text) {
    const copy = iconAction('copy', 'Copy', async b => {
      b.disabled = true;
      try {
        const value=typeof text==='function'?text():text;
        if (!value) { b.disabled=false;return; }
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
        else {
          // Plain HTTP access has no Clipboard API; fall back to the browser's user-click copy ability.
          const field = create('textarea', 'sr-only');
          const focused = document.activeElement;
          field.value = value; field.readOnly = true; document.body.append(field);
          try {
            field.select();
            if (!document.execCommand('copy')) throw new Error('The browser did not allow copying');
          } finally { field.remove(); focused?.focus({ preventScroll: true }); }
        }
        b.innerHTML = UI_ICON.check;
        b.title = 'Copied'; b.setAttribute('aria-label', 'Copied');
        setTimeout(() => {
          b.innerHTML = UI_ICON.copy;
          b.title = 'Copy'; b.setAttribute('aria-label', 'Copy'); b.disabled = false;
        }, 1500);
      } catch {
        b.disabled = false;
        setError('Copy failed. Allow clipboard access, or select the text and copy it manually.');
      }
    });
    copy.disabled = !text;
    return copy;
  }

  /** Collapsing only affects display; viewing and copying the full text always use the complete original. */
  const renderLinkedMarkdown=(text,runId)=>linkRunDocuments(renderMarkdown(text),runId);
  function replyPreview(text, markdown = true, runId = null) {
    const preview = create('div', 'chat-reply-preview');
    preview.append(markdown ? renderLinkedMarkdown(text,runId) : create('div', 'chat-message-text', text));
    return preview;
  }

  let messageFullscreen, fullscreenView;
  /** Update only the same run that is open; stop auto-scrolling after the user scrolls up manually. */
  function updateLiveFullscreen() {
    const view=fullscreenView;
    if(!messageFullscreen?.open || !view?.taskId)return;
    const task=data.tasks?.find(t=>t.id===view.taskId);
    view.runId ||= task?.currentRunId;
    const run=data.runs?.find(r=>r.id===view.runId);
    const message=histories.get(view.projectId)?.messages.find(m=>m.id===`result-${view.runId}`);
    const text=fullRunReply(run,liveText(view.runId),message);
    const label=run?status(run):task?.waitingReason || (task?.status==='cancelled'?'Cancelled':'Waiting to start');
    view.heading.textContent=`${view.name || t('Role')} · ${label}`;
    view.copy.disabled=!text;
    if(text===view.text && view.label===label)return;
    const top=view.body.scrollTop;
    view.text=text;view.label=label;
    view.content.replaceChildren(text?renderLinkedMarkdown(text,view.runId):create('p','workspace-note',t('{label}; no reply content received yet.', { label })));
    view.body.scrollTop=view.follow?view.body.scrollHeight:top;
  }
  /** Open the full-screen reading layer on demand; no extra overlays are permanently shown on the normal chat page. */
  function fullscreenMessageButton(text, name, markdown = true, attachments = [], taskId = null, runId = null) {
    return iconAction('fullscreen', 'Full screen', () => {
      if (!messageFullscreen) {
        messageFullscreen = create('dialog', 'message-fullscreen');
        messageFullscreen.setAttribute('aria-label', 'Full reply');
        messageFullscreen.addEventListener('close',()=>{fullscreenView=null;});
        document.body.append(messageFullscreen);
      }
      const header = create('div', 'message-fullscreen-heading');
      const close = iconAction('close', 'Close', () => messageFullscreen.close());
      close.autofocus = true;
      const heading=create('strong', '', t('{v} · Full reply', { v: name || t('Message') }));
      const view={text,name,taskId,projectId,follow:true,runId};
      const copy=copyMessageButton(()=>view.text);
      header.append(heading,copy,close);
      const body = create('div', 'message-fullscreen-body');
      const content = create('div', 'message-fullscreen-content');
      content.append(markdown ? renderLinkedMarkdown(text,runId) : create('div', 'chat-message-text', text));
      if (attachments.length) {
        const files = create('div', 'chat-attachments');
        for (const item of attachments) files.append(attachmentCard(item));
        content.append(files);
      }
      body.append(content);
      Object.assign(view,{body,content,copy,heading});fullscreenView=view;
      if(taskId) {
        const follow=iconAction('follow','Follow latest reply',()=>{view.follow=true;body.scrollTop=body.scrollHeight;follow.setAttribute('aria-pressed','true');});
        follow.setAttribute('aria-pressed','true');header.insertBefore(follow,copy);
        body.addEventListener('scroll',()=>{view.follow=body.scrollHeight-body.clientHeight-body.scrollTop<40;follow.setAttribute('aria-pressed',String(view.follow));});
      }
      messageFullscreen.replaceChildren(header, body);
      messageFullscreen.showModal();
      updateLiveFullscreen();
      if(view.runId)void pullLive(view.runId);
    });
  }

  function renderApprovalsInline(run) {
    const list = (data.approvals || []).filter(a => a.runId === run.id && ['pending', 'waiting'].includes(a.status));
    if (!list.length) return null;
    const wrap = create('div', 'chat-approvals');
    for (const approval of list) {
      const card = create('div', 'chat-approval');
      const method = approval.method?.includes('fileChange') ? 'File change' : approval.method?.includes('command') ? 'Command' : 'Action';
      card.append(create('p', '', t('Confirmation needed: {method}', { method })));
      const actions = create('div', 'chat-approval-actions');
      const accept = button('Approve', b => decideApproval(approval, 'accept', b, decline), 'primary compact');
      const decline = button('Reject', b => decideApproval(approval, 'decline', b, accept), 'secondary compact');
      actions.append(accept, decline);
      card.append(actions);
      wrap.append(card);
    }
    return wrap;
  }

  function renderLiveBubble(task, messages) {
    const run = data.runs?.find(r => r.id === task.currentRunId);
    if (run && messages.some(m => m.runId === run.id)) return null;
    const role = task.roleSnapshot || {};
    const row = create('article', 'chat-row agent is-live');
    row.append(avatarFor(role, role.name));
    const col = create('div', 'chat-col');
    const label = run ? status(run) : task.status === 'cancelled' ? 'Cancelled' : task.status === 'blocked' ? (task.error || 'Blocked') : task.waitingReason || 'Waiting to be scheduled';
    col.append(create('div', 'chat-name', `@${role.name || t('Role')} · ${label}`));
    const bubble = create('div', 'chat-bubble');
    const preview = run ? liveText(run.id) : '';
    if (preview) bubble.append(replyPreview(preview,true,run?.id));
    else {
      const typing = create('div', 'chat-typing');
      typing.append(create('span'), create('span'), create('span'));
      bubble.append(typing, create('span', 'chat-typing-label', label));
    }
    col.append(bubble);
    const alert=run&&data.runAlerts?.find(a=>a.id===run.id);
    if(alert)col.append(create('p','run-alert',alert.reason));
    const approvals = run ? renderApprovalsInline(run) : null;
    if (approvals) col.append(approvals);
    const actions = [];
    if (preview) actions.push(copyMessageButton(preview));
    actions.push(fullscreenMessageButton(preview, role.name, true, [], task.id, run?.id));
    if (run && ['queued', 'starting', 'running', 'waiting_user'].includes(run.status)) {
      actions.push(iconAction('stop', 'Stop', b => stopRun(run, b)));
    }
    if (task.status === 'ready' && !run) {
      actions.push(iconAction('stop', 'Cancel queued item', async b => {
        b.disabled = true;
        try { await api(`/api/tasks/${encodeURIComponent(task.id)}/cancel`, { method: 'POST', json: {} }); await refreshState({ quiet: true }); }
        catch (e) { setError(e.message); b.disabled = false; }
      }));
    }
    if (run) actions.push(iconAction('log', 'Log', () => openTask(task.id,run.id)));
    if (actions.length) col.append(chatMeta('', actions));
    row.append(col);
    if (run && ['starting', 'running', 'waiting_user', 'stopping'].includes(run.status)) void pullLive(run.id);
    return row;
  }

  function renderMessageRow(m, messages) {
    const agent = m.sender === 'agent';
    const handoff = m.kind === 'handoff' && m.handoff;
    const replyDirection=dialogueReplyDirection(m,messages,data);
    const discussion=discussionDisplay(m,data);
    const row = create('article', `chat-row ${agent ? 'agent' : 'human'}${handoff || replyDirection ? ' is-handoff' : ''}`);
    const role = agent ? (data.roles || []).find(r => r.id === m.roleId) || (data.runs || []).find(r => r.id === m.runId)?.roleSnapshot : null;
    if (agent) row.append(avatarFor(role, m.senderName));
    const col = create('div', 'chat-col');
    col.append(create('div', 'chat-name', agent ? `@${m.senderName}` : m.broadcast ? 'Me · notify everyone' : 'Me'));
    const bubble = create('div', `chat-bubble${handoff || replyDirection ? ' handoff-card' : ''}`);
    if(discussion){const title=create('div','handoff-title');title.append(create('strong','',`${m.senderName||t('Me')} → @${discussion.to}`));bubble.append(title,create('div','handoff-label',t('Peer discussion · {state}', { state: discussion.state })));}
    if (m.replyToId) {
      const source = messages.find(q => q.id === m.replyToId);
      bubble.append(create('div', 'quoted-message', source ? t('{senderName}: {v}', { senderName: source.senderName, v: source.text.slice(0, 180) }) : 'Quoting an earlier message'));
    }
    if (handoff) {
      const title = create('div', 'handoff-title');
      title.append(create('strong', '', `@${m.handoff.fromRole}`), create('span', '', '→'), create('strong', '', `@${m.handoff.toRole}`));
      bubble.append(title, create('div', 'handoff-label', m.handoff.kind==='consult'?'Role conversation · question':'Collaboration handoff'), replyPreview(m.handoff.summary || m.text,true,m.runId));
    } else {
      if(replyDirection) {
        const title=create('div','handoff-title');
        title.append(create('strong','',`@${replyDirection.from}`),create('span','','→'),create('strong','',`@${replyDirection.to}`));
        bubble.append(title,create('div','handoff-label','Role conversation · reply'));
      }
      bubble.append(replyPreview(m.text, agent, m.runId));
    }
    if (m.attachments?.length) {
      const files = create('div','chat-attachments');
      for(const item of m.attachments) files.append(attachmentCard(item));
      bubble.append(files);
    }
    if(!discussion && (handoff||!agent)) {
      const ids=handoff?[m.requestId]:(m.taskIds||[]).map(id=>data.tasks?.find(t=>t.id===id)?.requestId).filter(Boolean);
      for(const id of ids) {
        const request=data.requests?.find(r=>r.id===id),progress=request?.messageProgress;
        if(!progress)continue;
        const target=data.roles?.find(r=>r.id===request.targetRoleId)?.name;
        const note=create('div',`message-progress${progress.attention?' needs-attention':''}`,`${target?`@${target} · `:''}${progress.label}`);
        const times={registeredAt:'Registered',sentAt:'Sent',receivedAt:'Device acknowledged',startedAt:'Run started',resultAt:'Run ended',resumeStartedAt:'Initiator resumed'};
        note.dataset.stage=progress.stage;note.title=[progress.reason,...Object.entries(progress.timestamps||{}).filter(([,v])=>v).map(([k,v])=>t('{v}: {time}', { v: times[k]||k, time: formatTime(v) }))].filter(Boolean).join('\n');
        bubble.append(note);
      }
    }
    const actions = [iconAction('quote', 'Quote', () => quoteReply(m))];
    if(discussion?.canReply) {
      actions.push(iconAction('reply','Reply to this question',()=>{quoteReply(m);draft().discussion={threadId:discussion.thread.id,expectedQuestionId:discussion.questionId,revision:discussion.thread.revision,directionRevision:discussion.thread.directionRevision};saveDrafts();}));
    }
    if(discussion?.canReply||discussion?.canResume) {
      actions.push(iconAction('check',discussion.canResume?'Changes verified; continue the original task':'Mark question as handled',async b=>{
        b.disabled=true;const requestId=`user-${discussion.canResume?'resume':'resolve'}:${discussion.thread.id}:${discussion.questionId}:${discussion.thread.revision}`;
        try{await api(`/api/projects/${encodeURIComponent(m.projectId)}/discussions/${encodeURIComponent(discussion.thread.id)}/resolve`,{method:'POST',json:{requestId,expectedQuestionId:discussion.questionId,revision:discussion.thread.revision,directionRevision:discussion.thread.directionRevision,...(discussion.canResume?{resumeAfterRunId:discussion.resumeAfterRunId}:{}),conclusion:discussion.canResume?'User reviewed the exception log and actual changes and explicitly chose to continue the original task':'User explicitly marked this question as handled in the web UI'}});await refreshState({quiet:true});}catch(e){setError(e.message);b.disabled=false;}
      }));
    }
    if(discussion?.canStop)actions.push(iconAction('stop','Stop original task',async b=>{
      b.disabled=true;
      try{await api(`/api/runs/${encodeURIComponent(discussion.stopRunId)}/stop`,{method:'POST',json:{commandId:`discussion-owner-stop:${discussion.stopRunId}:${discussion.questionId}`}});await refreshState({quiet:true});}catch(e){setError(e.message);b.disabled=false;}
    }));
    actions.push(copyMessageButton(handoff ? m.handoff.summary || m.text : m.text));
    actions.push(fullscreenMessageButton(handoff ? m.handoff.summary || m.text : m.text, m.senderName, true, m.attachments, null, m.runId));
    actions.push(iconAction('original','Original',()=>{void historyViewer.open(m.projectId,m.runId&&!discussion?'result':'message',m.runId&&!discussion?m.runId:m.id).catch(e=>setError(e.message));}));
    if(m.runId&&!discussion) {
      const report=data.runReports?.find(r=>r.id===m.runId);
      const run=data.runs?.find(r=>r.id===m.runId);
      if(!run?.discussionWaiting&&(report||run?.reportRequired)) bubble.append(create('div','report-verdict',t('Business verdict: {v}', { v: ({passed:t('Passed'),failed:t('Not passed'),blocked:t('Blocked'),needs_input:t('User decision needed')}[report?.verdict])||t('To verify') })));
    }
    if (m.runId) {
      const run = data.runs?.find(r => r.id === m.runId);
      if (run) actions.push(iconAction('log', 'Log', () => openTask(run.taskId,run.id)));
    }
    col.append(bubble, chatMeta(formatTime(m.createdAt), actions));
    row.append(col);
    return row;
  }

  function renderMessages() {
    const history = histories.get(projectId), messages = history?.messages || [];
    const scrollTop = scroller.scrollTop;
    const atBottom = scroller.scrollHeight - scroller.clientHeight - scrollTop < 120;
    feed.replaceChildren();
    older.hidden = !history?.hasMore;
    if (!messages.length) feed.append(create('div', 'chat-empty', history
      ? 'This is the project chat. Without @ it is only logged; @someone dispatches to them; @everyone only sends a notification and does not start an Agent.'
      : 'Loading chat…'));
    for (const m of messages) {
      feed.append(renderMessageRow(m, messages));
      for (const id of m.taskIds || []) {
        const task = data.tasks?.find(t => t.id === id);
        if (!task) continue;
        const live = renderLiveBubble(task, messages);
        if (live) feed.append(live);
      }
    }
    for(const task of unlinkedLiveTasks(messages,data.tasks || [],data.runs || [],projectId)) {
      const live=renderLiveBubble(task,messages);
      if(live)feed.append(live);
    }
    for(const run of (data.runs||[]).filter(r=>r.projectId===projectId&&r.discussionDeliveryId&&['queued','starting','running','waiting_user','stopping','reconciling'].includes(r.status))) {
      const live=renderLiveBubble({id:run.taskId,currentRunId:run.id,roleSnapshot:run.roleSnapshot},messages);if(live)feed.append(live);
    }
    scroller.scrollTop = atBottom ? scroller.scrollHeight : scrollTop;
    updateLiveFullscreen();
  }

  /** Read messages by Room revision; Token updates only refresh cards and do not re-fetch the whole history. */
  async function refresh(nextData, nextProjectId) {
    data = nextData;
    roleHistory.refresh();
    if (roleDialog.open && !savingRole && !checkingRuntime) renderDeviceOptions(roleForm.elements.nodeId.value);
    if (projectId !== nextProjectId) {
      if(messageFullscreen?.open)messageFullscreen.close();
      projectId = nextProjectId;
      if (projectId) input.value = draft().text || '';
    }
    if (!projectId) return;
    messageQueue.update(data,projectId);composer(); renderMessages();
    for (const run of (data.runs || []).filter(r => r.projectId === projectId && ['starting', 'running', 'waiting_user', 'stopping'].includes(r.status))) {
      void pullLive(run.id);
    }
    const viewing=data.runs?.find(r=>r.id===fullscreenView?.runId);
    if(viewing && (liveByRun.get(viewing.id)?.seq || 0)<viewing.lastSeq)void pullLive(viewing.id);
    const revision = data.rooms?.find(r => r.id === projectId)?.revision || 0;
    const previous = histories.get(projectId);
    if (previous?.revision === revision) return;
    const id = projectId, key = `${id}:${revision}`;
    if (pendingReads.has(key)) return;
    pendingReads.add(key);
    try {
      const result = await api(`/api/projects/${encodeURIComponent(id)}/messages`);
      const current = histories.get(id);
      if ((current?.revision ?? -1) > revision) return;
      const recentIds = new Set(result.messages.map(m => m.id));
      histories.set(id, { ...result, messages: [...(current?.messages || []).filter(m => !recentIds.has(m.id)), ...result.messages],
        hasMore: current ? current.hasMore : result.hasMore, nextBefore: current?.nextBefore || result.nextBefore, revision });
      if (id === projectId) renderMessages();
    } catch (e) { if (id === projectId) setError(t('Failed to load chat: {message}', { message: e.message })); }
    finally { pendingReads.delete(key); }
  }

  older.addEventListener('click', async () => {
    const id = projectId, history = histories.get(id); if (!history?.nextBefore) return;
    older.disabled = true;
    try {
      const result = await api(`/api/projects/${encodeURIComponent(id)}/messages?before=${encodeURIComponent(history.nextBefore)}`);
      if (id !== projectId) return;
      const current = histories.get(id), ids = new Set(current.messages.map(m => m.id));
      const height = scroller.scrollHeight, top = scroller.scrollTop;
      histories.set(id, { ...current, messages: [...result.messages.filter(m => !ids.has(m.id)), ...current.messages], hasMore: result.hasMore, nextBefore: result.nextBefore });
      renderMessages(); scroller.scrollTop = top + scroller.scrollHeight - height;
    } catch (e) { setError(e.message); } finally { older.disabled = false; }
  });

  function projectRoles() {
    return (data.roles || []).filter(r => r.projectId === projectId && r.enabled);
  }

  function mentionQuery() {
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, caret);
    const match = before.match(/(^|[\s,.!?;:(\u3001\uFF0C\u3002\uFF01\uFF1F\uFF1B\uFF1A\uFF08])@([\p{L}\p{N}_-]*)$/u);
    if (!match) return null;
    return { start: match.index + match[1].length, end: caret, query: match[2] };
  }

  function hideMentionMenu() {
    if (!mentionMenu) return;
    mentionMenu.hidden = true;
    mentionMenu.replaceChildren();
    mentionChoices = [];
    mentionRange = null;
  }

  function applyMention(name) {
    if (!mentionRange) return;
    const { start, end } = mentionRange;
    const next = `${input.value.slice(0, start)}@${name} ${input.value.slice(end)}`;
    input.value = next;
    const pos = start + name.length + 2;
    input.setSelectionRange(pos, pos);
    if (projectId) { draft().text = next; saveDrafts(); }
    hideMentionMenu();
    input.focus();
  }

  function renderMentionMenu() {
    if (!mentionMenu) return;
    mentionRange = mentionQuery();
    if (!mentionRange || input.disabled) { hideMentionMenu(); return; }
    const q = mentionRange.query.toLowerCase();
    const roles = projectRoles().filter(r => !q || r.name.toLowerCase().includes(q));
    const everyone = !q || 'everyone'.includes(q) || 'all'.startsWith(q);
    mentionChoices = [...(everyone ? [{ name: 'everyone', everyone: true }] : []), ...roles];
    if (!mentionChoices.length) { hideMentionMenu(); return; }
    mentionIndex = Math.min(mentionIndex, mentionChoices.length - 1);
    mentionMenu.replaceChildren();
    mentionChoices.forEach((item, i) => {
      const row = create('button', `mention-item${i === mentionIndex ? ' active' : ''}`);
      row.type = 'button';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === mentionIndex));
      if (item.everyone) row.append(create('span', 'mention-mark', '@'), create('span', '', 'everyone'), create('em', '', 'Notification only; does not start an Agent'));
      else {
        row.append(agentIconEl(item.runtime, item.name), create('span', '', `@${item.name}`), create('em', '', item.model || item.runtime || ''));
      }
      row.addEventListener('mousedown', e => { e.preventDefault(); applyMention(item.name); });
      mentionMenu.append(row);
    });
    mentionMenu.hidden = false;
  }

  input.addEventListener('input', e => {
    resizeInput();
    if (projectId) { draft().text = input.value; saveDrafts(); }
    if (projectId && !e.isComposing && !draft().inlineLongText && longTextFileName(input.value) && attachComposerText()) return;
    mentionIndex = 0;
    renderMentionMenu();
  });
  input.addEventListener('compositionend', () => {
    if (projectId && !draft().inlineLongText && longTextFileName(input.value)) attachComposerText();
  });
  input.addEventListener('click', () => renderMentionMenu());
  input.addEventListener('blur', () => setTimeout(hideMentionMenu, 120));
  input.addEventListener('keydown', e => {
    if (!mentionMenu?.hidden && mentionChoices.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); mentionIndex = (mentionIndex + 1) % mentionChoices.length; renderMentionMenu(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); mentionIndex = (mentionIndex - 1 + mentionChoices.length) % mentionChoices.length; renderMentionMenu(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyMention(mentionChoices[mentionIndex].name); return; }
      if (e.key === 'Escape') { e.preventDefault(); hideMentionMenu(); return; }
    }
    if (window.matchMedia('(max-width: 1000px)').matches) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !send.disabled) { e.preventDefault(); form.requestSubmit(); }
  });
  window.addEventListener('resize', composer);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    hideMentionMenu();
    if (!projectId || sendingProject || uploadCounts.get(projectId)) return;
    const id = projectId, d = draft();
    if (d.textFiles?.length) { setError('Finish uploading the long-text attachment first, or restore it to the input box'); return; }
    if (!d.pending && input.value.length > 12000) {
      const entry = attachComposerText();
      if (!entry) return;
      await textUploads.get(entry.id);
      if (projectId !== id || d.textFiles?.length) return;
    }
    if (!d.pending && !input.value.trim() && !d.attachments?.length) return;
    if(d.discussion&&d.attachments?.length){setError('Use text for discussion replies; send attachments as a separate regular message');return;}
    d.pending ||= { clientMessageId: crypto.randomUUID(), text: input.value, replyToId: d.replyToId || null, attachmentIds:(d.attachments||[]).map(a=>a.id),...(d.discussion?{discussion:d.discussion}:{}) };
    saveDrafts(); sendingProject = id; composer();
    try {
      if(d.pending.discussion)await api(`/api/projects/${encodeURIComponent(id)}/discussions/${encodeURIComponent(d.pending.discussion.threadId)}/reply`,{method:'POST',json:{...d.pending.discussion,requestId:d.pending.clientMessageId,text:d.pending.text}});
      else await api(`/api/projects/${encodeURIComponent(id)}/messages`, { method: 'POST', json: d.pending });
      drafts[id] = { text: '', replyToId: null, replyLabel: '' };
      if (projectId === id) input.value = '';
      setError('');
      await refreshState({ quiet: true });
    } catch (error) {
      if (!error.isNetworkError) delete d.pending;
      if (projectId === id) setError(error.message);
    } finally { sendingProject = null; saveDrafts(); composer(); }
  });

  const customPreset = { key: 'custom', name: '', mode: 'workspace-write', autoApprove: true, responsibility: '', instructions: '' };
  const rolePreset = key => key === 'custom' ? customPreset : (data.roleTemplates || []).find(item => item.key === key);
  let editingRoleRevision;
  let editingRoleSnapshot = null, roleRuntimeReady = false;

  /** Offline text edits retain the original binding; changing any execution setting still needs the normal checks. */
  function definitionOnly() {
    const role = editingRoleSnapshot, fields = roleForm.elements;
    return role && fields.name.value.trim() === role.name
      && ['nodeId', 'runtime', 'model', 'effort'].every(key => fields[key].value === (role[key] || ''))
      && fields.mode.value === (role.mode || 'workspace-write')
      && fields.enabled.checked === Boolean(role.enabled)
      && fields.autoApprove.checked === (role.autoApprove !== false);
  }
  function renderRoleSaveState() {
    if(!savingRole)document.querySelector('#role-save').textContent=editingRoleSnapshot?.runtime&&roleForm.elements.runtime.value!==editingRoleSnapshot.runtime?'Handoff and switch':'Save role';
    document.querySelector('#role-save').disabled = savingRole || checkingRuntime
      || (!definitionOnly() && !roleRuntimeReady && !(editingRoleId && !roleForm.elements.enabled.checked));
  }
  /** A saved unavailable value remains visible for metadata edits; it is not a claim that the CLI is usable. */
  function retainSavedOption(select, value) {
    if (!value || [...select.options].some(o => o.value === value)) return;
    const option = create('option', '', t('{value} (saved; unavailable)', { value }));
    option.value = value; option.disabled = true; select.append(option);
  }

  function roleBinding(nodeId) {
    return data.workspaces?.find(b => b.projectId === editingProjectId && b.nodeId === nodeId);
  }

  function populateRole(role) {
    editingRoleId = role?.id || null; roleForm.reset();
    editingRoleSnapshot = role ? { ...role } : null;
    const value = role || customPreset;
    editingRoleRevision = role ? role.revision || 1 : undefined;
    const presets = roleForm.elements.preset;
    presets.replaceChildren();
    for (const template of [customPreset, ...(data.roleTemplates || [])]) {
      const option = create('option', '', template.key === 'custom' ? 'Blank role' : t(template.name));
      option.value = template.key; presets.append(option);
    }
    presets.disabled = Boolean(role);
    document.querySelector('#role-archive').hidden = !role;
    for (const key of ['name', 'mode', 'responsibility', 'instructions']) roleForm.elements[key].value = value[key] ?? (key === 'mode' ? 'workspace-write' : '');
    roleForm.elements.preset.value = rolePreset(role?.templateKey)?.key || 'custom';
    preferredModel = value.model || '';
    preferredRuntime = role?.runtime || 'codex';
    preferredEffort = role?.effort || '';
    roleForm.elements.enabled.checked = role?.enabled ?? true;
    roleForm.elements.autoApprove.checked = role ? role.autoApprove !== false : true;
    renderDeviceOptions(role?.nodeId);
    roleError.hidden = true;
    document.querySelector('#role-dialog-title').textContent = 'Role Details';
    document.querySelector('#role-save').textContent = 'Save role';
    roleHistory.reset();
  }

  function renderDeviceOptions(selected) {
    const select = roleForm.elements.nodeId; select.replaceChildren();
    const blank = create('option', '', 'Select machine…'); blank.value = ''; select.append(blank);
    const workers = [...(data.workers || [])].sort((a, b) => Number(b.online) - Number(a.online));
    for (const w of workers) {
      const bound = Boolean(roleBinding(w.id));
      const system = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[w.platform] || w.platform || 'Unknown system';
      const usable = w.runtimes?.some(r => r.supported && r.available);
      const option = create('option', '', `${workerDisplayName(w)} · ${system} · ${w.online ? t('Online') : t('Offline')}${usable ? '' : t(' · CLI not ready')}${bound ? '' : t(' · Folder not bound')}`);
      option.value = w.id; option.disabled = !w.online; select.append(option);
    }
    if (selected) retainSavedOption(select, selected);
    select.value = selected !== undefined ? selected : workers.find(w => w.online && w.runtimes?.some(r => r.available && r.supported))?.id || '';
    renderRuntimeOptions();
  }

  /** The compact dropdown truncates long names; hovering still shows the full option. */
  function syncRoleSelectTitles() {
    for (const select of roleForm.querySelectorAll('select')) select.title = select.selectedOptions[0]?.textContent || '';
  }
  function renderRuntimeOptions() {
    const w = data.workers?.find(w => w.id === roleForm.elements.nodeId.value);
    const runtimeSelect = roleForm.elements.runtime, prior = runtimeSelect.value;
    runtimeSelect.replaceChildren();
    const placeholder = create('option', '', w?.runtimes?.some(r => r.available && r.supported) ? 'Select an available CLI…' : 'No CLI available on this device'); placeholder.value = ''; runtimeSelect.append(placeholder);
    for (const r of w?.runtimes || []) {
      const o = create('option', '', `${r.label || r.type} · ${r.available && r.supported ? r.version || t('Available') : r.reason || t('Unavailable')}`);
      o.value = r.type; o.disabled = !r.available || !r.supported; runtimeSelect.append(o);
    }
    const usable = [...runtimeSelect.options].filter(o => o.value && !o.disabled);
    const savedRuntime = editingRoleSnapshot?.nodeId === roleForm.elements.nodeId.value ? editingRoleSnapshot.runtime : '';
    if (savedRuntime) retainSavedOption(runtimeSelect, savedRuntime);
    runtimeSelect.value = (savedRuntime && preferredRuntime === savedRuntime ? savedRuntime : '')
      || usable.find(o => o.value === prior)?.value
      || usable.find(o => o.value === preferredRuntime)?.value
      || (!editingRoleId && (usable.find(o => o.value === 'codex')?.value || usable[0]?.value))
      || '';
    renderModelOptions();
  }
  function renderModelOptions() {
    const w = data.workers?.find(w => w.id === roleForm.elements.nodeId.value), r = w?.runtimes?.find(r => r.type === roleForm.elements.runtime.value);
    const select = roleForm.elements.model; select.replaceChildren();
    select.disabled = !w?.online || !r?.available;
    const blank = create('option', '', preferredModel && !r?.models?.some(m => m.id === preferredModel) ? t('Previously selected model {preferredModel} is not listed; please choose', { preferredModel }) : 'Select model…'); blank.value = ''; select.append(blank);
    for (const m of r?.models || []) { const o = create('option', '', m.name || m.id); o.value = m.id; select.append(o); }
    const savedBinding = editingRoleSnapshot?.nodeId === roleForm.elements.nodeId.value && editingRoleSnapshot.runtime === roleForm.elements.runtime.value;
    if (savedBinding) retainSavedOption(select, editingRoleSnapshot.model);
    select.value = [...select.options].some(o => o.value === preferredModel) ? preferredModel : '';
    renderEffortOptions(r?.models?.find(m => m.id === select.value) || null, r);
    const fresh = r?.checkedAt && Date.now() - Date.parse(r.checkedAt) < 600000;
    const binding = roleBinding(w?.id);
    const ready = w?.online && w.capabilities?.runtimeDiscovery && r?.supported && r.available && fresh && select.value && binding;
    const reason = !w?.online ? 'Please select an online device' : !w.capabilities?.runtimeDiscovery ? 'Please upgrade the Worker on this device' : !r?.available ? (w.runtimes?.[0]?.reason || 'No connected and available CLI Agent') : !fresh ? 'CLI check is stale; refresh it in "Basic Settings > Devices, CLIs and Models"' : !select.value ? 'Select a model actually returned by this CLI; the previously selected model is not replaced automatically' : !binding ? 'First bind the project folder in "Project Settings > Project Workspace"' : 'Device, CLI, model and project folder match; they are checked again on save';
    document.querySelector('#role-runtime-note').textContent = t('{reason}{v}. The check does not invoke model inference; actual runs may still be limited by network or quota.', { reason: t(reason), v: r?.checkedAt ? t('. Checked {time}', { time: formatTime(r.checkedAt) }) : '' });
    roleRuntimeReady = ready;
    renderRoleSaveState();
    renderAutoApproveNote();
    syncRoleSelectTitles();
  }
  function renderAutoApproveNote() {
    const field = document.querySelector('#role-auto-approve-field');
    const note = document.querySelector('#role-auto-approve-note');
    if (field) field.hidden = true;
    if (note) note.hidden = true;
  }
  function renderEffortOptions(model, runtime) {
    const field = document.querySelector('#role-effort-field');
    const select = roleForm.elements.effort;
    const efforts = Array.isArray(model?.efforts) ? model.efforts.filter(Boolean)
      : Array.isArray(runtime?.efforts) ? runtime.efforts.filter(Boolean) : [];
    const saved = editingRoleSnapshot;
    const keepEffort = saved && saved.nodeId === roleForm.elements.nodeId.value && saved.runtime === roleForm.elements.runtime.value && saved.model === roleForm.elements.model.value && saved.effort;
    if (keepEffort && !efforts.includes(saved.effort)) efforts.push(saved.effort);
    if (!efforts.length) {
      field.hidden = true;
      select.replaceChildren();
      const blank = create('option', '', 'Default (unspecified)'); blank.value = ''; select.append(blank);
      select.value = '';
      return;
    }
    field.hidden = false;
    select.replaceChildren();
    const blank = create('option', '', 'Default (unspecified)'); blank.value = ''; select.append(blank);
    for (const e of efforts) {
      const o = create('option', '', String(e)); o.value = String(e); select.append(o);
    }
    select.value = efforts.includes(preferredEffort) ? preferredEffort : '';
  }
  roleForm.addEventListener('change', syncRoleSelectTitles);
  roleForm.addEventListener('input', renderRoleSaveState);
  roleForm.addEventListener('change', renderRoleSaveState);
  roleForm.elements.nodeId.addEventListener('change', renderRuntimeOptions);
  roleForm.elements.runtime.addEventListener('change', () => { preferredRuntime = roleForm.elements.runtime.value; renderModelOptions(); });
  roleForm.elements.model.addEventListener('change', () => { preferredModel = roleForm.elements.model.value; renderModelOptions(); });
  roleForm.elements.effort.addEventListener('change', () => { preferredEffort = roleForm.elements.effort.value; });
  roleForm.elements.enabled.addEventListener('change', renderModelOptions);

  function openRoleEditor(roleId) {
    if (savingRole) return;
    if (!projectId) {
      setError('Select a project on the left before adding or editing a role.');
      return;
    }
    editingProjectId = projectId;
    const role = roleId ? (data.roles || []).find(r => r.id === roleId) : null;
    populateRole(role || undefined);
    roleDialog.showModal();
    if(role){const pending=cliSwitch.resume({projectId:editingProjectId,role,host:roleForm,operation:data.roleSwitches?.find(op=>op.roleId===role.id&&!['committed','cancelled'].includes(op.status))});if(pending){savingRole=true;void pending.then(op=>{if(op.status==='committed')roleDialog.close();}).catch(error=>setError(error.message)).finally(()=>{savingRole=false;renderRoleSaveState();});}}
  }
  document.querySelector('#manage-roles')?.addEventListener('click', () => openRoleEditor());
  document.querySelector('#add-role-sidebar')?.addEventListener('click', () => openRoleEditor());
  document.querySelector('#close-role-dialog').addEventListener('click', () => { if (!savingRole) roleDialog.close();else void cliSwitch.cancel(); });
  roleDialog.addEventListener('cancel', e => { if (savingRole){e.preventDefault();void cliSwitch.cancel();} });
  roleForm.elements.preset.addEventListener('change', () => {
    if (editingRoleId) return;
    const preset = rolePreset(roleForm.elements.preset.value);
    if (preset) {
      for (const key of ['name', 'mode', 'responsibility', 'instructions']) roleForm.elements[key].value = key === 'mode' ? preset[key] : t(preset[key] || '');
      roleForm.elements.autoApprove.checked = preset.autoApprove !== false;
      renderModelOptions();
    }
  });
  document.querySelector('#role-archive').addEventListener('click', async () => {
    if (!editingRoleId || savingRole) return;
    savingRole = true;
    try {
      await api(`/api/projects/${encodeURIComponent(editingProjectId)}/roles/${encodeURIComponent(editingRoleId)}/archive`, { method: 'POST', json: {} });
      await refreshState({ quiet: true }); populateRole();
      roleError.textContent = 'Role archived; message history and run records are kept.'; roleError.hidden = false;
    } catch (error) { roleError.textContent = error.message; roleError.hidden = false; }
    finally { savingRole = false; renderModelOptions(); }
  });
  roleForm.addEventListener('submit', async e => {
    e.preventDefault(); if (savingRole || checkingRuntime || document.querySelector('#role-save').disabled) return;
    const values = Object.fromEntries(new FormData(roleForm));
    // Disabled saved options are omitted by FormData; keep the binding shown by the editor instead of treating omission as a CLI switch or clear.
    for(const key of ['nodeId','runtime','model','effort'])values[key]=roleForm.elements[key].value;
    const onlyDefinition = definitionOnly();
    const effort = String(values.effort || '').trim();
    const body = { ...values, id: editingRoleId || undefined, enabled: roleForm.elements.enabled.checked, autoApprove: roleForm.elements.autoApprove.checked, effort: effort || null };
    body.revision = editingRoleRevision;
    if (!editingRoleId && values.preset !== 'custom') body.templateKey = values.preset;
    delete body.preset;
    savingRole = true; document.querySelector('#role-save').disabled = true; roleError.hidden = true;
    document.querySelector('#role-save').textContent = onlyDefinition ? 'Saving role definition…' : 'Checking device and CLI…';
    try {
      const endpoint = `/api/projects/${encodeURIComponent(editingProjectId)}/roles`;
      if(editingRoleSnapshot?.runtime&&roleForm.elements.runtime.value!==editingRoleSnapshot.runtime) {
        const op=await cliSwitch.begin({projectId:editingProjectId,role:editingRoleSnapshot,draft:body,host:roleForm});
        if(op.status==='committed'){roleDialog.close();await refreshState({quiet:true});}
        return;
      }
      const role = onlyDefinition
        ? await api(`${endpoint}/${encodeURIComponent(editingRoleId)}/definition`, { method: 'PATCH', json: { revision: editingRoleRevision, responsibility: values.responsibility, instructions: values.instructions } })
        : await api(endpoint, { method: 'POST', json: body });
      data.roles = [...(data.roles || []).filter(r => r.id !== role.id), role];
      populateRole(role);
      roleDialog.close();
      await refreshState({ quiet: true });
    } catch (error) {
      if (roleDialog.open) { roleError.textContent = error.message; roleError.hidden = false; }
      else setError(t('Role saved, but refreshing the list failed: {message}', { message: error.message }));
    }
    finally { savingRole = false; document.querySelector('#role-save').textContent = 'Save role'; renderModelOptions(); }
  });
  return { refresh, openRoleEditor };
}
