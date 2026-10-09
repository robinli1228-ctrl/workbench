import { tr } from './i18n.mjs';
import {assertBindingEditAllowed, activeRoleSwitch,roleSwitchWaitReason,effectiveExecutionRole} from './role-switch-policy.mjs';
import { normalizeResponsibility } from './role-definition.mjs';
import { randomUUID } from 'node:crypto';
import { terminal } from './store.mjs';
import {reservedTerminalSlots} from './device-capacity.mjs';
import { runtimeIssue } from './runtime-probe.mjs';
import { defaultRoleTemplates, isRoleConfigured, isSupervisorName, isBroadcastName } from './default-roles.mjs';
import { roleWorkspace } from './project-repositories.mjs';
import { executionConflict } from './execution-workspace.mjs';
import { steeringWaitReason } from './role-steering.mjs';
import { ConversationContext } from './conversation-context.mjs';
import {RoleDiscussions} from './role-discussions.mjs';

const now = () => new Date().toISOString();

/** Give a result continuation priority once at a turn boundary; after that, ordinary messages go first in their original FIFO order. */
export function orderRoleQueue(tasks,priorityUsed,discussionUsed=()=>false) {
  const rank=t=>t.steering ? -1 : (t.discussionDeliveryId||t.discussionIntentId) ? (discussionUsed(t.roleSnapshot?.nodeId)?1:0) : t.continuationRunId && !priorityUsed(t.roleId) ? 0 : t.scheduledJobId ? 2 : 1;
  return [...tasks].sort((a,b)=>rank(a)-rank(b)||(Date.parse(a.createdAt)||0)-(Date.parse(b.createdAt)||0));
}
export function mentionNames(text) {
  return [...new Set([...text.matchAll(/(?:^|[\s,.!?;:(\uff0c\u3002\uff01\uff1f\u3001\uff1b\uff1a\uff08])@([\p{L}\p{N}_-]+)/gu)].map(m => m[1]))];
}

/** Recognize only explicit collective dispatch in the user's own text; quotes, negations, and exception scopes are not guessed at and are left to the supervisor to clarify.
 *  English and Chinese phrasings are both recognised; the Chinese patterns are \u-escaped. */
export function collectiveRoleScope(text) {
  const prose=text.replace(/```[\s\S]*?(?:```|$)/g,'').replace(/^\s*>.*$/gm,'').replace(/`[^`]*`|\u201c[^\u201d]*\u201d|\u300c[^\u300d]*\u300d|"[^"]*"/g,'');
  for(const sentence of prose.split(/[.!;\n\u3002\uff01\uff1f\uff1b]+/)) {
    const scope=collectiveRoleScopeEn(sentence)||collectiveRoleScopeZh(sentence);
    if(scope)return scope;
  }
  return null;
}
function collectiveRoleScopeEn(sentence) {
  const match=sentence.match(/\b(?:all|every|each)(?:\s+of)?(?:\s+the)?\s+(?:(?:(review(?:er|ing)?|audit(?:or|ing)?)\s+)?roles?\b|(reviewers|auditors)\b)[^.!?;\n]{0,40}?\b(?:review|audit|assess|evaluate|comment|give|provide|propose|participate|check|execute|handle|analy[sz]e)\b/i);
  if(!match)return null;
  const prefix=sentence.slice(0,match.index).split(',').at(-1).trim().replace(/^@Supervisor\s*/i, '');
  const head=match[0].match(/^\S+(?:\s+of)?(?:\s+the)?\s+(?:\S+\s+)?(?:roles?|reviewers|auditors)\b/i)?.[0]||match[0];
  const action=match[0].slice(head.length).replace(/^[,\s]+/,'').split(',')[0];
  const tail=sentence.slice(match.index+head.length).trim();
  // The collective roles must be the ones being asked to act, not the source material of a request like "summarize / refer to the existing opinions of all roles".
  if(/\?\s*$/.test(sentence)||(prefix&&!/\b(?:please|ask|have|let|get|make|want|need|require|arrange|request|tell|instruct|schedule|assign)(?:\s+(?:you\s+to|you|to|that|for))?$/i.test(prefix)))return null;
  if(/\b(?:don'?t|do not|no need|need not|without|shouldn'?t|should not|cannot|can'?t|must not|not|why|whether|if|how)\b/i.test(prefix+' '+action))return null;
  if(/\b(?:except|other than|apart from|besides|only)\b/i.test(sentence)||/^(?:'s|\u2019s|who|that|which|already|previously|earlier|have|has|had)\b/i.test(action)||/\balready\b|\bpreviously\b/i.test(action))return null;
  if(/^(?:that|who|which|whose)\b/i.test(tail))return null;
  return (match[1]||match[2])?'reviewers':'all';
}
function collectiveRoleScopeZh(sentence) {
  const match=sentence.match(/(?:\u6240\u6709|\u5168\u90e8|\u5404\u4e2a|\u6bcf\u4e2a|\u5404\u4f4d|\u6bcf\u4f4d|\u5404)(?:\u7684)?(?:(\u5ba1\u6838|\u5ba1\u67e5|\u8bc4\u5ba1|\u590d\u6838)(?:\u7684)?)?\u89d2\u8272[^\u3002\uff01\uff1f!?;\uff1b\n]{0,40}?(?:\u5ba1\u6838|\u8bc4\u5ba1|\u5ba1\u67e5|\u590d\u6838|\u53d1\u8868|\u7ed9\u51fa|\u63d0\u51fa|\u63d0\u4f9b|\u53c2\u4e0e|\u68c0\u67e5|\u6267\u884c|\u5904\u7406|\u5206\u6790)/);
  if(!match)return null;
  const prefix=sentence.slice(0,match.index).split(/[\uff0c,]/).at(-1).trim().replace(/^@\u603b\u7ba1\s*/, '');
  const roleEnd=match[0].indexOf('\u89d2\u8272')+2;
  const action=match[0].slice(roleEnd).replace(/^[\uff0c,\s]+/,'').split(/[\uff0c,]/)[0];
  const tail=sentence.slice(match.index+roleEnd).trim();
  if(/\u5417\s*$/.test(sentence)||(prefix&&!/(?:\u8ba9|\u8bf7|\u5b89\u6392|\u8981\u6c42|\u5e0c\u671b)(?:\u8ba9|\u8bf7)?$/.test(prefix)))return null;
  if(/\u4e0d\u8981|\u4e0d\u7528|\u65e0\u9700|\u4e0d\u5fc5|\u4e0d\u9700\u8981|\u4e0d\u5e0c\u671b|\u4e0d\u8ba9|\u4e0d\u80fd|\u522b\u8ba9|\u4e3a\u4ec0\u4e48|\u4e3a\u4f55|\u662f\u5426|\u6709\u6ca1\u6709|\u600e\u4e48|\u5982\u4f55/.test(prefix+action))return null;
  if(/\u9664\u4e86|\u9664\u5916|\u4ec5\u8ba9|\u53ea\u8ba9|\u53ea\u6709/.test(sentence)||/^(?:\u7684|\u4e4b\u524d|\u6b64\u524d|\u5df2\u7ecf|\u66fe\u7ecf)/.test(action)||/\u90fd\u5df2\u7ecf|\u90fd\u66fe\u7ecf/.test(action))return null;
  if(/^(?:\u90fd|\u5df2|\u5df2\u7ecf|\u66fe\u7ecf|\u5206\u522b)*(?:\u7ed9\u51fa|\u63d0\u4f9b|\u63d0\u51fa|\u53d1\u8868|\u5ba1\u6838|\u5ba1\u67e5|\u8bc4\u5ba1|\u590d\u6838|\u5206\u6790|\u6267\u884c|\u5904\u7406)(?:\u8fc7|\u4e86)?\u7684/.test(tail))return null;
  return match[1]?'reviewers':'all';
}

/** In a new project, a message with no @ goes to the fixed supervisor; an explicit @ dispatches to that role; @everyone and legacy project discussions are only stored. */
export class Rooms {
  constructor(db) { this.db = db; }

  touch(projectId) {
    const prior = this.db.get('rooms', projectId);
    this.db.put('rooms', { id: projectId, revision: (prior?.revision || 0) + 1 });
  }

  /** Instruction settings are stored on the role record and copied at dispatch time; they never overwrite Markdown files in the user's repository. */
  saveRole(projectId, input) {
    assertBindingEditAllowed(this.db, input.id && this.db.get('roles', input.id), input);
    return this.db.put('roles', this.validateRole(projectId, input));
  }

  /** Validate a draft without temporarily saving it as the live execution binding. */
  validateRole(projectId, input) {
    if (!this.db.get('projects', projectId)) throw new Error(tr('rooms.projectNotFound'));
    const old = input.id ? this.db.get('roles', input.id) : null;
    if (old?.systemSupervisor) throw new Error(tr('rooms.editSystemSupervisorThroughSupervisor'));
    if (input.id && old?.projectId !== projectId) throw new Error(tr('rooms.roleDoesNotBelongProject'));
    if (old?.archivedAt) throw new Error(tr('rooms.roleArchivedCannotBeModified'));
    if (old && input.revision !== undefined && input.revision !== (old.revision || 1)) throw new Error(tr('rooms.roleConfigurationHasChangedReopen'));
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!/^[\p{L}\p{N}_-]{1,32}$/u.test(name)) throw new Error(tr('rooms.roleNamesMustBe1'));
    if (isBroadcastName(name) && old?.name !== name) throw new Error(tr('rooms.broadcastNameReserved'));
    if (isSupervisorName(name) && old?.name !== name) throw new Error(tr('rooms.supervisorFixedSystemRoleUse'));
    if (this.db.list('roles').some(r => r.projectId === projectId && r.name === name && r.id !== old?.id)) throw new Error(tr('rooms.projectAlreadyHasRoleWith'));
    const runtime = typeof input.runtime === 'string' ? input.runtime.trim() : '';
    const unchangedConfigured = Boolean(old && input.enabled === false && isRoleConfigured(old)
      && input.nodeId === old.nodeId && runtime === old.runtime && input.model === old.model);
    const repositoryId = null;
    const configured = unchangedConfigured || Boolean(input.nodeId && runtime && input.model && roleWorkspace(this.db, projectId, input.nodeId, repositoryId));
    if (input.enabled && !configured) throw new Error(tr('rooms.configureDeviceCliModelProject'));
    if (configured && !unchangedConfigured) {
      const issue = runtimeIssue(this.db.get('workers', input.nodeId), runtime, input.model);
      if (issue) throw new Error(issue);
    }
    if (typeof input.instructions !== 'string' || input.instructions.length > 12000) throw new Error(tr('rooms.roleInstructionsLimited12000Characters'));
    if (typeof input.enabled !== 'boolean') throw new Error(tr('rooms.enabledMustBeBoolean'));
    const autoApprove = true;
    let effort = null;
    if (input.effort != null && input.effort !== '') {
      effort = String(input.effort).trim();
      if (!effort || effort.length > 32) throw new Error(tr('rooms.invalidReasoningEffort'));
    }
    const templateKey = old ? old.templateKey : defaultRoleTemplates().find(t => t.key === input.templateKey)?.key;
    return { ...old, id: old?.id || randomUUID(), projectId, templateKey, revision: old ? (old.revision || 1) + 1 : 1,
      name, repositoryId, nodeId: configured ? input.nodeId : '', runtime: configured ? runtime : '', model: configured ? input.model : '',
      mode: 'workspace-write', effort, autoApprove, instructions: input.instructions.trim(), responsibility: normalizeResponsibility(input.responsibility, old?.responsibility || ''), configured, enabled: configured && input.enabled, updatedAt: now() };
  }

  /** Definition edits do not run a CLI probe or change any execution binding, including for offline roles. */
  updateRoleDefinition(projectId, roleId, input) {
    const old = this.db.get('roles', roleId);
    if (!old || old.projectId !== projectId) throw new Error(tr('rooms.roleDoesNotBelongProject'));
    if (old.systemSupervisor || old.platformAssistant) throw new Error(tr('rooms.editSystemSupervisorThroughSupervisor'));
    if (old.archivedAt) throw new Error(tr('rooms.roleArchivedCannotBeModified'));
    if (!Number.isInteger(input?.revision) || input.revision !== (old.revision || 1)) throw new Error(tr('rooms.roleConfigurationHasChangedReopen'));
    if (Object.keys(input).some(key => !['revision', 'responsibility', 'instructions'].includes(key))
      || (!Object.hasOwn(input, 'responsibility') && !Object.hasOwn(input, 'instructions'))) throw new Error(tr('roleDefinition.onlyDefinitionFields'));
    if (Object.hasOwn(input, 'instructions') && (typeof input.instructions !== 'string' || input.instructions.length > 12000)) throw new Error(tr('rooms.roleInstructionsLimited12000Characters'));
    const updated = this.db.put('roles', { ...old, responsibility: normalizeResponsibility(input.responsibility, old.responsibility || ''),
      instructions: input.instructions === undefined ? old.instructions : input.instructions.trim(), revision: (old.revision || 1) + 1, updatedAt: now() });
    this.touch(projectId);
    return updated;
  }

  /** Archiving only hides a working role and keeps its history; unfinished work must be cancelled or handled first. */
  archiveRole(projectId, roleId) {
    return this.db.transaction(() => {
      const role = this.db.get('roles', roleId);
      if (role?.systemSupervisor) throw new Error(tr('rooms.fixedProjectSupervisorCannotBe'));
      if (activeRoleSwitch(this.db, roleId)) throw new Error('CLI switch in progress; cannot archive this role.');
      if (role?.projectId !== projectId) throw new Error(tr('rooms.roleDoesNotBelongProject2'));
      if (role.archivedAt) return role;
      const activeRun = this.db.list('runs').some(r => r.projectId === projectId && r.roleId === roleId && !terminal.has(r.status));
      const pendingTask = this.db.list('tasks').some(t => t.projectId === projectId && t.roleId === roleId && ['ready', 'in_progress', 'awaiting_acceptance'].includes(t.status));
      const pendingRequest = this.db.list('coordinationRequests').some(r => r.projectId === projectId && r.targetRoleId === roleId && !['succeeded', 'failed', 'cancelled'].includes(r.status));
      if (activeRun || pendingTask || pendingRequest) throw new Error(tr('rooms.roleStillHasUnfinishedWork'));
      return this.db.put('roles', { ...role, enabled: false, archivedAt: now(), updatedAt: now(), revision: (role.revision || 1) + 1 });
    });
  }

  /** The message and the execution records of all recipient roles are committed together; resending does not dispatch again. */
  post(projectId, { clientMessageId, text = '', replyToId = null, attachmentIds = [], targetRoleId = null, scheduledJobId = null }) {
    if (typeof clientMessageId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(clientMessageId)) throw new Error(tr('rooms.invalidMessageId'));
    if (typeof text !== 'string' || (!text.trim() && !attachmentIds.length) || text.length > 12000) throw new Error(tr('rooms.enterTextAddAttachmentText'));
    const attachments = this.attachments ? this.attachments.resolve(projectId, attachmentIds) : [];
    text = text.trim();
    const fingerprint = JSON.stringify({ projectId, text, replyToId, ...(attachmentIds.length ? { attachmentIds } : {}),...(targetRoleId?{targetRoleId}:{}),...(scheduledJobId?{scheduledJobId}:{}) });
    return this.db.transaction(() => {
      const prior = this.db.get('roomMessages', clientMessageId);
      if (prior) { if (prior.fingerprint !== fingerprint) throw new Error(tr('rooms.messageIdConflictsWithDifferent')); return prior; }
      if (!this.db.get('projects', projectId)) throw new Error(tr('rooms.projectNotFound2'));
      const quote = replyToId ? this.db.get('roomMessages', replyToId) : null;
      if (replyToId && quote?.projectId !== projectId) throw new Error(tr('rooms.quotedMessageDoesNotBelong'));
      const fixedRole=targetRoleId?this.db.get('roles',targetRoleId):null;
      if(targetRoleId && fixedRole?.projectId!==projectId) throw new Error(tr('rooms.specifiedRoleDoesNotBelong'));
      const mentioned = fixedRole ? [fixedRole.name] : mentionNames(text);
      const pingAll = !fixedRole && mentioned.some(isBroadcastName);
      const names = mentioned.filter(name => fixedRole || !isBroadcastName(name));
      const project = this.db.get('projects', projectId);
      const supervisorRole = project.supervisorRoleId ? this.db.get('roles', project.supervisorRoleId) : null;
      if (!mentioned.length && project.supervisorRoleId) names.push(supervisorRole?.name || tr('rooms.supervisor'));
      const broadcast = pingAll;
      if (names.length > 4) throw new Error(tr('rooms.messageCanMentionAtMost'));
      let roles = [];
      if (names.length) {
        roles = names.map(name => {
          // The fixed Supervisor may have been created under a different display-name language, so @Supervisor / @\u603b\u7ba1 resolve through the project record.
          const role = fixedRole || (!mentioned.length && project.supervisorRoleId ? supervisorRole : this.db.list('roles').find(r => r.projectId === projectId && r.name === name) || (isSupervisorName(name) ? supervisorRole : null));
          if (!role || role.projectId !== projectId) throw new Error(tr('rooms.roleDoesNotExist', { name }));
          if (!isRoleConfigured(role)) throw new Error(tr('rooms.roleHasNoDeviceCli', { name }));
          if (!role.enabled) throw new Error(tr('rooms.roleDisabled', { name }));
          if (!roleWorkspace(this.db, projectId, role.nodeId, role.repositoryId)) throw new Error(tr('rooms.roleHasNoRepositoryDirectory', { name }));
          return role;
        });
      }
      const scope=!broadcast&&!fixedRole&&roles.length===1&&roles[0].systemSupervisor?collectiveRoleScope(text):null;
      const participants=scope?this.db.list('roles').filter(r=>r.projectId===projectId&&!r.archivedAt&&r.enabled&&!r.systemSupervisor&&(scope==='all'||r.templateKey==='reviewer'||/review|audit|\u5ba1\u6838|\u5ba1\u67e5|\u8bc4\u5ba1|\u590d\u6838/i.test(r.name))):roles.length>1?roles.filter(r=>!r.systemSupervisor):[];
      if(scope&&!participants.length)throw new Error(tr('rooms.noEnabledRoleInProject'));
      if(scope&&participants.length>12)throw new Error(tr('rooms.roundMatchesRolesExceedingLimit', { length: participants.length }));
      const schedulingTargets=participants.map(r=>r.id);
      const schedulingRoster=participants.map(r=>({id:r.id,name:r.name}));
      if (roles.length > 1) {
        const supervisor = this.db.get('roles', project.supervisorRoleId);
        if (!supervisor?.enabled || !isRoleConfigured(supervisor)) throw new Error(tr('rooms.configureSupervisorInProjectSettings'));
        roles = [supervisor];
      }
      if (roles.length && this.db.get('settings', 'main')?.paused) throw new Error(tr('rooms.remoteExecutionPausedMentionsCannot'));
      const source = quote?.runId ? this.db.get('runs', quote.runId) : null;
      // The supervisor's quote is conversation context and does not require handing the code repository over to the supervisor's configured directory.
      const reuseSource = source && roles.length && !source.roleSnapshot?.systemSupervisor && roles.every(r => !r.systemSupervisor);
      let sourceDelivery;
      if (reuseSource) {
        if (source.projectId !== projectId || source.status !== 'succeeded' || !source.workspace) throw new Error(tr('rooms.onlyRunsCompletedSuccessfullyKept'));
        if (roles.some(r => r.nodeId !== source.nodeId)) {
          const ready = this.db.list('deliveries').filter(d => d.projectId === projectId && d.sourceRunId === source.id && d.status === 'ready');
          if (ready.length !== 1) throw new Error(tr('rooms.crossDeviceQuoteNeedsExactly'));
          sourceDelivery = ready[0];
        }
      }
      const taskIds = roles.map(role => {
        // The original dispatch text is kept verbatim; quotes and recent conversation are attached separately by source in this turn's context pack.
        const prompt = text || tr('rooms.pleaseReviewAttachmentsInMessage');
        const task = this.db.createTask({ projectId, title: text.slice(0, 80) || tr('rooms.reviewAttachments'), prompt, model: role.model, mode: role.mode });
        this.db.put('tasks', { ...task, origin: 'chat', sourceMessageId: clientMessageId, roleId: role.id, roleSnapshot: role,
          sourceRunId: sourceDelivery || !reuseSource ? null : source.id, deliveryId: sourceDelivery?.id || null,
          quoteMessageId:quote?.id||null,
          attachments: attachments.length ? attachments : (quote?.attachments?.length ? quote.attachments : source?.attachments || []), schedulingTargets,schedulingRoster,reportRequired:true,scheduledJobId,
          requiresCoordination: Boolean(sourceDelivery), broadcast: broadcast || undefined });
        return task.id;
      });
      const message = this.db.put('roomMessages', { id: clientMessageId, projectId, sender: 'human', senderName: tr('rooms.me'), text, attachments, replyToId, taskIds, broadcast: broadcast || undefined, createdAt: now(), fingerprint });
      if(!project.systemConfig)new ConversationContext(this.db).enqueue(projectId);
      this.touch(projectId);
      return message;
    });
  }

  /** Paginate recent messages; the cursor must belong to the same project so that switching projects cannot leak history. */
  messages(projectId, before) {
    if (!this.db.get('projects', projectId)) throw new Error(tr('rooms.projectNotFound3'));
    const all = this.db.list('roomMessages').filter(m => m.projectId === projectId);
    const end = before ? all.findIndex(m => m.id === before) : all.length;
    if (end < 0) throw new Error(tr('rooms.historyCursorNotFound'));
    const start = Math.max(0, end - 60), messages = all.slice(start, end);
    return { messages, hasMore: start > 0, nextBefore: messages[0]?.id || null };
  }

  cancel(taskId) {
    const task = this.db.get('tasks', taskId);
    if (task?.origin !== 'chat' || task.currentRunId || !['ready', 'cancelled'].includes(task.status)) throw new Error(tr('rooms.onlyGroupChatAssignmentsHave'));
    return this.db.put('tasks', { ...task, status: 'cancelled', waitingReason: null });
  }

  /** Dispatch synchronously within a single Home, with one active run per role, respecting each node's total capacity. */
  schedule(isReady) {
    const nodes = new Set(); let changed = false;
    const discussions=new RoleDiscussions(this.db,{online:isReady});changed=discussions.recover().changed;
    const candidates=[...this.db.list('tasks').filter(t=>t.origin==='chat'&&t.status==='ready'&&!t.switchOperationId),...discussions.candidates()];
    for (const task of orderRoleQueue(candidates,id=>this.db.get('roleQueueTurns',id)?.priorityUsed,id=>this.db.get('discussionQueueTurns',id)?.priorityUsed)) {
      const discussion=Boolean(task.discussionDeliveryId||task.discussionIntentId);
      const kind=task.discussionDeliveryId?'discussionDeliveries':'discussionIntents',recordId=task.discussionDeliveryId||task.discussionIntentId;
      const role = effectiveExecutionRole(this.db,task), worker = this.db.get('workers', role.nodeId);
      const active = this.db.list('runs').filter(r => !terminal.has(r.status));
      const reason = this.db.get('settings', 'main')?.paused ? tr('rooms.remoteExecutionPaused')
        : roleSwitchWaitReason(this.db,task) ? roleSwitchWaitReason(this.db,task)
        : steeringWaitReason(this.db,task) ? steeringWaitReason(this.db,task)
        : !task.contextPrepared ? tr('rooms.organizingConversation')
        : projectTerminalLock(this.db,task.projectId,role.nodeId) ? tr('rooms.projectUnderManualTerminalTakeover')
        : !this.db.get('roles', role.id)?.enabled ? tr('rooms.roleDisabled2')
        : !isReady(role.nodeId) ? tr('rooms.waitingForNodeComeOnline')
        : !worker?.capabilities?.roomRoles ? tr('rooms.upgradeWorkerSupportRoles')
        : worker.capabilities.projectSpace !== 1 ? tr('rooms.upgradeWorkerSupportSharedProject')
        : worker.capabilities.managedResume !== 1 ? tr('rooms.upgradeWorkerSupportRoleSession')
        : task.attachments?.length && worker.capabilities.attachments !== 1 ? tr('rooms.upgradeWorkerReceiveAttachments')
        : task.reportRequired && worker.capabilities.collaborationTools !== 2 ? tr('rooms.upgradeWorkerForReportFull')
        : task.execution && worker.capabilities.executionScheduling !== 1 ? tr('rooms.upgradeWorkerRunSupervisorSchedules')
        : task.requiresCoordination && worker?.capabilities?.coordinationVersion !== 1 ? tr('rooms.upgradeWorkerSupportCrossDevice')
        : runtimeIssue(worker, role.runtime, role.model) ? runtimeIssue(worker, role.runtime, role.model)
        : active.some(r => r.roleId === role.id) ? tr('rooms.waitingForRoleFinishIts')
        : executionConflict({...task,nodeId:role.nodeId},active) ? (task.execution?.exclusive ? tr('rooms.waitingForExclusiveOperationWindow') : tr('rooms.waitingForProjectWorkspaceExclusive'))
        : active.some(r => r.nodeId === role.nodeId && r.status === 'reconciling') ? tr('rooms.nodeHasRunsAwaitingReconciliation')
        : active.filter(r => r.nodeId === role.nodeId).length+reservedTerminalSlots(this.db,role.nodeId)+(worker.capabilities.cliCapacity!==1&&worker.capabilities.summaryBatches===1?0:worker.organizerBusy||0) >= (worker.capacity || 1) ? tr('rooms.waitingForNodeBecomeIdle') : null;
      if (reason) {
        const record=discussion?this.db.get(kind,recordId):task;
        if (record?.waitingReason !== reason) { this.db.put(discussion?kind:'tasks', { ...record, waitingReason: reason }); changed = true; }
        continue;
      }
      try {
        if(task.discussionDeliveryId){const delivery=this.db.get('discussionDeliveries',task.discussionDeliveryId);this.db.startDiscussionRun({deliveryId:delivery.id,commandId:`discussion:${delivery.id}:${delivery.recoveryCount}`,nodeId:role.nodeId},{online:isReady});}
        else if(task.discussionIntentId)this.db.resumeDiscussionTask({intentId:task.discussionIntentId,commandId:`resume:${task.discussionIntentId}`,nodeId:role.nodeId},{online:isReady});
        else this.db.startTask(task.id, { commandId: `chat-${task.id}`, nodeId: role.nodeId });
        this.db.put('roleQueueTurns',{id:role.id,priorityUsed:Boolean(task.continuationRunId)});
        this.db.put('discussionQueueTurns',{id:role.nodeId,priorityUsed:discussion});
        nodes.add(role.nodeId); changed = true;
      } catch (error) {
        if(discussion){const record=this.db.get(kind,recordId);if(record?.waitingReason!==error.message){this.db.put(kind,{...record,waitingReason:error.message});changed=true;}continue;}
        this.db.transaction(() => {
          const current=this.db.get('tasks',task.id);
          if(current?.status==='ready' && !current.currentRunId) {
            this.db.put('tasks', { ...current, status: 'blocked', error: error.message });
            const request=current.requestId?this.db.get('coordinationRequests',current.requestId):null;
            if(request?.taskId===current.id && !request.currentRunId && !['succeeded','failed','cancelled'].includes(request.status)) {
              this.db.put('coordinationRequests',{...request,status:'failed',outcome:'blocked',result:tr('rooms.notStarted', { message: error.message }),updatedAt:now()});
            }
          }
        });changed = true;
      }
    }
    return { nodes: [...nodes], changed };
  }

  /** An agent leaves a note in the group; it does not trigger dispatch. */
  agentNote(run, text) {
    const body = typeof text === 'string' ? text.trim() : '';
    if (!body || body.length > 8000) throw new Error(tr('rooms.noteMustBe18000'));
    if (!run?.projectId || !run.roleSnapshot?.name) throw new Error(tr('rooms.currentRunInvalid'));
    const message = this.db.put('roomMessages', {
      id: randomUUID(), projectId: run.projectId, sender: 'agent', senderName: run.roleSnapshot.name,
      roleId: run.roleId, text: body, replyToId: run.sourceMessageId || null, runId: run.id, taskIds: [], createdAt: now()
    });
    this.touch(run.projectId);
    return message;
  }

  /** Post only a run's final state back to the group; text streams and tool logs stay in the run details. */
  complete(run) {
    if (!run?.roleId || !terminal.has(run.status)||run.discussionDeliveryId||run.switchOperationId) return;
    const id = `result-${run.id}`;
    if (this.db.get('roomMessages', id)) return;
    this.db.transaction(() => {
      const report = this.db.get('runReports', run.id);
      const question = report?.verdict === 'needs_input' ? tr('rooms.yourConfirmationNeededReplyBy', { summary: report.summary }) : '';
      const text = run.status === 'succeeded' ? (run.result || question || tr('rooms.runHasEndedRuntimeReturned'))
        : tr('rooms.text', { p1: run.status === 'interrupted' ? tr('rooms.runStopped') : tr('rooms.runFailed'), p2: run.error || tr('rooms.seeRunDetails'), p3: run.result ? tr('rooms.existingOutput', { result: run.result }) : '' });
      const handoff=this.db.get('roomMessages',`call:${run.requestId}`);
      this.db.put('roomMessages', { id, projectId: run.projectId, sender: 'agent', senderName: run.roleSnapshot.name,
        roleId: run.roleId, text, replyToId: handoff?.projectId===run.projectId?handoff.id:run.sourceMessageId,
        runId: run.id, taskIds: [], createdAt: now() });
      this.touch(run.projectId);
    });
  }
}
import { projectTerminalLock } from './terminal-resume.mjs';
