import {renderRetiredCommandWarning} from './retired-commands.js';
import {renderSessionQueue} from './session-queue.js';
import { t, dateLocale } from './i18n.js';
import { agentIconEl, UI_ICON, workerDisplayName, closeIcon } from './role-icons.js';
import { renderMarkdown, renderMessageMarkdown, linkRunDocuments, localizeDocumentLinks } from './markdown.js';
import { linkMedia, openImageLightbox, markImageOpener, fileGlyph } from './media.js';
import {simplifiedCliOutput} from './output-language.js';
import {executionProgress} from './execution-progress.js';
import {setChatCardState,highlightLatestChatCard} from './chat-card-state.js';
import { createHistoryViewer } from './history-view.js';
import {createRoleSwitchUI} from './role-switch.js';
import {createRoleHistoryTabs} from './role-history.js';
import {createCliRecoveryUI} from './cli-recovery.js';
import {createListOrder,orderedItems,readListOrder} from './list-order.js';
import { renderPermissionScope, permissionScopeValue } from './permission-scope.js';
import {renderModelUsageNotice} from './model-usage.js';
import {createMentionInput} from './mention-input.js';
import { elapsedEl } from './elapsed.js';
import {classifyStep,stepTitle} from './native-transcript.js';
import stepZh from './locales/native-takeover-zh.js';
import { getLanguage } from './i18n.js';
import { SEND_LABELS, uncertainSend, sendStateOf, sendLocked, lookupFailureState, sameSend } from './send-state.js';
import { pastesAsFile, pastedTextName } from './pasted-text.js';

/** Typed text that grows this long moves into an attachment too; pasted text moves at a much lower limit (pasted-text.js). The file keeps the original line breaks, whitespace and trailing characters. */
export function longTextFileName(text) {
  if (text.length <= 8000 && text.split(/\r\n|\r|\n/).length <= 80) return null;
  return pastedTextName(text);
}

/** Refresh real terminal processes before CLI probes; stale takeover receipts let the original queued work continue. */
export function createRoleRefresh({api,refreshState,getData,getProject,button,feedback,onUpdate=()=>{}}) {
  let busy=false;
  const notices=new Map(),checks=new Map(),terminalChecks=new Map();
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
  /** Both refresh buttons share one per-project check; offline/old Workers are reported without removing their lock. */
  function refreshTerminals() {
    const project=getProject();if(!project)return refreshState().then(()=> '');
    if(terminalChecks.has(project.id))return terminalChecks.get(project.id);
    const operation=(async()=>{const result=await api(`/api/projects/${encodeURIComponent(project.id)}/terminals/refresh`,{method:'POST',json:{},signal:AbortSignal.timeout(25000)});
      const summary=t('Terminal processes checked: {released} returned, {active} running, {unknown} unverified.',result);
      const reasons=[...new Set(result.results.filter(r=>r.reason).map(r=>r.reason))];
      notices.set(project.id,[summary,...reasons].join(' '));await refreshState({quiet:true});update();onUpdate();return [summary,...reasons].join(' ');
    })().finally(()=>terminalChecks.delete(project.id));terminalChecks.set(project.id,operation);return operation;
  }
  async function refresh() {
    const project=getProject();
    if(busy||!project||!rolesFor(project.id).length)return;
    const roles=rolesFor(project.id),workers=getData().workers||[],groups=new Map();
    for(const role of roles){const group=groups.get(role.nodeId)||[];group.push(role);groups.set(role.nodeId,group);}
    busy=true;notices.set(project.id,'Refreshing CLI status and remaining quota…');for(const role of roles)setCheck(role,{state:'checking'});update();onUpdate();
    const warnings=[];let checked=0,retried=0,terminalSummary='';
    try {
      try{terminalSummary=await refreshTerminals();}catch(error){warnings.push(t('Terminal check failed: {message}',{message:error.message}));}
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
      notices.set(project.id,`${terminalSummary?terminalSummary+' ':''}${warnings.length?t('Checked {devices}; {warnings}. Quota that could not be obtained keeps its previous value or is unknown', { devices, warnings: warnings.join(t('; ')) }):t('Refreshed role status and quota on {devices} · {time}', { devices, time: new Date().toLocaleTimeString(dateLocale()) })}${retried?t(retried===1?' · {count} transient check failure was retried':' · {count} transient check failures were retried', { count: retried }):''}${t('. Old tasks were not re-run; history is preserved.')}`);
    }catch(error){notices.set(project.id,t('Refresh incomplete: {message}', { message: error.message }));}
    finally{busy=false;update();onUpdate();}
  }
  button.addEventListener('click',()=>void refresh());
  update();
  return {refresh,refreshTerminals,update,getCheck:role=>{const check=checks.get(role.id);return check?.binding===binding(role)?check:null;}};
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

/** Match the room publisher: explicit business reports are never replaced by a compact handoff wait. */
export function quietHandoff(run,data={}) {
  const report=data.runReports?.find(report=>report.id===run?.id)||run?.report;
  return run?.status==='succeeded'&&Boolean(run.handoffWait?.requestId)&&!['passed','failed','blocked','needs_input'].includes(report?.verdict);
}

/** A succeeded turn that only handed work off shows one waiting line until its continuation takes over; null hides it. */
export function handoffWaitState(run, data) {
  if(!quietHandoff(run,data))return null;
  const parent=data.requests?.find(r=>r.id===run.handoffWait.requestId);
  if(!parent||parent.status!=='waiting_call'||parent.resumeError?.kind==='transient'||parent.continuationRequestId||(parent.currentRunId&&parent.currentRunId!==run.id))return null;
  const ids=parent.waitRequestIds||run.handoffWait.requestIds||[];
  const names=[...new Set(ids.map(id=>data.requests?.find(r=>r.id===id)).filter(Boolean)
    .map(r=>data.roles?.find(role=>role.id===r.targetRoleId)?.name||r.targetSnapshot?.name).filter(Boolean))];
  return {names:names.length>4?[...names.slice(0,4),`+${names.length-4}`]:names};
}

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
  const detail=task?.status==='cancelled'?'Original task stopped':!historical&&blocked&&thread&&blocked.threadId===thread.id?task.waitingReason:!historical&&thread?.status==='open'?(delivery?.status==='queued'?delivery.waitingReason:delivery?.error):null;
  return {to,thread,state:detail?`${state} · ${detail}`:state,canReply:!historical&&thread?.status==='open',canResume,resumeAfterRunId:canResume?after.id:null,canStop,stopRunId:canStop?task.currentRunId:null,questionId:meta.questionId};
}

/** Identify the reply target from the real call relationship; when history pagination lacks the question card, call records can still locate it. */
export function dialogueReplyDirection(message,messages,data) {
  if(message.sender!=='agent'||message.kind==='handoff'||message.id!==`result-${message.runId}`)return null;
  if(message.dialogue)return message.dialogue;
  const call=messages.find(m=>m.id===message.replyToId&&m.projectId===message.projectId)?.handoff;
  // A transferred owner answers the user, not the role that handed the task over.
  if(call)return call.kind==='transfer'?null:{from:message.senderName,to:call.fromRole};
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
function createMessageQueue({api,refreshState,create,setError,cliRecoveryUI,onUpdate,editQueued}) {
  const panel=document.querySelector('#message-queue'),summary=panel.querySelector('summary'),list=panel.querySelector('.message-queue-list');
  // The displayed queue owns these tasks until its next render, including while a drag is active.
  let displayedTaskIds=new Set();
  const commands=new Map(),pending=new Set(),steeringPending=new Set(),steeringErrors=new Map();let currentProject=null,lastData=null,optimistic=null,pausing=false;
  const queueKey=task=>Number.isFinite(task.queueOrder)?task.queueOrder:(Date.parse(task.createdAt)||0);
  // Long press reorders waiting items; Home stores the order and the scheduler runs them in that order.
  const order=createListOrder({container:list,scope:()=>`queue:${currentProject||''}`,onEnd:()=>{if(lastData){view.update(lastData,currentProject);onUpdate();}},onError:setError,
    persist:async taskIds=>{
      optimistic=taskIds;
      try{await api(`/api/projects/${encodeURIComponent(currentProject)}/queue/order`,{method:'POST',json:{taskIds}});await refreshState({quiet:true});}
      catch(error){setError(error.message);}
      finally{optimistic=null;if(lastData)view.update(lastData,currentProject);}
    }});
  const view={hasTask:id=>displayedTaskIds.has(id),update(data,projectId){
    lastData=data;if(order.active())return;
    if(currentProject!==projectId){panel.open=false;currentProject=projectId;optimistic=null;}
    const rank=new Map((optimistic||[]).map((id,index)=>[id,index]));
    const runs=new Map((data.runs||[]).map(run=>[run.id,run]));
    let tasks=(data.tasks||[]).filter(task=>{
      if(task.projectId!==projectId||task.origin!=='chat')return false;
      if(task.status==='ready'&&!task.currentRunId)return true;
      if(!task.steering||!['ready','in_progress','blocked'].includes(task.status))return false;
      const run=runs.get(task.currentRunId);
      // Creating a Run is not input acceptance. Keep the interruption/startup visible, including a failed launch.
      return !run||!(run.inputDeliveryState==='accepted'||run.status==='succeeded');
    })
      .sort((a,b)=>Number(Boolean(b.steering))-Number(Boolean(a.steering))||(rank.size?(rank.get(a.id)??Infinity)-(rank.get(b.id)??Infinity):0)||queueKey(a)-queueKey(b));
    // A message about to start is not waiting: its role is idle, nothing for that role is ahead of it and Home gave no reason
    // to wait. It shows as the role's starting card instead of in the queue (for at most 30s, so a stuck one comes back here).
    const busyRoles=new Set((data.runs||[]).filter(r=>r.projectId===projectId&&['queued','starting','running','waiting_user','stopping','reconciling'].includes(r.status)).map(r=>r.roleId));
    const firstForRole=new Map();for(const task of [...tasks].sort((a,b)=>queueKey(a)-queueKey(b)))if(!firstForRole.has(task.roleId))firstForRole.set(task.roleId,task.id);
    const starting=task=>!task.steering&&!task.waitingReason&&!data.settings?.paused&&!data.chatQueuePaused&&!busyRoles.has(task.roleId)
      &&firstForRole.get(task.roleId)===task.id&&Date.now()-Date.parse(task.createdAt)<30000;
    tasks=tasks.filter(task=>!starting(task));
    const conversation=tasks[0]?.conversationId||projectId;
    // Open waits of this chat sit in the queue at the slot their wake will run in; they hold nothing back and can be dragged.
    const waits=tasks.length?(data.queuedWaits||[]).filter(w=>w.projectId===projectId&&w.conversationId===conversation):[];
    const roleName=id=>(data.roles||[]).find(r=>r.id===id)?.name||t('Role');
    const items=[...tasks.map(task=>({id:task.id,task,key:queueKey(task)})),...waits.map(wait=>({id:wait.id,wait,key:wait.queueOrder}))]
      .sort((a,b)=>Number(Boolean(b.task?.steering))-Number(Boolean(a.task?.steering))||(rank.size?(rank.get(a.id)??Infinity)-(rank.get(b.id)??Infinity):0)||a.key-b.key);
    displayedTaskIds=new Set(tasks.map(task=>task.id));
    list.classList.toggle('is-orderable',Boolean(data.capabilities?.queueOrder)&&items.length>1);
    panel.hidden=!tasks.length;list.replaceChildren();
    const title=create('span','message-queue-title',t('Queue · {v}', { v: items.length }));
    // Pause/resume at the right of the title, as on the Sessions queue: paused messages wait after the running replies end.
    const paused=Boolean(data.chatQueuePaused)&&tasks.length>0,head=[title];panel.classList.toggle('is-paused',paused);
    if(paused)head.push(create('span','message-queue-paused',t('Paused')));
    if(data.capabilities?.queuePause&&tasks.length){
      const toggle=create('button',`icon-button message-queue-pause${paused?' is-paused':''}`),label=t(paused?'Resume the queue':'Pause the queue: keep these messages after the current replies end');
      toggle.type='button';toggle.innerHTML=UI_ICON[paused?'play':'pause'];toggle.querySelector('svg')?.setAttribute('aria-hidden','true');toggle.title=label;toggle.setAttribute('aria-label',label);toggle.disabled=pausing;
      // Inside <summary>: the click must not fold the queue.
      toggle.onclick=async e=>{e.preventDefault();e.stopPropagation();pausing=true;toggle.disabled=true;
        try{await api(`/api/projects/${encodeURIComponent(projectId)}/queue/pause`,{method:'POST',json:{paused:!paused,conversationId:conversation}});await refreshState({quiet:true});}
        catch(error){setError(error.message);}finally{pausing=false;if(lastData)view.update(lastData,currentProject);}};
      head.push(toggle);
    }
    summary.replaceChildren(...head);
    for(const [i,item] of items.entries()) {
      if(item.wait) {
        const wait=item.wait,row=create('div','message-queue-item is-wait'),info=create('div','message-queue-info');
        if(data.capabilities?.queueOrder){row.dataset.orderId=wait.id;row.title=t('Long press to drag and reorder');}
        const names=[...new Set(wait.waitingFor.map(w=>w.roleName||roleName(w.roleId)))].join(t(', '));
        // Without a readable dependency list (or in the moment before the wake exists) say only that it waits.
        const label=wait.waitingFor.length?t('Waiting for results from {names} ({open}/{total} still out); the reply runs here when they are back',{names,open:wait.waitingFor.length,total:wait.total})
          :t('Waiting for results; the reply runs here when they are back');
        const title=create('strong','',`${i+1}. @${wait.roleName||roleName(wait.roleId)} · ${label}`);title.title=label;
        info.append(title);row.append(info);list.append(row);continue;
      }
      const task=item.task;
      const row=create('div','message-queue-item'),info=create('div','message-queue-info');
      if(data.capabilities?.queueOrder&&!task.steering&&!steeringPending.has(task.id)){row.dataset.orderId=task.id;row.title=t('Long press to drag and reorder');}
      const title=create('strong','',`${i+1}. @${task.roleSnapshot?.name||t('Role')} · ${task.title||task.prompt}`);title.title=task.prompt||task.title;
      info.append(title);row.append(info);
      // Supervisor plans/consultations are not messages the user just sent and must not pose as a manual steering entry.
      const human=!task.planId&&!task.scheduledJobId&&!task.continuationRunId&&!task.requiresCoordination;
      if(human&&!task.steering){
        const edit=create('button','icon-button message-queue-edit');edit.type='button';edit.innerHTML=UI_ICON.edit;edit.title='Return queued message to input';edit.setAttribute('aria-label',t('Return queued message to input'));
        edit.disabled=pending.has(task.id);edit.onclick=async()=>{pending.add(task.id);edit.disabled=true;try{await editQueued(task);}finally{pending.delete(task.id);edit.disabled=false;}};row.append(edit);
      }
      if(human) {
        const run=runs.get(task.currentRunId),stopped=(task.steering?.waitForRunIds||[]).map(id=>runs.get(id));
        const error=task.steering?(task.error||run?.error||stopped.find(r=>r?.status==='reconciling')?.error):steeringErrors.get(task.id);
        const busy=(Boolean(task.steering)||steeringPending.has(task.id))&&!error;
        row.classList.toggle('is-error-card',Boolean(error));
        const steer=create('button',`icon-button message-queue-steer${busy?' is-active':''}${error?' is-error':''}`);steer.type='button';
        steer.setAttribute('aria-busy',String(busy));steer.setAttribute('aria-label',error?t('Steering needs attention'):t(busy?'Steering':'Steer now'));
        steer.innerHTML=busy?'<svg class="message-queue-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8" opacity=".2"/><path d="M12 4a8 8 0 0 1 8 8"/></svg>':error?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/></svg>':'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 13v8"/><path d="M12 3v3"/><path d="M18 6a2 2 0 0 1 1.387.56l2.307 2.22a1 1 0 0 1 0 1.44l-2.307 2.22A2 2 0 0 1 18 13H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z"/></svg>';
        steer.title=error?t('Steering needs attention: {reason}',{reason:error}):busy?[t('Interrupting and starting this message'),task.waitingReason].filter(Boolean).join(' · '):busyRoles.has(task.roleId)?t('Interrupt this role now; run this message in the same conversation. The old task will not resume automatically; existing changes are kept'):t('Run this message first; nothing is interrupted, and a pending wait keeps its place in the queue');
        steer.disabled=Boolean(task.steering)||pending.has(task.id)||data.settings?.paused||!(data.capabilities?.roleSteering>=2);
        if(!(data.capabilities?.roleSteering>=2))steer.title='Steer now becomes available after the service is upgraded';
        steer.onclick=async()=>{
          pending.add(task.id);steeringPending.add(task.id);steeringErrors.delete(task.id);setError('');view.update(lastData,currentProject);
          if(!commands.has(task.id))commands.set(task.id,crypto.randomUUID());
          try {
            const receipt=await api(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/steer`,{method:'POST',json:{mode:'replace',commandId:commands.get(task.id),conversationId:task.conversationId||task.projectId}});
            // A successful stop request stays busy even if the following workspace refresh fails.
            const current=lastData.tasks?.find(t=>t.id===task.id);if(current)current.steering=receipt;
            await refreshState({quiet:true});
          }
          catch(error){steeringErrors.set(task.id,error.message);setError(error.message);}
          finally{pending.delete(task.id);steeringPending.delete(task.id);if(lastData)view.update(lastData,currentProject);onUpdate();}
        };
        row.append(steer);
      }
      // A queued task has no chat placeholder; keep its existing recovery action accessible here.
      const recovery=cliRecoveryUI.button(task);
      if(recovery){recovery.className='icon-button cli-recovery-open';row.append(recovery);}
      const cancel=closeIcon(create('button','icon-button'));cancel.type='button';cancel.title='Cancel queued item';cancel.setAttribute('aria-label',t('Cancel queued item {v} {v2}', { v: task.roleSnapshot?.name||t('Role'), v2: task.title||'' }));
      cancel.disabled=pending.has(task.id)||Boolean(task.currentRunId)||task.status!=='ready';cancel.onclick=async()=>{
        cancel.disabled=true;try{await api(`/api/tasks/${encodeURIComponent(task.id)}/cancel`,{method:'POST',json:{}});await refreshState({quiet:true});}catch(error){setError(error.message);cancel.disabled=false;}
      };row.append(cancel);list.append(row);
    }
  }};
  return view;
}

/** The chat only handles display and user actions; role selection, idempotency and scheduling are validated by Home. */
export function createRoomUI({ api, refreshState, openTask, stopRun, decideApproval, create, formatTime, setError, configureDevice, openSideAsk }) {
  const historyViewer=createHistoryViewer({api});
  const cliRecoveryUI=createCliRecoveryUI({api,refreshState,getData:()=>data,create});
  const messageQueue=createMessageQueue({api,refreshState,create,setError,cliRecoveryUI,onUpdate:()=>renderMessages(),editQueued});
  const feed = document.querySelector('#chat-feed');
  // Configuration, plans and messages share one scroll area so status cards do not permanently crowd out the body.
  const scroller = document.querySelector('#chat-scroll');
  const form = document.querySelector('#chat-form');
  const input = form.elements.text;
  const send = form.querySelector('[type="submit"]');send.innerHTML=UI_ICON.send;
  // Send is an icon inside the field; its state reads through the tooltip and accessible name.
  const sendLabel=label=>{send.title=t(label);send.setAttribute('aria-label',t(label));};
  const quoteBar = document.querySelector('#chat-quote');
  const roleDialog = document.querySelector('#role-dialog');
  const roleForm = document.querySelector('#role-form');
  const roleCommandWarnings={};
  for(const key of ['responsibility','instructions']) {
    const warning=create('p','workspace-note full-width');warning.dataset.retiredWarning=key;
    roleForm.elements[key].after(warning);roleCommandWarnings[key]=warning;
    roleForm.elements[key].addEventListener('input',()=>renderRetiredCommandWarning(warning,roleForm.elements[key].value,t));
  }
  roleForm.prepend(create('p','workspace-note full-width','Role and project settings apply to every chat in this project.'));
  const roleHistory=createRoleHistoryTabs({getConversationId:()=>conversationId,host:roleDialog,settings:roleForm,getData:()=>data,getRole:()=>editingRoleSnapshot,api,refreshState,create,formatTime,openTask});
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
    header.append(create('strong', '', name), copyMessageButton(text), iconAction('close', 'Close attachment preview', () => previewDialog.close()));
    if (downloadUrl) header.insertBefore(iconAction('original', 'Download original', () => {
      const link = create('a'); link.href = downloadUrl; link.download = name; link.click();
    }), header.lastChild);
    const body = create('div', 'message-fullscreen-body');
    const content = create('div', 'message-fullscreen-content');
    content.append(/\.(md|markdown)$/i.test(name) ? renderMarkdown(simplifiedCliOutput(text)) : create('pre', 'attachment-text', text));
    body.append(content); previewDialog.replaceChildren(header, body);
    if (!previewDialog.open) previewDialog.showModal();
  }
  function attachmentCard(item, removable = false, ownerId = scopeId) {
    const card = create('div', `attachment-card${item.mime.startsWith('image/') ? '' : ' attachment-file-card'}${removable && item.pastedText ? ' attachment-text-card' : ''}`);
    card.title = item.name;
    const open = button('', async () => {
      try {
        const url = await attachmentUrl(item);
        // Pictures open in the same viewer as media named in replies: download, copy, close; name, size and the message time.
        if (item.mime.startsWith('image/')) {
          openImageLightbox({ name:item.name, size:item.size, at:open.closest('.chat-row')?.querySelector('time[datetime]')?.getAttribute('datetime')||null, url, from:open });
        } else if (/\.(md|markdown|txt)$/i.test(item.name)) {
          const response = await fetch(url);
          previewText(await response.text(), item.name, url);
        } else if (removable) {
          // 不支持正文预览的草稿附件也先显示详情，不在点击卡片时直接下载。
          previewDialog.className = 'attachment-dialog';
          previewDialog.setAttribute('aria-label', item.name);
          const link = create('a', '', 'Download original'); link.href = url; link.download = item.name;
          previewDialog.replaceChildren(iconAction('close','Close',()=>previewDialog.close()),create('p','attachment-text',item.name),create('p','',`${item.size} B`),link);
          previewDialog.showModal();
        } else {
          const link = create('a'); link.href = url; link.download = item.name; link.click();
        }
      } catch (e) { setError(e.message); }
    }, 'attachment-open');
    if (item.mime.startsWith('image/')) {
      const thumb = create('img'); thumb.alt = item.name; open.append(thumb); if (!removable) markImageOpener(open);
      void attachmentUrl(item).then(url=>{thumb.src=url;}).catch(()=>{thumb.alt='Preview failed to load; click to retry';});
    } else open.append(fileGlyph(item.name, 'attachment-file-icon'));
    open.append(create('span','attachment-name',item.name),create('small','',item.size<1024?`${item.size} B`:`${(item.size/1024).toFixed(1)} KB`));
    card.append(open);
    if (!removable) card.append(iconAction('transfer', 'Send to device', () => openAttachmentTransfer(item)));
    if (removable) card.append(closeIcon(button('', () => {
      const d = drafts[ownerId]; if (d?.pending || sendingProject === ownerId) return;
      d.attachments = (d.attachments || []).filter(a=>a.id!==item.id); saveDrafts(); composer();
    },'attachment-remove'), t('Remove attachment')));
    return card;
  }

  let transferDialog;
  /** File transfer is independent of dispatch: the user picks a target device and the Worker writes to the project temp folder. */
  function openAttachmentTransfer(item) {
    if(!transferDialog){transferDialog=create('dialog','attachment-transfer-dialog');transferDialog.setAttribute('aria-label','Send to device');document.body.append(transferDialog);}
    transferDialog.replaceChildren();
    const header=create('div','dialog-heading');header.append(create('h2','','Send to device'),iconAction('close','Close',()=>transferDialog.close()));
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
    if (!projectId || draft().pending || draft().queueEdit || sendingProject === scopeId) return;
    const id = scopeId, targetProjectId=projectId, d = draft(), incoming = [...files];
    if ((d.attachments?.length || 0) + (d.textFiles?.length || 0) + (uploadCounts.get(id) || 0) + incoming.length > 6) { setError('At most 6 attachments per message'); return; }
    if (incoming.some(f=>!f.size || f.size>20*1024*1024)) { setError('Attachments cannot be empty; each file is limited to 20 MB'); return; }
    uploadCounts.set(id,(uploadCounts.get(id)||0)+incoming.length); composer();
    for (const file of incoming) {
      try {
        const item = await api(`/api/projects/${encodeURIComponent(targetProjectId)}/attachments`, {method:'POST',body:file,headers:{'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(file.name || 'pasted-image.png')}});
        (d.attachments ||= []).push(item); saveDrafts();
      } catch(e) { setError(e.message); }
      finally { uploadCounts.set(id,Math.max(0,(uploadCounts.get(id)||0)-1)); if (id===scopeId) composer(); }
    }
  }
  /** Save a recoverable text draft first, then upload; on failure the card keeps the original text and sending without the attachment is blocked. */
  function uploadTextFile(entry, ownerId) {
    if (textUploads.has(entry.id)) return textUploads.get(entry.id);
    const d = drafts[ownerId];
    const job = Promise.resolve().then(async () => {
      entry.error = ''; if (ownerId === scopeId) composer();
      try {
        const file = new File([entry.text], entry.name, { type: 'text/markdown;charset=utf-8' });
        const item = await api(`/api/projects/${encodeURIComponent(d.projectId||ownerId)}/attachments`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(entry.name) } });
        (d.attachments ||= []).push({ ...item, pastedText: true });
        d.textFiles = d.textFiles.filter(value => value.id !== entry.id);
      } catch (error) { entry.error = error.message; }
      finally { textUploads.delete(entry.id); saveDrafts(); if (ownerId === scopeId) composer(); }
    });
    textUploads.set(entry.id, job); return job;
  }
  function textDraftCard(entry, ownerId) {
    const card = create('div', `attachment-card attachment-file-card attachment-text-card attachment-text-draft${entry.error && !textUploads.has(entry.id) ? ' is-error' : ''}`);
    card.title = entry.name;
    const busy = textUploads.has(entry.id);
    const open = button('', () => previewText(entry.text, entry.name), 'attachment-open');
    open.append(fileGlyph(entry.name, 'attachment-file-icon'), create('span', 'attachment-name', entry.name), create('small', '', busy ? 'Uploading…' : entry.error ? 'Upload failed; original text kept' : 'Pending upload'));
    card.append(open);
    if (!busy) {
      card.append(iconAction('refresh',entry.error ? 'Retry upload' : 'Upload', () => { void uploadTextFile(entry, ownerId); }));
      card.append(closeIcon(button('', () => {
        drafts[ownerId].textFiles = drafts[ownerId].textFiles.filter(value => value.id !== entry.id); saveDrafts(); composer();
      }, 'attachment-remove'), t('Remove attachment')));
    }
    if (entry.error) card.title = entry.error;
    return card;
  }
  function queueTextFile(text, remaining) {
    if (!projectId || draft().pending || draft().queueEdit || sendingProject === scopeId) return null;
    const d = draft(), ownerId = scopeId;
    if ((d.attachments?.length || 0) + (d.textFiles?.length || 0) + (uploadCounts.get(ownerId) || 0) >= 6) { setError('Attachments are full; the long text stays in the input box. Remove an attachment first'); return null; }
    if (new Blob([text]).size > 20 * 1024 * 1024) { setError('Text exceeds the 20 MB per-attachment limit; the original is kept, please split it before sending'); return null; }
    const entry = { id: crypto.randomUUID(), name: pastedTextName(text), text };
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
    // Pasted text over 200 characters becomes a text attachment; the rest of what was typed stays in the box.
    if (pastesAsFile(text)) {
      const remaining = input.value.slice(0, input.selectionStart) + input.value.slice(input.selectionEnd);
      if (queueTextFile(text, remaining)) e.preventDefault();
    }
  });
  const inputField=document.querySelector('.chat-input-field');
  inputField.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files')){e.preventDefault();inputField.classList.add('is-dragging');}});
  inputField.addEventListener('dragleave',()=>inputField.classList.remove('is-dragging'));
  inputField.addEventListener('drop',e=>{inputField.classList.remove('is-dragging');if(e.dataTransfer?.files.length){e.preventDefault();void uploadFiles(e.dataTransfer.files);}});
  // Respect the compact CSS baseline while retaining automatic growth for actual text.
  function resizeInput() { input.style.height='auto'; input.style.height=`${Math.min(120,Math.max(parseFloat(getComputedStyle(input).minHeight),input.scrollHeight))}px`;mentionInput.refresh(); }
  let mentionChoices = [];
  let mentionIndex = 0;
  let mentionRange = null;
  const histories = new Map();
  const pendingReads = new Set();
  const liveByRun = new Map();
  const liveFetching = new Set();
  let data = {}, projectId = null, conversationId = null, scopeId = null, editingProjectId = null, editingRoleId = null;
  let sendingProject = null, savingRole = false;
  let preferredModel = '', preferredRuntime = 'codex', preferredEffort = '', checkingRuntime = false;
  let drafts;
  try { drafts = JSON.parse(sessionStorage.getItem('agent-workbench.chat-drafts')) || {}; } catch { drafts = {}; }
  const saveDrafts = () => {
    try { sessionStorage.setItem('agent-workbench.chat-drafts', JSON.stringify(drafts)); return true; }
    catch { setError('Not enough browser draft storage; the original text is still on this page. Copy a backup first and do not close the page'); return false; }
  };
  const draft = () => drafts[scopeId] ||= { projectId, text: '', replyToId: null, replyLabel: '' };
  const queueEditing=new Set();
  /** Save the recall identity first so a lost response can be retried without dispatching or losing the original. */
  async function editQueued(task) {
    const ownerId=scopeId,d=draft();
    if(d.queueEdit||d.pending||sendingProject||uploadCounts.get(ownerId)||d.text?.trim()||d.attachments?.length||d.textFiles?.length||d.replyToId){setError('Keep or send the current draft before editing a queued message');return;}
    d.queueEdit={projectId,conversationId,taskId:task.id,commandId:crypto.randomUUID()};
    if(!saveDrafts()){delete d.queueEdit;return;}
    await finishQueueEdit(ownerId);
  }
  async function finishQueueEdit(ownerId) {
    const d=drafts[ownerId],pending=d?.queueEdit;if(!pending||queueEditing.has(ownerId))return;
    queueEditing.add(ownerId);if(ownerId===scopeId)composer();
    try{
      const result=await api(`/api/projects/${encodeURIComponent(pending.projectId)}/tasks/${encodeURIComponent(pending.taskId)}/edit-queued`,{method:'POST',json:{commandId:pending.commandId,conversationId:pending.conversationId}});
      const message=result.message,quote=result.replySource;
      drafts[ownerId]={projectId:pending.projectId,text:message.text||'',attachments:message.attachments||[],replyToId:message.replyToId||null,replyLabel:quote?`${quote.senderName}: ${quote.text}`:'Quoting an earlier message',inlineLongText:true};
      saveDrafts();if(ownerId===scopeId){input.value=drafts[ownerId].text;setError('');composer();input.focus();}
      await refreshState({quiet:true});
    }catch(error){if(error.status>=400&&error.status<500){delete d.queueEdit;saveDrafts();}setError(error.message);}
    finally{queueEditing.delete(ownerId);if(ownerId===scopeId)composer();}
  }
  // Send lifecycle per draft scope (see send-state.js). Home already treats a repeated clientMessageId idempotently.
  // Nothing here adds polling: checks run after a send fails and when the existing state refresh redraws the room,
  // at most every few seconds per scope.
  const verifying = new Set(), verifiedAt = new Map(), submitLocks = new Set();
  const sendState = (d, ownerId = scopeId) => sendStateOf(d, sendingProject === ownerId);
  const scopeProject = ownerId => { try { return ownerId.startsWith('[') ? JSON.parse(ownerId)[0] : ownerId; } catch { return ownerId; } };
  /** Clear only what the confirmed send carried; text typed afterwards or another scope's draft is never touched. */
  function settleSent(ownerId, sent) {
    const d = drafts[ownerId];
    if (!d) return;
    if ((d.text || '') === (sent.text || '')) {
      drafts[ownerId] = { projectId: d.projectId || scopeProject(ownerId), text: '', replyToId: null, replyLabel: '' };
      if (ownerId === scopeId) input.value = '';
      return;
    }
    const carried = new Set(sent.attachmentIds || []);
    delete d.pending; delete d.sendState;
    d.attachments = (d.attachments || []).filter(a => !carried.has(a.id));
    if (d.replyToId === sent.replyToId) { d.replyToId = null; d.replyLabel = ''; delete d.replyMention; delete d.discussion; }
  }
  /** Ask Home for an exact receipt of the frozen id; only a confirmed absence leads back to Send. */
  async function verifyPending(ownerId, force = false) {
    const d = drafts[ownerId], sent = d?.pending;
    if (!sent || sendingProject === ownerId || verifying.has(ownerId) || d.sendState === 'failed') return;
    if (!force && Date.now() - (verifiedAt.get(ownerId) || 0) < 5000) return;
    verifying.add(ownerId); verifiedAt.set(ownerId, Date.now());
    if (ownerId === scopeId) composer();
    const targetProjectId = d.projectId || scopeProject(ownerId);
    try {
      // Read-only receipts on the same authenticated routes; a recent-message window never decides that a send is missing.
      const receipt = sent.discussion
        ? await api(`/api/projects/${encodeURIComponent(targetProjectId)}/discussions/${encodeURIComponent(sent.discussion.threadId)}/reply?requestId=${encodeURIComponent(sent.clientMessageId)}`)
        : await api(`/api/projects/${encodeURIComponent(targetProjectId)}/messages?conversationId=${encodeURIComponent(sent.conversationId || targetProjectId)}&id=${encodeURIComponent(sent.clientMessageId)}`);
      if (drafts[ownerId]?.pending?.clientMessageId !== sent.clientMessageId) return;
      if (receipt?.exists === true) { settleSent(ownerId, sent); if (ownerId === scopeId) setError(''); }
      else if (receipt?.exists === false) drafts[ownerId].sendState = 'failed';
    } catch (error) {
      // 401/403/429 or an unreachable Home say nothing about the original POST: stay unknown and look again later.
      if (drafts[ownerId]?.pending?.clientMessageId === sent.clientMessageId) drafts[ownerId].sendState = lookupFailureState(error);
    } finally { verifying.delete(ownerId); saveDrafts(); if (ownerId === scopeId) composer(); }
  }
  const mentionInput=createMentionInput(input,()=>{
    const names=[...(data.roles||[]),...(data.supervisorRoles||[])].filter(r=>r.projectId===projectId&&!r.archivedAt).map(r=>r.name);
    if(data.projects?.find(p=>p.id===projectId)?.supervisorRoleId)names.push('Supervisor','supervisor','\u603b\u7ba1');
    return names;
  });
  const hasMention=text=>/(?:^|[\s,.!?;:(\uff0c\u3002\uff01\uff1f\u3001\uff1b\uff1a\uff08])@([\p{L}\p{N}_-]+)/u.test(text);
  const taskProgress=(task,run)=>{
    const request=run?.discussionDeliveryId?null:data.requests?.find(r=>r.id===(run?.requestId||task?.requestId));
    const nodeId=run?.nodeId||task?.roleSnapshot?.nodeId;
    return executionProgress({run,task:run?.discussionDeliveryId?null:task,request,online:!nodeId||Boolean(data.workers?.some(w=>w.id===nodeId&&w.online))});
  };
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
    input.placeholder = data.projects?.find(p => p.id === projectId)?.supervisorRoleId ? 'Without @, new messages go to the supervisor; replies target the sender, and @ several roles dispatches to each' : 'Type a message; @role to start work';
    const d = draft(), busy = sendingProject === scopeId, state = sendState(d);
    input.disabled = busy || !!d.pending || !!d.queueEdit;
    send.disabled = !!sendingProject || Boolean(uploadCounts.get(scopeId)) || Boolean(d.textFiles?.length) || sendLocked(state) || verifying.has(scopeId);
    attachButton.disabled = busy || !!d.pending || !!d.queueEdit;
    sendLabel(SEND_LABELS[state] || 'Send');
    if(d.queueEdit){sendLabel(queueEditing.has(scopeId)?'Retrieving queued message…':'Retry editing queued message');send.disabled=queueEditing.has(scopeId)||!!sendingProject;}
    attachTray.replaceChildren();
    for (const item of d.attachments || []) attachTray.append(attachmentCard(item,true));
    for (const entry of d.textFiles || []) attachTray.append(textDraftCard(entry, scopeId));
    if (uploadCounts.get(scopeId)) attachTray.append(create('span','attachment-uploading','Uploading attachments…'));
    attachTray.hidden = !attachTray.childElementCount;
    resizeInput();
    quoteBar.replaceChildren(); quoteBar.hidden = !d.replyToId;
    if (d.replyToId) quoteBar.append(create('span', '', t('Quoting {replyLabel}', { replyLabel: d.replyLabel })), iconAction('close', 'Cancel quote', () => {
      if (d.pending || busy) return;
      if(d.replyMention&&input.value.startsWith(d.replyMention)){input.value=input.value.slice(d.replyMention.length);d.text=input.value;}
      delete d.replyMention;
      d.replyToId = null; d.replyLabel = ''; delete d.discussion;saveDrafts(); composer();
    }));
  }

  function liveText(runId) {
    return liveByRun.get(runId)?.text || '';
  }
  // Step verbs ("Read", "Ran") share the Sessions page's own translations.
  const stepT=(text,params)=>{const own=getLanguage()==='zh'?stepZh[text]:undefined;return own===undefined?t(text,params):params?own.replace(/\{(\w+)\}/g,(m,k)=>params[k]??m):own;};
  /** What a running role is doing right now, from its live events: the latest tool still in progress, else '' (thinking or
   * writing). A tool's later events (its result) carry the same id, so a finished tool no longer counts. */
  function liveStep(events) {
    const tools=new Map();
    for(const e of events)if(e.type==='tool'&&e.payload?.item?.id){const prior=tools.get(e.payload.item.id);tools.delete(e.payload.item.id);tools.set(e.payload.item.id,{...prior,...e.payload.item,name:e.payload.item.name||prior?.name,input:e.payload.item.input??prior?.input,arguments:e.payload.item.arguments??prior?.arguments});}
    // Codex and others mark a running item inProgress; Claude's tool_use has no status until its tool_result arrives.
    const running=[...tools.values()].reverse().find(item=>item.status==='inProgress'||item.type==='tool_use'&&!item.status);
    if(!running)return '';const {verb,target}=stepTitle(classifyStep(running,'running'),stepT),text=`${verb} ${target}`.trim();return text.length>36?`${text.slice(0,35)}…`:text;
  }

  async function pullLive(runId) {
    if (!runId || liveFetching.has(runId)) return;
    liveFetching.add(runId);
    try {
      const prior=liveByRun.get(runId);
      const result = await api(`/api/runs/${encodeURIComponent(runId)}/events?after=${prior?.seq || 0}`);
      const events = [...new Map([...(prior?.events || []),...(Array.isArray(result?.events)?result.events:[])].map(e=>[e.seq,e])).values()].sort((a,b)=>a.seq-b.seq);
      const text = extractLiveText(events), step = liveStep(events);
      const prev = liveByRun.get(runId);
      liveByRun.set(runId, { text, step, events, seq:events.at(-1)?.seq || 0, at: Date.now() });
      updateLiveFullscreen();
      if ((text !== (prev?.text || '') || step !== (prev?.step || '')) && projectId) renderMessages();
    } catch {
      if(fullscreenView?.runId===runId)fullscreenView.heading.textContent='Live reply · connection unavailable; content already received is kept';
    } finally { liveFetching.delete(runId); }
  }

  function quoteReply(m,{mentionSender=true}={}) {
    if (draft().pending || draft().queueEdit || sendingProject === scopeId) return;
    const d=draft();
    // Replace only our own previous prefix; explicit mentions and the unsent body remain the user's choice.
    if(d.replyMention&&input.value.startsWith(d.replyMention))input.value=input.value.slice(d.replyMention.length);
    delete d.replyMention;
    const senderId=m.roleId||(data.runs||[]).find(r=>r.id===m.runId&&r.projectId===projectId)?.roleId;
    const role=m.sender==='agent'?(data.roles||[]).find(r=>r.projectId===projectId&&(senderId?r.id===senderId:r.name===m.senderName)):null;
    if(mentionSender&&role&&!hasMention(input.value)){
      d.replyMention=`@${role.name} `;input.value=d.replyMention+input.value;
    }
    Object.assign(d, { text:input.value,replyToId: m.id, replyLabel: t('{senderName}: {v}', { senderName: m.senderName, v: m.text.slice(0, 100) }) });
    delete d.discussion;
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

  /** Recipients come only from routing records; displayed prose is never parsed as dispatch metadata. */
  function messageRecipients(message,replyDirection) {
    const routed=message.kind==='discussion'&&message.discussion?.toRoleId
      ? [data.roles?.find(role=>role.id===message.discussion.toRoleId)||{id:message.discussion.toRoleId,name:message.discussion.toRoleId}]
      : Array.isArray(message.handoff?.toRoles)&&message.handoff.toRoles.length
      ? message.handoff.toRoles
      : message.handoff?.toRole ? [{id:message.handoff.toRoleId,name:message.handoff.toRole}] : [];
    const tasks=(message.taskIds||[]).map(id=>data.tasks?.find(task=>task.id===id)).filter(Boolean);
    const roster=message.sender==='human'?tasks.flatMap(task=>task.schedulingRoster||[]):[];
    if(roster.length)return [...new Map(roster.filter(role=>role?.name).map(role=>[role.id||role.name,role])).values()];
    const requestIds=Array.isArray(message.requestIds)?message.requestIds:[];
    const taskRequestIds=tasks.map(task=>task.requestId).filter(Boolean);
    const requested=[...requestIds,...taskRequestIds].map(id=>data.requests?.find(request=>request.id===id))
      .map(request=>data.roles?.find(role=>role.id===request?.targetRoleId)).filter(Boolean);
    const singleTaskTargets=message.sender==='human'&&!requested.length?tasks.map(task=>task.roleSnapshot||data.roles?.find(role=>role.id===task.roleId)).filter(Boolean):[];
    const replyTarget=replyDirection?.to?[data.roles?.find(role=>role.name===replyDirection.to)||{name:replyDirection.to}]:[];
    const resolved=[...routed,...requested,...singleTaskTargets];
    return [...new Map((resolved.length?resolved:replyTarget).filter(role=>role?.name).map(role=>[role.id||role.name,role])).values()];
  }

  /** Remove only leading mentions that exactly match already-resolved recipients; stored text is never changed. */
  function messageDisplayText(text,recipients) {
    let display=String(text||'');
    const targets=new Set(recipients.flatMap(role=>[role.id,role.name]).filter(Boolean).map(String));
    while(targets.size) {
      const mention=display.match(/^\s*[@\uFF20]([\p{L}\p{N}_-]+)(?=$|[^\p{L}\p{N}_-])\s*/u);
      if(!mention||!targets.has(mention[1]))break;
      display=display.slice(mention[0].length);
    }
    return display;
  }

  /** A persisted outbound card is complete; only a receiver's own reply follows its run state. */
  function messageCardMeta(message) {
    const outbound=message.sender!=='agent'||['handoff','discussion'].includes(message.kind);
    const kind=message.kind==='discussion'?'Question':message.kind==='handoff'
      ? ({consult:'Question',direct:'Instruction',transfer:'Transfer',note:'Notice'}[message.handoff?.kind]||'Instruction')
      : message.sender==='agent'?'Reply':'Message';
    if(outbound)return {kind,status:'Completed'};
    const run=data.runs?.find(item=>item.id===message.runId);
    const task=run&&data.tasks?.find(item=>item.id===run.taskId);
    const progress=run&&taskProgress(task||{roleSnapshot:run.roleSnapshot},run);
    // 只计算已完成的这次执行，不把排队时间或缺失的历史时间当作耗时。
    const elapsedMs=Date.parse(run?.finishedAt)-Date.parse(run?.startedAt);let duration='';
    if(progress?.state==='completed'&&Number.isFinite(elapsedMs)&&elapsedMs>=0){
      const total=Math.floor(elapsedMs/1000),hours=Math.floor(total/3600),minutes=Math.floor(total%3600/60),seconds=total%60;
      duration=`${hours?hours+'h':''}${hours||minutes?minutes+'m':''}${seconds}s`;
    }
    return {kind,status:progress?t(progress.label):'Completed',duration,state:progress?.state||'completed'};
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

  let documentPreviewDialog,documentPreviewVersion=0;
  /** Keep file reading in the existing fullscreen layer; ordinary external links retain their browser behavior. */
  function previewDocumentLinks(root,context=null){
    root.addEventListener('click',event=>{
      const link=event.target.closest?.('a[href]');if(!link||!root.contains(link)||event.button!==0)return;
      const href=link.getAttribute('href');let url;
      try{
        url=new URL(href,location.href);
        if(url.origin!==location.origin||url.pathname!=='/document.html'){
          if(!context||/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)||!/\.(?:md|markdown|txt)(?:#.*)?$/i.test(href))return;
          const path=context.get('path'),absolute=href.startsWith('/')||path.startsWith('/');
          const resolved=new URL(href,new URL(path,'https://document.invalid/'));
          let documentPath=decodeURIComponent(resolved.pathname);if(!absolute)documentPath=documentPath.replace(/^\//,'');
          const next=new URLSearchParams(context);next.set('path',documentPath);
          url=new URL(`/document.html?${next}`,location.href);
        }
      }catch{return;}
      event.preventDefault();void openDocumentPreview(url.searchParams);
    });
    return root;
  }
  /** Read through the existing authorized API; closing or replacing the reader fences late responses. */
  async function openDocumentPreview(params){
    const version=++documentPreviewVersion,path=params.get('path')||'',runId=params.get('runId'),id=params.get('projectId'),scopeId=params.get('scopeId');
    const name=path.split(/[\\/]/).at(-1)||t('Project Document');let raw='';
    if(!documentPreviewDialog){
      documentPreviewDialog=create('dialog','message-fullscreen');documentPreviewDialog.id='document-preview-dialog';
      documentPreviewDialog.addEventListener('close',()=>{documentPreviewVersion++;});document.body.append(documentPreviewDialog);
    }
    documentPreviewDialog.setAttribute('aria-label',name);
    const header=create('div','message-fullscreen-heading'),heading=create('strong','',name),copy=copyMessageButton(()=>raw);
    const close=iconAction('close','Close',()=>documentPreviewDialog.close());close.autofocus=true;copy.disabled=true;
    header.append(heading,copy,close);
    const body=create('div','message-fullscreen-body'),content=create('div','message-fullscreen-content'),status=create('p','workspace-note',t('Reading file…'));
    content.append(status);body.append(content);documentPreviewDialog.replaceChildren(header,body);
    if(!documentPreviewDialog.open)documentPreviewDialog.showModal();
    try{
      if(!path||!runId&&(!id||!scopeId))throw new Error('Incomplete document link');
      const endpoint=id?`/api/projects/${encodeURIComponent(id)}/local-file?${new URLSearchParams({scopeId,path})}`:`/api/runs/${encodeURIComponent(runId)}/document?path=${encodeURIComponent(path)}`;
      const result=await api(endpoint);if(version!==documentPreviewVersion||!documentPreviewDialog.open)return;
      if(result.shared){const location=create('p','workspace-note',result.path||t('Waiting for local synchronization'));location.setAttribute('translate','no');content.append(location);}
      if(result.shared&&result.content===null){status.textContent=t(result.preview==='binary'?'Binary file; preview unavailable.':result.preview==='too_large'?'File synchronized; text preview exceeds 600 KB.':result.syncState==='missing'?'Local file not found.':'Waiting for local synchronization');return;}
      raw=String(result.content||'');copy.disabled=!raw;
      const rendered=/\.(?:md|markdown)$/i.test(name)?previewDocumentLinks(renderMarkdown(simplifiedCliOutput(raw)),params):Object.assign(create('pre','artifact-code'),{textContent:raw});
      content.append(rendered);status.textContent=t('Full text loaded · {v} characters',{v:raw.length.toLocaleString(dateLocale())});
      if(result.syncState==='conflict'||result.syncState==='local_changes')status.textContent+=' · '+t(result.syncState==='conflict'?'Conflict detected; showing actual local file.':'Showing local changes; synchronization pending.');
    }catch(error){if(version===documentPreviewVersion&&documentPreviewDialog.open)status.textContent=t('Unable to open document: {message}',{message:error.message});}
  }

  /** Chat prose is simplified for display only; copying and the Original view retain the complete stored text. */
  /** Media files named in a reply open in the shared viewer; bytes stay on the device that ran the turn until requested. */
  const mediaContext=runId=>runId?{key:`run:${runId}`,describe:path=>api(`/api/runs/${encodeURIComponent(runId)}/media?path=${encodeURIComponent(path)}`)}:null;
  const renderLinkedMarkdown=(text,runId)=>previewDocumentLinks(localizeDocumentLinks(linkMedia(linkRunDocuments(renderMessageMarkdown(simplifiedCliOutput(text)),runId),mediaContext(runId)),runId,api));
  function replyPreview(text, markdown = true, runId = null, key = '') {
    const preview = create('div', 'chat-reply-preview');
    preview.dataset.previewKey = `${projectId}:${key}`;
    preview.append(markdown ? renderLinkedMarkdown(text,runId) : create('div', 'chat-message-text', simplifiedCliOutput(text)));
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
    const message=histories.get(scopeId)?.messages.find(m=>m.id===`result-${view.runId}`);
    const text=fullRunReply(run,liveText(view.runId),message);
    const label=t(taskProgress(task,run).label);
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
      content.append(markdown ? renderLinkedMarkdown(text,runId) : create('div', 'chat-message-text', simplifiedCliOutput(text)));
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

  /** 仅显示消息或任务当时的模型记录，避免角色改配置后误标历史。 */
  function appendModelLabel(header, model) {
    if (typeof model !== 'string' || !model.trim()) return;
    const label = create('span', 'chat-model-label', model.trim());
    label.translate = false;
    label.title = `${t('Model')}: ${model.trim()}`;
    header.append(label);
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
    // A recalled draft never ran: keep its human history, without inventing a stopped Agent reply.
    if(task.queueEditId&&!task.currentRunId)return null;
    // Share the queue's actual displayed membership rather than maintaining a second eligibility rule.
    if(messageQueue.hasTask(task.id))return null;
    const run = data.runs?.find(r => r.id === task.currentRunId);
    const recoveryButton=cliRecoveryUI.button(task);
    if(task.backgroundFollowup||run?.backgroundFollowup){const approvals=run?renderApprovalsInline(run):null;if(!recoveryButton)return approvals;const entry=create('div','chat-approvals');if(approvals)entry.append(approvals);entry.append(recoveryButton);return entry;}
    if (run && messages.some(m => m.runId === run.id)) return null;
    const role = task.roleSnapshot || {};
    if (quietHandoff(run, data)) {
      // The handoff cards already carry the work; keep only a compact waiting line, without replaying this turn's text.
      const waiting = handoffWaitState(run, data);
      if (!waiting) return null;
      const row = create('article', 'chat-row agent is-live is-handoff-wait');
      row.append(avatarFor(role, role.name));
      const col = create('div', 'chat-col');
      const label = waiting.names.length ? t('Waiting for {names} to reply', { names: waiting.names.map(name => `@${name}`).join(t(', ')) }) : t('Waiting for other roles to reply');
      const line = create('div', 'chat-name handoff-wait-line', `@${role.name || t('Role')} · ${label}`);
      line.translate = false;
      const header=create('div','chat-message-header');header.append(create('div','chat-name',role.name||t('Role')));
      appendModelLabel(header,run?.model||run?.roleSnapshot?.model||role.model);
      const bubble=setChatCardState(create('div','chat-bubble'),'waiting'),footer=create('div','chat-card-footer'),actions=create('div','chat-card-actions');
      line.className='chat-message-text';actions.append(iconAction('live','Log',()=>openTask(task.id,run.id)));footer.append(create('span','chat-card-kind',t('Waiting')),actions);bubble.append(line,footer);col.append(header,bubble);
      row.append(col);
      return row;
    }
    const row = create('article', 'chat-row agent is-live');
    row.append(avatarFor(role, role.name));
    const col = create('div', 'chat-col');
    const progress=taskProgress(task,run),label=t(progress.label);
    const running=progress.state==='running'&&run?.startedAt;
    const nameLine=create('div', 'chat-name', `@${role.name || t('Role')}`);
    nameLine.translate=false;nameLine.title=nameLine.textContent;
    // The time sits on the name line outside the card, like every other message.
    const header = create('div', 'chat-message-header');
    const sentAt = run?.startedAt || run?.createdAt || task.createdAt;
    const time = create('time', '', formatTime(sentAt));
    if (sentAt) time.dateTime = sentAt;
    header.append(nameLine);
    appendModelLabel(header,run?.model||run?.roleSnapshot?.model||role.model);
    header.append(time);
    col.append(header);
    const bubble = setChatCardState(create('div', 'chat-bubble is-live-card'),progress.state);
    // Home resolves the immediate call before pagination; older Homes can still resolve visible call cards locally.
    const request=data.requests?.find(r=>r.id===(run?.requestId||task.requestId));
    const quotes=histories.get(scopeId)?.liveReplySources;
    const source = quotes&&Object.hasOwn(quotes,task.id)?quotes[task.id]:messages.find(q=>q.id===(request?.callMessageId||`call:${request?.id}`))||(!request?.parentRequestId&&!['consult','handoff','continuation'].includes(request?.kind)?messages.find(q=>q.id===task.sourceMessageId):null);
    // An attachment-only source still names its sender and opens the original; its files stand in for the empty text.
    const sourceFiles = source?.attachments?.length ? t('[Attachment] {v}', { v: source.attachments.map(a => a.name).filter(Boolean).join(t(', ')) || source.attachments.length }) : '';
    const sourceText = simplifiedCliOutput(source ? source.text || sourceFiles || task.title || task.prompt || '' : task.title || task.prompt || '');
    if (sourceText) {
      const flat = sourceText.replace(/\s+/g, ' ').trim(), summary = flat.length > 240 ? `${flat.slice(0, 240)}…` : flat;
      const label = source ? t('Reply to {senderName}: {v}', { senderName: source.senderName, v: summary }) : t('Reply to: {v}', { v: summary });
      const quote = create(source ? 'button' : 'div', 'quoted-message chat-live-reply');
      quote.append(create('span', 'chat-live-reply-text', label));
      quote.translate = false;
      if (source) {
        quote.type = 'button'; quote.title = 'View quoted original'; quote.setAttribute('aria-label', 'View quoted original');
        quote.addEventListener('click', () => void historyViewer.open(source.projectId || task.projectId, 'message', source.id, source.conversationId || source.projectId || task.projectId).catch(e => setError(e.message)));
      }
      bubble.append(quote);
    }
    const preview = run && !run.explicitPublish ? liveText(run.id) : '';
    if (preview) bubble.append(replyPreview(preview,true,run?.id,`run:${run?.id || task.id}`));
    else if(progress.state==='error')bubble.append(create('div','chat-message-text',progress.reason||run?.error||task.error||t(progress.detail)));
    else {
      const typing = create('div', 'chat-typing');
      typing.append(create('span'), create('span'), create('span'));
      const typingRow = create('div', 'chat-typing-row');
      // The status line below already names the state; the dots only show the card is alive.
      typing.setAttribute('role', 'status'); typing.setAttribute('aria-label', label);
      typingRow.append(typing);
      bubble.append(typingRow);
    }
    col.append(bubble);
    const alert=run&&data.runAlerts?.find(a=>a.id===run.id);
    if(alert)bubble.append(create('p','run-alert',alert.reason));
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
    if (run) actions.push(iconAction('live', 'Log', () => openTask(task.id,run.id)));
    // Status and actions sit inside the card, the same footer as finished messages.
    // The footer names the stage: queued, the CLI getting ready (workspace, start, resume), then thinking, the step it is
    // running, or replying, with the time it has taken so far.
    const preparing=progress.stage==='worker_received',step=running?liveByRun.get(run.id)?.step:'';
    const stage=preparing?t('CLI preparing'):progress.stage==='queued'?t('Queued'):running?(step||t(preview?'Replying':'Thinking')):label;
    const footer = create('div', 'chat-card-footer'), status = create('span', 'chat-card-kind', stage);status.title=stage;
    if (running||preparing) { const elapsed = elapsedEl(create, running?run.startedAt:run.createdAt); if (elapsed) status.append(elapsed); }
    const actionBar = create('div', 'chat-card-actions'); actionBar.append(...actions);
    // The CLI occupancy check stays available as one more icon in the row, instead of a box standing in for the body.
    if (recoveryButton) actionBar.append(recoveryButton);
    footer.append(status, actionBar); bubble.append(footer);
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
    row.dataset.messageId=m.id;
    const role = agent ? (data.roles || []).find(r => r.id === m.roleId) || (data.runs || []).find(r => r.id === m.runId)?.roleSnapshot : null;
    if (agent) row.append(avatarFor(role, m.senderName));
    const col = create('div', 'chat-col');
    const header = create('div', 'chat-message-header');
    const time = create('time', '', formatTime(m.createdAt));
    if (m.createdAt) time.dateTime = m.createdAt;
    const sender=create('div', 'chat-name', agent ? m.senderName : 'Me');
    // Saved role names are identities, not UI dictionary keys.
    if(agent)sender.setAttribute('translate','no');
    if(agent)sender.title=m.senderName||'';
    // Name and send time share the line above the card; the card itself starts with the reply quote, if any.
    header.append(sender);
    if (agent) {
      const run=data.runs?.find(r=>r.id===m.runId);
      appendModelLabel(header,run?.model||run?.roleSnapshot?.model||m.model);
    }
    header.append(time);
    col.append(header);
    const bubble = create('div', `chat-bubble${handoff || replyDirection ? ' handoff-card' : ''}`);
    const top = create('div', 'chat-bubble-top');
    if (m.replyToId) {
      const source = m.replySource || messages.find(q => q.id === m.replyToId);
      const quoteText=source?simplifiedCliOutput(source.text|| (source.attachments?.length?t('[Attachment] {v}',{v:source.attachments.map(a=>a.name).filter(Boolean).join(t(', '))||source.attachments.length}):'')):'';
      const quote=create(source?.id?'button':'div', 'quoted-message', source ? t('{senderName}: {v}', { senderName: source.senderName, v: quoteText.slice(0, 180)+(quoteText.length>=180?'...':'') }) : 'Quoting an earlier message');
      if(source?.id){quote.type='button';quote.title='View quoted original';quote.setAttribute('aria-label','View quoted original');quote.addEventListener('click',()=>void historyViewer.open(m.projectId,'message',source.id,m.conversationId||m.projectId).catch(error=>setError(error.message)));}
      top.append(quote);
      bubble.append(top);
    }
    const recipients=messageRecipients(m,replyDirection);
    const bodyText=messageDisplayText(handoff?m.handoff.summary||m.text:m.text,recipients);
    const body=replyPreview(bodyText,handoff||agent,m.runId,`message:${m.id}`);
    if(recipients.length){
      const list=create('span','chat-recipient-list');list.translate=false;
      for(const recipient of recipients)list.append(create('span','chat-recipient role-mention-token',`@${recipient.name}`),document.createTextNode(' '));
      const content=body.firstElementChild,first=content.firstElementChild;
      // Ordinary Markdown paragraphs accept the inline prefix; lists and code blocks keep their own structure.
      (content.classList.contains('markdown-body')&&first?.tagName==='P'?first:content).prepend(list);
    }
    bubble.append(body);
    if (m.attachments?.length) {
      const files = create('div','chat-attachments');
      for(const item of m.attachments) files.append(attachmentCard(item));
      bubble.append(files);
    }
    const actions = [],discussionActions=[];
    if(discussion?.canReply) {
      actions.push(iconAction('quote','Reply to this question',()=>{quoteReply(m,{mentionSender:false});draft().discussion={threadId:discussion.thread.id,expectedQuestionId:discussion.questionId,revision:discussion.thread.revision,directionRevision:discussion.thread.directionRevision};saveDrafts();}));
    } else actions.push(iconAction('quote', 'Reply', () => quoteReply(m)));
    if(discussion?.canReply||discussion?.canResume) {
      discussionActions.push(iconAction('check',discussion.canResume?'Changes verified; continue the original task':'Mark question as handled',async b=>{
        b.disabled=true;const requestId=`user-${discussion.canResume?'resume':'resolve'}:${discussion.thread.id}:${discussion.questionId}:${discussion.thread.revision}`;
        try{await api(`/api/projects/${encodeURIComponent(m.projectId)}/discussions/${encodeURIComponent(discussion.thread.id)}/resolve`,{method:'POST',json:{requestId,expectedQuestionId:discussion.questionId,revision:discussion.thread.revision,directionRevision:discussion.thread.directionRevision,...(discussion.canResume?{resumeAfterRunId:discussion.resumeAfterRunId}:{}),conclusion:discussion.canResume?'User reviewed the exception log and actual changes and explicitly chose to continue the original task':'User explicitly marked this question as handled in the web UI'}});await refreshState({quiet:true});}catch(e){setError(e.message);b.disabled=false;}
      }));
    }
    if(discussion?.canStop)discussionActions.push(iconAction('stop','Stop original task',async b=>{
      b.disabled=true;
      try{await api(`/api/runs/${encodeURIComponent(discussion.stopRunId)}/stop`,{method:'POST',json:{commandId:`discussion-owner-stop:${discussion.stopRunId}:${discussion.questionId}`}});await refreshState({quiet:true});}catch(e){setError(e.message);b.disabled=false;}
    }));
    actions.push(copyMessageButton(handoff ? m.handoff.summary || m.text : m.text));
    if(agent&&m.runId&&openSideAsk)actions.push(iconAction('sideAsk','Side question',()=>void openSideAsk(m)));
    if (m.runId) {
      const run = data.runs?.find(r => r.id === m.runId);
      if (run) actions.push(iconAction('live', 'Log', () => openTask(run.taskId,run.id)));
    }
    actions.push(fullscreenMessageButton(handoff ? m.handoff.summary || m.text : m.text, m.senderName, agent || Boolean(handoff), m.attachments, null, m.runId));
    actions.push(...discussionActions);
    const cardMeta=messageCardMeta(m),footer=create('div','chat-card-footer');setChatCardState(bubble,cardMeta.state);
    footer.append(create('span','chat-card-kind',t('{kind} · {status}',{kind:t(cardMeta.kind),status:t(cardMeta.status)})+(cardMeta.duration?` · ${cardMeta.duration}`:'')));
    const actionBar=create('div','chat-card-actions');actionBar.append(...actions);footer.append(actionBar);bubble.append(footer);
    col.append(bubble);
    row.append(col);
    return row;
  }

  /** Continuation notices are historical events, not a persistent footer or a new message on every refresh. */
  function renderResumeNotice(request, at) {
    const task=data.tasks?.find(t=>t.id===request.taskId);
    const role=task?.roleSnapshot||data.roles?.find(r=>r.id===request.targetRoleId)||{};
    const progress=executionProgress({task,request}),row=create('article','chat-row agent is-resume-notice'),col=create('div','chat-col');
    const header=create('div','chat-message-header'),line=create('div','chat-message-text',t(progress.detail));
    line.setAttribute('role','status');line.title=progress.reason||request.error||request.resumeError?.message||'';
    header.append(create('div','chat-name',role.name||t('Role')));
    appendModelLabel(header,task?.roleSnapshot?.model);
    if(at){const time=create('time','',formatTime(at));time.dateTime=at;header.append(time);}
    const bubble=setChatCardState(create('div','chat-bubble'),progress.state),footer=create('div','chat-card-footer'),actions=create('div','chat-card-actions');
    bubble.append(line);if(line.title)bubble.append(create('div','chat-message-text',line.title));
    if(task)actions.append(iconAction('live','Log',()=>openTask(task.id,request.currentRunId)));
    footer.append(create('span','chat-card-kind',t(progress.label)),actions);bubble.append(footer);col.append(header,bubble);
    row.append(avatarFor(role,role.name),col);return row;
  }

  function renderMessages() {
    cliRecoveryUI.refresh();
    const history = histories.get(scopeId), messages = history?.messages || [];
    const scrollTop = scroller.scrollTop;
    const atBottom = scroller.scrollHeight - scroller.clientHeight - scrollTop < 120;
    // 状态刷新会重建消息节点，按消息身份保留正文阅读位置，不抢回顶部。
    const previewScroll = new Map([...feed.querySelectorAll('.chat-reply-preview')].map(node => [node.dataset.previewKey, { top: node.scrollTop, left: node.scrollLeft }]));
    feed.replaceChildren();
    older.hidden = !history?.hasMore;
    if (!messages.length) feed.append(create('div', 'chat-empty', history
      ? data.projects?.find(p=>p.id===projectId)?.supervisorRoleId
        ? 'This is the project chat. New messages without @ go to the supervisor; replies target their sender; multiple @ mentions dispatch to each role; @everyone only sends a notification and does not start an Agent.'
        : 'This is the project chat. Without @ it is only logged; @someone dispatches to them; @everyone only sends a notification and does not start an Agent.'
      : 'Loading chat…'));
    // Use the saved error time, never refresh time. Older notices follow the same history window as messages.
    const eventTime=value=>Date.parse(value)||0;
    const notices=(data.requests||[]).filter(r=>r.projectId===projectId&&(r.conversationId||r.projectId)===conversationId&&!r.continuationRequestId&&
      (r.status==='waiting_call'&&r.resumeError?.kind==='transient'||r.status==='failed'&&r.failureKind==='resume_failed')&&
      data.tasks?.find(task=>task.id===r.taskId)?.status!=='cancelled')
      .map(request=>({request,at:request.resumeError?.at||request.updatedAt||request.createdAt}))
      .filter(item=>!history?.hasMore||messages.length&&eventTime(item.at)>=eventTime(messages[0].createdAt))
      .sort((a,b)=>eventTime(a.at)-eventTime(b.at)||a.request.id.localeCompare(b.request.id));
    // One timeline, one key: trigger time. Messages carry the server's order; a running role's card sits where its run was
    // triggered (the same place its reply will take), so nothing moves once placed. Queued work is not in the timeline.
    const entries=[],orderOf=m=>String(m.orderAt||m.createdAt||'');
    messages.forEach((m,i)=>{
      // Hide only wholly queued user inputs; keep the original record available for quotes and multi-role replies.
      if(m.sender==='human'&&m.taskIds?.length&&m.taskIds.every(id=>messageQueue.hasTask(id)))return;
      entries.push({at:orderOf(m),rank:0,seq:typeof m.orderSeq==='number'?m.orderSeq:i,node:()=>renderMessageRow(m,messages)});
    });
    for(const item of notices)entries.push({at:String(item.request.createdAt||item.at||''),rank:1,seq:0,node:()=>renderResumeNotice(item.request,item.at)});
    const liveTasks=new Map();
    for(const m of messages)for(const id of m.taskIds||[]){const task=data.tasks?.find(t=>t.id===id);if(task)liveTasks.set(task.id,task);}
    for(const task of unlinkedLiveTasks(messages,data.tasks || [],data.runs || [],projectId))liveTasks.set(task.id,task);
    for(const task of liveTasks.values()){const run=data.runs?.find(r=>r.id===task.currentRunId);entries.push({at:String(run?.createdAt||task.createdAt||''),rank:2,seq:0,node:()=>renderLiveBubble(task,messages)});}
    for(const run of (data.runs||[]).filter(r=>r.projectId===projectId&&r.discussionDeliveryId&&['queued','starting','running','waiting_user','stopping','reconciling'].includes(r.status)))
      entries.push({at:String(run.createdAt||''),rank:2,seq:0,node:()=>renderLiveBubble({id:run.taskId,currentRunId:run.id,roleSnapshot:run.roleSnapshot},messages)});
    entries.sort((a,b)=>a.at.localeCompare(b.at)||a.rank-b.rank||a.seq-b.seq);
    for(const entry of entries){const node=entry.node();if(node)feed.append(node);}
    const queueStrip=renderSessionQueue(data.sessionQueues?.[projectId],{create,api,refreshState,projectId,roleName:id=>(data.roles||[]).find(r=>r.id===id)?.name||id});
    if(queueStrip)feed.append(queueStrip);
    feed.querySelectorAll('.chat-reply-preview').forEach(node => {
      const position = previewScroll.get(node.dataset.previewKey);
      if (position) { node.scrollTop = position.top; node.scrollLeft = position.left; }
    });
    highlightLatestChatCard(feed);
    scroller.scrollTop = atBottom ? scroller.scrollHeight : scrollTop;
    updateLiveFullscreen();
  }

  /** Read messages by Room revision; Token updates only refresh cards and do not re-fetch the whole history. */
  async function refresh(nextData, nextProjectId, nextConversationId=nextProjectId) {
    data = nextData;
    roleHistory.refresh();
    if (roleDialog.open && !savingRole && !checkingRuntime) renderDeviceOptions(roleForm.elements.nodeId.value);
    if (projectId !== nextProjectId || conversationId!==nextConversationId) {
      if(messageFullscreen?.open)messageFullscreen.close();
      projectId = nextProjectId;
      conversationId=nextConversationId;scopeId=conversationId===projectId?projectId:JSON.stringify([projectId,conversationId]);
      if (projectId) input.value = draft().text || '';
    }
    if (!projectId) return;
    messageQueue.update(data,projectId);composer(); renderMessages();
    if (draft().pending && sendState(draft()) !== 'failed') void verifyPending(scopeId);
    for (const run of (data.runs || []).filter(r => r.projectId === projectId && ['starting', 'running', 'waiting_user', 'stopping'].includes(r.status))) {
      void pullLive(run.id);
    }
    const viewing=data.runs?.find(r=>r.id===fullscreenView?.runId);
    if(viewing && (liveByRun.get(viewing.id)?.seq || 0)<viewing.lastSeq)void pullLive(viewing.id);
    const revision = data.rooms?.find(r => r.id === conversationId)?.revision || 0;
    const previous = histories.get(scopeId);
    if (previous?.revision === revision) return;
    const id = scopeId, targetProjectId=projectId, targetConversationId=conversationId, key = `${id}:${revision}`;
    if (pendingReads.has(key)) return;
    pendingReads.add(key);
    try {
      const receiptQuery=Number.isSafeInteger(previous?.receiptCursor)?`&afterReceipt=${previous.receiptCursor}`:'';
      const result = await api(`/api/projects/${encodeURIComponent(targetProjectId)}/messages?conversationId=${encodeURIComponent(targetConversationId)}${receiptQuery}`);
      const current = histories.get(id);
      if ((current?.revision ?? -1) > revision) return;
      const recentIds = new Set(result.messages.map(m => m.id));
      histories.set(id, { ...result, messages: [...(current?.messages || []).filter(m => !recentIds.has(m.id)), ...result.messages],
        hasMore: current ? current.hasMore : result.hasMore, nextBefore: current?.nextBefore || result.nextBefore, revision:result.hasMoreUpdates?null:revision });
      if (id === scopeId) renderMessages();
    } catch (e) { if (id === scopeId) setError(t('Failed to load chat: {message}', { message: e.message })); }
    finally { pendingReads.delete(key); }
  }

  older.addEventListener('click', async () => {
    const id = scopeId, targetProjectId=projectId, targetConversationId=conversationId, history = histories.get(id); if (!history?.nextBefore) return;
    older.disabled = true;
    try {
      const result = await api(`/api/projects/${encodeURIComponent(targetProjectId)}/messages?conversationId=${encodeURIComponent(targetConversationId)}&before=${encodeURIComponent(history.nextBefore)}`);
      if (id !== scopeId) return;
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
    resizeInput();
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
    // The project supervisor is routed by name on the server; offer it in the menu like any other role.
    const project = data.projects?.find(p => p.id === projectId);
    const supervisorRole = project?.supervisorRoleId ? (data.supervisorRoles || []).find(r => r.id === project.supervisorRoleId) : null;
    const supervisor = supervisorRole ? { ...supervisorRole, name: t('Supervisor@@roleCard') } : null;
    const supervisorMatches = supervisor && (!q || supervisor.name.toLowerCase().includes(q) || 'supervisor'.startsWith(q) || '\u603b\u7ba1'.includes(q));
    const roles = orderedItems(projectRoles(),readListOrder(`roles:${projectId}`)).filter(r => !q || r.name.toLowerCase().includes(q));
    const everyone = !q || 'everyone'.includes(q) || 'all'.startsWith(q);
    // Keep @everyone above the roles; role candidates follow the sidebar's pinned supervisor and saved card order.
    mentionChoices = [...(everyone ? [{ name: 'everyone', everyone: true }] : []), ...(supervisorMatches ? [supervisor] : []), ...roles];
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

  input.addEventListener('beforeinput',e=>{
    const d=projectId&&draft(),start=input.selectionStart??input.value.length,end=input.selectionEnd??start;
    // Editing the automatic prefix makes it user-owned, even if the same mention is later retyped.
    if(d?.replyMention&&(start<d.replyMention.length||start===end&&start===d.replyMention.length&&e.inputType==='deleteContentBackward'))delete d.replyMention;
  });
  input.addEventListener('input', e => {
    resizeInput();
    if (projectId) { if(draft().replyMention&&!input.value.startsWith(draft().replyMention))delete draft().replyMention;draft().text = input.value; saveDrafts(); }
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
    if(e.isComposing||e.keyCode===229)return;
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
    if (!projectId || sendingProject || uploadCounts.get(scopeId) || submitLocks.has(scopeId)) return;
    const id = projectId, ownerId=scopeId, targetConversationId=conversationId, d = draft();
    if(d.queueEdit){await finishQueueEdit(ownerId);return;}
    // Click, double click, Enter and redraws all land here: an in-flight or unknown send is only ever looked up, never resent.
    if (d.pending && d.sendState !== 'failed') { void verifyPending(ownerId, true); return; }
    submitLocks.add(ownerId);
    try {
    if (d.textFiles?.length) { setError('Finish uploading the long-text attachment first, or restore it to the input box'); return; }
    if (!d.pending && input.value.length > 12000) {
      const entry = attachComposerText();
      if (!entry) return;
      await textUploads.get(entry.id);
      if (scopeId !== ownerId || d.textFiles?.length) return;
    }
    if (!d.pending && !input.value.trim() && !d.attachments?.length) return;
    if(d.discussion&&d.attachments?.length){setError('Use text for discussion replies; send attachments as a separate regular message');return;}
    if (!d.pending) {
      const payload = { conversationId:targetConversationId, text: input.value, replyToId: d.replyToId || null, attachmentIds:(d.attachments||[]).map(a=>a.id),...(d.discussion&&!hasMention(input.value)?{discussion:d.discussion}:{}) };
      // A retry of exactly the content Home rejected keeps its id; any edit gets a new id, never the old one.
      d.pending = { clientMessageId: sameSend(d.rejected?.payload, payload) ? d.rejected.clientMessageId : crypto.randomUUID(), ...payload };
    }
    delete d.rejected; d.sendState = 'sending'; d.projectId ||= id;
    const sent = d.pending;
    saveDrafts(); sendingProject = ownerId; composer();
    try {
      if(sent.discussion)await api(`/api/projects/${encodeURIComponent(id)}/discussions/${encodeURIComponent(sent.discussion.threadId)}/reply`,{method:'POST',json:{...sent.discussion,requestId:sent.clientMessageId,text:sent.text}});
      else await api(`/api/projects/${encodeURIComponent(id)}/messages`, { method: 'POST', json: sent });
      settleSent(ownerId, sent);
      setError('');
      await refreshState({ quiet: true });
      // Home starts the reply within a second or two; a polling page would otherwise learn of it only on its next poll.
      for (const ms of [1000, 3000, 6000]) setTimeout(() => void refreshState({ quiet: true }).catch(() => {}), ms);
    } catch (error) {
      // Lost connections, timeouts and server errors leave the outcome unknown: keep the id and look it up.
      // A definite rejection (4xx) stored nothing, so the draft becomes editable again with its text and files.
      if (uncertainSend(error)) d.sendState = 'checking';
      else { const { clientMessageId, ...payload } = sent; d.rejected = { clientMessageId, payload }; delete d.pending; delete d.sendState; }
      if (scopeId === ownerId) setError(error.message);
    } finally { sendingProject = null; saveDrafts(); composer(); if (drafts[ownerId]?.pending === sent && drafts[ownerId].sendState === 'checking') void verifyPending(ownerId, true); }
    } finally { submitLocks.delete(ownerId); }
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
      && fields.autoApprove.checked === (role.autoApprove !== false)
      && (!fields.permissionScope.value || fields.permissionScope.value === role.permissionScope);
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
      // Home localizes built-ins; saved template names and prompt text remain user content.
      const option = create('option', '', template.key === 'custom' ? 'Blank role' : template.name);
      if (template.key !== 'custom') option.setAttribute('translate', 'no');
      option.value = template.key; presets.append(option);
    }
    presets.disabled = Boolean(role);
    document.querySelector('#role-archive').hidden = !role;
    for (const key of ['name', 'mode', 'responsibility', 'instructions']) roleForm.elements[key].value = value[key] ?? (key === 'mode' ? 'workspace-write' : '');
    for(const key of ['responsibility','instructions'])renderRetiredCommandWarning(roleCommandWarnings[key],roleForm.elements[key].value,t);
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
    renderModelUsageNotice(roleForm.querySelector('[data-model-usage-note]'),roleForm.elements.runtime.value,r?.models?.find(m=>m.id===select.value)||{id:select.value});
    const fresh = r?.checkedAt && Date.now() - Date.parse(r.checkedAt) < 600000;
    const binding = roleBinding(w?.id);
    const ready = w?.online && w.capabilities?.runtimeDiscovery && r?.supported && r.available && fresh && select.value && binding;
    const reason = !w?.online ? 'Please select an online device' : !w.capabilities?.runtimeDiscovery ? 'Please upgrade the Worker on this device' : !r?.available ? (w.runtimes?.[0]?.reason || 'No connected and available CLI Agent') : !fresh ? 'CLI check is stale; refresh it in "Basic Settings > Devices and CLIs"' : !select.value ? 'Select a model actually returned by this CLI; the previously selected model is not replaced automatically' : !binding ? 'First bind the project folder in "Project Settings > Project Workspace"' : 'Device, CLI, model and project folder match; they are checked again on save';
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
  const renderRolePermission = () => renderPermissionScope(roleForm.elements.permissionScope, roleForm.querySelector('[data-permission-note]'), {
    worker: data.workers?.find(w => w.id === roleForm.elements.nodeId.value), runtime: roleForm.elements.runtime.value,
    saved: editingRoleSnapshot?.permissionScope, isNew: !editingRoleId || editingRoleSnapshot?.configured === false });
  roleForm.elements.permissionScope.addEventListener('change', () => { roleForm.elements.permissionScope.dataset.touched = '1'; renderRolePermission(); });
  roleForm.elements.nodeId.addEventListener('change', renderRolePermission);
  roleForm.elements.runtime.addEventListener('change', renderRolePermission);
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
    delete roleForm.elements.permissionScope.dataset.touched; renderRolePermission();
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
      for (const key of ['name', 'mode', 'responsibility', 'instructions']) roleForm.elements[key].value = preset[key] || '';
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
    delete values.permissionScope; const permissionScope = permissionScopeValue(roleForm.elements.permissionScope); if (permissionScope) values.permissionScope = permissionScope;
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
  async function jumpMessage(target,id){
    if(target.projectId!==projectId||target.conversationId!==conversationId)return;
    const owner=scopeId;
    // Explicit navigation uses the existing paginated history, never a background history scan.
    for(let page=0;page<100;page++){
      if(owner!==scopeId)return;
      const node=[...feed.querySelectorAll('[data-message-id]')].find(n=>n.dataset.messageId===id);
      if(node){node.tabIndex=-1;node.focus({preventScroll:true});node.scrollIntoView({block:'center'});return;}
      const history=histories.get(owner);if(!history?.hasMore||!history.nextBefore)break;
      const before=history.nextBefore;
      const result=await api(`/api/projects/${encodeURIComponent(target.projectId)}/messages?${new URLSearchParams({conversationId:target.conversationId,before})}`);
      if(owner!==scopeId)return;
      const current=histories.get(owner),ids=new Set(current.messages.map(m=>m.id));
      histories.set(owner,{...current,messages:[...result.messages.filter(m=>!ids.has(m.id)),...current.messages],hasMore:result.hasMore,nextBefore:result.nextBefore});renderMessages();
      if(result.nextBefore===before)break;
    }
    throw new Error(t('Message is not in the loaded history. Use Load older messages to continue.'));
  }
  return { refresh, openRoleEditor, jumpMessage };
}
