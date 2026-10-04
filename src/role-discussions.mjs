import {randomUUID,createHash} from 'node:crypto';
import {RoleSessions} from './role-sessions.mjs';
import {roleWorkspace} from './project-repositories.mjs';
import {projectRepositories} from './project-space.mjs';
import {projectTerminalLock} from './terminal-resume.mjs';
import {executionConflict} from './execution-workspace.mjs';
import {discussionPolicy,supportsDiscussion,discussionTargetStatus} from './discussion-policy.mjs';
import {buildTeamContext} from './team-context.mjs';
import { tr, isMessage } from './i18n.mjs';

const now=()=>new Date().toISOString();
const closed=new Set(['succeeded','failed','interrupted','stopping','reconciling']);
const terminal=new Set(['succeeded','failed','interrupted']);
const canonical=value=>JSON.stringify(value,(_,v)=>v && !Array.isArray(v) && typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const key=(...parts)=>createHash('sha256').update(JSON.stringify(parts)).digest('hex');
/** Continuing after an abnormal turn requires a web verification record bound to that consuming run; tool cleanup cannot be treated as business verification. */
function resumeConfirmed(db,intent,run) {
  const evidence=db.get('roomMessages',intent.recoveryEvidenceId||'');
  return evidence?.sender==='human'&&evidence.projectId===intent.projectId&&evidence.discussion?.action==='resume'
    &&evidence.discussion.threadId===intent.threadId&&evidence.discussion.afterRunId===run?.id;
}
function text(value,label) {
  if(typeof value!=='string'||!value.trim()||value.length>12000)throw new Error(tr('roleDiscussions.mustBe112000Characters', { label }));
  return value;
}
function fields(input,allowed) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error(tr('roleDiscussions.invalidDiscussionParameters'));
  if(Object.keys(input).some(k=>!allowed.includes(k)))throw new Error(tr('roleDiscussions.discussionParametersContainUnauthorizedField'));
}

/** Discussions share the Home transaction; messages do not create business call edges, and the current question decides whether resuming is allowed. */
export class RoleDiscussions {
  constructor(db,{online}={}) {this.db=db;this.online=online;}

  /** Acceptance and the actual start share the same checks so that an accepted message cannot get permanently stuck on a target that can never run. */
  assertReady(role) {
    const status=discussionTargetStatus(this.db.get('workers',role?.nodeId),role,{online:typeof this.online==='function'?this.online(role?.nodeId):null});
    if(!status.ready)throw Object.assign(new Error(status.reason),{code:status.code});
  }

  /** A handling turn is not a business subtask: it locks the recipient role session and does not overwrite the original Task. */
  startRun({deliveryId,commandId,nodeId}) {
    return this.db.transaction(()=>{
      if(!commandId||!nodeId)throw new Error(tr('roleDiscussions.commandidNodeidRequired'));
      const fingerprint=canonical({deliveryId,nodeId}),prior=this.db.get('commands',commandId);
      if(prior){if(prior.fingerprint!==fingerprint)throw new Error(tr('roleDiscussions.commandidConflictsWithDifferentParameters'));return this.db.get('runs',prior.runId);}
      const delivery=this.db.get('discussionDeliveries',deliveryId),message=this.db.get('discussionMessages',delivery?.messageId);
      const thread=this.db.get('discussionThreads',delivery?.threadId),task=this.db.get('tasks',delivery?.taskId);
      if(!delivery||delivery.status!=='queued'||!message||!thread||!task)throw new Error(tr('roleDiscussions.invalidDiscussionDeliveryState'));
      this.assertCurrent(thread,task,message.kind==='question'?message.id:message.replyTo);
      const source=message.sourceRunId?this.db.get('runs',message.sourceRunId):null;
      if(source&&(!terminal.has(source.status)||source.controlLost||source.discussionCleanup?.turnEnded!==true||source.discussionCleanup?.toolsClosed!==true))throw new Error(tr('roleDiscussions.waitingForSourceTurnEnd'));
      const role=this.db.get('roles',delivery.recipientRoleId),session=this.db.get('roleSessions',delivery.recipientSessionId);
      this.assertStart(role,nodeId,task);
      if(!session||session.status==='archived'||session.projectId!==thread.projectId||session.conversationId!==thread.conversationId||session.roleId!==role.id||session.nodeId!==nodeId||session.runtime!==role.runtime)throw new Error(tr('roleDiscussions.recipientSessionBindingHasChanged'));
      const binding=roleWorkspace(this.db,thread.projectId,nodeId,null);
      if(!binding||binding.localRoot!==session.workspaceRoot)throw new Error(tr('roleDiscussions.recipientWorkspaceHasChanged'));
      const purpose=message.kind==='question'?'clarification':'answer_resume';
      const run={id:randomUUID(),taskId:task.id,businessTaskId:task.id,projectId:thread.projectId,nodeId,roleId:role.id,roleSnapshot:{...role},
        roleSessionId:session.id,resumeNativeSessionId:session.nativeSessionId||null,resumeNativeSession:session.nativeSession||null,resumeWorkspace:session.workspace||null,
        discussionDeliveryId:delivery.id,discussionThreadId:thread.id,discussionMessageId:message.id,directionRevision:thread.directionRevision,turnPurpose:purpose,
        discussionProtocol:2,permissionProfile:discussionPolicy({turnPurpose:purpose}).profileId,projectScope:true,projectRoot:binding.localRoot,
        repositories:projectRepositories(this.db,thread.projectId,nodeId),model:role.model,mode:role.mode||'workspace-write',reportRequired:false,status:'queued',lastSeq:0,createdAt:now(),updatedAt:now(),
        discussionContext:{threadId:thread.id,questionId:thread.currentQuestionId,revision:thread.revision,message,attempt:delivery.attempts.length+1,
          actionRequestIds:purpose==='clarification'?{reply:`reply:${message.id}`}:{resolve:`resolve:${thread.currentQuestionId}`}}};
      run.inputTask={title:purpose==='clarification'?tr('roleDiscussions.replyPeerQuestion'):tr('roleDiscussions.handlePeerAnswer'),prompt:JSON.stringify(run.discussionContext),model:role.model,mode:run.mode,roleSnapshot:run.roleSnapshot};
      new RoleSessions(this.db).claim(session.id,run.id);
      this.db.put('runs',run);
      this.db.put('discussionDeliveries',{...delivery,status:'dispatched',waitingReason:null,processingRunId:run.id,attempts:[...delivery.attempts,{runId:run.id,startedAt:now()}],updatedAt:now()});
      this.db.put('commands',{id:commandId,type:'launch',runId:run.id,nodeId,fingerprint,acked:false,createdAt:now()});
      return run;
    });
  }

  assertCurrent(thread,task,questionId) {
    if(task.status==='cancelled'||thread.status!=='open'||thread.directionRevision!==(task.directionRevision||1)||thread.currentQuestionId!==questionId||task.discussionWait?.questionId!==questionId)throw new Error(tr('roleDiscussions.currentQuestionDirectionTaskState'));
  }

  /** Even when called directly, bypassing the scheduler, the capacity, exclusivity, and manual-takeover gates are kept. */
  assertStart(role,nodeId,task) {
    if(!role?.enabled||role.archivedAt||role.nodeId!==nodeId)throw new Error(tr('roleDiscussions.roleDisabledDeviceHasChanged'));
    const worker=this.db.get('workers',nodeId),active=this.db.list('runs').filter(r=>!terminal.has(r.status));
    if(this.db.get('settings','main')?.paused)throw new Error(tr('roleDiscussions.remoteExecutionPaused'));
    this.assertReady(role);
    if(active.some(r=>r.nodeId===nodeId&&r.status==='reconciling')||active.filter(r=>r.nodeId===nodeId).length>=(worker.capacity||1)||active.some(r=>r.roleId===role.id))throw new Error(tr('roleDiscussions.waitingForRoleFinishNode'));
    if(projectTerminalLock(this.db,task.projectId,nodeId))throw new Error(tr('roleDiscussions.projectUnderManualTakeover'));
    if(executionConflict({projectId:task.projectId,nodeId},active))throw new Error(tr('roleDiscussions.waitingForExclusiveProjectOperation'));
  }

  /** An intent is redeemed only once, after the consuming run reaches a final state, and continues the original Task, role, and native session. */
  resumeTask({intentId,commandId,nodeId}) {
    return this.db.transaction(()=>{
      const intent=this.db.get('discussionIntents',intentId);
      if(!intent)throw new Error(tr('roleDiscussions.resumeIntentNotFound'));
      if(intent.status==='started')return this.db.get('runs',intent.runId);
      const task=this.db.get('tasks',intent.taskId),thread=this.db.get('discussionThreads',intent.threadId),after=this.db.get('runs',intent.afterRunId);
      if(intent.status!=='queued'||!task||task.status==='cancelled'||task.discussionWait||thread?.status!=='resolved'||intent.directionRevision!==(task.directionRevision||1))throw new Error(tr('roleDiscussions.resumeIntentNoLongerValid'));
      if(!terminal.has(after?.status)||after.stopRequested||after.controlLost||after.discussionCleanup?.turnEnded!==true||after.discussionCleanup?.toolsClosed!==true)throw new Error(tr('roleDiscussions.waitingForConsumingTurnEnd'));
      if(after.status!=='succeeded'&&!resumeConfirmed(this.db,intent,after))throw new Error(tr('roleDiscussions.answerConsumingTurnEndedAbnormally'));
      const role=this.db.get('roles',task.roleId);this.assertStart(role,nodeId,task);
      if(['nodeId','runtime','model'].some(k=>role[k]!==task.roleSnapshot?.[k]))throw new Error(tr('roleDiscussions.originalTaskRoleConfigurationHas'));
      const session=this.db.get('roleSessions',thread.ownerSessionId);
      if(!session||session.status==='archived'||session.roleId!==task.roleId||session.nodeId!==nodeId)throw new Error(tr('roleDiscussions.originalBusinessSessionNoLonger'));
      if(this.db.list('runs').some(r=>r.businessTaskId===task.id&&!terminal.has(r.status)))throw new Error(tr('roleDiscussions.waitingForDiscussionTurnEnd'));
      this.db.put('tasks',{...task,status:'ready',waitingReason:null,discussionResumeBlocked:null,discussionResolution:{threadId:thread.id,questionId:thread.currentQuestionId,conclusion:thread.conclusion,basis:thread.resolutionBasis}});
      if(task.requestId){
        const request=this.db.get('coordinationRequests',task.requestId);
        if(!request||['cancelled','failed','succeeded'].includes(request.status))throw new Error(tr('roleDiscussions.originalBusinessCallHasEnded'));
        if(request.status==='waiting_call'&&(this.db.list('coordinationRequests').some(r=>r.parentRequestId===request.id&&!r.continuationOf&&!['succeeded','failed','cancelled'].includes(r.status))||this.db.list('executionPlans').some(p=>p.parentRequestId===request.id&&['running','cancelled'].includes(p.status))))throw new Error(tr('roleDiscussions.stillWaitingForOriginalBusiness'));
        this.db.put('coordinationRequests',{...request,status:'queued'});
      }
      const run=this.db.startTask(task.id,{commandId,nodeId});
      this.db.put('discussionIntents',{...intent,status:'started',runId:run.id,updatedAt:now()});return run;
    });
  }

  /** Returning handled prevents the original business wrap-up chain from treating a Q&A turn as a task delivery. */
  finishRun(runId) {
    return this.db.transaction(()=>{
      const run=this.db.get('runs',runId);
      if(!run||(!run.discussionDeliveryId&&!run.discussionWaiting))return {handled:false,changed:false};
      if(!terminal.has(run.status)){
        const delivery=this.db.get('discussionDeliveries',run.discussionDeliveryId||'');
        if(delivery&&['dispatched','runtime_accepted','reconciling'].includes(delivery.status)){
          const status=run.status==='reconciling'?'reconciling':run.status==='running'?'runtime_accepted':delivery.status;
          if(status!==delivery.status){this.db.put('discussionDeliveries',{...delivery,status,updatedAt:now()});return {handled:true,changed:true};}
        }
        return {handled:true,changed:false};
      }
      if(run.discussionFinished)return {handled:true,changed:false};
      if(run.discussionDeliveryId){
        const delivery=this.db.get('discussionDeliveries',run.discussionDeliveryId);
        if(delivery?.processingRunId===run.id&&!['consumed','cancelled','superseded','failed'].includes(delivery.status))this.db.put('discussionDeliveries',{...delivery,status:'failed',error:'no_response',updatedAt:now()});
      }
      this.db.put('runs',{...run,discussionFinished:true});return {handled:true,changed:true};
    });
  }

  /** No timeout-based cancellation; repair state and invalidate deliveries without replaying a missed answer that may already have had side effects. */
  recover() {
    return this.db.transaction(()=>{
      let changed=false;
      for(const original of this.db.list('discussionDeliveries')) {
        const run=this.db.get('runs',original.processingRunId||'');
        if(run)changed=this.finishRun(run.id).changed||changed;
        const delivery=this.db.get('discussionDeliveries',original.id),thread=this.db.get('discussionThreads',delivery.threadId),task=this.db.get('tasks',delivery.taskId);
        const message=this.db.get('discussionMessages',delivery.messageId),session=this.db.get('roleSessions',delivery.recipientSessionId);
        const valid=thread?.status==='open'&&task&&task.status!=='cancelled'&&thread.directionRevision===(task.directionRevision||1)&&task.discussionWait?.questionId===thread.currentQuestionId
          &&thread.currentQuestionId===(message?.kind==='question'?message.id:message?.replyTo)&&session?.status!=='archived'&&session;
        if(!valid&&!['consumed','cancelled','superseded'].includes(delivery.status)) {
          const status=run&&!terminal.has(run.status)?'reconciling':'superseded';
          if(delivery.status!==status||!isMessage(delivery.error,'roleDiscussions.questionSessionNoLongerValid')){this.db.put('discussionDeliveries',{...delivery,status,error:tr('roleDiscussions.questionSessionNoLongerValid'),updatedAt:now()});changed=true;}
          if(run&&!terminal.has(run.status)&&!run.stopRequested)this.db.requestStop(run.id,`discussion-stale:${run.id}`);
          continue;
        }
        // A weakly controlled turn may already have made changes; even if an old record is marked effectsKnown, it must not be replayed automatically on that basis.
      }
      for(const intent of this.db.list('discussionIntents').filter(i=>['queued','blocked'].includes(i.status))) {
        const task=this.db.get('tasks',intent.taskId),thread=this.db.get('discussionThreads',intent.threadId),session=this.db.get('roleSessions',thread?.ownerSessionId);
        if(!task||task.status==='cancelled'||intent.directionRevision!==(task.directionRevision||1)||thread?.status!=='resolved'||session?.status==='archived') {this.db.put('discussionIntents',{...intent,status:'cancelled',updatedAt:now()});changed=true;continue;}
        const after=this.db.get('runs',intent.afterRunId);
        if(intent.status==='queued'&&terminal.has(after?.status)&&after.status!=='succeeded'&&!resumeConfirmed(this.db,intent,after)) {
          const reason=tr('roleDiscussions.answerConsumingTurnEndedAbnormally2');
          this.db.put('discussionIntents',{...intent,status:'blocked',waitingReason:reason,updatedAt:now()});
          this.db.put('tasks',{...task,status:'blocked',waitingReason:reason,discussionResumeBlocked:{threadId:thread.id,afterRunId:after.id}});changed=true;
        }
      }
      return {changed};
    });
  }

  /** Acts only on the current question of that run; stopping the clarification keeps the question for a manual reply and does not cancel the asker's business work. */
  stopRun(run) {
    if(run.turnPurpose==='clarification'&&(run.stopRequested||terminal.has(run.status)))return {current:false,stopRunIds:[]};
    const task=this.db.get('tasks',run.businessTaskId||run.taskId);
    const delivery=this.db.get('discussionDeliveries',run.discussionDeliveryId||'');
    const thread=this.db.get('discussionThreads',run.discussionThreadId||delivery?.threadId||'');
    const message=this.db.get('discussionMessages',delivery?.messageId||'');
    const questionId=message?.kind==='question'?message.id:message?.replyTo;
    const current=task&&thread&&thread.directionRevision===(task.directionRevision||1)&&
      (task.discussionWait?.threadId===thread.id&&(run.discussionWaiting?task.discussionWait.sourceRunId===run.id:task.discussionWait.questionId===questionId)
      ||this.db.list('discussionIntents').some(i=>i.threadId===thread.id&&(i.afterRunId===run.id||run.discussionWaiting&&task.currentRunId===run.id)&&['queued','blocked'].includes(i.status)));
    if(!current)return {current:false,stopRunIds:[]};
    if(run.turnPurpose!=='clarification')return {current:true,...this.invalidateTask(task.id,{reason:tr('roleDiscussions.userStoppedDiscussion')})};
    const stopRunIds=[];
    for(const item of this.db.list('discussionDeliveries').filter(d=>d.threadId===thread.id)) {
      const m=this.db.get('discussionMessages',item.messageId);
      if((m?.kind==='question'?m.id:m?.replyTo)!==thread.currentQuestionId)continue;
      const active=this.db.get('runs',item.processingRunId||'');
      if(active&&!terminal.has(active.status))stopRunIds.push(active.id);
      if(!['consumed','cancelled','superseded'].includes(item.status))this.db.put('discussionDeliveries',{...item,status:'failed',error:tr('roleDiscussions.clarificationStoppedReplyManuallyMark'),updatedAt:now()});
    }
    this.db.put('discussionThreads',{...thread,revision:thread.revision+1,updatedAt:now()});
    this.db.put('tasks',{...task,status:'blocked',waitingReason:tr('roleDiscussions.clarificationStoppedReplyOriginalQuestion')});
    return {current:true,stopRunIds};
  }

  /** Invalidating a business wait does not mean the process has stopped; the caller sends stop, and the original lock is released by the final-state event. */
  invalidateTask(taskId,{reason,directionRevision}={}) {
    return this.db.transaction(()=>{
      const task=this.db.get('tasks',taskId);if(!task)return {stopRunIds:[]};
      for(const thread of this.db.list('discussionThreads').filter(t=>t.taskId===taskId&&t.status==='open'))this.db.put('discussionThreads',{...thread,status:'cancelled',reason,revision:thread.revision+1,updatedAt:now()});
      for(const kind of ['discussionDeliveries','discussionIntents'])for(const item of this.db.list(kind).filter(i=>i.taskId===taskId&&!['consumed','started','cancelled','superseded'].includes(i.status)))this.db.put(kind,{...item,status:'cancelled',error:reason,updatedAt:now()});
      this.db.put('tasks',{...task,discussionWait:null,discussionResumeBlocked:null,...(directionRevision?{directionRevision}:{}),waitingReason:reason});
      return {stopRunIds:this.db.list('runs').filter(r=>(r.taskId===taskId||r.businessTaskId===taskId)&&!terminal.has(r.status)).map(r=>r.id)};
    });
  }

  /** Quota changes are accepted only from the fixed supervisor or an authenticated user, with two-level CAS in one transaction, and the question is not resent automatically. */
  extendBudget(actor,input) {
    fields(input,['requestId','rootTaskId','reason','root','thread']);text(input.reason,tr('roleDiscussions.reason'));
    if(!/^[a-zA-Z0-9:_-]{1,200}$/.test(input.requestId||''))throw new Error(tr('roleDiscussions.invalidRequestId'));
    return this.db.transaction(()=>{
      let projectId=actor.projectId,actorId='human';
      if(actor.kind!=='human') {
        const run=this.db.get('runs',actor.runId);this.context(run,'discuss.budget_extend');
        if(this.db.get('projects',run.projectId)?.supervisorRoleId!==run.roleId||!run.roleSnapshot?.systemSupervisor)throw new Error(tr('roleDiscussions.onlyFixedSupervisorCanIncrease'));
        projectId=run.projectId;actorId=run.roleId;
      }
      const id=key(projectId,actorId,input.requestId),fingerprint=canonical({name:'budget_extend',input});
      const prior=this.db.get('discussionActions',id);if(prior){if(prior.fingerprint!==fingerprint)throw new Error(tr('roleDiscussions.requestIdConflictsWithDifferent'));return prior.result;}
      const root=this.db.get('tasks',input.rootTaskId),thread=input.thread?this.db.get('discussionThreads',input.thread.threadId):null;
      if(!root||root.projectId!==projectId||(!input.root&&!input.thread)||input.thread&&(!thread||thread.rootTaskId!==root.id))throw new Error(tr('roleDiscussions.invalidQuotaTarget'));
      const update=(old,change)=>{
        fields(change,['revision','limit','threadId']);
        if(change.revision!==old.revision)throw new Error(tr('roleDiscussions.quotaVersionHasChanged'));
        if(!Number.isSafeInteger(change.limit)||change.limit<=old.limit||change.limit>100)throw new Error(tr('roleDiscussions.newQuotaMustExceedOld'));
        return {...old,limit:change.limit,revision:old.revision+1};
      };
      const rootBudget=input.root?update(root.discussionBudget||{used:0,limit:6,revision:0},input.root):root.discussionBudget;
      const threadBudget=input.thread?update(thread.budget,input.thread):null;
      if(input.root)this.db.put('tasks',{...root,discussionBudget:rootBudget});
      if(input.thread)this.db.put('discussionThreads',{...thread,budget:threadBudget});
      const result={rootBudget,threadBudget};this.db.put('discussionActions',{id,projectId,actor:actorId,fingerprint,result,reason:input.reason,createdAt:now()});return result;
    });
  }

  /** Provides candidates only; capacity and fairness are still decided by the single scheduling loop in Rooms. */
  candidates() {
    const result=[];
    for(const delivery of this.db.list('discussionDeliveries').filter(d=>d.status==='queued')) {
      const task=this.db.get('tasks',delivery.taskId),role=this.db.get('roles',delivery.recipientRoleId),message=this.db.get('discussionMessages',delivery.messageId);
      if(!task||!role||!message)continue;
      if(message.sourceRunId&&!terminal.has(this.db.get('runs',message.sourceRunId)?.status))continue;
      result.push({id:`discussion:${delivery.id}`,projectId:task.projectId,roleId:role.id,roleSnapshot:role,contextPrepared:true,discussionDeliveryId:delivery.id,createdAt:delivery.createdAt});
    }
    for(const intent of this.db.list('discussionIntents').filter(i=>i.status==='queued')) {
      const task=this.db.get('tasks',intent.taskId);
      if(!task||!terminal.has(this.db.get('runs',intent.afterRunId)?.status))continue;
      result.push({...task,id:`discussion:${intent.id}`,contextPrepared:true,discussionIntentId:intent.id,createdAt:intent.createdAt});
    }
    return result;
  }

  consume(run) {
    if(!run.discussionDeliveryId)return;
    const delivery=this.db.get('discussionDeliveries',run.discussionDeliveryId);
    if(!delivery||delivery.processingRunId!==run.id)throw new Error(tr('roleDiscussions.discussionHandlingOwnershipHasChanged'));
    this.db.put('discussionDeliveries',{...delivery,status:'consumed',updatedAt:now()});
  }

  peers(run) {
    const ctx=this.context(run,'discuss.peers');
    const team=buildTeamContext(this.db,ctx.run,{online:this.online,inherit:false});
    const runs=this.db.list('runs').filter(r=>r.projectId===ctx.run.projectId&&!terminal.has(r.status));
    const tasks=this.db.list('tasks').filter(t=>t.projectId===ctx.run.projectId);
    const messages=this.db.list('roomMessages').filter(m=>m.projectId===ctx.run.projectId);
    return {observedAt:team.observedAt,teamVersion:team.version,memberCount:team.memberCount,selfRoleId:team.selfRoleId,notice:tr('roleDiscussions.snapshotManagedRoleStatusNot'),
      items:this.db.list('roles').filter(r=>r.projectId===ctx.run.projectId&&(!r.archivedAt||runs.some(run=>run.roleId===r.id))).map(r=>{
        const member=team.members.find(m=>m.id===r.id);
        const activeRuns=runs.filter(run=>run.roleId===r.id).map(run=>({id:run.id,taskId:run.taskId,turnPurpose:run.turnPurpose||'task',status:run.status,
          workspace:run.workspace||null,workspaceStatus:run.workspace?'reported':'pending',plannedWorkspace:run.resumeWorkspace||run.projectRoot||null,updatedAt:run.updatedAt,
          repositories:(run.repositories||[]).map(repo=>({id:repo.id,key:repo.key,localRoot:repo.localRoot||null})),repositoryStatus:run.workspace?'reported':'planned',
          plannedWriteRepositories:run.execution?.writeRepositories||null,title:run.inputTask?.title||tasks.find(t=>t.id===run.taskId)?.title||null}));
        const activeTasks=tasks.filter(t=>t.roleId===r.id&&(['in_progress','waiting_discussion','ready'].includes(t.status)||activeRuns.some(run=>run.taskId===t.id)))
          .map(t=>({id:t.id,title:t.title,status:t.status,waitingReason:t.waitingReason||null}));
        return {id:r.id,name:r.name,nodeId:r.nodeId,runtime:r.runtime,model:r.model||null,enabled:Boolean(r.enabled&&!r.archivedAt),online:member?.online??null,
          responsibility:member?.responsibility||tr('roleDiscussions.archivedRoleActiveRunRecords'),instructionsMissing:member?.instructionsMissing??true,responsibilityTruncated:member?.responsibilityTruncated??false,
          activeRuns,tasks:activeTasks,taskIds:activeTasks.map(t=>t.id),
          recentMessages:messages.filter(m=>m.roleId===r.id).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,3)
            .map(m=>({id:m.id,runId:m.runId,createdAt:m.createdAt,excerpt:String(m.text||'').slice(0,400),truncated:String(m.text||'').length>400})),
          communication:member?.communication||{consultationSupported:false,discussionSupported:false,discussionUnavailableReason:'archived',deliveryMode:'queued_next_turn'}};
      })};
  }

  /** Return full messages in pages; when a cursor becomes invalid, require a re-read and do not treat vanished unread items as handled. */
  read(run,input) {
    fields(input,['threadId','unread','cursor','limit']);
    const ctx=this.context(run,'discuss.read');
    if(Boolean(input.threadId)===Boolean(input.unread))throw new Error(tr('roleDiscussions.chooseExactlyOneReadMode'));
    const limit=input.limit??10;
    if(!Number.isSafeInteger(limit)||limit<1||limit>20)throw new Error(tr('roleDiscussions.limitMustBe120'));
    let thread=null;
    if(input.threadId) {
      thread=this.db.get('discussionThreads',input.threadId);
      if(!thread||thread.projectId!==ctx.run.projectId||!thread.participants.includes(ctx.run.roleId))throw new Error(tr('roleDiscussions.notAllowedReadThread'));
    }
    const unread=new Set(this.db.list('discussionDeliveries').filter(d=>d.projectId===ctx.run.projectId&&d.recipientRoleId===ctx.run.roleId&&['queued','dispatched','runtime_accepted','reconciling'].includes(d.status)).map(d=>d.messageId));
    const messages=this.db.list('discussionMessages').filter(m=>m.projectId===ctx.run.projectId&&(thread?m.threadId===thread.id:unread.has(m.id)));
    let start=0;
    if(input.cursor) {
      const i=messages.findIndex(m=>m.id===input.cursor);
      if(i<0)throw new Error(tr('roleDiscussions.readCursorNoLongerValid'));
      start=i+1;
    }
    const items=messages.slice(start,start+limit);
    return {items,nextCursor:start+items.length<messages.length?items.at(-1).id:null,...(thread?{thread}:{})};
  }

  context(run,action) {
    const current=this.db.get('runs',run?.id);
    if(!current||closed.has(current.status)||this.db.get('settings','main')?.paused)throw new Error(tr('roleDiscussions.currentRunInvalidPaused'));
    const task=this.db.get('tasks',current.businessTaskId||current.taskId);
    if(!task||task.projectId!==current.projectId||task.status==='cancelled'||current.stopRequested)throw new Error(tr('roleDiscussions.originalTaskNoLongerValid'));
    const session=this.db.get('roleSessions',current.roleSessionId);
    if(!session||session.status==='archived'||session.projectId!==current.projectId||session.roleId!==current.roleId||session.nodeId!==current.nodeId)throw new Error(tr('roleDiscussions.currentRoleSessionBindingNo'));
    return {run:current,task};
  }

  action(run,input,name,work) {
    if(typeof input.requestId!=='string'||!/^[a-zA-Z0-9:_-]{1,200}$/.test(input.requestId))throw new Error(tr('roleDiscussions.invalidRequestId2'));
    return this.db.transaction(()=>{
      const ctx=this.context(run,`discuss.${name}`);
      const id=key(ctx.run.projectId,ctx.run.roleId,input.requestId);
      const fingerprint=canonical({name,input,taskId:ctx.task.id});
      const prior=this.db.get('discussionActions',id);
      if(prior){if(prior.fingerprint!==fingerprint)throw new Error(tr('roleDiscussions.requestIdConflictsWithDifferent2'));return prior.result;}
      const result=work(ctx);
      this.db.put('discussionActions',{id,projectId:ctx.run.projectId,roleId:ctx.run.roleId,requestId:input.requestId,fingerprint,result,createdAt:now()});
      return result;
    });
  }

  thread(ctx,id) {
    const thread=this.db.get('discussionThreads',id);
    if(!thread||thread.projectId!==ctx.run.projectId||thread.taskId!==ctx.task.id)throw new Error(tr('roleDiscussions.threadDoesNotBelongCurrent'));
    if(!thread.participants.includes(ctx.run.roleId))throw new Error(tr('roleDiscussions.notParticipantThread'));
    if(thread.directionRevision!==(ctx.task.directionRevision||1))throw new Error(tr('roleDiscussions.taskDirectionHasChanged'));
    return thread;
  }

  session(role,conversationId=role?.projectId) {
    if(!role||!role.enabled||role.archivedAt)throw new Error(tr('roleDiscussions.targetRoleDisabled'));
    const binding=roleWorkspace(this.db,role.projectId,role.nodeId,null);
    if(!binding)throw new Error(tr('roleDiscussions.targetRoleWorkspaceHasNot'));
    return new RoleSessions(this.db).getOrCreate({projectId:role.projectId,conversationId,roleId:role.id,nodeId:role.nodeId,runtime:role.runtime,model:role.model,workspaceRoot:binding.localRoot}).id;
  }

  /** The visible record and the pending delivery are committed in the caller's single transaction; recipients are never guessed from natural language. */
  message(ctx,thread,{requestId,kind,toRoleId,replyTo=null,text,evidenceRefs=[],late=false}) {
    const message={id:randomUUID(),projectId:thread.projectId,threadId:thread.id,taskId:thread.taskId,rootTaskId:thread.rootTaskId,
      directionRevision:thread.directionRevision,requestId,kind,fromRoleId:ctx.run.roleId,toRoleId,replyTo,text,evidenceRefs,late,sourceRunId:ctx.run.id,createdAt:now()};
    this.db.put('discussionMessages',message);
    const from=this.db.get('roles',message.fromRoleId),to=this.db.get('roles',toRoleId);
    this.db.put('roomMessages',{id:`discussion:${message.id}`,projectId:message.projectId,sender:'agent',senderName:from?.name||message.fromRoleId,roleId:message.fromRoleId,
      kind:'discussion',text,runId:ctx.run.id,taskIds:[],conversationId:thread.conversationId,discussion:{messageId:message.id,threadId:thread.id,questionId:replyTo||message.id,fromRoleId:message.fromRoleId,toRoleId,late},createdAt:message.createdAt});
    const room=this.db.get('rooms',thread.projectId)||{id:thread.projectId};
    this.db.put('rooms',{...room,revision:(room.revision||0)+1});
    if(!late) {
      const recipientSessionId=thread.participantSessions?.[toRoleId]||this.session(to,thread.conversationId||thread.projectId);
      const recipientSession=this.db.get('roleSessions',recipientSessionId);
      if(!recipientSession||recipientSession.status==='archived'||recipientSession.nodeId!==to.nodeId||recipientSession.runtime!==to.runtime)throw new Error(tr('roleDiscussions.recipientSessionHasChangedReconfirm'));
      this.db.put('discussionDeliveries',{id:key(message.id,toRoleId,thread.directionRevision),projectId:thread.projectId,threadId:thread.id,taskId:thread.taskId,
        messageId:message.id,recipientRoleId:toRoleId,recipientSessionId,directionRevision:thread.directionRevision,status:'queued',deliveryMode:'next_turn',processingRunId:null,recoveryCount:0,attempts:[],createdAt:now(),updatedAt:now()});
    }
    return message;
  }

  ask(run,input) {
    fields(input,['requestId','toRoleId','text','threadId','revision','replyTo']);text(input.text,tr('roleDiscussions.question'));
    return this.action(run,input,'ask',ctx=>{
      if(ctx.run.execution?.exclusive)throw new Error('exclusive_operation_active');
      // A report and a wait cannot both be the conclusion of this turn; reject before creating a message or session or deducting budget.
      if(this.db.get('runReports',ctx.run.id))throw new Error(tr('roleDiscussions.businessReportWasAlreadySubmitted'));
      const role=this.db.get('roles',input.toRoleId);
      if(!role||role.projectId!==ctx.run.projectId||!role.enabled||role.archivedAt||role.id===ctx.run.roleId)throw new Error(tr('roleDiscussions.invalidTargetRole'));
      if(role.nodeId!==ctx.run.nodeId||!supportsDiscussion(this.db.get('workers',role.nodeId),role.runtime))throw new Error(tr('roleDiscussions.atStageOnlyRolesOn'));
      this.assertReady(role);
      const targetSessionId=this.session(role,ctx.task.conversationId||ctx.task.projectId);
      const request=this.db.get('coordinationRequests',ctx.run.requestId||'');
      const rootTaskId=ctx.task.rootTaskId||this.db.get('coordinationRequests',request?.rootRequestId||'')?.taskId||ctx.task.id;
      const root=this.db.get('tasks',rootTaskId);
      if(!root||root.projectId!==ctx.run.projectId)throw new Error(tr('roleDiscussions.invalidRootTask'));
      let thread;
      if(input.threadId) {
        thread=this.thread(ctx,input.threadId);
        if(thread.participantSessions?.[role.id]&&thread.participantSessions[role.id]!==targetSessionId)throw new Error(tr('roleDiscussions.recipientSessionHasChangedReconfirm2'));
        const reply=this.db.get('discussionMessages',input.replyTo);
        if(thread.status!=='open'||thread.ownerRoleId!==ctx.run.roleId||thread.revision!==input.revision)throw new Error(tr('roleDiscussions.threadVersionStateHasChanged'));
        if(ctx.task.discussionWait?.questionId!==thread.currentQuestionId||!reply||reply.kind!=='answer'||reply.threadId!==thread.id||reply.replyTo!==thread.currentQuestionId||reply.late)throw new Error(tr('roleDiscussions.notReplyCurrentQuestion'));
        if(ctx.run.turnPurpose==='answer_resume'&&ctx.run.discussionMessageId!==reply.id)throw new Error(tr('roleDiscussions.replyDoesNotBelongTurn'));
      } else {
        if(ctx.run.turnPurpose!=='task'&&ctx.run.turnPurpose)throw new Error(tr('roleDiscussions.newQuestionsCanOnlyBe'));
        if(ctx.task.discussionWait)throw new Error('blocking_question_exists');
        thread={id:randomUUID(),projectId:ctx.run.projectId,conversationId:ctx.task.conversationId||ctx.task.projectId,taskId:ctx.task.id,rootTaskId,ownerRoleId:ctx.run.roleId,ownerSessionId:ctx.run.roleSessionId,participants:[ctx.run.roleId,role.id],status:'open',revision:0,
          directionRevision:ctx.task.directionRevision||1,currentQuestionId:null,budget:{used:0,limit:3,revision:0},createdAt:now()};
      }
      const rootBudget=root.discussionBudget||{used:0,limit:6,revision:0};
      if(thread.budget.used>=thread.budget.limit||rootBudget.used>=rootBudget.limit)throw new Error('discussion_budget_exhausted');
      thread={...thread,participantSessions:{...thread.participantSessions,[ctx.run.roleId]:ctx.run.roleSessionId,[role.id]:targetSessionId},participants:[...new Set([...thread.participants,role.id])],revision:thread.revision+1,budget:{...thread.budget,used:thread.budget.used+1},updatedAt:now()};
      const message=this.message(ctx,thread,{...input,kind:'question'});
      thread.currentQuestionId=message.id;
      this.db.put('discussionThreads',thread);
      this.db.put('tasks',{...root,discussionBudget:{...rootBudget,used:rootBudget.used+1}});
      this.db.put('tasks',{...this.db.get('tasks',ctx.task.id),discussionWait:{threadId:thread.id,questionId:message.id,sourceRunId:ctx.run.id,directionRevision:thread.directionRevision},waitingReason:tr('roleDiscussions.waitingForReply', { name: role.name })});
      this.db.put('runs',{...ctx.run,discussionWaiting:true,discussionThreadId:thread.id});
      this.consume(ctx.run);
      for(const d of this.db.list('discussionDeliveries').filter(d=>d.threadId===thread.id&&d.status==='queued'&&d.messageId!==message.id))this.db.put('discussionDeliveries',{...d,status:'superseded',updatedAt:now()});
      return {threadId:thread.id,messageId:message.id,questionId:message.id,revision:thread.revision,status:'waiting_answer'};
    });
  }

  /** A user reply and an explicit resolution are two separate actions; a reply is delivered only to the original asker. */
  userReply(projectId,input) {
    fields(input,['requestId','threadId','revision','expectedQuestionId','directionRevision','text']);text(input.text,tr('roleDiscussions.reply'));
    if(typeof input.requestId!=='string'||!/^[a-zA-Z0-9:_-]{1,200}$/.test(input.requestId))throw new Error(tr('roleDiscussions.invalidRequestId3'));
    return this.db.transaction(()=>{
      const id=key(projectId,'human',input.requestId),fingerprint=canonical({name:'userReply',input});
      const prior=this.db.get('discussionActions',id);
      if(prior){if(prior.fingerprint!==fingerprint)throw new Error(tr('roleDiscussions.requestIdConflictsWithDifferent3'));return prior.result;}
      const thread=this.db.get('discussionThreads',input.threadId),task=this.db.get('tasks',thread?.taskId);
      if(!thread||thread.projectId!==projectId||!task||task.status==='cancelled'||thread.status!=='open')throw new Error(tr('roleDiscussions.threadStateHasChanged'));
      if(thread.revision!==input.revision||thread.directionRevision!==input.directionRevision||thread.directionRevision!==(task.directionRevision||1))throw new Error(tr('roleDiscussions.threadVersionDirectionHasChanged'));
      if(thread.currentQuestionId!==input.expectedQuestionId||task.discussionWait?.questionId!==input.expectedQuestionId)throw new Error(tr('roleDiscussions.currentQuestionHasChanged'));
      const session=this.db.get('roleSessions',thread.ownerSessionId);
      if(!session||session.status==='archived')throw new Error(tr('roleDiscussions.originalAskerSessionNoLonger'));
      const message=this.message({run:{id:null,roleId:null}},thread,{requestId:input.requestId,kind:'answer',toRoleId:thread.ownerRoleId,replyTo:thread.currentQuestionId,text:input.text});
      const visible=this.db.get('roomMessages',`discussion:${message.id}`);
      this.db.put('roomMessages',{...visible,sender:'human',senderName:tr('roleDiscussions.me')});
      this.db.put('discussionThreads',{...thread,revision:thread.revision+1,updatedAt:now()});
      const result={threadId:thread.id,messageId:message.id,replyTo:thread.currentQuestionId,late:false,status:'queued'};
      this.db.put('discussionActions',{id,projectId,actor:'human',fingerprint,result,createdAt:now()});return result;
    });
  }

  reply(run,input) {
    fields(input,['requestId','threadId','replyTo','text','evidenceRefs']);text(input.text,tr('roleDiscussions.reply2'));
    return this.action(run,input,'reply',ctx=>{
      const thread=this.thread(ctx,input.threadId),question=this.db.get('discussionMessages',input.replyTo);
      if(input.evidenceRefs&&(!Array.isArray(input.evidenceRefs)||input.evidenceRefs.length>20||input.evidenceRefs.some(v=>typeof v!=='string'||v.length>1500)))throw new Error(tr('roleDiscussions.atMost20EvidenceText'));
      if(!question||question.threadId!==thread.id||question.kind!=='question'||question.toRoleId!==ctx.run.roleId||ctx.run.discussionMessageId!==question.id)throw new Error(tr('roleDiscussions.questionDoesNotBelongTurn'));
      const late=thread.status!=='open'||thread.currentQuestionId!==question.id||ctx.task.discussionWait?.questionId!==question.id;
      const message=this.message(ctx,thread,{...input,kind:'answer',toRoleId:thread.ownerRoleId,late});
      const incoming=this.db.list('discussionDeliveries').find(d=>d.messageId===question.id&&d.recipientRoleId===ctx.run.roleId);
      if(ctx.run.discussionDeliveryId&&(incoming?.id!==ctx.run.discussionDeliveryId||incoming.processingRunId!==ctx.run.id))throw new Error(tr('roleDiscussions.questionHandlingOwnershipHasChanged'));
      if(incoming)this.db.put('discussionDeliveries',{...incoming,status:'consumed',responseMessageId:message.id,updatedAt:now()});
      if(!late)this.db.put('discussionThreads',{...thread,revision:thread.revision+1,updatedAt:now()});
      return {threadId:thread.id,messageId:message.id,replyTo:question.id,late,status:late?'historical':'queued'};
    });
  }

  resolve(run,input) {
    fields(input,['requestId','threadId','revision','expectedQuestionId','conclusion','basedOnReplyIds','evidenceRefs']);text(input.conclusion,tr('roleDiscussions.conclusion'));
    return this.action(run,input,'resolve',ctx=>{
      if(ctx.run.turnPurpose!=='answer_resume')throw new Error(tr('roleDiscussions.questionCanOnlyBeResolved'));
      const thread=this.thread(ctx,input.threadId);
      if(thread.ownerRoleId!==ctx.run.roleId||thread.status!=='open'||thread.revision!==input.revision)throw new Error(tr('roleDiscussions.threadVersionStateHasChanged2'));
      if(thread.currentQuestionId!==input.expectedQuestionId||ctx.task.discussionWait?.questionId!==input.expectedQuestionId)throw new Error(tr('roleDiscussions.currentQuestionHasChanged2'));
      const ids=input.basedOnReplyIds||[],refs=input.evidenceRefs||[];
      if(!Array.isArray(ids)||!Array.isArray(refs)||ids.length+refs.length===0||ids.length+refs.length>20)throw new Error(tr('roleDiscussions.validResolutionEvidenceRequired'));
      for(const id of ids) {
        const reply=this.db.get('discussionMessages',id);
        if(!reply||reply.threadId!==thread.id||reply.kind!=='answer'||reply.replyTo!==thread.currentQuestionId||reply.late)throw new Error(tr('roleDiscussions.resolutionEvidenceNotCurrentReply'));
      }
      for(const id of refs) {
        const evidence=this.db.get('roomMessages',id)||this.db.get('runs',id);
        if(!evidence||evidence.projectId!==ctx.run.projectId)throw new Error(tr('roleDiscussions.resolutionEvidenceDoesNotExist'));
      }
      const resumeIntentId=`discussion-resume:${thread.id}`;
      this.consume(ctx.run);
      this.db.put('discussionThreads',{...thread,status:'resolved',revision:thread.revision+1,conclusion:input.conclusion,resolutionBasis:{questionId:thread.currentQuestionId,basedOnReplyIds:ids,evidenceRefs:refs,runId:ctx.run.id},updatedAt:now()});
      this.db.put('tasks',{...ctx.task,discussionWait:null,waitingReason:tr('roleDiscussions.waitingForReplyHandlingTurn')});
      this.db.put('discussionIntents',{id:resumeIntentId,projectId:thread.projectId,taskId:thread.taskId,threadId:thread.id,questionId:thread.currentQuestionId,directionRevision:thread.directionRevision,afterRunId:ctx.run.id,status:'queued',createdAt:now()});
      return {threadId:thread.id,questionId:thread.currentQuestionId,revision:thread.revision+1,resumeIntentId,status:'resolved'};
    });
  }

  /** Callable only from the authenticated web entry point; user identity is never accepted through an agent request. */
  userResolve(projectId,input) {
    fields(input,['requestId','threadId','revision','expectedQuestionId','directionRevision','conclusion','resumeAfterRunId']);text(input.conclusion,tr('roleDiscussions.conclusion2'));
    if(typeof input.requestId!=='string'||!/^[a-zA-Z0-9:_-]{1,200}$/.test(input.requestId))throw new Error(tr('roleDiscussions.invalidRequestId4'));
    return this.db.transaction(()=>{
      const id=key(projectId,'human',input.requestId),fingerprint=canonical({name:'userResolve',input});
      const prior=this.db.get('discussionActions',id);
      if(prior){if(prior.fingerprint!==fingerprint)throw new Error(tr('roleDiscussions.requestIdConflictsWithDifferent4'));return prior.result;}
      const thread=this.db.get('discussionThreads',input.threadId),task=this.db.get('tasks',thread?.taskId);
      if(!thread||thread.projectId!==projectId||!task||task.status==='cancelled'||!['open','resolved'].includes(thread.status))throw new Error(tr('roleDiscussions.threadStateHasChanged2'));
      if(thread.revision!==input.revision||thread.directionRevision!==input.directionRevision||thread.directionRevision!==(task.directionRevision||1))throw new Error(tr('roleDiscussions.threadVersionDirectionHasChanged2'));
      if(thread.status==='resolved') {
        const intent=this.db.list('discussionIntents').find(i=>i.threadId===thread.id&&i.status==='blocked');
        const after=this.db.get('runs',intent?.afterRunId||'');
        if(!intent||task.discussionResumeBlocked?.afterRunId!==after?.id||input.resumeAfterRunId!==after?.id||input.expectedQuestionId!==thread.currentQuestionId)throw new Error(tr('roleDiscussions.verifyCurrentAbnormalTurnThen'));
        if(!terminal.has(after?.status)||after.stopRequested||after.controlLost||after.discussionCleanup?.turnEnded!==true||after.discussionCleanup?.toolsClosed!==true)throw new Error(tr('roleDiscussions.originalRunHasNotEnded'));
        const evidenceId=`discussion-user:${randomUUID()}`;
        this.db.put('roomMessages',{id:evidenceId,projectId,sender:'human',senderName:tr('roleDiscussions.me2'),text:input.conclusion,taskIds:[],discussion:{threadId:thread.id,questionId:thread.currentQuestionId,action:'resume',afterRunId:after.id},createdAt:now()});
        this.db.put('discussionIntents',{...intent,status:'queued',waitingReason:null,recoveryEvidenceId:evidenceId,updatedAt:now()});
        this.db.put('tasks',{...task,discussionResumeBlocked:{...task.discussionResumeBlocked,confirmed:true},waitingReason:tr('roleDiscussions.verifiedWaitingForOriginalTask')});
        const result={threadId:thread.id,questionId:thread.currentQuestionId,revision:thread.revision,resumeIntentId:intent.id,status:'resolved'};
        this.db.put('discussionActions',{id,projectId,actor:'human',fingerprint,result,createdAt:now()});return result;
      }
      if(thread.currentQuestionId!==input.expectedQuestionId||task.discussionWait?.questionId!==input.expectedQuestionId)throw new Error(tr('roleDiscussions.currentQuestionHasChanged3'));
      const evidenceId=`discussion-user:${randomUUID()}`,resumeIntentId=`discussion-resume:${thread.id}`;
      this.db.put('roomMessages',{id:evidenceId,projectId,sender:'human',senderName:tr('roleDiscussions.me3'),text:input.conclusion,taskIds:[],discussion:{threadId:thread.id,questionId:thread.currentQuestionId,action:'resolve'},createdAt:now()});
      this.db.put('discussionThreads',{...thread,status:'resolved',revision:thread.revision+1,conclusion:input.conclusion,resolutionBasis:{source:'human',questionId:thread.currentQuestionId,evidenceRefs:[evidenceId]},updatedAt:now()});
      this.db.put('tasks',{...task,discussionWait:null,waitingReason:tr('roleDiscussions.waitingForOriginalTurnEnd')});
      this.db.put('discussionIntents',{id:resumeIntentId,projectId,taskId:task.id,threadId:thread.id,questionId:thread.currentQuestionId,directionRevision:thread.directionRevision,afterRunId:task.discussionWait.sourceRunId,status:'queued',createdAt:now()});
      const result={threadId:thread.id,questionId:thread.currentQuestionId,revision:thread.revision+1,resumeIntentId,status:'resolved'};
      this.db.put('discussionActions',{id,projectId,actor:'human',fingerprint,result,createdAt:now()});
      return result;
    });
  }
}
