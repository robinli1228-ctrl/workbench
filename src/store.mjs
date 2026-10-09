import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { giteeRepository } from './repository.mjs';
import { roleWorkspace } from './project-repositories.mjs';
import { projectRepositories } from './project-space.mjs';
import { projectTerminalLock } from './terminal-resume.mjs';
import { RoleSessions } from './role-sessions.mjs';
import { buildRunContext } from './run-context.mjs';
import { steeringWaitReason } from './role-steering.mjs';
import {RoleDiscussions} from './role-discussions.mjs';
import {supportsDiscussion} from './discussion-policy.mjs';
import { tr } from './i18n.mjs';
import {switchSettled,roleSwitchWaitReason,effectiveExecutionRole,isSwitchMaintenance} from './role-switch-policy.mjs';

export const terminal = new Set(['succeeded', 'failed', 'interrupted']);
const now = () => new Date().toISOString();

/** SQLite is the persistent record kept separately by Home and each Worker; files are not shared across machines. */
export class Store {
  constructor(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,seq INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id,seq);`);
  }
  get(kind, id) { const r = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, id); return r ? JSON.parse(r.data) : null; }
  list(kind) { return this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind).map(r => JSON.parse(r.data)); }
  put(kind, value) { this.db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind, value.id, JSON.stringify(value)); return value; }
  remove(kind, id) { this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id); }
  /** A synchronous transaction makes the check and the creation a single operation, avoiding duplicate claims. */
  transaction(fn) {
    const depth=this.transactionDepth||0,savepoint=`nested_${depth}`;
    this.db.exec(depth ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.transactionDepth=depth+1;
    try { const r=fn();this.db.exec(depth ? `RELEASE ${savepoint}` : 'COMMIT');return r; }
    catch(e) {this.db.exec(depth ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');throw e;}
    finally {this.transactionDepth=depth;}
  }
  createProject({ id = randomUUID(), name, root = '', description = '', repoUrl = '' }) {
    if (typeof name !== 'string' || !name.trim()) throw new Error(tr('store.projectNameRequired'));
    if (typeof root !== 'string' || (root && !root.startsWith('/'))) throw new Error(tr('store.projectDirectoryMustBeAbsolute'));
    const repository = giteeRepository(repoUrl);
    return this.put('projects', { id, name: name.trim(), root, description, repoUrl: repository?.url || '', repository, createdAt: now() });
  }
  /** Project metadata never changes any node's Git remote or account credentials. */
  updateProject(id, { name, description = '', repoUrl = '' }) {
    const p = this.get('projects', id); if (!p) throw new Error(tr('store.projectNotFound'));
    if (typeof name !== 'string' || !name.trim()) throw new Error(tr('store.projectNameRequired2'));
    if (typeof description !== 'string' || description.length > 12000) throw new Error(tr('store.descriptionMustBeAtMost'));
    const repository = giteeRepository(repoUrl);
    return this.put('projects', { ...p, name: name.trim(), description, repoUrl: repository?.url || '', repository });
  }
  deleteProject(id) {
    return this.transaction(() => {
      const project = this.get('projects', id);
      if (!project) throw new Error(tr('store.projectNotFound2'));
      if(this.list('roleSwitches').some(op=>op.projectId===id&&(!switchSettled(op)||!op.steps.released)))throw new Error('Project still has an unsettled CLI switch.');
      if(this.list('discussionThreads').some(t=>t.projectId===id&&t.status==='open')
        ||this.list('discussionDeliveries').some(d=>d.projectId===id&&['queued','dispatched','runtime_accepted','reconciling'].includes(d.status))
        ||this.list('discussionIntents').some(i=>i.projectId===id&&i.status==='queued'))throw new Error(tr('store.projectStillHasUnfinishedDiscussions'));
      if(this.list('terminalSessions').some(s=>s.projectId===id&&!['released','cancelled'].includes(s.status)))throw new Error(tr('store.projectStillUnderManualTerminal'));
      if (this.list('coordinationRequests').some(r => r.projectId === id && !['succeeded', 'failed', 'cancelled'].includes(r.status))
        || this.list('plans').some(p => p.projectId === id && !['completed', 'cancelled'].includes(p.status))) throw new Error(tr('store.projectStillHasUnfinishedCalls'));
      if (this.list('deliveries').some(d => d.projectId === id && !['ready', 'cancelled', 'blocked'].includes(d.status))) throw new Error(tr('store.projectStillHasUnfinishedGit'));
      const runs = this.list('runs').filter(r => r.projectId === id);
      if (runs.some(r => !terminal.has(r.status))) {
        throw new Error(tr('store.projectStillHasExecutionsIn'));
      }
      for (const run of runs) {
        // Keep minimal ownership credentials so that old events from a disconnected Worker can be acknowledged and discarded, and cannot resurrect a deleted project.
        this.put('deletedRuns',{id:run.id,nodeId:run.nodeId,deletedAt:now()});
        this.db.prepare('DELETE FROM events WHERE run_id=?').run(run.id);
        for (const a of this.list('approvals').filter(a => a.runId === run.id)) this.remove('approvals', a.id);
        for (const c of this.list('commands').filter(c => c.runId === run.id)) this.remove('commands', c.id);
        this.remove('runs', run.id);
      }
      for (const t of this.list('tasks').filter(t => t.projectId === id)) this.remove('tasks', t.id);
      for (const m of this.list('roomMessages').filter(m => m.projectId === id)) this.remove('roomMessages', m.id);
      for (const r of this.list('roles').filter(r => r.projectId === id)) this.remove('roles', r.id);
      for (const w of this.list('workspaces').filter(w => w.projectId === id)) this.remove('workspaces', w.id);
      for (const g of this.list('gitChecks').filter(g => g.projectId === id)) this.remove('gitChecks', g.id);
      if (this.list('setupProposals').some(p => p.projectId === id && p.status === 'running')) throw new Error(tr('store.projectSetupOperationStillRunning'));
      for (const kind of ['repositories', 'repositoryWorkspaces', 'repositoryOperations', 'setupProposals', 'rolePromptChanges', 'supervisorConfigs', 'coordinationRequests', 'deliveries', 'plans', 'planVersions', 'planSteps', 'reports', 'executionPlans', 'attachments', 'scheduledJobs', 'scheduledOccurrences', 'timerActions', 'runReports', 'runAlerts', 'projectGitVersions', 'roleSessions']) {
        for (const record of this.list(kind).filter(r => r.projectId === id)) this.remove(kind, record.id);
      }
      this.remove('rooms', id);
      for(const kind of ['discussionThreads','discussionMessages','discussionDeliveries','discussionActions','discussionIntents'])for(const record of this.list(kind).filter(r=>r.projectId===id))this.remove(kind,record.id);
      for(const kind of ['conversationContexts','summaryJobs','summaryQueues'])for(const record of this.list(kind).filter(r=>r.projectId===id))this.remove(kind,record.id);
      this.remove('projects', id);
      for(const op of this.list('roleSwitches').filter(op=>op.projectId===id))this.remove('roleSwitches',op.id);
      for(const history of this.list('roleSwitchHistory').filter(history=>history.projectId===id))this.remove('roleSwitchHistory',history.id);
      return { id: project.id, name: project.name, deleted: true };
    });
  }
  /** Only stores the node directory the Worker actually checks; the legacy project root is only a configuration hint and takes no part in new dispatches. */
  bindWorkspace(projectId, nodeId, { localRoot, git = null }) {
    if (!this.get('projects', projectId)) throw new Error(tr('store.projectNotFound3'));
    if (!this.get('workers', nodeId)) throw new Error(tr('store.nodeNotFound'));
    if (typeof localRoot !== 'string' || !localRoot.startsWith('/') || localRoot.includes('\0')) throw new Error(tr('store.nodeDirectoryMustBeAbsolute'));
    return this.put('workspaces', { id: `${projectId}:${nodeId}`, projectId, nodeId, localRoot, git, checkedAt: now() });
  }
  createTask({ projectId, title, prompt, model = 'gpt-5.6-sol' }) {
    if (!this.get('projects', projectId)) throw new Error(tr('store.projectNotFound4'));
    if (!title?.trim() || !prompt?.trim()) throw new Error(tr('store.taskTitleRequirementsRequired'));
    if (typeof model !== 'string' || !model.trim() || model.length > 200 || /[\r\n]/.test(model)) throw new Error(tr('store.invalidModelId'));
    return this.put('tasks', { id: randomUUID(), projectId, title: title.trim(), prompt: prompt.trim(), model, mode: 'workspace-write', status: 'ready', createdAt: now() });
  }
  startDiscussionRun(options,context) {return new RoleDiscussions(this,context).startRun(options);}
  resumeDiscussionTask(options,context) {return new RoleDiscussions(this,context).resumeTask(options);}
  /** The same commandId returns the same Run; reassignment is not allowed while an unverified execution exists. */
  startTask(taskId, { commandId, nodeId }) {
    if (!commandId || !nodeId) throw new Error(tr('store.commandidNodeidRequired'));
    return this.transaction(() => {
      const fingerprint = JSON.stringify({ taskId, nodeId });
      const prior = this.get('commands', commandId);
      if (prior) { if (prior.fingerprint !== fingerprint) throw new Error(tr('store.commandidParameterConflict')); return this.get('runs', prior.runId); }
      if (this.get('settings', 'main')?.paused) throw new Error(tr('store.remoteCommandsPaused'));
      if (this.get('workers',nodeId)?.capabilities?.projectSpace !== 1) throw new Error(tr('store.upgradeTargetWorkerSupportShared'));
      const storedTask = this.get('tasks', taskId);
      if (!storedTask) throw new Error(tr('store.taskNotFound'));
      const task = storedTask.executionBinding ? {...storedTask,roleSnapshot:effectiveExecutionRole(this,storedTask),model:effectiveExecutionRole(this,storedTask).model} : storedTask;
      const switchReason=roleSwitchWaitReason(this,task);if(switchReason)throw new Error(switchReason);
      const steeringReason=steeringWaitReason(this,task);
      if(steeringReason)throw new Error(steeringReason);
      if(task.origin==='chat' && this.get('workers',nodeId)?.capabilities?.managedResume!==1)throw new Error(tr('store.upgradeTargetWorkerSupportRole'));
      if (projectTerminalLock(this,task.projectId,nodeId)) throw new Error(tr('store.projectUnderManualTerminalTakeover'));
      if (task.origin === 'chat' && (task.status !== 'ready' || task.roleSnapshot.nodeId !== nodeId)) throw new Error(tr('store.groupChatAssignmentStatusNode'));
      if (this.list('runs').some(r => r.taskId === taskId && !terminal.has(r.status))) throw new Error(tr('store.taskRunningUnverifiedCannotBe'));
      const repositoryId = null;
      const binding = roleWorkspace(this, task.projectId, nodeId, repositoryId);
      if (!binding) throw new Error(tr('store.bindProjectWorkspaceOnNode'));
      const repositories = projectRepositories(this, task.projectId, nodeId).filter(r=>!task.execution?.repositoryKeys||task.execution.repositoryKeys.includes(r.key));
      if (!task.roleSnapshot?.systemSupervisor && repositories.some(repo => !repo.localRoot)) throw new Error(tr('store.projectRepositoriesOnDeviceNot'));
      const roleSession = isSwitchMaintenance(task) ? this.get('roleSessions',task.switchSessionId) : task.origin === 'chat' && (task.roleSnapshot?.id || task.roleId)
        ? new RoleSessions(this).getOrCreate({projectId:task.projectId,conversationId:task.conversationId||task.projectId,
          roleId:task.roleSnapshot?.id||task.roleId,nodeId,runtime:task.roleSnapshot?.runtime||'codex',model:task.model,workspaceRoot:binding.localRoot}) : null;
      const run = { id: randomUUID(), taskId, projectId: task.projectId, nodeId, repositoryId,turnPurpose:'task',directionRevision:task.directionRevision||1,
        ...(isSwitchMaintenance(task)?{switchOperationId:task.switchOperationId,switchPhase:task.switchPhase,switchHandoffHash:task.switchHandoffHash}:{}),
        ...(storedTask.executionBinding?{originalRoleSnapshot:storedTask.roleSnapshot,executionBinding:storedTask.executionBinding,inputTask:task}:{}),
        discussionProtocol:supportsDiscussion(this.get('workers',nodeId),task.roleSnapshot?.runtime,task.roleSnapshot?.model)?2:0,peerStatus:this.get('workers',nodeId)?.capabilities?.peerStatus===1?1:0,permissionProfile:'business',
        roleSessionId:roleSession?.id||null,resumeNativeSessionId:roleSession?.nativeSessionId||null,resumeNativeSession:roleSession?.nativeSession||null,resumeWorkspace:roleSession?.workspace||null,
        projectScope: true, repositories, attachments: task.attachments || [], execution:task.execution||null,reportRequired:Boolean(task.reportRequired),scheduledJobId:task.scheduledJobId||null,
        repositoryUrl: repositoryId ? this.get('repositories', repositoryId)?.repoUrl : null,
        projectRoot: binding.localRoot, model: task.model, mode: task.mode, status: 'queued', lastSeq: 0, createdAt: now(), updatedAt: now(),
        requestId: task.requestId || null, deliveryId: task.deliveryId || null, continuationRunId: task.continuationRunId || null, planId: task.planId || null, planVersion: task.planVersion || null, stepId: task.stepId || null,
        ...(task.origin === 'chat' ? { roleId: task.roleId, roleSnapshot: task.roleSnapshot, sourceMessageId: task.sourceMessageId, sourceRunId: task.sourceRunId, hop: task.hop || 0 } : {}) };
      if(task.origin==='chat'&&!isSwitchMaintenance(task)) {
        const context=this.get('conversationContexts',`${task.projectId}:${task.conversationId||task.projectId}`);
        const source=task.sourceMessageId?this.get('roomMessages',task.sourceMessageId):null;
        const messages=this.list('roomMessages').filter(message=>message.projectId===task.projectId && (message.conversationId||message.projectId)===(task.conversationId||task.projectId) && message.kind!=='summary');
        const quote=task.quoteMessageId?this.get('roomMessages',task.quoteMessageId):null;
        const request=task.requestId?this.get('coordinationRequests',task.requestId):null;
        run.contextPacket=buildRunContext({run,task:{...task,coordinationKind:request?.kind},role:task.roleSnapshot,
          previousRun:roleSession?.lastRunId?this.get('runs',roleSession.lastRunId):null,
          environment:{cwd:binding.localRoot,repositories:repositories.map(repository=>({key:repository.key,localRoot:repository.localRoot})),attachments:(task.attachments||[]).map(item=>({id:item.id,name:item.name}))},
          conversation:context,organizer:this.get('summaryQueues',`${task.projectId}:${task.conversationId||task.projectId}`),
          messages,deliveries:task.deliveryId?[this.get('deliveries',task.deliveryId)].filter(Boolean):[],
          references:[...(quote?[quote]:[]),...(source&&source.text!==task.prompt&&source.id!==quote?.id?[source]:[])]});
        run.contextVersion=run.contextPacket.context.version;
        run.promptRevision=task.roleSnapshot?.revision||null;
      }
      if(roleSession)new RoleSessions(this).claim(roleSession.id,run.id);
      this.put('runs', run);
      this.put('tasks', { ...storedTask, status: 'in_progress', currentRunId: run.id });
      if (task.requestId) {
        const request = this.get('coordinationRequests', task.requestId);
        if (!request || request.status !== 'queued') throw new Error(tr('store.callWasCancelledItsStatus'));
        this.put('coordinationRequests', { ...request, status: 'running', currentRunId: run.id, updatedAt: now() });
      }
      this.put('commands', { id: commandId, type: 'launch', runId: run.id, nodeId, fingerprint, acked: false, createdAt: now() });
      return run;
    });
  }
  requestStop(runId, commandId) {
    if (!commandId) throw new Error(tr('store.commandidRequired'));
    return this.transaction(() => {
      const r = this.get('runs', runId);
      if (!r) throw new Error(tr('store.runNotFound'));
      const prior = this.get('commands', commandId);
      if (prior && (prior.runId !== runId || prior.type !== 'stop')) throw new Error(tr('store.commandidParameterConflict2'));
      if (terminal.has(r.status)) return r;
      this.put('commands', { id: commandId, type: 'stop', runId, nodeId: r.nodeId, acked: false, createdAt: now() });
      return this.put('runs', { ...r, status: 'stopping', stopRequested: true, updatedAt: now() });
    });
  }
  /** Events are persisted first; status only accepts a larger seq, and a terminal state is never overwritten by progress events. */
  event(event) {
    return this.transaction(() => {
      const r = this.get('runs', event.runId);
      if (!r) throw new Error(tr('store.unknownRun'));
      if (!event.id || !Number.isSafeInteger(event.seq) || event.seq < 1) throw new Error(tr('store.invalidEventId'));
      const e = { ...event, createdAt: event.createdAt || now() };
      const inserted = this.db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?,?)').run(e.id, e.runId, e.seq, JSON.stringify(e));
      if (!inserted.changes) return r;
      if (e.seq <= r.lastSeq) return r;
      const next = { ...r, lastSeq: e.seq, updatedAt: now() };
      if (e.type === 'status' && !terminal.has(r.status)) {
        Object.assign(next, e.payload);
        if(next.status==='running'&&!r.startedAt)next.startedAt=now();
        if(terminal.has(next.status)&&!r.finishedAt)next.finishedAt=now();
        if (r.stopRequested && !terminal.has(next.status) && next.status !== 'reconciling') next.status = 'stopping';
      }
      if (e.type === 'usage') next.usage = e.payload;
      if (e.type === 'status' && e.payload.controlLost) {
        for (const a of this.list('approvals').filter(a => a.runId === r.id && ['pending', 'responding'].includes(a.status))) {
          this.put('approvals', { ...a, status: a.status === 'responding' ? 'unconfirmed' : 'expired' });
        }
      }
      if (e.type === 'message' && e.payload.phase === 'final_answer') next.result = e.payload.text;
      this.put('runs', next);
      if (next.roleSessionId && e.type === 'status' && e.payload.nativeSession?.id) {
        new RoleSessions(this).recordNative(next.roleSessionId,next.id,e.payload.nativeSession,next.workspace);
      }
      if (terminal.has(next.status)) {
        if(next.roleSessionId && !terminal.has(r.status))new RoleSessions(this).release(next.roleSessionId,next.id);
        const task = this.get('tasks', r.taskId);
        if (!r.discussionDeliveryId && task && (!task.currentRunId || task.currentRunId === r.id) && !['done','cancelled'].includes(task.status)) this.put('tasks', { ...task, waitingReason:next.discussionWaiting?task.waitingReason:null,error:next.status==='failed'?next.error||null:null,status:next.discussionWaiting?'waiting_discussion': next.status === 'succeeded' ? (task.origin === 'chat' ? 'completed' : 'awaiting_acceptance') : 'blocked' });
        for (const a of this.list('approvals').filter(a => a.runId === r.id && ['pending', 'responding'].includes(a.status))) this.put('approvals', { ...a, status: 'expired' });
      }
      if (e.type === 'approval' && !terminal.has(next.status)) this.put('approvals', e.payload);
      if (e.type === 'approval_resolved') { const a = this.get('approvals', e.payload.id); if (a) this.put('approvals', { ...a, status: e.payload.status }); }
      return next;
    });
  }
  events(runId, after = 0) { return this.db.prepare('SELECT data FROM events WHERE run_id=? AND seq>? ORDER BY seq').all(runId,after).map(r => JSON.parse(r.data)); }
  /** Manual acceptance only applies to the latest successful execution; a stale page cannot confirm the result of another round. */
  acceptTask(taskId, runId) {
    return this.transaction(() => {
      const task = this.get('tasks', taskId), run = this.get('runs', runId);
      const latest = this.list('runs').filter(r => r.taskId === taskId).at(-1);
      if (!task || !run || latest?.id !== runId || run.status !== 'succeeded') throw new Error(tr('store.onlyLatestSuccessfulExecutionCan'));
      return this.put('tasks', { ...task, status: 'done', acceptedRunId: runId, acceptedAt: now() });
    });
  }
  close() { this.db.close(); }
}
