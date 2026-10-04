import { randomUUID } from 'node:crypto';
import { terminal } from './store.mjs';
import { runtimeIssue } from './runtime-probe.mjs';
import { DEFAULT_ROLE_TEMPLATES, isRoleConfigured } from './default-roles.mjs';
import { roleWorkspace } from './project-repositories.mjs';
import { executionConflict } from './execution-workspace.mjs';
import { steeringWaitReason } from './role-steering.mjs';
import { ConversationContext } from './conversation-context.mjs';
import {RoleDiscussions} from './role-discussions.mjs';

const now = () => new Date().toISOString();

const EVERYONE = /^(everyone|all)$/i;
/** Give a result continuation priority once at a turn boundary; after that, ordinary messages go first in their original FIFO order. */
export function orderRoleQueue(tasks,priorityUsed,discussionUsed=()=>false) {
  const rank=t=>t.steering ? -1 : (t.discussionDeliveryId||t.discussionIntentId) ? (discussionUsed(t.roleSnapshot?.nodeId)?1:0) : t.continuationRunId && !priorityUsed(t.roleId) ? 0 : t.scheduledJobId ? 2 : 1;
  return [...tasks].sort((a,b)=>rank(a)-rank(b)||(Date.parse(a.createdAt)||0)-(Date.parse(b.createdAt)||0));
}
function mentionNames(text) {
  return [...new Set([...text.matchAll(/(?:^|[\s,.!?;:(])@([\p{L}\p{N}_-]+)/gu)].map(m => m[1]))];
}

/** Recognize only explicit collective dispatch in the user's own text; quotes, negations, and exception scopes are not guessed at and are left to the supervisor to clarify. */
function collectiveRoleScope(text) {
  const prose=text.replace(/```[\s\S]*?(?:```|$)/g,'').replace(/^\s*>.*$/gm,'').replace(/`[^`]*`|\u201c[^\u201d]*\u201d|"[^"]*"/g,'');
  for(const sentence of prose.split(/[.!;\n]+/)) {
    const match=sentence.match(/\b(?:all|every|each)(?:\s+of)?(?:\s+the)?\s+(?:(?:(review(?:er|ing)?|audit(?:or|ing)?)\s+)?roles?\b|(reviewers|auditors)\b)[^.!?;\n]{0,40}?\b(?:review|audit|assess|evaluate|comment|give|provide|propose|participate|check|execute|handle|analy[sz]e)\b/i);
    if(!match)continue;
    const prefix=sentence.slice(0,match.index).split(',').at(-1).trim().replace(/^@Supervisor\s*/i, '');
    const head=match[0].match(/^\S+(?:\s+of)?(?:\s+the)?\s+(?:\S+\s+)?(?:roles?|reviewers|auditors)\b/i)?.[0]||match[0];
    const action=match[0].slice(head.length).replace(/^[,\s]+/,'').split(',')[0];
    const tail=sentence.slice(match.index+head.length).trim();
    // The collective roles must be the ones being asked to act, not the source material of a request like "summarize / refer to the existing opinions of all roles".
    if(/\?\s*$/.test(sentence)||(prefix&&!/\b(?:please|ask|have|let|get|make|want|need|require|arrange|request|tell|instruct|schedule|assign)(?:\s+(?:you\s+to|you|to|that|for))?$/i.test(prefix)))continue;
    if(/\b(?:don'?t|do not|no need|need not|without|shouldn'?t|should not|cannot|can'?t|must not|not|why|whether|if|how)\b/i.test(prefix+' '+action))continue;
    if(/\b(?:except|other than|apart from|besides|only)\b/i.test(sentence)||/^(?:'s|\u2019s|who|that|which|already|previously|earlier|have|has|had)\b/i.test(action)||/\balready\b|\bpreviously\b/i.test(action))continue;
    if(/^(?:that|who|which|whose)\b/i.test(tail))continue;
    return (match[1]||match[2])?'reviewers':'all';
  }
  return null;
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
    if (!this.db.get('projects', projectId)) throw new Error('Project not found');
    const old = input.id ? this.db.get('roles', input.id) : null;
    if (old?.systemSupervisor) throw new Error('Edit the system supervisor through the supervisor settings');
    if (input.id && old?.projectId !== projectId) throw new Error('The role does not belong to this project');
    if (old?.archivedAt) throw new Error('The role is archived and cannot be modified');
    if (old && input.revision !== undefined && input.revision !== (old.revision || 1)) throw new Error('The role configuration has changed; reopen it and edit again');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!/^[\p{L}\p{N}_-]{1,32}$/u.test(name)) throw new Error('Role names must be 1-32 characters: letters, digits, underscores, or hyphens');
    if (name === 'Supervisor' && old?.name !== name) throw new Error('Supervisor is a fixed system role; use a different name');
    if (this.db.list('roles').some(r => r.projectId === projectId && r.name === name && r.id !== old?.id)) throw new Error('This project already has a role with that name');
    const runtime = typeof input.runtime === 'string' ? input.runtime.trim() : '';
    const unchangedConfigured = Boolean(old && input.enabled === false && isRoleConfigured(old)
      && input.nodeId === old.nodeId && runtime === old.runtime && input.model === old.model);
    const repositoryId = null;
    const configured = unchangedConfigured || Boolean(input.nodeId && runtime && input.model && roleWorkspace(this.db, projectId, input.nodeId, repositoryId));
    if (input.enabled && !configured) throw new Error('Configure the device, CLI, model, and project directory before enabling the role');
    if (configured && !unchangedConfigured) {
      const issue = runtimeIssue(this.db.get('workers', input.nodeId), runtime, input.model);
      if (issue) throw new Error(issue);
    }
    if (typeof input.instructions !== 'string' || input.instructions.length > 12000) throw new Error('Role instructions are limited to 12000 characters');
    if (typeof input.enabled !== 'boolean') throw new Error('enabled must be a boolean');
    const autoApprove = true;
    let effort = null;
    if (input.effort != null && input.effort !== '') {
      effort = String(input.effort).trim();
      if (!effort || effort.length > 32) throw new Error('Invalid reasoning effort');
    }
    const templateKey = old ? old.templateKey : DEFAULT_ROLE_TEMPLATES.find(t => t.key === input.templateKey)?.key;
    return this.db.put('roles', { id: old?.id || randomUUID(), projectId, templateKey, revision: old ? (old.revision || 1) + 1 : 1,
      name, repositoryId, nodeId: configured ? input.nodeId : '', runtime: configured ? runtime : '', model: configured ? input.model : '',
      mode: 'workspace-write', effort, autoApprove, instructions: input.instructions.trim(), configured, enabled: configured && input.enabled, updatedAt: now() });
  }

  /** Archiving only hides a working role and keeps its history; unfinished work must be cancelled or handled first. */
  archiveRole(projectId, roleId) {
    return this.db.transaction(() => {
      const role = this.db.get('roles', roleId);
      if (role?.systemSupervisor) throw new Error('The fixed project supervisor cannot be archived');
      if (role?.projectId !== projectId) throw new Error('The role does not belong to this project');
      if (role.archivedAt) return role;
      const activeRun = this.db.list('runs').some(r => r.projectId === projectId && r.roleId === roleId && !terminal.has(r.status));
      const pendingTask = this.db.list('tasks').some(t => t.projectId === projectId && t.roleId === roleId && ['ready', 'in_progress', 'awaiting_acceptance'].includes(t.status));
      const pendingRequest = this.db.list('coordinationRequests').some(r => r.projectId === projectId && r.targetRoleId === roleId && !['succeeded', 'failed', 'cancelled'].includes(r.status));
      if (activeRun || pendingTask || pendingRequest) throw new Error('The role still has unfinished work; complete or cancel it first');
      return this.db.put('roles', { ...role, enabled: false, archivedAt: now(), updatedAt: now(), revision: (role.revision || 1) + 1 });
    });
  }

  /** The message and the execution records of all recipient roles are committed together; resending does not dispatch again. */
  post(projectId, { clientMessageId, text = '', replyToId = null, attachmentIds = [], targetRoleId = null, scheduledJobId = null }) {
    if (typeof clientMessageId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(clientMessageId)) throw new Error('Invalid message ID');
    if (typeof text !== 'string' || (!text.trim() && !attachmentIds.length) || text.length > 12000) throw new Error('Enter text or add an attachment; text is limited to 12000 characters');
    const attachments = this.attachments ? this.attachments.resolve(projectId, attachmentIds) : [];
    text = text.trim();
    const fingerprint = JSON.stringify({ projectId, text, replyToId, ...(attachmentIds.length ? { attachmentIds } : {}),...(targetRoleId?{targetRoleId}:{}),...(scheduledJobId?{scheduledJobId}:{}) });
    return this.db.transaction(() => {
      const prior = this.db.get('roomMessages', clientMessageId);
      if (prior) { if (prior.fingerprint !== fingerprint) throw new Error('Message ID conflicts with different parameters'); return prior; }
      if (!this.db.get('projects', projectId)) throw new Error('Project not found');
      const quote = replyToId ? this.db.get('roomMessages', replyToId) : null;
      if (replyToId && quote?.projectId !== projectId) throw new Error('The quoted message does not belong to this project');
      const fixedRole=targetRoleId?this.db.get('roles',targetRoleId):null;
      if(targetRoleId && fixedRole?.projectId!==projectId) throw new Error('The specified role does not belong to this project');
      const mentioned = fixedRole ? [fixedRole.name] : mentionNames(text);
      const pingAll = mentioned.some(name => EVERYONE.test(name));
      const names = mentioned.filter(name => !EVERYONE.test(name));
      const project = this.db.get('projects', projectId);
      if (!mentioned.length && project.supervisorRoleId) names.push('Supervisor');
      const broadcast = pingAll;
      if (names.length > 4) throw new Error('A message can @-mention at most 4 roles; leave multi-role requests to the supervisor to decide the execution order');
      let roles = [];
      if (names.length) {
        roles = names.map(name => {
          const role = this.db.list('roles').find(r => r.projectId === projectId && r.name === name);
          if (!role) throw new Error(`Role @${name} does not exist`);
          if (!isRoleConfigured(role)) throw new Error(`Role @${name} has no device, CLI, or model configured`);
          if (!role.enabled) throw new Error(`Role @${name} is disabled`);
          if (!roleWorkspace(this.db, projectId, role.nodeId, role.repositoryId)) throw new Error(`Role @${name} has no repository directory bound`);
          return role;
        });
      }
      const scope=!broadcast&&!fixedRole&&roles.length===1&&roles[0].systemSupervisor?collectiveRoleScope(text):null;
      const participants=scope?this.db.list('roles').filter(r=>r.projectId===projectId&&!r.archivedAt&&r.enabled&&!r.systemSupervisor&&(scope==='all'||r.templateKey==='reviewer'||/review|audit/i.test(r.name))):roles.length>1?roles.filter(r=>!r.systemSupervisor):[];
      if(scope&&!participants.length)throw new Error('No enabled role in this project matches; specify the participating roles explicitly');
      if(scope&&participants.length>12)throw new Error(`This round matches ${participants.length} roles, exceeding the limit of 12 executions per schedule; name them in explicit batches. This message has not been dispatched`);
      const schedulingTargets=participants.map(r=>r.id);
      const schedulingRoster=participants.map(r=>({id:r.id,name:r.name}));
      if (roles.length > 1) {
        const supervisor = this.db.get('roles', project.supervisorRoleId);
        if (!supervisor?.enabled || !isRoleConfigured(supervisor)) throw new Error('Configure the supervisor in project settings before multiple roles can collaborate');
        roles = [supervisor];
      }
      if (roles.length && this.db.get('settings', 'main')?.paused) throw new Error('Remote execution is paused; @-mentions cannot dispatch right now');
      const source = quote?.runId ? this.db.get('runs', quote.runId) : null;
      // The supervisor's quote is conversation context and does not require handing the code repository over to the supervisor's configured directory.
      const reuseSource = source && roles.length && !source.roleSnapshot?.systemSupervisor && roles.every(r => !r.systemSupervisor);
      let sourceDelivery;
      if (reuseSource) {
        if (source.projectId !== projectId || source.status !== 'succeeded' || !source.workspace) throw new Error('Only runs that completed successfully and kept their workspace can be quoted');
        if (roles.some(r => r.nodeId !== source.nodeId)) {
          const ready = this.db.list('deliveries').filter(d => d.projectId === projectId && d.sourceRunId === source.id && d.status === 'ready');
          if (ready.length !== 1) throw new Error('A cross-device quote needs exactly one pushed Git delivery; complete the delivery first or specify the version explicitly');
          sourceDelivery = ready[0];
        }
      }
      const taskIds = roles.map(role => {
        // The original dispatch text is kept verbatim; quotes and recent conversation are attached separately by source in this turn's context pack.
        const prompt = text || 'Please review the attachments in this message.';
        const task = this.db.createTask({ projectId, title: text.slice(0, 80) || 'Review attachments', prompt, model: role.model, mode: role.mode });
        this.db.put('tasks', { ...task, origin: 'chat', sourceMessageId: clientMessageId, roleId: role.id, roleSnapshot: role,
          sourceRunId: sourceDelivery || !reuseSource ? null : source.id, deliveryId: sourceDelivery?.id || null,
          quoteMessageId:quote?.id||null,
          attachments: attachments.length ? attachments : (quote?.attachments?.length ? quote.attachments : source?.attachments || []), schedulingTargets,schedulingRoster,reportRequired:true,scheduledJobId,
          requiresCoordination: Boolean(sourceDelivery), broadcast: broadcast || undefined });
        return task.id;
      });
      const message = this.db.put('roomMessages', { id: clientMessageId, projectId, sender: 'human', senderName: 'Me', text, attachments, replyToId, taskIds, broadcast: broadcast || undefined, createdAt: now(), fingerprint });
      if(!project.systemConfig)new ConversationContext(this.db).enqueue(projectId);
      this.touch(projectId);
      return message;
    });
  }

  /** Paginate recent messages; the cursor must belong to the same project so that switching projects cannot leak history. */
  messages(projectId, before) {
    if (!this.db.get('projects', projectId)) throw new Error('Project not found');
    const all = this.db.list('roomMessages').filter(m => m.projectId === projectId);
    const end = before ? all.findIndex(m => m.id === before) : all.length;
    if (end < 0) throw new Error('History cursor not found');
    const start = Math.max(0, end - 60), messages = all.slice(start, end);
    return { messages, hasMore: start > 0, nextBefore: messages[0]?.id || null };
  }

  cancel(taskId) {
    const task = this.db.get('tasks', taskId);
    if (task?.origin !== 'chat' || task.currentRunId || !['ready', 'cancelled'].includes(task.status)) throw new Error('Only group-chat assignments that have not started can be cancelled');
    return this.db.put('tasks', { ...task, status: 'cancelled', waitingReason: null });
  }

  /** Dispatch synchronously within a single Home, with one active run per role, respecting each node's total capacity. */
  schedule(isReady) {
    const nodes = new Set(); let changed = false;
    const discussions=new RoleDiscussions(this.db,{online:isReady});changed=discussions.recover().changed;
    const candidates=[...this.db.list('tasks').filter(t=>t.origin==='chat'&&t.status==='ready'),...discussions.candidates()];
    for (const task of orderRoleQueue(candidates,id=>this.db.get('roleQueueTurns',id)?.priorityUsed,id=>this.db.get('discussionQueueTurns',id)?.priorityUsed)) {
      const discussion=Boolean(task.discussionDeliveryId||task.discussionIntentId);
      const kind=task.discussionDeliveryId?'discussionDeliveries':'discussionIntents',recordId=task.discussionDeliveryId||task.discussionIntentId;
      const role = task.roleSnapshot, worker = this.db.get('workers', role.nodeId);
      const active = this.db.list('runs').filter(r => !terminal.has(r.status));
      const reason = this.db.get('settings', 'main')?.paused ? 'Remote execution is paused'
        : steeringWaitReason(this.db,task) ? steeringWaitReason(this.db,task)
        : !task.contextPrepared ? 'Organizing the conversation'
        : projectTerminalLock(this.db,task.projectId,role.nodeId) ? 'This project is under manual terminal takeover; return it to the platform first'
        : !this.db.get('roles', role.id)?.enabled ? 'The role is disabled'
        : !isReady(role.nodeId) ? 'Waiting for the node to come online'
        : !worker?.capabilities?.roomRoles ? 'Upgrade the Worker to support roles'
        : worker.capabilities.projectSpace !== 1 ? 'Upgrade the Worker to support the shared project workspace'
        : worker.capabilities.managedResume !== 1 ? 'Upgrade the Worker to support role session resume'
        : task.attachments?.length && worker.capabilities.attachments !== 1 ? 'Upgrade the Worker to receive attachments'
        : task.reportRequired && worker.capabilities.collaborationTools !== 2 ? 'Upgrade the Worker for the report and full-text tools'
        : task.execution && worker.capabilities.executionScheduling !== 1 ? 'Upgrade the Worker to run supervisor schedules'
        : task.requiresCoordination && worker?.capabilities?.coordinationVersion !== 1 ? 'Upgrade the Worker to support cross-device role collaboration'
        : runtimeIssue(worker, role.runtime, role.model) ? runtimeIssue(worker, role.runtime, role.model)
        : active.some(r => r.roleId === role.id) ? 'Waiting for the role to finish its current run'
        : executionConflict({...task,nodeId:role.nodeId},active) ? (task.execution?.exclusive ? 'Waiting for the exclusive operation window of this project' : 'Waiting for the project workspace or exclusive operation to be released')
        : active.some(r => r.nodeId === role.nodeId && r.status === 'reconciling') ? 'The node has runs awaiting reconciliation'
        : active.filter(r => r.nodeId === role.nodeId).length+(worker.capabilities.summaryBatches===1?0:worker.organizerBusy||0) >= (worker.capacity || 1) ? 'Waiting for the node to become idle' : null;
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
              this.db.put('coordinationRequests',{...request,status:'failed',outcome:'blocked',result:`Not started: ${error.message}`,updatedAt:now()});
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
    if (!body || body.length > 8000) throw new Error('A note must be 1-8000 characters');
    if (!run?.projectId || !run.roleSnapshot?.name) throw new Error('The current run is invalid');
    const message = this.db.put('roomMessages', {
      id: randomUUID(), projectId: run.projectId, sender: 'agent', senderName: run.roleSnapshot.name,
      roleId: run.roleId, text: body, replyToId: run.sourceMessageId || null, runId: run.id, taskIds: [], createdAt: now()
    });
    this.touch(run.projectId);
    return message;
  }

  /** Post only a run's final state back to the group; text streams and tool logs stay in the run details. */
  complete(run) {
    if (!run?.roleId || !terminal.has(run.status)||run.discussionDeliveryId) return;
    const id = `result-${run.id}`;
    if (this.db.get('roomMessages', id)) return;
    this.db.transaction(() => {
      const report = this.db.get('runReports', run.id);
      const question = report?.verdict === 'needs_input' ? `Your confirmation is needed: ${report.summary}\n\nReply by quoting this message, or reply with the matching WeChat number.` : '';
      const text = run.status === 'succeeded' ? (run.result || question || 'The run has ended; the runtime returned no text result.')
        : `${run.status === 'interrupted' ? 'Run stopped' : 'Run failed'}: ${run.error || 'See the run details'}${run.result ? `\n\nExisting output:\n${run.result}` : ''}`;
      const handoff=this.db.get('roomMessages',`call:${run.requestId}`);
      this.db.put('roomMessages', { id, projectId: run.projectId, sender: 'agent', senderName: run.roleSnapshot.name,
        roleId: run.roleId, text, replyToId: handoff?.projectId===run.projectId?handoff.id:run.sourceMessageId,
        runId: run.id, taskIds: [], createdAt: now() });
      this.touch(run.projectId);
    });
  }
}
import { projectTerminalLock } from './terminal-resume.mjs';
