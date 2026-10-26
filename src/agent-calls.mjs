import {ConversationTasks} from './conversation-tasks.mjs';
import {createHash} from 'node:crypto';
import {isSupervisorName} from './default-roles.mjs';
import {tr} from './i18n.mjs';
import {conversationIdOf,agentConversationInput} from './group-conversations.mjs';

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
      let role=target,summary=input.text;
      // Keep existing cross-device ownership routing; consultation and transfer always use the recipient's own workspace.
      if(!['consult','transfer'].includes(kind)&&!run.roleSnapshot.systemSupervisor&&role.nodeId!==run.nodeId){
        if(run.planId)throw new Error(tr('home.forNewCrossDeviceWork'));
        role=db.get('roles',db.get('projects',run.projectId)?.supervisorRoleId);
        if(!role?.enabled)throw new Error(tr('home.crossDeviceCallsRequireProject'));
        summary=tr('home.crossDeviceRequestFromTarget',{name:run.roleSnapshot.name,name2:target.name,text:input.text});
      }
      const requestId=targets.length===1?id:`multi:${createHash('sha256').update(JSON.stringify([id,target.id])).digest('hex')}`;
      const request=transfer
        ?calls.create({id:requestId,projectId:run.projectId,targetRoleId:role.id,sourceRunId:run.id,originNodeId:run.nodeId,
          sourceMessageId:run.sourceMessageId,kind:'direct',transferredFrom:parent.id,summary,sourceSyncBatchId:input.sourceSyncBatchId,attachments:run.attachments||[]})
        :calls.create({id:requestId,projectId:run.projectId,targetRoleId:role.id,parentRequestId:parent.id,sourceRunId:run.id,originNodeId:run.nodeId,
          sourceMessageId:run.sourceMessageId,kind,summary,deliveryId:input.deliveryId,sourceSyncBatchId:input.sourceSyncBatchId,attachments:run.attachments||[],
          ...(kind==='consult'?{}:{planId:run.planId,planVersion:run.planVersion,stepId:run.stepId,execution:run.execution})});
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
    return response(message);
  });
}
