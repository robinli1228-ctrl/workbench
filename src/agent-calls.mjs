import {ConversationTasks} from './conversation-tasks.mjs';
import {createHash} from 'node:crypto';
import {isSupervisorName} from './default-roles.mjs';
import {tr} from './i18n.mjs';
import {conversationIdOf,agentConversationInput} from './group-conversations.mjs';
import {mentionNames} from './rooms.mjs';
import {supplementPending} from './role-steering.mjs';

/**
 * Roles of the project @-mentioned in a role's text that would not have it otherwise: not the writer, the role that called it
 * (the answer goes back there anyway), roles sent the same call, or roles this run already has open calls to. A name may run
 * straight into the next word (Chinese text right after it); the longest role name it starts with counts. Words that are no role are left alone.
 */
export function mentionedRoles(db,run,text) {
  const roles=db.list('roles').filter(r=>r.projectId===run.projectId&&!r.archivedAt).sort((a,b)=>b.name.length-a.name.length);
  const request=db.get('coordinationRequests',run.requestId||''),skip=new Set([run.roleId]),requests=db.listProject('coordinationRequests',run.projectId);
  if(request?.parentRequestId)skip.add(db.get('coordinationRequests',request.parentRequestId)?.targetRoleId);
  for(const r of requests)if(request?.callMessageId&&r.callMessageId===request.callMessageId||r.sourceRunId===run.id&&!['succeeded','failed','cancelled'].includes(r.status))skip.add(r.targetRoleId);
  const resolve=name=>roles.find(r=>r.name===name)||(isSupervisorName(name)?roles.find(r=>r.systemSupervisor&&!r.platformAssistant):null)||roles.find(r=>name.startsWith(r.name));
  return [...new Map(mentionNames(String(text||'')).map(resolve).filter(role=>role&&!skip.has(role.id)).map(role=>[role.id,role])).values()];
}

/**
 * An @ notifies, but never costs the work it rides on. A consult or direct call goes out as asked; the roles its brief
 * mentions get a copy as a call of their own (`<id>-cc`), and if that copy cannot be sent the sender is told why.
 */
export function callWithMentions(ctx,run,input) {
  const result=createAgentCalls(ctx,run,input),kind=input.kind||'consult';
  if(!['consult','direct'].includes(kind)||typeof input.text!=='string')return result;
  const extra=mentionedRoles(ctx.db,run,input.text).filter(role=>!result.requests.some(r=>r.targetRoleId===role.id));
  if(!extra.length)return result;
  const names=extra.map(role=>`@${role.name}`).join(' '),hint=text=>({...result,hint:[result.hint,text].filter(Boolean).join(' ')});
  const {role,roles,...rest}=input;
  try{const copy=createAgentCalls(ctx,run,{...rest,requestId:`${input.requestId}-cc`,roles:extra.map(r=>r.id)});return {...hint(tr('agentCalls.mentionHint',{names})),mentionRequestIds:copy.requestIds};}
  catch(error){return hint(tr('agentCalls.mentionFailed',{names,reason:error.message}));}
}

/**
 * A note that @-mentions roles reaches them as a consultation, so each answers and the answer comes back to the writer.
 * Only a role turn with its own call does this; when the consultation cannot be sent the note is posted as before.
 */
export function noteWithMentions(ctx,run,text) {
  const eligible=typeof text==='string'&&text.trim().length<=8000&&run.requestId&&!run.discussionDeliveryId&&!run.collaborationBatchId&&!run.continuationBatchId;
  if(eligible)try{
    const requestId=`${run.id}:note-${createHash('sha256').update(text).digest('hex').slice(0,16)}`,prior=ctx.db.get('roomMessages',`call:${requestId}`);
    // A retried note returns its first notification; the roles it reached now count as busy with this turn's call.
    const extra=prior?.callFingerprint?(prior.requestIds||[prior.requestId]).map(id=>ctx.db.get('roles',ctx.db.get('coordinationRequests',id)?.targetRoleId||'')).filter(Boolean):mentionedRoles(ctx.db,run,text);
    if(extra.length){
      const sent=createAgentCalls(ctx,run,{requestId,roles:extra.map(r=>r.id),kind:'consult',text});
      return {...sent,hint:tr('agentCalls.noteSentAsCall',{names:extra.map(role=>`@${role.name}`).join(' ')})};
    }
  }catch{/* posted as a plain note below */}
  return ctx.rooms.agentNote(run,text);
}

// A teammate that was just corrected gets time to act on it before the next correction.
const STEER_GAP_MS=3*60*1000;
/** Roles that handed the work of this run out: the caller of its request (through wakes and transfers) and the run that sent it. */
function assigners(db,run) {
  const ids=new Set();
  for(let request=db.get('coordinationRequests',run.requestId||''),seen=new Set();request&&!seen.has(request.id);request=db.get('coordinationRequests',request.continuationOf||'')) {
    seen.add(request.id);
    for(const id of [request.parentRequestId,request.transferredFrom]){const source=id&&db.get('coordinationRequests',id);if(source?.targetRoleId)ids.add(source.targetRoleId);}
    const sender=request.sourceRunId&&db.get('runs',request.sourceRunId);if(sender?.roleId)ids.add(sender.roleId);
  }
  return ids;
}

/**
 * wb call --kind steer|interrupt: correct a teammate whose turn is running. steer adds the text to that turn (Claude, Codex)
 * or, when the turn cannot take it, puts it first in the role's queue; interrupt stops the turn and the role continues from
 * the text. Only the manager, or the role that handed that work out, may do this, and not twice within a few minutes.
 */
function steerTeammate({db,calls,steering,online=()=>true},run,request,target,kind) {
  if(!steering)throw new Error(tr('roleCalls.invalidCallType'));
  const admitted=calls.reconcile(request.id),task=admitted?.taskId&&db.get('tasks',admitted.taskId);
  if(!task)throw new Error(admitted?.error||tr('agentCalls.steerNotRunning',{name:target.name}));
  db.put('tasks',{...task,roleSteer:{kind,byRoleId:run.roleId,byRole:run.roleSnapshot.name,at:new Date().toISOString()}});
  // The request carries the mark too: waits and their deadlines treat a correction differently from handed-out work.
  db.put('coordinationRequests',{...db.get('coordinationRequests',request.id),roleSteer:kind});
  const conversationId=conversationIdOf(run);
  if(kind==='steer'){
    const added=steering.supplement(run.projectId,task.id,{conversationId},{online});
    if(!added)throw new Error(tr('agentCalls.steerNotRunning',{name:target.name}));
    return added.supplementing?{steer:'added',dispatchNodeIds:[added.nodeId].filter(Boolean),note:tr('agentCalls.steerAdded',{name:target.name})}
      :{steer:'queued_first',dispatchNodeIds:[],note:tr('agentCalls.steerQueuedFirst',{name:target.name})};
  }
  const result=steering.request(run.projectId,task.id,`role-steer-${createHash('sha256').update(request.id).digest('hex').slice(0,24)}`,{conversationId});
  return {steer:'interrupting',dispatchNodeIds:[...new Set((result.waitForRunIds||[]).map(id=>db.get('runs',id)?.nodeId).filter(Boolean))],note:tr('agentCalls.steerInterrupting',{name:target.name})};
}

/** One shared instruction is published atomically; each recipient retains its own queue, request and reply lifecycle. */
export function createAgentCalls({db,calls,rooms,steering,online},run,input) {
  agentConversationInput(run,input);
  const kind=input.kind||'consult';
  if(!['consult','direct','handoff','transfer','steer','interrupt'].includes(kind))throw new Error(tr('roleCalls.invalidCallType'));
  // A correction is stored as a consultation of its one target; the flag on its task makes it a steer.
  const steer=['steer','interrupt'].includes(kind)?kind:null;
  // A transfer hands the whole task over: the recipient owns it, replies to the user itself and is not tied to this turn.
  const transfer=kind==='transfer';
  if(input.role!==undefined&&input.roles!==undefined)throw new Error(tr('wbTools.invalidCallTargets'));
  const names=input.roles===undefined?[input.role]:input.roles;
  if(!Array.isArray(names)||!names.length||names.some(name=>typeof name!=='string'||!name.trim()))throw new Error(tr('wbTools.invalidCallTargets'));
  return db.transaction(()=>{
    const projectRoles=db.list('roles').filter(r=>r.projectId===run.projectId);
    const targets=[...new Map(names.map(name=>{
      const target=name.trim().replace(/^@/,'');
      const role=projectRoles.find(r=>r.id===target)||projectRoles.find(r=>r.name===target)||(isSupervisorName(target)?projectRoles.find(r=>r.systemSupervisor&&!r.platformAssistant):undefined);
      if(!role)throw new Error(tr('home.targetRoleNotFoundUse'));
      return [role.id,role];
    })).values()];
    // Roles @-mentioned in a consultation or delegation are sent the same brief; a transfer or delivery keeps its one recipient.
    if(transfer&&targets.length!==1)throw new Error(tr('wbTools.invalidCallTargets'));
    if(transfer&&targets[0].id===run.roleId)throw new Error(tr('roleCalls.transferToSelf'));
    if(transfer&&input.deliveryId)throw new Error(tr('roleCalls.transferNoDelivery'));
    if(steer) {
      const target=targets[0],conversationId=conversationIdOf(run);
      if(targets.length!==1||input.deliveryId||input.sourceSyncBatchId||input.task!==undefined)throw new Error(tr('wbTools.invalidCallTargets'));
      if(target.id===run.roleId)throw new Error(tr('agentCalls.steerSelf'));
      const active=db.activeRuns().filter(r=>r.projectId===run.projectId&&conversationIdOf(r)===conversationId&&r.roleId===target.id);
      if(!db.get('roomMessages',`call:${input.requestId||''}`)?.callFingerprint) {
        if(!active.length)throw new Error(tr('agentCalls.steerNotRunning',{name:target.name}));
        if(!run.roleSnapshot.systemSupervisor&&!active.some(r=>assigners(db,r).has(run.roleId)))throw new Error(tr('agentCalls.steerNotAllowed',{name:target.name}));
        const steers=db.listProject('tasks',run.projectId).filter(t=>conversationIdOf(t)===conversationId&&t.roleId===target.id&&t.roleSteer);
        // This role's own correction still waiting in the target's queue: an interrupt takes its place instead of running after it.
        const waiting=steer==='interrupt'?steers.filter(t=>t.roleSteer.byRoleId===run.roleId&&t.status==='ready'&&!t.currentRunId&&!t.steering&&!supplementPending(db,t)):[];
        if(steers.some(t=>!waiting.includes(t)&&Date.now()-Date.parse(t.roleSteer.at)<STEER_GAP_MS))throw new Error(tr('agentCalls.steerTooSoon',{name:target.name}));
        for(const t of waiting){const cancelled=rooms.cancel(t.id);if(cancelled?.requestId||t.requestId)calls.cancel(cancelled?.requestId||t.requestId);}
      }
    }
    const id=input.requestId||'';
    if(typeof id!=='string'||!/^[a-zA-Z0-9:_-]{1,200}$/.test(id))throw new Error(tr('roleCalls.invalidCallId'));
    if(typeof input.text!=='string'||!input.text.trim()||input.text.length>12000)throw new Error(tr('roleCalls.callSummaryMustBe1'));
    // The stored call is a consultation; kind keeps what the role asked for (the chat card and a retry's fingerprint).
    const callKind=steer?'consult':kind;
    const messageId=`call:${id}`,fingerprint=JSON.stringify({runId:run.id,targets:targets.map(r=>r.id).sort(),kind,text:input.text,deliveryId:input.deliveryId||null,sourceSyncBatchId:input.sourceSyncBatchId||null,...(input.task!==undefined?{task:input.task}:{})});
    const existing=db.get('roomMessages',messageId);
    const response=message=>{
      const requestIds=message.requestIds||[message.requestId];
      const requests=requestIds.map(id=>db.get('coordinationRequests',id));
      if(requests.some(r=>!r||r.projectId!==run.projectId))throw new Error(tr('roleCalls.callIdConflictsWithDifferent'));
      return {requestId:requestIds[0],requestIds,messageId,status:requests.length===1?requests[0].status:'accepted',requests:requests.map(r=>({requestId:r.id,targetRoleId:r.targetRoleId,status:r.status})),
        note:transfer?tr('home.transferredToOwner',{name:requests[0].targetSnapshot?.name||''}):message.steer?.note||tr('home.deliveredDirectlyTargetRoleWhen'),...(message.steer?{steer:message.steer.state}:{})};
    };
    if(existing?.callFingerprint){
      if(existing.projectId!==run.projectId||existing.callFingerprint!==fingerprint)throw new Error(tr('roleCalls.callIdConflictsWithDifferent'));
      return response(existing);
    }
    if(existing&&targets.length>1)throw new Error(tr('roleCalls.callIdConflictsWithDifferent'));
    const parent=calls.forRun(run);
    if(!parent)throw new Error(tr('home.currentExecutionHasNoRole'));
    // Only an owner hands a task over: a consulted or delegated role answers its caller, and a plan stage stays in its plan.
    if(transfer&&(parent.parentRequestId||run.planId||parent.planId))throw new Error(tr('roleCalls.transferNotOwner'));
    const taskList=new ConversationTasks(db),linked=input.task===undefined?null:taskList.show(run,input.task);
    if(linked&&!taskList.visible(linked,run))throw new Error(tr('conversationTasks.notFound'));
    const recipients=[],requests=targets.map(target=>{
      if(target.archivedAt)throw new Error(tr('home.targetRoleArchivedCannotBe'));
      const role=target,summary=input.text;
      // Work goes straight to the role on its own device, in its own workspace; only a plan stage may not add cross-device work.
      if(!['consult','transfer'].includes(callKind)&&!run.roleSnapshot.systemSupervisor&&role.nodeId!==run.nodeId&&run.planId)throw new Error(tr('home.forNewCrossDeviceWork'));
      const requestId=targets.length===1?id:`multi:${createHash('sha256').update(JSON.stringify([id,target.id])).digest('hex')}`;
      const request=transfer
        ?calls.create({id:requestId,projectId:run.projectId,targetRoleId:role.id,sourceRunId:run.id,originNodeId:run.nodeId,
          sourceMessageId:run.sourceMessageId,kind:'direct',transferredFrom:parent.id,summary,sourceSyncBatchId:input.sourceSyncBatchId,attachments:run.attachments||[]})
        :calls.create({id:requestId,projectId:run.projectId,targetRoleId:role.id,parentRequestId:parent.id,sourceRunId:run.id,originNodeId:run.nodeId,
          sourceMessageId:run.sourceMessageId,kind:callKind,summary,deliveryId:input.deliveryId,sourceSyncBatchId:input.sourceSyncBatchId,attachments:steer?[]:run.attachments||[],
          // The caller's execution pins its own device's versions; a role on another device works from its own workspace.
          ...(callKind==='consult'||role.nodeId!==run.nodeId&&!run.roleSnapshot.systemSupervisor?{}:{planId:run.planId,planVersion:run.planVersion,stepId:run.stepId,execution:run.execution})});
      if(linked&&transfer)taskList.transfer(run,linked.id,role.id);
      recipients.push({id:role.id,name:role.name});
      return db.put('coordinationRequests',{...request,...(linked?{conversationTaskId:linked.id}:{}),callMessageId:messageId});
    });
    if(existing)return response(existing);
    const steered=steer?steerTeammate({db,calls,steering,online},run,requests[0],targets[0],steer):null;
    const toRoles=[...new Map(recipients.map(r=>[r.id,r])).values()];
    const message=db.put('roomMessages',{id:messageId,projectId:run.projectId,conversationId:conversationIdOf(run),sender:'agent',senderName:run.roleSnapshot.name,roleId:run.roleId,kind:'handoff',runId:run.id,
      requestId:requests[0].id,requestIds:requests.map(r=>r.id),callFingerprint:fingerprint,taskIds:[],text:input.text,replyToId:rooms.replySourceFor(run)?.id||null,
      handoff:{kind,fromRoleId:run.roleId,fromRole:run.roleSnapshot.name,toRoleId:toRoles[0].id,toRole:toRoles[0].name,toRoles,summary:input.text},
      ...(steered?{steer:{state:steered.steer,note:steered.note}}:{}),createdAt:new Date().toISOString()});
    rooms.touch(run.projectId,conversationIdOf(run));
    // Nudges at the moment of dispatch; the call itself is sent unchanged either way.
    const hints=[];
    // Work handed to others should be tracked as a task; consultations and reviews are not.
    if(['direct','transfer'].includes(kind)&&!linked&&!parent.conversationTaskId)hints.push(tr('agentCalls.taskHint'));
    // Only an owning root turn can transfer; do not suggest a handover that the permission checks would reject.
    if(kind==='direct'&&run.roleSnapshot?.systemSupervisor&&linked&&targets.length===1&&linked.ownerRoleId===run.roleId&&targets[0].id!==run.roleId&&!parent.parentRequestId&&!run.planId&&!parent.planId&&!['done','cancelled'].includes(linked.status))hints.push(tr('agentCalls.transferHint'));
    const result=hints.length?{...response(message),hint:hints.join(' ')}:response(message);
    // Home sends the supplement or the stop to these devices right away; the list is not part of the role's answer.
    if(steered?.dispatchNodeIds.length)Object.defineProperty(result,'dispatchNodeIds',{value:steered.dispatchNodeIds,enumerable:false});
    return result;
  });
}
