import { randomUUID } from 'node:crypto';
import { tr } from './i18n.mjs';
import { collaborationSessionsEnabled, sessionOf, reviewView } from './collaboration-sessions.mjs';
import {conversationIdOf,assertConversationRecord} from './group-conversations.mjs';

/**
 * Home-side external queue (design V3 sections 4-6). Messages wait here; a CLI only receives a sealed batch
 * after its Worker reported a true idle state and a still-valid reservation. Nothing here writes to a CLI.
 */
export const QUEUE_CAPABILITY = 'sessionQueue';
export const QUEUE_PROTOCOL = 2;
export const DEFAULT_QUEUE_CONFIG = Object.freeze({ quietSeconds: 10, maxSeconds: 30, leaseSeconds: 30, maxBatchMessages: 50, verifyAlertSeconds: 600, budgetBatches: null, backlogMessages: 50, backlogWaitSeconds: 600 });
const CYCLE = 'sessionCycles', ALERT = 'sessionQueueAlerts', RECEIPT = 'sessionReceipts', COLLECTOR = 'sessionCollectors', BATCH = 'sessionBatches', ROTATION = 'sessionRotations';
const iso = ms => new Date(ms).toISOString();
const ms = value => Date.parse(value);
const workerBinding = (db, roleId) => {const r=db.get('roles',roleId);return JSON.stringify({nodeId:r?.nodeId,runtime:r?.runtime,model:r?.model,revision:r?.revision,runtimes:db.get('workers',r?.nodeId||'')?.runtimes});};
const receiptRequests=(db,receipt)=>(receipt.requestIds||[receipt.requestId]).map(id=>db.get('coordinationRequests',id||'')).filter(r=>r?.projectId===receipt.projectId&&r.targetRoleId===receipt.roleId);

/** Project-level merge parameters; an invalid combination is rejected and the stored value stays unchanged. */
export function queueConfig(db, projectId) {
  const project=db.get('projects',projectId);
  return { ...DEFAULT_QUEUE_CONFIG,budgetBatches:project?.testProject===true?20:null,version: 0, ...(project?.sessionQueue || {}),enabled:project?.features?.collaborationSessions===true };
}
export function setQueueConfig(db, projectId, input = {}) {
  return db.transaction(() => {
    const project = db.get('projects', projectId);
    if (!project) throw new Error(tr('collabSessions.projectNotFound'));
    const current = queueConfig(db, projectId);
    if(input.version!==undefined&&input.version!==current.version)throw new Error(tr('sessionQueue.configChanged'));
    if(input.enabled!==undefined&&typeof input.enabled!=='boolean')throw new Error(tr('collabSessions.enabledMustBeBoolean'));
    const next = { quietSeconds: input.quietSeconds ?? current.quietSeconds, maxSeconds: input.maxSeconds ?? current.maxSeconds };
    const verifyAlertSeconds = input.verifyAlertSeconds ?? current.verifyAlertSeconds;
    if (!Number.isSafeInteger(verifyAlertSeconds) || verifyAlertSeconds < 60 || verifyAlertSeconds > 86400) throw new Error(tr('sessionQueue.verifyAlertRange'));
    next.verifyAlertSeconds = verifyAlertSeconds;
    const budgetBatches = Object.hasOwn(input,'budgetBatches')?input.budgetBatches:current.budgetBatches;
    if (budgetBatches!==null && (!Number.isSafeInteger(budgetBatches) || budgetBatches < 1 || budgetBatches > 1000)) throw new Error(tr('sessionQueue.budgetRange'));
    next.budgetBatches = budgetBatches;
    const backlogMessages = input.backlogMessages ?? current.backlogMessages, backlogWaitSeconds = input.backlogWaitSeconds ?? current.backlogWaitSeconds;
    if (!Number.isSafeInteger(backlogMessages) || backlogMessages < 1 || backlogMessages > 10000 || !Number.isSafeInteger(backlogWaitSeconds) || backlogWaitSeconds < 60 || backlogWaitSeconds > 86400) throw new Error(tr('sessionQueue.backlogRange'));
    Object.assign(next, { backlogMessages, backlogWaitSeconds });
    for (const value of [next.quietSeconds, next.maxSeconds]) if (!Number.isSafeInteger(value) || value < 0 || value > 3600) throw new Error(tr('sessionQueue.secondsMustBeInteger'));
    if (next.maxSeconds < next.quietSeconds) throw new Error(tr('sessionQueue.maxBelowQuiet'));
    const sessionQueue = { ...(project.sessionQueue || {}), ...next, version: current.version + 1 };
    db.put('projects', { ...project, sessionQueue,...(input.enabled!==undefined?{features:{...(project.features||{}),collaborationSessions:input.enabled}}:{}) });
    return queueConfig(db, projectId);
  });
}

/** Called for every new room message: tags its collaboration session from existing links (flag on only). */
export function tagMessage(db, message) {
  if (!message?.projectId || message.collaborationSessionId || !collaborationSessionsEnabled(db, message.projectId)) return message;
  const sessionId = sessionOf(db, 'roomMessages', message);
  return sessionId ? { ...message, collaborationSessionId: sessionId } : message;
}

export class SessionQueue {
  constructor(db, { now = () => Date.now() } = {}) { this.db = db; this.now = now; }

  /**
   * Register per-role receipts for a complete message. Broadcast is off unless the session explicitly sets
   * broadcast:true (phase 4 adds budgets before anything turns it on). Explicit requests still need the target.
   */
  register(message, { explicitRequestRoleIds = [] } = {}) {
    return this.db.transaction(() => {
      if (!message?.collaborationSessionId || !collaborationSessionsEnabled(this.db, message.projectId)) return [];
      const session = this.db.get('collaborationSessions', message.collaborationSessionId);
      if (!session || session.state !== 'open') return [];
      assertConversationRecord(session,message);
      if (message.partial || message.visibility === 'internal' || !['human', 'agent'].includes(message.sender)) return [];
      if(['user_question','technical_notice'].includes(message.kind))return [];
      const requests=[...new Set([message.requestId,...(message.requestIds||[])].filter(Boolean))].map(id=>this.db.get('coordinationRequests',id)).filter(r=>r?.projectId===message.projectId);
      const tasks = (message.sender === 'human' ? message.taskIds || [] : []).map(id => this.db.get('tasks', id)).filter(t => t?.projectId === message.projectId);
      const addressed = new Set([...explicitRequestRoleIds, ...requests.map(r=>r.targetRoleId), ...tasks.map(t => t.roleId)]);
      const at = this.now(), created = [];
      const recipients = session.participants.map(p => p.roleId)
        .filter(roleId => roleId !== message.roleId)                               // the sender is never woken by itself
        .filter(roleId => session.broadcast === true || addressed.has(roleId));
      for (const roleId of recipients) {
        const id = `${message.id}:${roleId}`;
        if (this.db.get(RECEIPT, id)) continue;                                    // redelivery never registers twice
        const directed=requests.filter(r=>r.targetRoleId===roleId);
        const receipt = { id, projectId: message.projectId, conversationId:conversationIdOf(message), sessionId: session.id, roleId, messageId: message.id,
          explicitRequest: addressed.has(roleId), requestId: directed[0]?.id || null,
          ...(message.requestIds&&directed.length?{requestIds:directed.map(r=>r.id)}:{}),
          taskId: tasks.find(t => t.roleId === roleId)?.id || null,
          status: 'queued', batchId: null, createdAt: iso(at), order: at };
        this.db.put(RECEIPT, receipt); created.push(receipt);
        const key = `${session.id}:${roleId}`, collector = this.db.get(COLLECTOR, key);
        this.db.put(COLLECTOR, { ...(collector||{}),id: key, projectId: message.projectId, conversationId:conversationIdOf(message), sessionId: session.id, roleId,
          firstAt: collector?.open ? collector.firstAt : at, lastAt: at, open: true, explicit: Boolean(collector?.open && collector.explicit) || receipt.explicitRequest, waitingReason: collector?.startBlocked?'startup_failed':null });
      }
      return created;
    });
  }

  #ready(collector, config, at) {
    if (!collector?.open) return false;
    if (collector.explicit) return true;                                           // explicit requests skip the discussion window
    return at >= Math.min(collector.lastAt + config.quietSeconds * 1000, collector.firstAt + config.maxSeconds * 1000);
  }

  /** Hold protected opinions, rather than delivering or acknowledging them on behalf of a reviewer. */
  readableReceipts(projectId, roleId, sessionId) {
    const view = reviewView(this.db, { projectId, roleId });
    return this.db.listProject(RECEIPT, projectId).filter(r => r.sessionId === sessionId && r.roleId === roleId && r.status === 'queued'
      && !r.requestIds?.length && !r.taskId && !this.db.get('coordinationRequests', r.requestId || '')?.taskId && view.get('roomMessages', r.messageId));
  }

  /** Fair choice for one role: rotate across ready sessions, starting after the persisted position. */
  pick(projectId, roleId) {
    const config = queueConfig(this.db, projectId), at = this.now();
    const ready = this.db.listProject(COLLECTOR, projectId).filter(c => c.roleId === roleId && this.#ready(c, config, at)
      && this.db.get('collaborationSessions', c.sessionId)?.state === 'open')
      .filter(c => {
        const session = this.db.get('collaborationSessions', c.sessionId);
        if(c.startBlocked && c.blockedBinding===workerBinding(this.db,roleId))return false;
        if(c.startBlocked)this.db.put(COLLECTOR,{...c,startBlocked:false,blockedBinding:null});
        let reason = this.readableReceipts(projectId, roleId, c.sessionId).length ? null : 'review_isolation';
        if (!reason && session.broadcast === true) {
          const cycle = ensureCycle(this.db, session, at);
          if (cycle.ended) reason = 'session_closed';
          else if (cycle.paused || cycle.used + cycle.reserved >= cycle.limit) {
            reason = 'broadcast_paused';
            if (!cycle.paused) {
              this.db.put(CYCLE, { ...cycle, paused: true, pausedAt: iso(at), pauseReason: 'budget_exhausted' });
              raiseAlert(this.db, { projectId, sessionId: session.id, kind: 'budget_exhausted', detail: { used: cycle.used, limit: cycle.limit } }, at);
            }
          }
        }
        if (reason && c.waitingReason !== reason) this.db.put(COLLECTOR, { ...c, waitingReason: reason });
        return !reason;
      })
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    if (!ready.length) return null;
    const last = this.db.get(ROTATION, `${projectId}:${roleId}`)?.lastSessionId;
    return ready.find(c => last && c.sessionId > last) || ready[0];
  }

  /**
   * Seal a batch against a Worker reservation. The Worker must have checked true idleness and returned a
   * reservation {id, generation, expiresAt}; old Workers keep everything queued.
   */
  seal(projectId, roleId, { workerId, reservation, roleSessionId = null }) {
    return this.db.transaction(() => {
      const collector = this.pick(projectId, roleId);
      if (!collector) return null;
      const worker = this.db.get('workers', workerId);
      if (worker?.capabilities?.[QUEUE_CAPABILITY] !== QUEUE_PROTOCOL) {
        this.db.put(COLLECTOR, { ...collector, waitingReason: 'worker_upgrade_required' });
        return null;
      }
      if (!reservation?.id || !Number.isSafeInteger(reservation.generation) || (reservation.expiresAt && !(ms(reservation.expiresAt) > this.now()))) {
        this.db.put(COLLECTOR, { ...collector, waitingReason: 'not_idle' });
        return null;
      }
      if (this.db.list(BATCH).some(b => b.roleId === roleId && b.projectId === projectId && ['reserved', 'pending_verification', 'processing'].includes(b.status)&&!b.waitingForDiscussion&&!b.waitingForCall))
        { this.db.put(COLLECTOR, { ...collector, waitingReason: 'role_busy' }); return null; }
      // Automatic propagation consumes the session's cycle budget; reserve atomically before sealing.
      const session = this.db.get('collaborationSessions', collector.sessionId);
      let cycle = null;
      if (session?.broadcast === true) {
        cycle = ensureCycle(this.db, session, this.now());
        if (cycle.ended) { this.db.put(COLLECTOR, { ...collector, waitingReason: 'session_closed' }); return null; }
        if (cycle.paused || cycle.used + cycle.reserved >= cycle.limit) {
          this.db.put(COLLECTOR, { ...collector, waitingReason: 'broadcast_paused' });
          if (!cycle.paused) { cycle = this.db.put(CYCLE, { ...cycle, paused: true, pausedAt: iso(this.now()), pauseReason: 'budget_exhausted' });
            raiseAlert(this.db, { projectId, sessionId: session.id, kind: 'budget_exhausted', detail: { used: cycle.used, limit: cycle.limit } }, this.now()); }
          return null;
        }
        cycle = this.db.put(CYCLE, { ...cycle, reserved: cycle.reserved + 1 });
      }
      const config = queueConfig(this.db, projectId);
      const receipts = this.db.listProject(RECEIPT, projectId).filter(r => r.sessionId === collector.sessionId && r.roleId === roleId && r.status === 'queued')
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      const visible = new Set(this.readableReceipts(projectId, roleId, collector.sessionId).map(r => r.id));
      const taken = receipts.filter(r => visible.has(r.id)).slice(0, config.maxBatchMessages); // hidden receipts remain pending, ordered splits never truncate
      for(const receipt of taken)assertConversationRecord(session,this.db.get('roomMessages',receipt.messageId));
      const batch = { id: randomUUID(), projectId, conversationId:conversationIdOf(session), sessionId: collector.sessionId, roleId, roleSessionId, workerId,
        messageIds: taken.map(r => r.messageId), explicit: taken.some(r => r.explicitRequest), configVersion: config.version,
        // The Home lease runs on the Home clock; the Worker re-checks its own expiry before writing.
        reservation: { id: reservation.id, generation: reservation.generation, expiresAt: iso(this.now() + config.leaseSeconds * 1000), workerExpiresAt: reservation.expiresAt || null },
        status: 'reserved', deliveryAttempted: false, runId: null, createdAt: iso(this.now()), cycleId: cycle?.id || null, budget: cycle ? 'reserved' : null };
      this.db.put(BATCH, batch);
      for (const r of taken) this.db.put(RECEIPT, { ...r, status: 'sealed', batchId: batch.id });
      const remaining = receipts.filter(r => !taken.some(t => t.id === r.id)), rest = remaining.length > 0;
      this.db.put(COLLECTOR, { ...collector, open: rest, explicit: rest && remaining.some(r => r.explicitRequest),
        firstAt: rest ? collector.firstAt : null, waitingReason: null });
      this.db.put(ROTATION, { id: `${projectId}:${roleId}`, projectId, roleId, lastSessionId: collector.sessionId });
      return batch;
    });
  }

  /** Home is about to send the start command; from here on a lost acknowledgement means "needs verification". */
  markDelivering(batchId) { return this.#update(batchId, b => b.status === 'reserved' ? { ...b, deliveryAttempted: true } : b); }

  confirmStarted(batchId, { runId, reservationId }) {
    return this.#update(batchId, b => {
      if (b.reservation.id !== reservationId) throw new Error(tr('sessionQueue.reservationMismatch'));
      if (!['reserved', 'pending_verification'].includes(b.status)) return b;
      if (b.budget === 'reserved') moveBudget(this.db, b.cycleId, { reserved: -1, used: 1 });
      return { ...b, status: 'processing', runId, startedAt: iso(this.now()), budget: b.budget === 'reserved' ? 'charged' : b.budget };
    }, 'processing');
  }

  /** A batch is processed only once its reply or no-reply result is saved; receipts are confirmed per message. */
  complete(batchId, { outcome }) {
    if (!['replied', 'passed', 'blocked'].includes(outcome)) throw new Error(tr('sessionQueue.invalidOutcome'));
    return this.#update(batchId, b => {
      if (b.status !== 'processing') return b;
      const pending = b.messageIds.filter(id => {
        const receipt = this.db.get(RECEIPT, `${id}:${b.roleId}`);
        return receipt?.explicitRequest && !this.requestHandled(receipt);
      });
      return { ...b, status: pending.length ? 'unresolved' : 'processed', unresolvedMessageIds: pending, outcome, finishedAt: iso(this.now()) };
    }, 'processed');
  }

  /** Each addressed request needs its own delivered result, blocker or valid dependency wait. */
  requestHandled(receipt) {
    const requests=receiptRequests(this.db,receipt);
    if(!requests.length||requests.length!==(receipt.requestIds||[receipt.requestId]).length)return false;
    return requests.every(request=>{
      if (['succeeded', 'failed', 'cancelled'].includes(request.status)) return Boolean(request.status === 'cancelled' || request.result?.trim() || request.reportSummary?.trim() || request.error?.trim());
      return request.status === 'waiting_call' && Boolean(request.resumeSummary?.trim()) && request.waitRequestIds?.length > 0
        && request.waitRequestIds.every(id => this.db.get('coordinationRequests', id)?.projectId === request.projectId);
    });
  }

  /** Existing formal requests keep their own task/Run; receipt tracking never creates a second driver. */
  attachRequest(request) {
    for (const receipt of this.db.listProject(RECEIPT, request.projectId).filter(r => r.roleId === request.targetRoleId
      && (r.requestIds?.includes(request.id)||r.requestId === request.id || request.taskId && r.taskId === request.taskId))) {
      this.db.put(RECEIPT, { ...receipt, requestId: receipt.requestIds?receipt.requestId:request.id, taskId: receipt.requestIds?receiptRequests(this.db,receipt).find(r=>r.taskId)?.taskId||receipt.taskId:request.taskId || receipt.taskId });
      const key=`${receipt.sessionId}:${receipt.roleId}`,collector=this.db.get(COLLECTOR,key);
      const unassigned=this.db.listProject(RECEIPT,request.projectId).some(r=>r.sessionId===receipt.sessionId&&r.roleId===receipt.roleId&&r.status==='queued'&&!r.requestIds?.length&&!r.taskId&&!this.db.get('coordinationRequests',r.requestId||'')?.taskId);
      if(collector&&!unassigned)this.db.put(COLLECTOR,{...collector,open:false,firstAt:null,explicit:false,waitingReason:null});
    }
  }

  settleRequest(request) {
    this.attachRequest(request);
    for (const receipt of this.db.listProject(RECEIPT, request.projectId).filter(r => r.requestIds?.includes(request.id)||r.requestId === request.id)) {
      if (this.requestHandled(receipt)) this.db.put(RECEIPT, { ...receipt, status: 'processed', requestStatus: request.status });
    }
  }

  /** Lease expiry: unsent reservations return to the queue; possibly-sent ones wait for verification; started ones are untouched. */
  expireLeases() {
    return this.db.transaction(() => {
      const changed = [];
      for (const b of this.db.list(BATCH).filter(b => b.status === 'reserved' && ms(b.reservation.expiresAt) <= this.now())) {
        if (b.deliveryAttempted) changed.push(this.db.put(BATCH, { ...b, status: 'pending_verification', verifySince: iso(this.now()) }));
        else changed.push(this.#releaseBatch(b, 'lease_expired'));
      }
      return changed;
    });
  }

  /** Resolve a pending verification from facts the Worker reported about the original Run / native turn / process. Never reruns. */
  verify(batchId, facts = {}) {
    return this.db.transaction(() => {
      const b = this.db.get(BATCH, batchId);
      if (!b || b.status !== 'pending_verification') return b;
      if (facts.started === true || facts.started === false && facts.processSettled === true) clearAlert(this.db, 'pending_verification', b.id);
      if (facts.started === true && facts.runId) return this.confirmStarted(batchId, { runId: facts.runId, reservationId: b.reservation.id });
      if (facts.started === false && facts.processSettled === true) return this.#releaseBatch(b, 'verified_not_started');
      return b;                                                                    // still unknown: keep waiting, do not start again
    });
  }

  /** Explicit public reply from the batch's own run (wb chat post). */
  recordReply(run, messageId) {
    return this.#update(run.collaborationBatchId||run.continuationBatchId, b => (b.activeRunId||b.runId) === run.id ? { ...b, repliedMessageIds: [...new Set([...(b.repliedMessageIds || []), messageId])] } : b);
  }

  /** wb pass: identity comes from the trusted Run; refused while an explicit request or a public reply exists; idempotent. */
  pass(run) {
    return this.db.transaction(() => {
      const id=run?.collaborationBatchId||run?.continuationBatchId,b=id?this.db.get(BATCH,id):null;
      if (!b || (b.activeRunId||b.runId) !== run.id || b.roleId !== run.roleId || b.projectId !== run.projectId) throw new Error(tr('sessionQueue.passNoBatch'));
      if (b.passedAt) return { batchId: b.id, status: 'passed', idempotent: true };
      if (b.status !== 'processing') throw new Error(tr('sessionQueue.passNoBatch'));
      if (b.explicit && (!b.messageIds.some(id => this.db.get(RECEIPT, `${id}:${b.roleId}`)?.explicitRequest) || b.messageIds.some(id => {
        const receipt = this.db.get(RECEIPT, `${id}:${b.roleId}`);
        return !receipt || receipt.explicitRequest && !this.requestHandled(receipt);
      }))) throw new Error(tr('sessionQueue.passExplicitRequest'));
      if (b.repliedMessageIds?.length) throw new Error(tr('sessionQueue.passAfterReply'));
      this.db.put(BATCH, { ...b, passedAt: iso(this.now()) });
      return { batchId: b.id, status: 'passed', idempotent: false };
    });
  }

  /** Run reached a terminal state. Only a saved reply, a pass or an explicit block confirms the batch; anything else stays unresolved, never silently processed. */
  finish(run, { queueRejected = false, queueRetryable = true } = {}) {
    return this.db.transaction(() => {
      const id=run?.collaborationBatchId||run?.continuationBatchId,b=id?this.db.get(BATCH,id):null;
      if (!b || ['processed', 'released', 'unresolved'].includes(b.status)) return b;
      if(b.activeRunId&&b.activeRunId!==run.id)return b;
      if (queueRejected) {
        if (!['reserved', 'pending_verification'].includes(b.status)) return b;
        const next=this.#releaseBatch(b,'worker_rejected');
        if(!queueRetryable){const key=`${b.sessionId}:${b.roleId}`,c=this.db.get(COLLECTOR,key);this.db.put(COLLECTOR,{...c,startBlocked:true,blockedBinding:workerBinding(this.db,b.roleId),waitingReason:'startup_failed'});}
        return next;
      }
      if (b.status !== 'processing') return b;
      const task=this.db.get('tasks',run.taskId||'');
      if(run.discussionWaiting&&task?.discussionWait)return this.db.put(BATCH,{...b,waitingForDiscussion:true,waitingRunId:run.id});
      const request=this.db.get('coordinationRequests',run.requestId||'');
      if(request?.status==='waiting_call'&&request.currentRunId===run.id&&request.resumeSummary&&request.waitRequestIds?.length)
        return this.db.put(BATCH,{...b,waitingForCall:true,waitingRunId:run.id});
      const verdict = this.db.get('runReports', run.id)?.verdict;
      const outcome = b.repliedMessageIds?.length ? 'replied' : b.passedAt ? 'passed' : ['blocked', 'needs_input'].includes(verdict) ? 'blocked' : null;
      if (outcome) return this.complete(b.id, { outcome });
      raiseAlert(this.db, { projectId: b.projectId, sessionId: b.sessionId, kind: 'unresolved', detail: { batchId: b.id, roleId: b.roleId, runId: run.id } }, this.now());
      return this.db.put(BATCH, { ...b, status: 'unresolved', finishedAt: iso(this.now()), runStatus: run.status });
    });
  }

  #releaseBatch(b, reason) {
    // A queued launch task for this batch must not start later with a dead reservation.
    for (const task of this.db.listProject('tasks', b.projectId).filter(t => t.collaborationBatchId === b.id && ['ready', 'queued'].includes(t.status) && !t.currentRunId))
      this.db.put('tasks', { ...task, status: 'cancelled', error: reason });
    for (const id of b.messageIds) {
      const r = this.db.get(RECEIPT, `${id}:${b.roleId}`);
      if (r?.batchId === b.id) this.db.put(RECEIPT, { ...r, status: 'queued', batchId: null });
    }
    const key = `${b.sessionId}:${b.roleId}`, c = this.db.get(COLLECTOR, key);
    this.db.put(COLLECTOR, { ...(c || { id: key, projectId: b.projectId, sessionId: b.sessionId, roleId: b.roleId, lastAt: this.now() }),
      open: true, firstAt: c?.open ? c.firstAt : this.now(), explicit: Boolean(c?.explicit || b.explicit), waitingReason: reason });
    if (b.budget === 'reserved') moveBudget(this.db, b.cycleId, { reserved: -1 });
    return this.db.put(BATCH, { ...b, status: 'released', releasedReason: reason, budget: b.budget === 'reserved' ? 'returned' : b.budget });
  }

  #update(batchId, fn, receiptStatus) {
    return this.db.transaction(() => {
      const b = this.db.get(BATCH, batchId);
      if (!b) throw new Error(tr('sessionQueue.batchNotFound'));
      const next = fn(b);
      if (next !== b) this.db.put(BATCH, next);
      if (receiptStatus && next.status === receiptStatus) for (const id of next.messageIds) {
        const r = this.db.get(RECEIPT, `${id}:${next.roleId}`);
        if (r?.batchId === next.id) this.db.put(RECEIPT, { ...r, status: receiptStatus === 'processing' ? 'sealed' : 'processed' });
      }
      return next;
    });
  }

  /** Delivery status for the page: platform queue, pending verification, CLI processing, processed. */
  status(projectId) {
    const batches = this.db.listProject(BATCH, projectId);
    const state = r => {
      if (r.status === 'processed') return 'processed';
      const active=receiptRequests(this.db,r).filter(request=>request.currentRunId&&!['succeeded','failed','cancelled'].includes(request.status));
      if(active.length)return active.every(request=>request.status==='waiting_call')?'waiting_reply':'processing';
      const b = r.batchId ? batches.find(x => x.id === r.batchId) : null;
      if(b?.status==='processing'&&(b.waitingForDiscussion||b.waitingForCall))return 'waiting_reply';
      if (b?.status === 'processing') return 'processing';
      if (b?.status === 'pending_verification') return 'pending_verification';
      if (b?.status === 'unresolved') return 'unresolved';
      return 'queued';
    };
    return { receipts: this.db.listProject(RECEIPT, projectId).map(r => ({ messageId: r.messageId, roleId: r.roleId, sessionId: r.sessionId, state: state(r) })),
      collectors: this.db.listProject(COLLECTOR, projectId).filter(c => c.open).map(c => ({ sessionId: c.sessionId, roleId: c.roleId, waitingReason: c.waitingReason || 'collecting' })),
      sessions: this.db.listProject('collaborationSessions', projectId).map(x => ({ id: x.id, goal: x.goal, type: x.type, state: x.state, participants: x.participants.map(p => p.roleId), reviewReleased: Boolean(x.reviewReleasedAt), broadcast: x.broadcast === true, parentSessionId: x.parentSessionId || null })),
      alerts: this.db.listProject(ALERT, projectId).filter(a => a.active).map(a => ({ id: a.id, kind: a.kind, sessionId: a.sessionId })),
      cycles: this.db.listProject(CYCLE, projectId).map(c => ({ id: c.id, rootSessionId: c.rootSessionId, ended: Boolean(c.ended), used: c.used, reserved: c.reserved, limit: c.limit, paused: c.paused })),
      batches: batches.map(b => ({ id: b.id, sessionId: b.sessionId, roleId: b.roleId, status: b.status, messageIds: b.messageIds, runId: b.runId, configVersion: b.configVersion })) };
  }
}

/**
 * Home pump: asks the role's Worker for a reservation over WebSocket, seals a batch against it and turns the batch
 * into one ordinary launch task. Lease timeouts are enforced here on the Home clock.
 */
/** Acceptance-only switch, allowed only on projects explicitly marked as test projects. Budgets still apply. */
export function setSessionBroadcast(db, projectId, sessionId, { enabled, acknowledgeNoBudget } = {}) {
  const s = db.get('collaborationSessions', sessionId);
  if (!s || s.projectId !== projectId) throw new Error(tr('collabSessions.sessionNotFound'));
  if (db.get('projects', projectId)?.testProject !== true) throw new Error(tr('sessionQueue.broadcastTestOnly'));
  if (typeof enabled !== 'boolean' || (enabled && acknowledgeNoBudget !== true)) throw new Error(tr('sessionQueue.broadcastNeedsAcknowledgement'));
  if (enabled) ensureCycle(db, s, Date.now());
  return db.put('collaborationSessions', { ...s, broadcast: enabled });
}

export function setTestProject(db, projectId, enabled) {
  const project = db.get('projects', projectId);
  if (!project) throw new Error(tr('collabSessions.projectNotFound'));
  if (typeof enabled !== 'boolean') throw new Error(tr('collabSessions.enabledMustBeBoolean'));
  return db.put('projects', { ...project, testProject: enabled });
}

/** One propagation cycle per root session; derived sessions (parentSessionId) share it, so splitting never resets the budget. */
export function ensureCycle(db, session, at = Date.now()) {
  let root = session;
  const seen = new Set();
  while (root.parentSessionId) {
    if (seen.has(root.id)) throw new Error(tr('collabSessions.invalidAncestry'));
    seen.add(root.id);
    const parent = db.get('collaborationSessions', root.parentSessionId);
    if (!parent || parent.projectId !== session.projectId) throw new Error(tr('collabSessions.invalidAncestry'));
    root = parent;
  }
  const id = root.cycleId || `cycle:${root.id}`, existing = db.get(CYCLE, id);
  if (existing) return existing;
  const limit = queueConfig(db, root.projectId).budgetBatches || 0;
  return db.put(CYCLE, { id, projectId: root.projectId, rootSessionId: root.id, sourceMessageId: root.sourceMessageId || null,
    limit, used: 0, reserved: 0, paused: false, grants: [{ limit, actor: { kind: 'project_default' }, at: iso(at) }], createdAt: iso(at) });
}

function moveBudget(db, cycleId, { reserved = 0, used = 0 }) {
  const c = cycleId ? db.get(CYCLE, cycleId) : null;
  if(c){const next={...c,reserved:Math.max(0,c.reserved+reserved),used:c.used+used};
    if(reserved<0&&!next.ended&&next.pauseReason==='budget_exhausted'&&next.used+next.reserved<next.limit){Object.assign(next,{paused:false,pausedAt:null,pauseReason:null});clearAlert(db,'budget_exhausted',next.rootSessionId);}
    db.put(CYCLE,next);
  }
}

/** Reserve new automatic tool work at actual dispatch, not request registration. Necessary continuations are exempt. */
export function reservePropagation(db, task, { recordFailure = true } = {}) {
  if (!task.automaticPropagation || !task.collaborationCycleId || task.collaborationBatchId) return true;
  if(db.get('workers',task.roleSnapshot?.nodeId||'')?.capabilities?.[QUEUE_CAPABILITY]!==QUEUE_PROTOCOL){if(recordFailure)db.put('tasks',{...task,waitingReason:'worker_upgrade_required'});return false;}
  const cycle = db.get(CYCLE, task.collaborationCycleId);
  if (!cycle || cycle.ended || cycle.paused || cycle.used + cycle.reserved >= cycle.limit) {
    if(recordFailure)db.put('tasks', { ...task, waitingReason: 'broadcast_paused' });
    if (cycle && !cycle.ended && !cycle.paused) {
      db.put(CYCLE, { ...cycle, paused: true, pauseReason: 'budget_exhausted', pausedAt: iso(Date.now()) });
      raiseAlert(db, { projectId: task.projectId, sessionId: cycle.rootSessionId, kind: 'budget_exhausted', detail: { used: cycle.used, limit: cycle.limit } });
    }
    return false;
  }
  moveBudget(db, cycle.id, { reserved: 1 });
  return true;
}

/** A Run's trusted delivery facts charge or refund its reservation exactly once, independent of replayed events. */
export function settlePropagation(db, run, facts) {
  if (!run.collaborationCycleId || run.collaborationBatchId || run.propagationBudget !== 'reserved') return run;
  if (facts.inputDeliveryState === 'accepted') {
    moveBudget(db, run.collaborationCycleId, { reserved: -1, used: 1 });
    return { ...run, propagationBudget: 'charged' };
  }
  if (facts.queueRejected === true && facts.processSettled === true) {
    moveBudget(db, run.collaborationCycleId, { reserved: -1 });
    return { ...run, propagationBudget: 'returned' };
  }
  return run;
}

/** Resuming needs a new human grant; usage history is kept, never reset. */
export function grantBudget(db, projectId, sessionId, { additional } = {}, actor = { kind: 'human' }, at = Date.now()) {
  return db.transaction(() => {
    const s = db.get('collaborationSessions', sessionId);
    if (!s || s.projectId !== projectId) throw new Error(tr('collabSessions.sessionNotFound'));
    if (actor?.kind !== 'human') throw new Error(tr('sessionQueue.grantHumanOnly'));
    if (!Number.isSafeInteger(additional) || additional < 1 || additional > 1000) throw new Error(tr('sessionQueue.budgetRange'));
    const c = ensureCycle(db, s, at);
    clearAlert(db, 'budget_exhausted', s.id); if (c.rootSessionId !== s.id) clearAlert(db, 'budget_exhausted', c.rootSessionId);
    return db.put(CYCLE, { ...c, limit: c.limit + additional, paused: false, pausedAt: null, pauseReason: null,
      grants: [...c.grants, { additional, actor, at: iso(at), usedAtGrant: c.used }] });
  });
}

/**
 * Supervisor alerts are merged per matter (session): while an alert task for the same session has not started,
 * new kinds are appended to it instead of waking the supervisor again. The alert task is never broadcast.
 */
export function raiseAlert(db, { projectId, sessionId, kind, detail = {}, matter = null }, at = Date.now()) {
  const conversationId=conversationIdOf(db.get('collaborationSessions',sessionId))||projectId;
  const key = `${kind}:${matter || detail.batchId || sessionId}`;
  const ledger = db.get(ALERT, key);
  if (ledger?.active) return null;                                             // still over the line: no repeat
  const open = db.listProject('tasks', projectId).find(t => conversationIdOf(t)===conversationId && !t.currentRunId && ['ready', 'queued'].includes(t.status)
    && (t.sessionQueueAlert?.sessionId === sessionId || (t.proactiveInitial && !t.sessionQueueAlert)));   // same matter, or a pending silence follow-up
  const project = db.get('projects', projectId), supervisor = db.get('roles', project?.supervisorRoleId || '');
  db.put(ALERT, { id: key, projectId, sessionId, kind, detail, active: true, at: iso(at), count: (ledger?.count || 0) + 1, taskId: open?.id || null });
  if (!supervisor || supervisor.enabled === false || supervisor.archivedAt) return null;
  const line = tr(`sessionQueue.alert.${kind}`, { sessionId, ...Object.fromEntries(Object.entries(detail).map(([k, v]) => [k, String(v)])) });
  if (open) {
    const info = open.sessionQueueAlert || { sessionId, kinds: [] };
    return db.put('tasks', { ...open, prompt: `${open.prompt}\n${line}`, sessionQueueAlert: { ...info, kinds: [...info.kinds, kind] } });
  }
  const task = db.createTask({ projectId, title: tr('sessionQueue.alertTitle'), prompt: `${tr('sessionQueue.alertIntro')}\n${line}`, model: supervisor.model, mode: supervisor.mode });
  db.put(ALERT, { ...db.get(ALERT, key), taskId: task.id });
  return db.put('tasks', { ...task, conversationId, origin: 'chat', roleId: supervisor.id, roleSnapshot: supervisor, sessionQueueAlert: { sessionId, kinds: [kind] } });
}

/** The matter recovered; crossing the line again later raises a new alert. */
export function clearAlert(db, kind, matter) {
  const ledger = db.get(ALERT, `${kind}:${matter}`);
  if (ledger?.active) db.put(ALERT, { ...ledger, active: false, clearedAt: new Date().toISOString() });
}

export class QueuePump {
  constructor(db, { send, online, now = () => Date.now(), render, verify }) {
    this.db = db; this.send = send; this.online = online; this.now = now; this.render = render;
    this.queue = new SessionQueue(db, { now }); this.pending = new Map();
    this.verify=verify;this.verifications=new Map();
  }

  /** Query delivery receipts on the original Worker; unknown facts keep the original reservation and history. */
  async reconcileVerifications() {
    if(!this.verify)return false;
    let changed=false;
    await Promise.all(this.db.list(BATCH).filter(b=>b.status==='pending_verification'&&b.runId&&this.online(b.workerId)).map(async b=>{
      const prior=this.verifications.get(b.id);
      if(prior?.pending || prior&&prior.at+15000>this.now())return;
      this.verifications.set(b.id,{at:this.now(),pending:true});
      try {
        const facts=await this.verify(b);
        if(facts.started===true && facts.runId!==b.runId)return;
        const next=this.queue.verify(b.id,facts);
        changed ||= next?.status!==b.status;
        const run=this.db.get('runs',b.runId);
        if(next?.status==='processing'&&run&&['succeeded','failed','interrupted'].includes(run.status))this.queue.finish(run);
      } catch(error) {
        const current=this.db.get(BATCH,b.id);
        if(current?.status==='pending_verification')this.db.put(BATCH,{...current,verificationError:error.message});
      } finally {this.verifications.set(b.id,{at:this.now(),pending:false});}
    }));
    return changed;
  }

  /** One merged supervisor alert per batch that stays in pending verification past the project threshold. Never reruns anything. */
  alertStaleVerifications() {
    const alerts = [];
    for (const b of this.db.list(BATCH).filter(b => b.status === 'pending_verification' && !b.verifyAlertAt)) {
      const config = queueConfig(this.db, b.projectId);
      if (ms(b.verifySince) + config.verifyAlertSeconds * 1000 > this.now()) continue;
      const minutes = Math.round((this.now() - ms(b.verifySince)) / 60000);
      const task = raiseAlert(this.db, { projectId: b.projectId, sessionId: b.sessionId, kind: 'pending_verification', detail: { batchId: b.id, roleId: b.roleId, minutes, runId: b.runId || '-' } }, this.now());
      this.db.put(BATCH, { ...this.db.get(BATCH, b.id), verifyAlertAt: iso(this.now()), verifyAlertTaskId: task?.id || null });
      if (task) alerts.push(task);
    }
    return alerts;
  }

  /** Backlog per session+role: alert once when either threshold is crossed, clear when back under both. */
  checkBacklog() {
    const raised = [];
    for (const project of this.db.list('projects').filter(p => p.features?.collaborationSessions === true)) {
      const config = queueConfig(this.db, project.id), groups = new Map();
      for (const r of this.db.listProject(RECEIPT, project.id).filter(r => r.status === 'queued')) {
        const k = `${r.sessionId}:${r.roleId}`, g = groups.get(k) || { sessionId: r.sessionId, roleId: r.roleId, count: 0, oldest: r.order };
        g.count++; g.oldest = Math.min(g.oldest, r.order); groups.set(k, g);
      }
      for (const c of this.db.listProject(COLLECTOR, project.id)) {
        const g = groups.get(c.id), waitSeconds = g ? Math.floor((this.now() - g.oldest) / 1000) : 0;
        if (g && (g.count >= config.backlogMessages || waitSeconds >= config.backlogWaitSeconds)) {
          const task = raiseAlert(this.db, { projectId: project.id, sessionId: c.sessionId, kind: 'backlog', matter: c.id, detail: { roleId: c.roleId, count: g.count, minutes: Math.floor(waitSeconds / 60) } }, this.now());
          if (task) raised.push(task);
        } else clearAlert(this.db, 'backlog', c.id);
      }
    }
    return raised;
  }

  tick() {
    this.queue.expireLeases();
    this.alertStaleVerifications();
    this.checkBacklog();
    for (const [id, p] of this.pending) if (p.at + 15000 < this.now()) this.pending.delete(id);
    const projects = this.db.list('projects').filter(p => p.features?.collaborationSessions === true);
    for (const project of projects) {
      const roleIds = [...new Set(this.db.listProject(COLLECTOR, project.id).filter(c => c.open).map(c => c.roleId))];
      for (const roleId of roleIds) {
        if ([...this.pending.values()].some(p => p.projectId === project.id && p.roleId === roleId)) continue;
        if (!this.queue.pick(project.id, roleId)) continue;
        const role = this.db.get('roles', roleId);
        if(role?.enabled===false){for(const c of this.db.listProject(COLLECTOR,project.id).filter(c=>c.open&&c.roleId===roleId))if(c.waitingReason!=='role_disabled')this.db.put(COLLECTOR,{...c,waitingReason:'role_disabled'});continue;}
        if (!role?.nodeId || role.archivedAt || !this.online(role.nodeId)) continue;
        if (this.db.get('workers', role.nodeId)?.capabilities?.[QUEUE_CAPABILITY] !== QUEUE_PROTOCOL) {
          for (const c of this.db.listProject(COLLECTOR, project.id).filter(c => c.open && c.roleId === roleId))
            if (c.waitingReason !== 'worker_upgrade_required') this.db.put(COLLECTOR, { ...c, waitingReason: 'worker_upgrade_required' });
          continue;
        }
        const id = randomUUID(), key = `${project.id}:${roleId}`;
        this.pending.set(id, { projectId: project.id, roleId, nodeId: role.nodeId, key, at: this.now() });
        this.send(role.nodeId, { type: 'queue_reserve', id, projectId: project.id, roleId, key, runtime: role.runtime, ownerNodeId: role.nodeId });
      }
    }
  }

  /** Worker answered. Only the Worker that was asked can satisfy the request. */
  onReservation(nodeId, m) {
    const p = this.pending.get(m.id);
    if (!p || p.nodeId !== nodeId) return null;
    this.pending.delete(m.id);
    if (!m.ok) {
      for (const c of this.db.listProject(COLLECTOR, p.projectId).filter(c => c.open && c.roleId === p.roleId)) this.db.put(COLLECTOR, { ...c, waitingReason: m.reason || 'not_idle' });
      return null;
    }
    return this.db.transaction(() => {
      const batch = this.queue.seal(p.projectId, p.roleId, { workerId: nodeId, reservation: m.reservation, roleSessionId: p.key });
      if (!batch) { this.send(nodeId, { type: 'queue_cancel', key: p.key, reservationId: m.reservation?.id }); return null; }
      const role = this.db.get('roles', p.roleId), view = reviewView(this.db, { projectId: p.projectId, roleId: p.roleId });
      const messages = batch.messageIds.map(id => view.get('roomMessages', id)).filter(Boolean);
      const task = this.db.createTask({ projectId: p.projectId, title: `batch ${batch.id.slice(0, 8)}`, prompt: this.render(batch, messages), model: role.model, mode: role.mode });
      this.db.put('tasks', { ...task, conversationId:conversationIdOf(batch), origin: 'chat', roleId: role.id, roleSnapshot: role, sourceMessageId: batch.messageIds.at(-1) || null,
        collaborationSessionId:batch.sessionId,collaborationCycleId:batch.cycleId,
        collaborationBatchId: batch.id,
        collaborationBatch: { id: batch.id, key: p.key, projectId: p.projectId, roleId:role.id, deliveryProtocol:2,ownerNodeId: role.nodeId, runtime: role.runtime, reservation: { id: m.reservation.id, generation: m.reservation.generation } } });
      this.db.put(BATCH, { ...this.db.get(BATCH, batch.id), taskId: task.id });
      return this.db.get('tasks', task.id);
    });
  }
}

/**
 * Reassign an explicit request only if its execution has not started; the original request stays linked.
 * Uses the existing RoleCalls cancel/create, no second request system.
 */
export function reassignRequest(db, calls, projectId, requestId, roleId) {
  return db.transaction(() => {
    const request = db.get('coordinationRequests', requestId), role = db.get('roles', roleId);
    if (!request || request.projectId !== projectId) throw new Error(tr('sessionQueue.requestNotFound'));
    if (!role || role.projectId !== projectId || role.archivedAt) throw new Error(tr('collabSessions.participantNotInProject'));
    const task = request.taskId ? db.get('tasks', request.taskId) : null;
    const started = request.currentRunId || task?.currentRunId || request.status !== 'queued'
      || db.list('runs').some(r => r.requestId === requestId || (task && r.taskId === task.id));
    if (started) throw new Error(tr('sessionQueue.reassignStarted'));
    calls.cancel(requestId);
    const next = calls.create({ id: `${requestId}:to:${roleId}`.slice(0, 200), projectId, targetRoleId: roleId, kind: request.kind, summary: request.summary,
      sourceMessageId: request.sourceMessageId, parentRequestId: request.parentRequestId, originNodeId: request.originNodeId,
      ...(request.transferredFrom ? { transferredFrom: request.transferredFrom } : {}) });
    db.put('coordinationRequests', { ...db.get('coordinationRequests', next.id), reassignedFrom: requestId, ...(request.collaborationSessionId ? { collaborationSessionId: request.collaborationSessionId } : {}) });
    db.put('coordinationRequests', { ...db.get('coordinationRequests', requestId), reassignedTo: next.id });
    return db.get('coordinationRequests', next.id);
  });
}
