import {ConversationTasks} from './conversation-tasks.mjs';
import {createHash} from 'node:crypto';
import {isSupervisorName} from './default-roles.mjs';
import {tr} from './i18n.mjs';
import {conversationIdOf,agentConversationInput} from './group-conversations.mjs';
import {mentionNames} from './rooms.mjs';

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

/** One shared instruction is published atomically; each recipient retains its own queue, request and reply lifecycle. */
export function createAgentCalls({db,calls,rooms},run,input) {
  agentConversationInput(run,input);
  const kind=input.kind||'consult';
  if(!['consult','direct','handoff','transfer'].includes(kind))throw new Error(tr('roleCalls.invalidCallType'));
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
    const id=input.requestId||'';
    if(typeof id!=='string'||!/^[a-zA-Z0-9:_-]{1,200}$/.test(id))throw new Error(tr('roleCalls.invalidCallId'));
    if(typeof input.text!=='string'||!input.text.trim()||input.text.length>12000)throw new Error(tr('roleCalls.callSummaryMustBe1'));
    const messageId=`call:${id}`,fingerprint=JSON.stringify({runId:run.id,targets:targets.map(r=>r.id).sort(),kind,text:input.text,deliveryId:input.deliveryId||null,sourceSyncBatchId:input.sourceSyncBatchId||null,...(input.task!==undefined?{task:input.task}:{})});
    const existing=db.get('roomMessages',messageId);
    const response=message=>{
      const requestIds=message.requestIds||[message.requestId];
      const requests=requestIds.map(id=>db.get('coordinationRequests',id));
      if(requests.some(r=>!r||r.projectId!==run.projectId))throw new Error(tr('roleCalls.callIdConflictsWithDifferent'));
      return {requestId:requestIds[0],requestIds,messageId,status:requests.length===1?requests[0].status:'accepted',requests:requests.map(r=>({requestId:r.id,targetRoleId:r.targetRoleId,status:r.status})),
        note:transfer?tr('home.transferredToOwner',{name:requests[0].targetSnapshot?.name||''}):tr('home.deliveredDirectlyTargetRoleWhen')};
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
      if(!['consult','transfer'].includes(kind)&&!run.roleSnapshot.systemSupervisor&&role.nodeId!==run.nodeId&&run.planId)throw new Error(tr('home.forNewCrossDeviceWork'));
      const requestId=targets.length===1?id:`multi:${createHash('sha256').update(JSON.stringify([id,target.id])).digest('hex')}`;
      const request=transfer
        ?calls.create({id:requestId,projectId:run.projectId,targetRoleId:role.id,sourceRunId:run.id,originNodeId:run.nodeId,
          sourceMessageId:run.sourceMessageId,kind:'direct',transferredFrom:parent.id,summary,sourceSyncBatchId:input.sourceSyncBatchId,attachments:run.attachments||[]})
        :calls.create({id:requestId,projectId:run.projectId,targetRoleId:role.id,parentRequestId:parent.id,sourceRunId:run.id,originNodeId:run.nodeId,
          sourceMessageId:run.sourceMessageId,kind,summary,deliveryId:input.deliveryId,sourceSyncBatchId:input.sourceSyncBatchId,attachments:run.attachments||[],
          // The caller's execution pins its own device's versions; a role on another device works from its own workspace.
          ...(kind==='consult'||role.nodeId!==run.nodeId&&!run.roleSnapshot.systemSupervisor?{}:{planId:run.planId,planVersion:run.planVersion,stepId:run.stepId,execution:run.execution})});
      if(linked&&transfer)taskList.transfer(run,linked.id,role.id);
      recipients.push({id:role.id,name:role.name});
      return db.put('coordinationRequests',{...request,...(linked?{conversationTaskId:linked.id}:{}),callMessageId:messageId});
    });
    if(existing)return response(existing);
    const toRoles=[...new Map(recipients.map(r=>[r.id,r])).values()];
    const message=db.put('roomMessages',{id:messageId,projectId:run.projectId,conversationId:conversationIdOf(run),sender:'agent',senderName:run.roleSnapshot.name,roleId:run.roleId,kind:'handoff',runId:run.id,
      requestId:requests[0].id,requestIds:requests.map(r=>r.id),callFingerprint:fingerprint,taskIds:[],text:input.text,replyToId:rooms.replySourceFor(run)?.id||null,
      handoff:{kind,fromRoleId:run.roleId,fromRole:run.roleSnapshot.name,toRoleId:toRoles[0].id,toRole:toRoles[0].name,toRoles,summary:input.text},createdAt:new Date().toISOString()});
    rooms.touch(run.projectId,conversationIdOf(run));
    // Nudges at the moment of dispatch; the call itself is sent unchanged either way.
    const hints=[];
    // Work handed to others should be tracked as a task; consultations and reviews are not.
    if(['direct','transfer'].includes(kind)&&!linked&&!parent.conversationTaskId)hints.push(tr('agentCalls.taskHint'));
    // Only an owning root turn can transfer; do not suggest a handover that the permission checks would reject.
    if(kind==='direct'&&run.roleSnapshot?.systemSupervisor&&linked&&targets.length===1&&linked.ownerRoleId===run.roleId&&targets[0].id!==run.roleId&&!parent.parentRequestId&&!run.planId&&!parent.planId&&!['done','cancelled'].includes(linked.status))hints.push(tr('agentCalls.transferHint'));
    const result=response(message);
    return hints.length?{...result,hint:hints.join(' ')}:result;
  });
}
