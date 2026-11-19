import {terminal} from './store.mjs';
import {RoleDiscussions} from './role-discussions.mjs';
import { tr } from './i18n.mjs';
import {conversationIdOf,resolveConversationId,assertConversationRecord} from './group-conversations.mjs';
import {placeAtStart,queueKey} from './rooms.mjs';
import {SessionQueue} from './session-queue.mjs';
import {privateFollowup} from './proactive-followup.mjs';

/** Roles whose running turn can take a queued message without being interrupted: resident Claude (next step) and Codex (turn/steer). */
const SUPPLEMENT_RUNTIMES=new Set(['claude','codex']);

/**
 * The Worker's answer about a message added to a running turn. Taken: the message's task is completed by that run (its reply
 * answers it), the message joins the chat now and leaves the queue. Not taken: it stays queued and starts after the turn.
 * A task that already started or was cancelled meanwhile is left alone.
 */
const frontOfQueue=(db,task)=>Math.min(queueKey(task),...db.chatTasks(['ready']).filter(t=>t.projectId===task.projectId&&conversationIdOf(t)===conversationIdOf(task)&&t.id!==task.id).map(queueKey))-1;
/** A supplement flag counts only while the turn it was sent to is still going; a turn that ended (or was reconciled) frees the message. */
export const supplementPending=(db,task)=>Boolean(task?.supplementing)&&!terminal.has(db.get('runs',task.supplementing.runId)?.status);

/**
 * A turn ended: messages added to it share its outcome. When it succeeded their requests carry its reply; when it failed or
 * was stopped they are marked blocked with its reason, so a message the CLI read is never silently taken as answered.
 * Messages still waiting to be added to it are freed.
 */
export function settleMergedTasks(db,run) {
  const rows=sql=>db.db.prepare(`SELECT data FROM records WHERE kind='tasks' AND ${sql}=?`).all(run.id).map(r=>JSON.parse(r.data));
  const at=new Date().toISOString();
  for(const task of rows("json_extract(data,'$.supplementing.runId')")){if(task.status!=='ready'||task.currentRunId)continue;const {supplementing,...rest}=task;db.put('tasks',{...rest,waitingReason:null});}
  for(const task of rows("json_extract(data,'$.mergedIntoRunId')")){
    if(task.currentRunId)continue;
    const ok=run.status==='succeeded',request=task.requestId?db.get('coordinationRequests',task.requestId):null;
    if(!ok&&task.status==='completed')db.put('tasks',{...task,status:'blocked',error:run.error||null});
    if(request?.mergedIntoRunId===run.id)db.put('coordinationRequests',{...request,status:ok?'succeeded':'failed',result:ok?run.result||'':'',...(ok?{}:{error:run.error||tr('rooms.runFailed')}),updatedAt:at});
  }
}

export function settleGroupSupplement(db,run,type,payload={}) {
  const task=db.get('tasks',String(payload.id||''));
  if(!task||task.supplementing?.runId!==run.id||task.status!=='ready'||task.currentRunId)return;
  const {supplementing,...rest}=task,at=new Date().toISOString();
  // Not taken: first in line, so it starts right after the turn, as the user asked by steering it.
  if(type==='supplement_failed'){db.put('tasks',{...rest,waitingReason:null,queueOrder:frontOfQueue(db,task)});return;}
  db.put('tasks',{...rest,status:'completed',waitingReason:null,mergedIntoRunId:run.id,mergedAt:at});
  const request=task.requestId?db.get('coordinationRequests',task.requestId):null;
  if(request&&request.status==='queued'){const settled=db.put('coordinationRequests',{...request,status:'succeeded',mergedIntoRunId:run.id,result:'',updatedAt:at});new SessionQueue(db).settleRequest(settled);}
  placeAtStart(db,db.get('tasks',task.id),at);
}

/** A steer is a persisted stop barrier; the same native session cannot be resumed until the stop is confirmed. */
export function steeringWaitReason(db,task) {
  if(task.steering) {
    if(task.steering.waitForRunIds.some(id=>!terminal.has(db.get('runs',id)?.status))) return tr('roleSteering.interruptingWaitingForOldRun');
    return null;
  }
  // Steering holds the role only in its own group chat; its sessions in other chats go on.
  if(db.roleSteeringTasks(task.projectId,task.roleId).some(t=>t.steering&&conversationIdOf(t)===conversationIdOf(task) &&
    (t.status==='ready' || (t.currentRunId && !terminal.has(db.get('runs',t.currentRunId)?.status))))) return tr('roleSteering.waitingForRoleContinueWith');
  return null;
}

/** Only promotes an already saved human message; it does not resend the message, change the text, or release the Worker session lock. */
export class RoleSteering {
  constructor(db,calls) {this.db=db;this.calls=calls;}

  /**
   * Steer on a Claude or Codex role whose turn in this chat is running never interrupts it: the message is added to that turn,
   * or, when the turn cannot take it now (still starting, a slash command, attachments, an older Worker), it moves to the front
   * of the queue and starts after the turn. Returns null for other CLIs and idle roles: the ordinary steer applies.
   */
  supplement(projectId,taskId,input={},{online=()=>true}={}) {
    const conversationId=resolveConversationId(this.db,projectId,input.conversationId);
    return this.db.transaction(()=>{
      const task=this.db.get('tasks',taskId);
      if(!task||task.projectId!==projectId||conversationIdOf(task)!==conversationId)return null;
      if(supplementPending(this.db,task))return {supplementing:true,runId:task.supplementing.runId};
      const message=this.db.get('roomMessages',task.sourceMessageId);
      if(task.origin!=='chat'||task.status!=='ready'||task.currentRunId||task.steering||message?.sender!=='human'||!message.taskIds?.includes(task.id)||task.scheduledJobId||task.planId||task.continuationRunId)return null;
      if(!SUPPLEMENT_RUNTIMES.has(task.roleSnapshot?.runtime))return null;
      if(task.requestId&&this.db.get('coordinationRequests',task.requestId)?.status!=='queued')return null;
      const active=this.db.activeRuns().filter(r=>r.projectId===projectId&&conversationIdOf(r)===conversationId&&r.roleId===task.roleId);
      if(!active.length)return null;
      const run=active.length===1?active[0]:null;
      const takes=run&&run.status==='running'&&run.roleSessionId&&!run.discussionDeliveryId&&!run.switchOperationId&&!run.diagnosis&&!run.stopRequested
        // Only a turn whose reply is posted to the chat can answer the message: not a private follow-up, an explicitly published
        // collaboration turn, a background follow-up, a handoff wait or a read-only review.
        &&!run.explicitPublish&&!run.backgroundFollowup&&!run.handoffWait&&!run.execution?.purpose&&!privateFollowup(this.db,run)
        &&run.nodeId===task.roleSnapshot.nodeId&&run.roleSnapshot?.runtime===task.roleSnapshot.runtime&&!message.attachments?.length&&!String(message.text||'').trimStart().startsWith('/')
        &&online(run.nodeId)&&this.db.get('workers',run.nodeId)?.capabilities?.groupSupplement===1;
      if(!takes){
        this.db.put('tasks',{...task,queueOrder:frontOfQueue(this.db,task)});
        return {queuedFirst:true};
      }
      const at=new Date().toISOString(),id=`supplement-${task.id}-${run.id}`;
      this.db.put('tasks',{...task,supplementing:{runId:run.id,at},waitingReason:tr('roleSteering.addingToCurrentTurn')});
      if(!this.db.get('commands',id))this.db.put('commands',{id,type:'supplement',runId:run.id,nodeId:run.nodeId,taskId:task.id,text:tr('roleSteering.supplementText',{text:message.text||''}),acked:false,createdAt:at});
      return {supplementing:true,runId:run.id,nodeId:run.nodeId};
    });
  }

  request(projectId,taskId,commandId,input={}) {
    const conversationId=resolveConversationId(this.db,projectId,input.conversationId);
    if(typeof commandId!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(commandId))throw new Error(tr('roleSteering.invalidSteeringId'));
    return this.db.transaction(()=>{
      let task=this.db.get('tasks',taskId);
      if(!task||task.projectId!==projectId)throw new Error(tr('roleSteering.messageDoesNotBelongCurrent'));
      assertConversationRecord({projectId,conversationId},task);
      if(task.steering) {
        if(task.steering.commandId!==commandId)throw new Error(tr('roleSteering.messageHasAlreadyStartedImmediate'));
        return task.steering;
      }
      const message=this.db.get('roomMessages',task.sourceMessageId);
      if(task.origin!=='chat'||task.status!=='ready'||task.currentRunId||message?.sender!=='human'||!message.taskIds?.includes(task.id)||task.scheduledJobId||task.planId||task.continuationRunId)throw new Error(tr('roleSteering.onlyHumanMessagesHaveNot'));
      const role=this.db.get('roles',task.roleId);
      if(!role?.enabled||role.archivedAt)throw new Error(tr('roleSteering.roleDisabledArchived'));
      if(this.db.list('tasks').some(t=>t.projectId===projectId&&conversationIdOf(t)===conversationId&&t.roleId===task.roleId&&t.steering&&t.status==='ready'&&!t.currentRunId))throw new Error(tr('roleSteering.roleAlreadyHasSteeringMessage'));
      const active=this.db.activeRuns().filter(r=>r.projectId===projectId&&conversationIdOf(r)===conversationId&&r.roleId===task.roleId);
      if(input.roleSessionId&&active.some(r=>r.roleSessionId!==input.roleSessionId))throw new Error(tr('conversations.recordMismatch'));
      if(active.some(r=>r.nodeId!==task.roleSnapshot.nodeId||r.roleSnapshot?.runtime!==task.roleSnapshot.runtime))throw new Error(tr('roleSteering.roleDeviceCliHasChanged'));
      if(task.requestId && this.db.get('coordinationRequests',task.requestId)?.status!=='queued')throw new Error(tr('roleSteering.messageStateHasChangedRefresh'));
      const stopped=new Set(active.map(r=>r.id)), blocked=new Set(), planIds=new Set();
      const discussions=new RoleDiscussions(this.db);
      const pendingDiscussionTasks=new Set(this.db.list('discussionIntents').filter(i=>i.projectId===projectId&&['queued','blocked'].includes(i.status)).map(i=>i.taskId));
      for(const prior of this.db.list('tasks').filter(t=>t.projectId===projectId&&conversationIdOf(t)===conversationId&&t.roleId===task.roleId&&t.id!==taskId&&(t.discussionWait||pendingDiscussionTasks.has(t.id)))) {
        for(const id of discussions.invalidateTask(prior.id,{reason:tr('roleSteering.userChangedDirection'),directionRevision:(prior.directionRevision||1)+1}).stopRunIds)stopped.add(id);
      }
      // Steering interrupts only the turn that is running. An open wait is left alone: it stays in the queue and its wake
      // runs in its own slot afterwards.
      for(const run of active) this.calls.forRun(run);
      const requests=this.db.list('coordinationRequests').filter(r=>r.projectId===projectId&&conversationIdOf(r)===conversationId&&r.targetRoleId===task.roleId&&r.taskId!==taskId&&
        active.some(run=>run.id===r.currentRunId));
      for(const request of requests) {
        for(const id of this.calls.cancel(request.id,{preserveRunningChildren:true,cause:'user_interrupted'}))stopped.add(id);
        let current=request;
        while(current&&!blocked.has(current.id)) {
          blocked.add(current.id);if(current.planId)planIds.add(current.planId);
          for(const plan of this.db.list('executionPlans').filter(p=>p.parentRequestId===current.id))planIds.add(plan.id);
          // Only this role's own chain follows the user's new direction. A caller of another role that waits for this work
          // is not frozen: its wait shows as cancelled and it is woken to look at what happened and decide (RoleCalls.resume).
          const latest=this.db.get('coordinationRequests',current.id);
          if(latest.targetRoleId===task.roleId)this.db.put('coordinationRequests',{...latest,steeringTaskId:taskId});
          current=this.db.get('coordinationRequests',current.parentRequestId||current.continuationOf||'');
        }
      }
      // Sibling roles already running continue; members of the old plan that have not been dispatched yet cannot start in the old direction.
      for(const id of planIds) {
        const plan=this.db.get('executionPlans',id);
        if(!plan||['succeeded','cancelled'].includes(plan.status))continue;
        this.db.put('executionPlans',{...plan,status:'blocked',steeringTaskId:taskId,error:tr('roleSteering.userHasChangedDirectionOld'),updatedAt:new Date().toISOString()});
        for(const r of this.db.list('coordinationRequests').filter(r=>r.planId===id&&!r.currentRunId&&!['succeeded','failed','cancelled'].includes(r.status)))this.calls.cancel(r.id);
      }
      for(const id of stopped)this.db.requestStop(id,`steer:${taskId}:${id}`);
      const steering={commandId,waitForRunIds:[...stopped],planIds:[...planIds],createdAt:new Date().toISOString()};
      task=this.db.get('tasks',taskId);
      this.db.put('tasks',{...task,steering,contextPrepared:true,contextState:'excerpt',waitingReason:stopped.size?tr('roleSteering.interruptingWaitingForOldRun2'):tr('roleSteering.continueWithNewInstructionFirst')});
      return steering;
    });
  }
}
