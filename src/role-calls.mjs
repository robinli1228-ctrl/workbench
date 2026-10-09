import { isRoleConfigured } from './default-roles.mjs';
import {RoleDiscussions} from './role-discussions.mjs';
import { terminal } from './store.mjs';
import { roleWorkspace } from './project-repositories.mjs';
import {outcomeFor,runFailureKind} from './run-reports.mjs';
import { tr } from './i18n.mjs';
import {createHash} from 'node:crypto';
import {currentContinuation,waitDependencies} from './coordination-wait.mjs';

export const callTerminal = new Set(['succeeded', 'failed', 'cancelled']);

function clippedResult(text, limit) {
  text = String(text || tr('roleCalls.noTextResultWasProvided'));
  if (text.length <= limit) return text;
  const marker = tr('roleCalls.truncatedInMiddle');
  if (limit <= marker.length + 2) return text.slice(0, limit);
  const available = limit - marker.length;
  const head = Math.ceil(available * 0.65);
  return `${text.slice(0, head)}${marker}${text.slice(-(available - head))}`;
}

/** Split the continuation budget fairly across the roles' results so that a few long answers cannot swallow the later roles. */
export function packCoordinationResults(children, limit) {
  if (!Array.isArray(children) || !children.length || limit <= 0) return '';
  const prefixes = children.map(child => tr('roleCalls.outcomeFullTextWbResult', { p1: child.targetSnapshot?.name || tr('roleCalls.unknownRole'), p2: child.notExecutedReason?tr('roleCalls.runNotExecuted'):child.runStatus?tr('roleCalls.run', { runStatus: child.runStatus }):tr('roleCalls.call', { status: child.status }), p3: child.outcome||tr('roleCalls.unverified'), id: child.id }));
  const overhead = prefixes.reduce((sum, prefix) => sum + prefix.length, 0) + children.length - 1;
  const contentBudget = Math.max(0, limit - overhead);
  const base = Math.floor(contentBudget / children.length);
  let remainder = contentBudget % children.length;
  return children.map((child, index) => {
    const share = base + (remainder-- > 0 ? 1 : 0);
    const failureLabel={temporary_service:tr('roleCalls.temporaryServiceError'),incomplete_output:tr('roleCalls.incompleteResult'),authorization:tr('roleCalls.permissionLoginProblem'),unknown:tr('roleCalls.errorBeChecked')}[child.failureKind]||tr('roleCalls.executionError');
    const text=child.error?tr('roleCalls.partialOutputNotDelivery', { failureLabel, error: child.error, p3: child.result||'' }):child.reportSummary||child.result;
    return `${prefixes[index]}${clippedResult(text, share)}`;
  }).join('\n').slice(0, limit);
}

/** Stable call identity and role snapshot; kept separate from Git delivery identity, and a consultation does not depend on the source run succeeding. */
export class RoleCalls {
  constructor(db) { this.db = db; }

  create(input) {
    if (typeof input.id !== 'string' || !/^[a-zA-Z0-9:_-]{1,200}$/.test(input.id)) throw new Error(tr('roleCalls.invalidCallId'));
    if (!['direct', 'consult', 'handoff', 'continuation'].includes(input.kind)) throw new Error(tr('roleCalls.invalidCallType'));
    if (typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 12000) throw new Error(tr('roleCalls.callSummaryMustBe1'));
    const normalized = { id: input.id, projectId: input.projectId, targetRoleId: input.targetRoleId,
      kind: input.kind, summary: input.summary.trim(), sourceMessageId: input.sourceMessageId || null,
      originNodeId: input.originNodeId || null, parentRequestId: input.parentRequestId || null,
      continuationOf: input.continuationOf || null, deliveryId: input.deliveryId || null,
      ...(input.waitRequestIds?{waitRequestIds:[...input.waitRequestIds]}:{}),...(input.wakeReason?{wakeReason:input.wakeReason}:{}),
      planId: input.planId || null, planVersion: input.planVersion || null, stepId: input.stepId || null };
    const fingerprint = JSON.stringify(normalized);
    return this.db.transaction(() => {
      if (!this.db.get('projects', input.projectId)) throw new Error(tr('roleCalls.projectNotFound'));
      const prior = this.db.get('coordinationRequests', input.id);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error(tr('roleCalls.callIdConflictsWithDifferent'));
        return prior;
      }
      const role = this.db.get('roles', input.targetRoleId);
      if (role?.projectId !== input.projectId) throw new Error(tr('roleCalls.targetRoleDoesNotBelong'));
      if (role.archivedAt || !role.enabled || !isRoleConfigured(role)) throw new Error(tr('roleCalls.targetRoleNotConfiguredDisabled'));
      if (!roleWorkspace(this.db, input.projectId, role.nodeId, role.repositoryId)) throw new Error(tr('roleCalls.targetRoleHasNoRepository'));
      for (const id of [normalized.parentRequestId, normalized.continuationOf].filter(Boolean)) {
        if (this.db.get('coordinationRequests', id)?.projectId !== input.projectId) throw new Error(tr('roleCalls.sourceCallDoesNotBelong'));
      }
      let ancestor = normalized.parentRequestId ? this.db.get('coordinationRequests', normalized.parentRequestId) : null;
      if (ancestor && (callTerminal.has(ancestor.status) || ancestor.steeringTaskId)) throw new Error(tr('roleCalls.sourceCallHasEndedBeen'));
      if(input.kind==='consult' && (ancestor?.consultRound||0)>=3)throw new Error(tr('roleCalls.discussionHasAlreadyUsedThree'));
      let depth = 0, rootRequestId = ancestor?.rootRequestId || ancestor?.id || normalized.id;
      while (ancestor) {
        if(ancestor.steeringTaskId)throw new Error(tr('roleCalls.userHasChangedDirectionOld'));
        if (++depth > 4) throw new Error(tr('roleCalls.collaborationCallsExceed4Levels'));
        if (ancestor.targetRoleId === input.targetRoleId && !callTerminal.has(ancestor.status)) throw new Error(tr('roleCalls.rejectedRoleLoopInActive'));
        ancestor = ancestor.parentRequestId ? this.db.get('coordinationRequests', ancestor.parentRequestId) : null;
      }
      const continued = normalized.continuationOf ? this.db.get('coordinationRequests', normalized.continuationOf) : null;
      if (continued) rootRequestId = continued.rootRequestId || continued.id;
      if (input.kind!=='continuation'&&this.db.list('coordinationRequests').filter(r => r.rootRequestId === rootRequestId&&r.kind!=='continuation').length >= 20) throw new Error(tr('roleCalls.collaborationChainHasReached20'));
      if (normalized.sourceMessageId && this.db.get('roomMessages', normalized.sourceMessageId)?.projectId !== input.projectId) throw new Error(tr('roleCalls.sourceMessageDoesNotBelong'));
      if (normalized.deliveryId && this.db.get('deliveries', normalized.deliveryId)?.projectId !== input.projectId) throw new Error(tr('roleCalls.deliveryDoesNotBelongProject'));
      if (this.db.get('settings', 'main')?.paused) throw new Error(tr('roleCalls.remoteExecutionPaused'));
      const now = new Date().toISOString();
      return this.db.put('coordinationRequests', { ...normalized, fingerprint,
        consultRound:continued ? (continued.consultRound||0)+(input.wakeReason==='timeout'?0:1) : 0,
        scheduledJobId:input.scheduledJobId||continued?.scheduledJobId||this.db.get('coordinationRequests',normalized.parentRequestId||'')?.scheduledJobId||null,
        attachments: input.attachments || continued?.attachments || [], execution:input.execution || continued?.execution || null,
        rootRequestId, targetSnapshot: continued?.targetSnapshot || { ...role, revision: role.revision || 1 },
        status: input.kind === 'handoff' ? 'waiting_delivery' : 'queued', currentRunId: null,
        createdAt: now, updatedAt: now });
    });
  }

  /** Backfill a stable call identity for an existing group-chat task without replacing the original role snapshot or restarting the task. */
  adoptTask(taskId) {
    const task = this.db.get('tasks', taskId);
    if (!task || task.origin !== 'chat' || task.switchOperationId) return null;
    if (task.requestId) return this.db.get('coordinationRequests', task.requestId);
    const id = `task:${task.id}`, now = new Date().toISOString();
    return this.db.transaction(() => {
      const existing = this.db.get('coordinationRequests', id);
      const record = existing || this.db.put('coordinationRequests', { id, projectId: task.projectId,
        rootRequestId: id, targetRoleId: task.roleId, targetSnapshot: task.roleSnapshot,executionBinding:task.executionBinding||null,
        kind: task.deliveryId ? 'handoff' : 'direct', deliveryId: task.deliveryId || null, sourceMessageId: task.sourceMessageId, summary: task.prompt,
        attachments:task.attachments||[],scheduledJobId:task.scheduledJobId||null,
        taskId, currentRunId: task.currentRunId || null,
        status: task.currentRunId ? 'running' : task.status === 'cancelled' ? 'cancelled' : 'queued', createdAt: now, updatedAt: now });
      this.db.put('tasks', { ...task, requestId: id });
      return record;
    });
  }

  /** Materialize a Task the legacy scheduler can consume only once the conditions are met. A consultation carries no sourceRunId. */
  reconcile(requestId) {
    return this.db.transaction(() => {
      const r = this.db.get('coordinationRequests', requestId);
      if (!r || callTerminal.has(r.status) || this.db.get('settings', 'main')?.paused) return r;
      if (r.taskId || !['queued', 'waiting_delivery'].includes(r.status)) return r;
      const delivery = r.deliveryId ? this.db.get('deliveries', r.deliveryId) : null;
      if (r.kind === 'handoff' && delivery?.status !== 'ready') return r;
      const role = r.targetSnapshot;
      const previous = r.continuationOf ? this.db.get('coordinationRequests', r.continuationOf) : null;
      const task = this.db.createTask({ projectId: r.projectId, title: r.summary.slice(0, 80), prompt: r.summary,
        model: role.model, mode: role.mode });
      this.db.put('tasks', { ...task, origin: 'chat', sourceMessageId: r.sourceMessageId,
        requestId: r.id, roleId: role.id, roleSnapshot: role, executionBinding:r.executionBinding||null, deliveryId: r.deliveryId,
        continuationRunId: previous?.currentRunId || null,
        requiresCoordination: r.kind !== 'direct', contextPrepared:['consult','continuation'].includes(r.kind), planId: r.planId, planVersion: r.planVersion, stepId: r.stepId,
        execution:r.execution || null,attachments:r.attachments || [],reportRequired:true,scheduledJobId:r.scheduledJobId||null });
      return this.db.put('coordinationRequests', { ...r, status: 'queued', taskId: task.id, updatedAt: new Date().toISOString() });
    });
  }

  forRun(run) {
    return run.requestId ? this.db.get('coordinationRequests', run.requestId) : this.adoptTask(run.taskId);
  }

  /** Waiting is only a business state; the execution slot cannot be released until the Worker confirms the turn is complete. */
  wait(run, summary, options={}) {
    return this.db.transaction(()=>{
    const r = this.forRun(run);
    const current=this.db.get('runs',run.id);
    if (!r || !current||terminal.has(current.status)||current.stopRequested||current.roleId!==r.targetRoleId||r.currentRunId&&r.currentRunId!==run.id||callTerminal.has(r.status)||r.continuationRequestId) throw new Error(tr('roleCalls.currentRunCannotWaitFor'));
    const children=this.dependencies(r),available=new Set(children.map(c=>c.id)),requestIds=options.requestIds??children.map(c=>c.id);
    if (!Array.isArray(requestIds)||!requestIds.length||requestIds.some(id=>!available.has(id))) throw new Error(tr('roleCalls.currentRunHasNoChild'));
    if (typeof summary !== 'string' || !summary.trim() || summary.length > 8000) throw new Error(tr('roleCalls.provideResumeSummary18000'));
    const timeoutSeconds=options.timeoutSeconds??1800;
    if(!Number.isSafeInteger(timeoutSeconds)||timeoutSeconds<60||timeoutSeconds>86400)throw new Error(tr('minimal.invalidWait'));
    // A lost tool response/retry cannot extend the same wait deadline or replace its dependency set.
    if(r.status==='waiting_call') {
      if(JSON.stringify([...new Set(requestIds)].sort())!==JSON.stringify([...(r.waitRequestIds||requestIds)].sort()))throw new Error(tr('minimal.invalidWait'));
      return r;
    }
    return this.db.put('coordinationRequests', { ...r, currentRunId: run.id, status: 'waiting_call', resumeSummary: summary.trim(),
      waitRequestIds:[...new Set(requestIds)],waitDeadlineAt:new Date(Date.now()+timeoutSeconds*1000).toISOString(),updatedAt:new Date().toISOString() });
    });
  }

  /** Shared by call and discussion recovery so inherited dependencies cannot be bypassed. */
  dependencies(request) {return waitDependencies(this.db,request);}

  /** Persisted deadlines survive Home restart; expired waits never stop or replay the receiving CLI. */
  expireWaits(time=Date.now()) {
    let changed=false;
    for(const request of this.db.list('coordinationRequests').filter(r=>r.status==='waiting_call'&&r.waitDeadlineAt)) {
      const before=JSON.stringify(this.db.get('coordinationRequests',request.id));this.resume(request.id,time);
      changed=before!==JSON.stringify(this.db.get('coordinationRequests',request.id))||changed;
    }
    return changed;
  }

  /** A call completes only on the Worker's turn-final state; after the child results return, the original session is resumed with exactly one new run. */
  finish(runId) {
    const run = this.db.get('runs', runId);
    if (!run || !terminal.has(run.status)||run.discussionDeliveryId||run.discussionWaiting||run.switchOperationId) return;
    let r = run.requestId ? this.db.get('coordinationRequests', run.requestId)
      : this.db.list('coordinationRequests').find(c => c.currentRunId === runId);
    if (!r || (r.currentRunId && r.currentRunId !== runId) || r.status === 'cancelled') return;
    if (!callTerminal.has(r.status) && (r.status !== 'waiting_call' || run.status !== 'succeeded')) {
      const outcome=outcomeFor(this.db,run), report=this.db.get('runReports',run.id);
      r = this.db.put('coordinationRequests', { ...r, outcome,runStatus:run.status,failureKind:runFailureKind(run),reportSummary:report?.summary||null,error:run.status==='succeeded'?null:run.error||null,
        status: run.status === 'succeeded' && !['failed','blocked','needs_input'].includes(outcome) ? 'succeeded' : 'failed',
        result: run.result || run.error || '', updatedAt: new Date().toISOString() });
    }
    this.resume(r.id);
    if (r.parentRequestId) this.resume(r.parentRequestId);
    if (r.continuationOf && callTerminal.has(r.status)) {
      let previousId = r.continuationOf;
      const seen=new Set();
      for (; previousId&&!seen.has(previousId);) {
        seen.add(previousId);
        const prior = this.db.get('coordinationRequests', previousId);
        if (!prior || callTerminal.has(prior.status)) break;
        this.db.put('coordinationRequests', { ...prior, status: r.status, result: r.result, outcome:r.outcome,runStatus:r.runStatus,failureKind:r.failureKind||null,reportSummary:r.reportSummary,error:r.error||null,updatedAt: r.updatedAt });
        if (prior.parentRequestId) this.resume(prior.parentRequestId);
        previousId = prior.continuationOf;
      }
    }
  }

  /** Replay synchronous wrap-up after a Home restart; existing decisions are unchanged and only the parent-chain propagation unfinished before the crash is completed. */
  recoverTerminalRuns() {
    return this.db.transaction(() => {
      for (const run of this.db.list('runs').filter(item => terminal.has(item.status))) this.finish(run.id);
    });
  }

  resume(requestId,time=Date.now()) {
    return this.db.transaction(()=>{
    const parent = currentContinuation(this.db,requestId);
    if (parent?.status !== 'waiting_call' || parent.continuationRequestId || parent.steeringTaskId || this.db.get('tasks',parent.taskId)?.status==='cancelled') return;
    if(this.db.get('tasks',parent.taskId)?.discussionWait||this.db.list('discussionIntents').some(i=>i.taskId===parent.taskId&&['queued','blocked'].includes(i.status)))return;
    if (this.db.list('executionPlans').some(p=>p.parentRequestId===parent.id && ['running','cancelled'].includes(p.status))) return;
    if (this.db.get('runs', parent.currentRunId)?.status !== 'succeeded') return;
    const children = this.dependencies(parent);
    if (!children.length) return;
    const ready=children.every(r=>callTerminal.has(r.status)),expired=parent.waitDeadlineAt&&Date.parse(parent.waitDeadlineAt)<=time;
    if(!ready&&!expired)return;
    const reason=ready?'results':'timeout';
    if(!parent.waitEvent)this.db.put('coordinationRequests',{...parent,waitEvent:{id:`wait:${parent.id}`,reason,observedAt:new Date(time).toISOString(),requestIds:children.map(r=>r.id)}});
    if (this.db.get('settings', 'main')?.paused) return;
    try {
      const header = reason==='timeout'?tr('minimal.waitTimeout',{resumeSummary:parent.resumeSummary,requestIds:children.map(r=>r.id).join(', ')}):tr('roleCalls.assistanceResultsContextOnly', { resumeSummary: parent.resumeSummary });
      const next = this.create({ id: `resume:${createHash('sha256').update(parent.id).digest('hex')}`, projectId: parent.projectId, targetRoleId: parent.targetRoleId,
        kind: 'continuation', continuationOf: parent.id, sourceMessageId: parent.sourceMessageId,
        parentRequestId: parent.parentRequestId, deliveryId: parent.deliveryId,attachments:parent.attachments||[],
        planId:parent.planId,planVersion:parent.planVersion,stepId:parent.stepId,execution:parent.execution,
        wakeReason:reason,waitRequestIds:reason==='timeout'?children.filter(c=>!callTerminal.has(c.status)).map(c=>c.id):[],
        summary: `${header}${packCoordinationResults(children, Math.max(0, 12000 - header.length))}`.slice(0, 12000) });
      this.db.put('coordinationRequests', { ...this.db.get('coordinationRequests',parent.id), continuationRequestId: next.id, updatedAt: new Date().toISOString() });
    } catch (error) { this.db.put('coordinationRequests', { ...this.db.get('coordinationRequests',parent.id), waitingReason: error.message }); }
    });
  }

  /** The stop scope and the command are fixed in the same transaction; an HTTP retransmission can only resend the original scope and cannot rescan for new runs. */
  stopRun(runId,commandId) {
    return this.db.transaction(()=>{
      const run=this.db.get('runs',runId),prior=this.db.get('commands',commandId);
      if(!run||typeof commandId!=='string'||!commandId)throw new Error(tr('roleCalls.runDoesNotExistCommand'));
      if(prior) {
        if(prior.type!=='stop'||prior.runId!==runId)throw new Error(tr('roleCalls.commandidConflictsWithDifferentParameters'));
        return {run,stopRunIds:prior.stopRunIds||[runId]};
      }
      this.db.requestStop(runId,commandId);
      const discussions=new RoleDiscussions(this.db),scope=discussions.stopRun(run);
      const ids=new Set([runId,...scope.stopRunIds]);
      const task=this.db.get('tasks',run.businessTaskId||run.taskId);
      const ownsCurrent=run.discussionDeliveryId||run.discussionWaiting?scope.current:task?.currentRunId===runId;
      if(run.turnPurpose!=='clarification'&&ownsCurrent) {
        const request=this.forRun(run);
        if(request)for(const id of this.cancel(request.id))ids.add(id);
      }
      for(const id of ids)if(id!==runId)this.db.requestStop(id,`${commandId}:${id}`);
      this.db.put('commands',{...(this.db.get('commands',commandId)||{id:commandId,type:'stop',runId,nodeId:run.nodeId,acked:true,createdAt:new Date().toISOString()}),stopRunIds:[...ids]});
      return {run:this.db.get('runs',runId),stopRunIds:[...ids]};
    });
  }

  /** Cancelling the chain first blocks new dispatches, then returns the truly active runs so Home can send stop commands. */
  cancel(requestId) {
    return this.db.transaction(()=>{
    let root = this.db.get('coordinationRequests', requestId);
    if (!root) throw new Error(tr('roleCalls.callNotFound'));
    const seen=new Set();
    while(root.continuationOf&&!seen.has(root.id)) {
      seen.add(root.id);const previous=this.db.get('coordinationRequests',root.continuationOf);
      if(!previous||previous.projectId!==root.projectId||previous.targetRoleId!==root.targetRoleId)throw new Error('Invalid continuation cancellation scope.');root=previous;
    }
    const ids = new Set([root.id]);
    const all = this.db.list('coordinationRequests').filter(r => r.projectId === root.projectId);
    for (let i = 0; i < all.length; i++) for (const r of all) if (ids.has(r.parentRequestId) || ids.has(r.continuationOf)) ids.add(r.id);
    const runs = [];
    this.db.transaction(() => {
      for (const r of all.filter(r => ids.has(r.id))) {
        const task = r.taskId ? this.db.get('tasks', r.taskId) : null;
        // A retransmission only repairs the idle wait left by the original turn; it must not cancel a new run that this Task resumed later.
        const staleWait=r.status==='cancelled'&&task?.status==='waiting_discussion'&&task.currentRunId===r.currentRunId
          &&terminal.has(this.db.get('runs',task.currentRunId)?.status)
          &&!this.db.list('runs').some(run=>(run.taskId===task.id||run.businessTaskId===task.id)&&!terminal.has(run.status));
        if(!callTerminal.has(r.status)||staleWait) {
          const stopRunIds=task?new RoleDiscussions(this.db).invalidateTask(task.id,{reason:tr('roleCalls.businessCallCancelled')}).stopRunIds:[];
          runs.push(...stopRunIds);
          // Fix the original stop targets in the same transaction as the cancelled state; a crash before Home sends the command can still be retransmitted without scanning later runs.
          this.db.put('coordinationRequests', { ...r, status: 'cancelled', cancelRunIds:[...new Set([...(r.cancelRunIds||[]),...stopRunIds])], updatedAt: new Date().toISOString() });
          // While waiting for a reply the finished business run ID is retained; no further terminal event will clean up the Task for it.
          // Read the record after invalidation handling to avoid writing back the old discussionWait; active/unknown runs still wait for stop verification.
          const current=task?.currentRunId?this.db.get('runs',task.currentRunId):null;
          if (task && (!task.currentRunId||terminal.has(current?.status))) this.db.put('tasks', { ...this.db.get('tasks',task.id), status: 'cancelled', waitingReason:null });
        }
        for(const id of r.cancelRunIds||[]) {
          const pending=this.db.get('runs',id);
          if(pending&&!terminal.has(pending.status))runs.push(id);
        }
        // Cancelling a call does not mean the process has exited; a repeated cancel must still wait for stop confirmation from the active child runs.
        const run = r.currentRunId ? this.db.get('runs', r.currentRunId) : null;
        if (run && !terminal.has(run.status)) runs.push(run.id);
      }
    });
    return [...new Set(runs)];
    });
  }
}
