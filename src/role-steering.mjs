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
  for(const task of rows("json_extract(data,'$.supplementing.runId')")){if(task.status!=='ready'||task.currentRunId)continue;const {supplementing,...rest}=task;
    // A teammate's correction the turn never took still goes first, and its chat card says it is queued.
    db.put('tasks',{...rest,waitingReason:null,...(task.roleSteer?{queueOrder:frontOfQueue(db,task)}:{})});steerCardQueued(db,task);}
  for(const task of rows("json_extract(data,'$.mergedIntoRunId')")){
    if(task.currentRunId)continue;
    const ok=run.status==='succeeded',request=task.requestId?db.get('coordinationRequests',task.requestId):null;
    if(!ok&&task.status==='completed')db.put('tasks',{...task,status:'blocked',error:run.error||null});
    if(request?.mergedIntoRunId===run.id)db.put('coordinationRequests',{...request,status:ok?'succeeded':'failed',result:ok?run.result||'':'',...(ok?{}:{error:run.error||tr('rooms.runFailed')}),updatedAt:at});
  }
}

/** The chat card of a role's correction that the running turn did not take: it now waits first in the queue. */
function steerCardQueued(db,task) {
  const request=task.roleSteer&&task.requestId?db.get('coordinationRequests',task.requestId):null,message=request?.callMessageId?db.get('roomMessages',request.callMessageId):null;
  if(message?.steer?.state==='added')db.put('roomMessages',{...message,steer:{state:'queued_first',note:tr('agentCalls.steerQueuedFirst',{name:task.roleSnapshot?.name||''})}});
}

export function settleGroupSupplement(db,run,type,payload={}) {
  const task=db.get('tasks',String(payload.id||''));
  if(!task||task.supplementing?.runId!==run.id||task.status!=='ready'||task.currentRunId)return;
  const {supplementing,...rest}=task,at=new Date().toISOString();
  // Not taken: first in line, so it starts right after the turn, as the user asked by steering it.
  if(type==='supplement_failed'){db.put('tasks',{...rest,waitingReason:null,queueOrder:frontOfQueue(db,task)});steerCardQueued(db,task);return;}
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
      // A role's own steer (wb call --kind steer|interrupt) is a call, not a human chat message: its text is the call's brief.
      const byRole=task.roleSteer||null,message=this.db.get('roomMessages',task.sourceMessageId);
      // A correction inherits its caller's scheduled job; only the job's own task is never steered.
      if(task.origin!=='chat'||task.status!=='ready'||task.currentRunId||task.steering||!byRole&&task.scheduledJobId||task.planId||task.continuationRunId)return null;
      if(!byRole&&(message?.sender!=='human'||!message.taskIds?.includes(task.id)))return null;
      if(!SUPPLEMENT_RUNTIMES.has(task.roleSnapshot?.runtime))return byRole?this.#first(task):null;
      if(task.requestId&&this.db.get('coordinationRequests',task.requestId)?.status!=='queued')return null;
      const active=this.db.activeRuns().filter(r=>r.projectId===projectId&&conversationIdOf(r)===conversationId&&r.roleId===task.roleId);
      if(!active.length)return null;
      const run=active.length===1?active[0]:null;
      const takes=run&&run.status==='running'&&run.roleSessionId&&!run.discussionDeliveryId&&!run.switchOperationId&&!run.diagnosis&&!run.stopRequested
        // A user's message must be answered by a turn whose reply is posted to the chat: not a private follow-up, an explicitly
        // published collaboration turn, a background follow-up, a handoff wait or a read-only review. A role's correction
        // needs no answer of its own, so it goes into any working turn except the platform's own background follow-ups.
        &&(byRole?!run.backgroundFollowup&&!privateFollowup(this.db,run)
          :!run.explicitPublish&&!run.backgroundFollowup&&!run.handoffWait&&!run.execution?.purpose&&!privateFollowup(this.db,run)&&!message.attachments?.length&&!String(message.text||'').trimStart().startsWith('/'))
        &&run.nodeId===task.roleSnapshot.nodeId&&run.roleSnapshot?.runtime===task.roleSnapshot.runtime
        &&online(run.nodeId)&&this.db.get('workers',run.nodeId)?.capabilities?.groupSupplement===1;
      if(!takes)return this.#first(task);
      const at=new Date().toISOString(),id=`supplement-${task.id}-${run.id}`;
      const text=byRole?tr('roleSteering.roleSteerText',{name:byRole.byRole,text:task.prompt||''}):tr('roleSteering.supplementText',{text:message.text||''});
      this.db.put('tasks',{...task,supplementing:{runId:run.id,at},waitingReason:tr('roleSteering.addingToCurrentTurn')});
      if(!this.db.get('commands',id))this.db.put('commands',{id,type:'supplement',runId:run.id,nodeId:run.nodeId,taskId:task.id,text,acked:false,createdAt:at});
      return {supplementing:true,runId:run.id,nodeId:run.nodeId};
    });
  }

  /** The turn cannot take the message now: it goes first in the role's queue and starts right after the turn. */
  #first(task) {this.db.put('tasks',{...task,queueOrder:frontOfQueue(this.db,task)});return {queuedFirst:true};}

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
      const byRole=task.roleSteer||null,message=this.db.get('roomMessages',task.sourceMessageId);
      if(task.origin!=='chat'||task.status!=='ready'||task.currentRunId||!byRole&&(message?.sender!=='human'||!message.taskIds?.includes(task.id)||task.scheduledJobId)||task.planId||task.continuationRunId)throw new Error(tr('roleSteering.onlyHumanMessagesHaveNot'));
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
        const open=byRole?new Set(this.db.listProject('coordinationRequests',projectId).filter(r=>r.status!=='cancelled').map(r=>r.id)):null;
        for(const id of this.calls.cancel(request.id,{preserveRunningChildren:true,cause:'user_interrupted'}))stopped.add(id);
        // Interrupted by a role, not the user: whoever waits for this work is told by whom. A wake's turn is cancelled
        // together with the request it continues, and a waiting caller looks at that first request.
        if(byRole)for(const r of this.db.listProject('coordinationRequests',projectId))if(open.has(r.id)&&r.status==='cancelled'&&r.cancelReason==='user_interrupted')this.db.put('coordinationRequests',{...r,interruptedByRole:byRole.byRole});
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
      // A teammate's correction redirects one turn. Only the user changing direction ends the plans around it.
      if(byRole)planIds.clear();
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
