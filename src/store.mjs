import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {conversationIdOf,resolveConversationId,assertConversationRecord,conversationView} from './group-conversations.mjs';
import { mkdirSync,statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { giteeRepository } from './repository.mjs';
import { roleWorkspace } from './project-repositories.mjs';
import { projectRepositories,assertProjectReady } from './project-space.mjs';
import { projectTerminalLock, terminalOwnsProject } from './terminal-resume.mjs';
import { RoleSessions,taskConversationId } from './role-sessions.mjs';
import { buildRunContext } from './run-context.mjs';
import { steeringWaitReason } from './role-steering.mjs';
import {RoleDiscussions} from './role-discussions.mjs';
import {supportsDiscussion} from './discussion-policy.mjs';
import { tr } from './i18n.mjs';
import {switchSettled,roleSwitchWaitReason,effectiveExecutionRole,isSwitchMaintenance} from './role-switch-policy.mjs';
import {syncError} from './source-sync-manifest.mjs';
import {sourceInputWaitReason,sourceConflictContext} from './source-sync-input.mjs';
import {ProactiveFollowup,followupFor,privateFollowup} from './proactive-followup.mjs';
import {reviewView} from './collaboration-sessions.mjs';
import {tagMessage,SessionQueue,reservePropagation,settlePropagation} from './session-queue.mjs';
import { permissionScopeIssue } from './role-permissions.mjs';

export const terminal = new Set(['succeeded', 'failed', 'interrupted']);
const now = () => new Date().toISOString();
// Match the existing !command.result rule, including legacy null/false/zero/empty results.
const pendingSourceCommand = "COALESCE(json_extract(data,'$.result'),0) IN (0,'')";
const activeRun = "COALESCE(json_extract(data,'$.status'),'') NOT IN ('succeeded','failed','interrupted')";
const chatTask = "json_extract(data,'$.origin')='chat' AND json_extract(data,'$.status') IN ('ready','in_progress')";
const schedulableRequest = "json_extract(data,'$.status') IN ('queued','waiting_call','waiting_delivery')";
const pendingCallResult = "json_extract(data,'$.status') IN ('running','queued')";
const unresolvedRecovery = "COALESCE(json_extract(data,'$.state'),'')!='resolved'";

/** SQLite is the persistent record kept separately by Home and each Worker; files are not shared across machines. */
export class Store {
  constructor(file) {
    this.file=file;
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,seq INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id,seq);
      CREATE TABLE IF NOT EXISTS room_message_receipts(seq INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT NOT NULL UNIQUE,project_id TEXT NOT NULL,received_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS room_receipts_project ON room_message_receipts(project_id,seq);
      CREATE INDEX IF NOT EXISTS records_kind_project ON records(kind,json_extract(data,'$.projectId'));
      CREATE INDEX IF NOT EXISTS records_source_command_batch ON records(json_extract(data,'$.projectId'),json_extract(data,'$.batchId')) WHERE kind='sourceSyncCommands';
      CREATE INDEX IF NOT EXISTS records_source_command_pending ON records(json_extract(data,'$.projectId'),json_extract(data,'$.nodeId')) WHERE kind='sourceSyncCommands' AND ${pendingSourceCommand};
      CREATE INDEX IF NOT EXISTS records_active_runs ON records(json_extract(data,'$.nodeId')) WHERE kind='runs' AND ${activeRun};
      CREATE INDEX IF NOT EXISTS records_chat_tasks ON records(id) WHERE kind='tasks' AND ${chatTask};
      CREATE INDEX IF NOT EXISTS records_schedulable_requests ON records(id) WHERE kind='coordinationRequests' AND ${schedulableRequest};
      CREATE INDEX IF NOT EXISTS records_pending_call_results ON records(id) WHERE kind='coordinationRequests' AND ${pendingCallResult};
      CREATE INDEX IF NOT EXISTS records_conflict_runs ON records(json_extract(data,'$.sourceConflictId')) WHERE kind='runs' AND json_extract(data,'$.sourceConflictId') IS NOT NULL;
      CREATE INDEX IF NOT EXISTS records_unresolved_recoveries ON records(id) WHERE kind='cliRecoveries' AND ${unresolvedRecovery};
      CREATE INDEX IF NOT EXISTS records_native_driver_read ON records(json_extract(data,'$.projectId'),json_extract(data,'$.roleId'),json_extract(data,'$.nativeSession.id')) WHERE kind='runs';`);
  }
  get(kind, id) { const r = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, id); return r ? JSON.parse(r.data) : null; }
  /** Admission uses the result-store filesystem, never a remote workspace or a caller-provided path. */
  readResultFreeBytes(){
    if(this.file===':memory:')return Infinity;
    const info=statfsSync(dirname(this.file));return info.bavail*info.bsize;
  }
  list(kind) { return this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind).map(r => JSON.parse(r.data)); }
  /** Read one role/session with a hard row budget; omitted history is unknown, never proof of idle. */
  readNativeDriverRecords(binding,{limit=100}={}){
    if(!binding?.projectId||!binding.roleId||!binding.taskId||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('invalid_read_request');
    // A legacy prior Run is already unique; forcing the native-session index scans its role history.
    if(!binding.nativeSessionId){
      const record=this.get('runs',binding.priorRunId||'');
      const matches=record&&record.id!==binding.runId&&record.projectId===binding.projectId&&record.roleId===binding.roleId
        &&(!binding.roleSessionId||!record.roleSessionId||record.roleSessionId===binding.roleSessionId);
      return {records:matches?[record]:[],partial:false};
    }
    const conditions=["kind='runs'","json_extract(data,'$.projectId')=?","json_extract(data,'$.roleId')=?"],params=[binding.projectId,binding.roleId];
    conditions.push("json_extract(data,'$.nativeSession.id')=?");params.push(binding.nativeSessionId);
    if(binding.runId){conditions.push('id!=?');params.push(binding.runId);}
    if(binding.roleSessionId){conditions.push("(json_extract(data,'$.roleSessionId') IS NULL OR json_extract(data,'$.roleSessionId')=?)");params.push(binding.roleSessionId);}
    const rows=this.db.prepare(`SELECT data FROM records INDEXED BY records_native_driver_read WHERE ${conditions.join(' AND ')} ORDER BY rowid DESC LIMIT ?`).all(...params,limit+1);
    return {records:rows.slice(0,limit).reverse().map(r=>JSON.parse(r.data)),partial:rows.length>limit};
  }
  /** Poll only live scheduling candidates; unknown Run states still reserve capacity, and history stays intact. */
  activeRuns(nodeId) {
    return this.db.prepare(`SELECT data FROM records INDEXED BY records_active_runs WHERE kind='runs' AND ${activeRun}${nodeId===undefined?'':" AND json_extract(data,'$.nodeId')=?"} ORDER BY rowid`).all(...(nodeId===undefined?[]:[nodeId])).map(r=>JSON.parse(r.data));
  }
  chatTasks(statuses=['ready','in_progress']) {
    return this.db.prepare(`SELECT data FROM records INDEXED BY records_chat_tasks WHERE kind='tasks' AND ${chatTask} ORDER BY rowid`).all().map(r=>JSON.parse(r.data)).filter(t=>statuses.includes(t.status));
  }
  schedulableRequests() {
    return this.db.prepare(`SELECT data FROM records INDEXED BY records_schedulable_requests WHERE kind='coordinationRequests' AND ${schedulableRequest} ORDER BY rowid`).all().map(r=>JSON.parse(r.data));
  }
  /** Missed terminal receipts still settle queued/running requests, without polling completed history. */
  pendingCallResults() {
    return this.db.prepare(`SELECT data FROM records INDEXED BY records_pending_call_results WHERE kind='coordinationRequests' AND ${pendingCallResult} ORDER BY rowid`).all().map(r=>JSON.parse(r.data));
  }
  conflictRuns() {
    return this.db.prepare("SELECT data FROM records INDEXED BY records_conflict_runs WHERE kind='runs' AND json_extract(data,'$.sourceConflictId') IS NOT NULL ORDER BY rowid").all().map(r=>JSON.parse(r.data)).filter(r=>r.sourceConflictId);
  }
  unresolvedRecoveries() {
    return this.db.prepare(`SELECT data FROM records INDEXED BY records_unresolved_recoveries WHERE kind='cliRecoveries' AND ${unresolvedRecovery} ORDER BY rowid`).all().map(r=>JSON.parse(r.data));
  }
  /** Organizer idle checks need an insertion-ordered cursor, not every conversation's message bodies. */
  latestConversationMessageId(projectId,conversationId) {
    return this.db.prepare("SELECT id FROM records WHERE kind='roomMessages' AND json_extract(data,'$.projectId')=? AND CASE WHEN COALESCE(json_extract(data,'$.conversationId'),0) IN (0,'') THEN json_extract(data,'$.projectId') ELSE json_extract(data,'$.conversationId') END=? AND COALESCE(json_extract(data,'$.kind'),'')!='summary' ORDER BY rowid DESC LIMIT 1").get(projectId,conversationId)?.id||null;
  }
  /** Project-local sync metadata must not scan or serialize other projects' full manifests. */
  listProject(kind,projectId) {return this.db.prepare("SELECT data FROM records WHERE kind=? AND json_extract(data,'$.projectId')=? ORDER BY rowid").all(kind,projectId).map(r=>JSON.parse(r.data));}
  /** Filter before materializing manifest bodies; keep history and the existing row order intact. */
  listSourceSyncCommands({projectId,batchId,nodeId,repositoryId,action,pending=false}={}) {
    const conditions=["kind='sourceSyncCommands'"],params=[];
    if(pending)conditions.push(pendingSourceCommand);
    for(const [key,value] of Object.entries({projectId,batchId,nodeId,repositoryId,action}))if(value!==undefined){conditions.push(`json_extract(data,'$.${key}')=?`);params.push(value);}
    // Without statistics SQLite may prefer the general kind index and parse every historical manifest.
    const index=pending?'records_source_command_pending':'records_source_command_batch';
    return this.db.prepare(`SELECT data FROM records INDEXED BY ${index} WHERE ${conditions.join(' AND ')} ORDER BY rowid`).all(...params).map(r=>JSON.parse(r.data));
  }
  /** Page small transport records first; never parse historical receipt bodies just to select work. */
  sourceReceiptTransports({ready=true,at=Date.now(),limit=16,exclude=[]}={}) {
    const due=ready?'nextReceiptAt':'nextRecoveryAt';
    const conditions=["t.kind='sourceSyncTransport'",`COALESCE(json_extract(t.data,'$.ready'),0)=${ready?1:0}`,
      `COALESCE(json_extract(t.data,'$.${due}'),0)<=?`,"EXISTS (SELECT 1 FROM records r WHERE r.kind='sourceSyncReceipts' AND r.id=t.id)"];
    if(!ready)conditions.push("json_extract(t.data,'$.message.commandId') IS NOT NULL","COALESCE(json_extract(t.data,'$.recoveryAttempts'),0)<5");
    if(exclude.length)conditions.push(`t.id NOT IN (${exclude.map(()=>'?').join(',')})`);
    return this.db.prepare(`SELECT t.data FROM records t WHERE ${conditions.join(' AND ')} ORDER BY COALESCE(json_extract(t.data,'$.${due}'),0),t.rowid LIMIT ?`).all(at,...exclude,limit).map(r=>JSON.parse(r.data));
  }
  put(kind, value) {
    if(kind==='roomMessages')return this.transaction(()=>{
      const previous=this.get(kind,value.id);
      if(!previous)value=tagMessage(this,value); // Session tagging from existing links; no-op while the project flag is off.
      if(!previous)this.db.prepare('INSERT OR IGNORE INTO room_message_receipts(message_id,project_id,received_at) VALUES(?,?,?)').run(value.id,value.projectId,now());
      this.db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind,value.id,JSON.stringify(value));
      if(!previous&&value.collaborationSessionId)new SessionQueue(this,{now:this.queueNow||Date.now}).register(value); // no-op unless the session opted into broadcast
      return value;
    });
    this.db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind, value.id, JSON.stringify(value));return value;
  }
  /** A monotonic Home receipt survives edits, imports, deletion and restarts without trusting a device timestamp. */
  messageCursor(projectId,conversationId=projectId){return this.db.prepare("SELECT COALESCE(MAX(m.seq),0) AS seq FROM room_message_receipts m JOIN records r ON r.kind='roomMessages' AND r.id=m.message_id WHERE m.project_id=? AND COALESCE(NULLIF(json_extract(r.data,'$.conversationId'),''),m.project_id)=?").get(projectId,conversationId).seq;}
  messageArrivals(projectId,after,conversationId=projectId){return this.db.prepare("SELECT r.data,m.seq,m.received_at FROM room_message_receipts m JOIN records r ON r.kind='roomMessages' AND r.id=m.message_id WHERE m.project_id=? AND m.seq>? AND COALESCE(NULLIF(json_extract(r.data,'$.conversationId'),''),m.project_id)=? ORDER BY m.seq").all(projectId,after,conversationId).map(r=>({...JSON.parse(r.data),receiptSeq:r.seq,receivedAt:r.received_at}));}
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
  updateProject(id, { name, description = '', repoUrl = '', collaborationWaitReleaseMinutes }) {
    assertProjectReady(this,id);
    const p = this.get('projects', id); if (!p) throw new Error(tr('store.projectNotFound'));
    if (typeof name !== 'string' || !name.trim()) throw new Error(tr('store.projectNameRequired2'));
    if (typeof description !== 'string' || description.length > 12000) throw new Error(tr('store.descriptionMustBeAtMost'));
    // Omitted keeps the saved value; older clients that do not send it cannot reset it.
    if (collaborationWaitReleaseMinutes!==undefined && !(Number.isSafeInteger(collaborationWaitReleaseMinutes)&&collaborationWaitReleaseMinutes>=5&&collaborationWaitReleaseMinutes<=1440)) throw new Error(tr('collabWait.invalidMinutes'));
    const repository = giteeRepository(repoUrl);
    return this.put('projects', { ...p, name: name.trim(), description, repoUrl: repository?.url || '', repository,
      ...(collaborationWaitReleaseMinutes!==undefined?{collaborationWaitReleaseMinutes}:{}) });
  }
  deleteProject(id) {
    return this.transaction(() => {
      const project = this.get('projects', id);
      if (!project) throw new Error(tr('store.projectNotFound2'));
      assertProjectReady(this,id);
      if(this.list('roleSwitches').some(op=>op.projectId===id&&(!switchSettled(op)||!op.steps.released)))throw new Error('Project still has an unsettled CLI switch.');
      if(this.listProject('sourceSyncCommands',id).some(c=>!c.result))throw syncError('sync_busy');
      for(const c of this.listProject('sourceSyncCommands',id))this.put('sourceSyncTombstones',{id:c.id,nodeId:c.nodeId,projectId:id,generation:c.generation,deletedAt:now()});
      for(const kind of ['sourceSyncConfigs','sourceSyncManifests','sourceSyncVersions','sourceSyncDevices','sourceSyncBatches','sourceSyncConflicts','sourceSyncConflictHistory','sourceSyncCandidates','sourceSyncProvenance','sourceSyncCommands','sourceSyncReceipts','sourceSyncUploads','sourceSyncUploadReceipts','sourceSyncWatchStates','sourceSyncWatchNotices'])for(const r of this.listProject(kind,id))this.remove(kind,r.id);
      if(this.list('discussionThreads').some(t=>t.projectId===id&&t.status==='open')
        ||this.list('discussionDeliveries').some(d=>d.projectId===id&&['queued','dispatched','runtime_accepted','reconciling'].includes(d.status))
        ||this.list('discussionIntents').some(i=>i.projectId===id&&i.status==='queued'))throw new Error(tr('store.projectStillHasUnfinishedDiscussions'));
      if(this.list('terminalSessions').some(s=>terminalOwnsProject(this,s,id)))throw new Error(tr('store.projectStillUnderManualTerminal'));
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
      for (const c of this.listProject('groupConversations',id)) this.remove('groupConversations',c.id);
      for(const followup of this.listProject('proactiveFollowups',id))this.remove('proactiveFollowups',followup.id);
      // Only explicit project deletion releases its private read evidence; there is no background eviction.
      const readOperations=this.listProject('readOperations',id),readUsage=this.get('readStorageUsage','home');
      if(readUsage)this.put('readStorageUsage',{...readUsage,
        usedBytes:Math.max(0,readUsage.usedBytes-readOperations.reduce((sum,r)=>sum+(r.resultBytes||0),0)),
        reservedBytes:Math.max(0,readUsage.reservedBytes-readOperations.reduce((sum,r)=>sum+(r.reservedBytes||0),0))});
      for(const operation of readOperations){this.remove('readOperations',operation.id);this.remove('readResults',operation.id);}
      this.remove('projectReadAccess',id);
      for(const binding of this.listProject('readWorkspaceBindings',id))this.remove('readWorkspaceBindings',binding.id);
      for(const kind of ['cliRecoveries','cliRecoveryDecisions'])for(const record of this.list(kind).filter(r=>r.projectId===id))this.remove(kind,record.id);
      this.db.prepare('DELETE FROM room_message_receipts WHERE project_id=?').run(id);
      for (const r of this.list('roles').filter(r => r.projectId === id)) this.remove('roles', r.id);
      for (const w of this.list('workspaces').filter(w => w.projectId === id)) this.remove('workspaces', w.id);
      for (const g of this.list('gitChecks').filter(g => g.projectId === id)) this.remove('gitChecks', g.id);
      if (this.list('setupProposals').some(p => p.projectId === id && p.status === 'running')) throw new Error(tr('store.projectSetupOperationStillRunning'));
      for (const kind of ['repositories', 'repositoryWorkspaces', 'repositoryOperations', 'setupProposals', 'rolePromptChanges', 'supervisorConfigs', 'coordinationRequests', 'deliveries', 'plans', 'planVersions', 'planSteps', 'reports', 'executionPlans', 'attachments', 'scheduledJobs', 'scheduledOccurrences', 'timerActions', 'runReports', 'reportSubmissions', 'runAlerts', 'projectGitVersions', 'roleSessions']) {
        for (const record of this.list(kind).filter(r => r.projectId === id)) this.remove(kind, record.id);
      }
      this.remove('rooms', id);
      for(const room of this.listProject('rooms',id))this.remove('rooms',room.id);
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
      const storedTask = new ProactiveFollowup(this).prepareStart(taskId);
      if(!storedTask&&this.get('tasks',taskId))return null;
      if (!storedTask) throw new Error(tr('store.taskNotFound'));
      assertProjectReady(this,storedTask.projectId);
      const task = storedTask.executionBinding ? {...storedTask,roleSnapshot:effectiveExecutionRole(this,storedTask),model:effectiveExecutionRole(this,storedTask).model} : storedTask;
      const conversationId=resolveConversationId(this,task.projectId,task.conversationId);
      if(conversationId!==task.projectId&&this.get('workers',nodeId)?.capabilities?.groupConversations!==1)throw new Error(tr('conversations.workerUpgrade'));
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
      // Freeze the role's saved scope for this execution; switch maintenance keeps its own read-only boundary.
      const permissionScope = task.origin==='chat'&&!isSwitchMaintenance(task) ? (this.get('roles', task.roleSnapshot?.id||task.roleId)?.permissionScope ?? task.roleSnapshot?.permissionScope) : undefined;
      if (permissionScope !== undefined) { const issue = permissionScopeIssue(this.get('workers', nodeId), task.roleSnapshot?.runtime || 'codex', permissionScope); if (issue) throw new Error(tr(`rolePermissions.${issue}`, { scope: permissionScope })); }
      const repositories = projectRepositories(this, task.projectId, nodeId).filter(r=>!task.execution?.repositoryKeys||task.execution.repositoryKeys.includes(r.key));
      if (!task.roleSnapshot?.systemSupervisor && repositories.some(repo => !repo.localRoot)) throw new Error(tr('store.projectRepositoriesOnDeviceNot'));
      const sourceWait=sourceInputWaitReason(this,task,nodeId);if(sourceWait)throw syncError(sourceWait);
      if (!reservePropagation(this, task)) return null;
      const roleSession = isSwitchMaintenance(task) ? this.get('roleSessions',task.switchSessionId) : task.origin === 'chat' && (task.roleSnapshot?.id || task.roleId)
        ? new RoleSessions(this).getOrCreate({projectId:task.projectId,conversationId:taskConversationId(task),groupConversationId:conversationId,
          roleId:task.roleSnapshot?.id||task.roleId,nodeId,runtime:task.roleSnapshot?.runtime||'codex',model:task.model,workspaceRoot:binding.localRoot}) : null;
      const run = { id: randomUUID(), taskId, projectId: task.projectId, conversationId, sessionConversationId:taskConversationId(task), nodeId, repositoryId,turnPurpose:'task',directionRevision:task.directionRevision||1,
        collaborationSessionId:task.collaborationSessionId||null,collaborationCycleId:task.collaborationCycleId||null,
        continuationBatchId:task.continuationBatchId||null,...(task.explicitPublish?{explicitPublish:true}:{}),
        ...(task.automaticPropagation&&!task.collaborationBatchId?{propagationBudget:'reserved',explicitPublish:true}:{}),
        ...(followupFor(this,task)?{proactiveFollowup:followupFor(this,task),backgroundFollowup:privateFollowup(this,task)}:{}),
        ...(isSwitchMaintenance(task)?{switchOperationId:task.switchOperationId,switchPhase:task.switchPhase,switchHandoffHash:task.switchHandoffHash}:{}),
        ...(storedTask.executionBinding?{originalRoleSnapshot:storedTask.roleSnapshot,executionBinding:storedTask.executionBinding,inputTask:task}:{}),
        sourceInputs:structuredClone(task.sourceInputs||[]),sourceSyncBatchId:task.sourceSyncBatchId||null,
        ...sourceConflictContext(task),
        sourceSyncTracking:Boolean(this.get('sourceSyncConfigs',task.projectId)?.enabled&&this.get('sourceSyncConfigs',task.projectId)?.nodeIds?.includes(nodeId)),
        discussionProtocol:supportsDiscussion(this.get('workers',nodeId),task.roleSnapshot?.runtime,task.roleSnapshot?.model)?2:0,peerStatus:this.get('workers',nodeId)?.capabilities?.peerStatus===1?1:0,permissionProfile:'business',
        roleSessionId:roleSession?.id||null,resumeNativeSessionId:roleSession?.nativeSessionId||null,resumeNativeSession:roleSession?.nativeSession||null,resumeWorkspace:roleSession?.workspace||null,
        projectScope: true, repositories, attachments: task.attachments || [], execution:task.execution||null,reportRequired:Boolean(task.reportRequired),scheduledJobId:task.scheduledJobId||null,
        documentViews:this.get('workers',nodeId)?.capabilities?.sessionQueue===2?1:0,
        repositoryUrl: repositoryId ? this.get('repositories', repositoryId)?.repoUrl : null,
        projectRoot: binding.localRoot, model: task.model, mode: task.mode, status: 'queued', lastSeq: 0, createdAt: now(), updatedAt: now(),
        ...(permissionScope !== undefined ? { permissionScope, permissionContract: 1 } : {}),
        ...(task.collaborationBatchId?{collaborationBatchId:task.collaborationBatchId,collaborationBatch:task.collaborationBatch,explicitPublish:true}:{}),
        requestId: task.requestId || null, deliveryId: task.deliveryId || null, continuationRunId: task.continuationRunId || null, planId: task.planId || null, planVersion: task.planVersion || null, stepId: task.stepId || null,
        ...(task.origin === 'chat' ? { roleId: task.roleId, roleSnapshot: task.roleSnapshot, sourceMessageId: task.sourceMessageId, sourceRunId: task.sourceRunId, hop: task.hop || 0 } : {}) };
      if(task.origin==='chat'&&!isSwitchMaintenance(task)) {
        if(run.backgroundFollowup)run.followupState=this.listProject('tasks',task.projectId).filter(t=>t.id!==task.id&&conversationIdOf(t)===conversationId).slice(-10).map(t=>({taskId:t.id,status:t.status,roleId:t.roleId,runId:t.currentRunId||null,requestId:t.requestId||null,waitingReason:t.waitingReason||null}));
        // Independent review: other reviewers' unreleased opinions never enter this role's new input.
        for(const [kind,id] of [['roomMessages',task.sourceMessageId],['roomMessages',task.quoteMessageId],['runs',task.sourceRunId],['runs',task.continuationRunId],['coordinationRequests',task.requestId]])if(id)assertConversationRecord(run,this.get(kind,id));
        const view=conversationView(reviewView(this,{projectId:task.projectId,roleId:task.roleSnapshot?.id||task.roleId}),run);
        run.reviewGuarded=view.reviewGuarded===true;
        if(run.reviewGuarded&&this.get('workers',nodeId)?.capabilities?.sessionQueue!==2)throw new Error(tr('store.reviewWorkerUpgradeRequired'));
        const context=view.get('conversationContexts',`${task.projectId}:${task.conversationId||task.projectId}`);
        const source=task.sourceMessageId?view.get('roomMessages',task.sourceMessageId):null;
        const messages=view.list('roomMessages').filter(message=>message.projectId===task.projectId && (message.conversationId||message.projectId)===(task.conversationId||task.projectId) && message.kind!=='summary');
        const quote=task.quoteMessageId?view.get('roomMessages',task.quoteMessageId):null;
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
        new SessionQueue(this).attachRequest(this.get('coordinationRequests',request.id));
      }
      if(task.collaborationBatchId){const batch=this.get('sessionBatches',task.collaborationBatchId);
        if(!batch||batch.status!=='reserved')throw new Error(tr('sessionQueue.reservationInvalid'));
        this.put('sessionBatches',{...batch,deliveryAttempted:true,runId:run.id});}
      if(task.continuationBatchId){const batch=this.get('sessionBatches',task.continuationBatchId);
        if(!batch||batch.projectId!==run.projectId||batch.roleId!==run.roleId||!(batch.taskId===task.id||batch.waitingRunId===task.continuationRunId)||!(batch.waitingForDiscussion||batch.waitingForCall))throw new Error(tr('sessionQueue.reservationMismatch'));
        this.put('sessionBatches',{...batch,activeRunId:run.id,waitingForDiscussion:false,waitingForCall:false,continuationRunIds:[...(batch.continuationRunIds||[]),run.id]});}
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
      const next = { ...settlePropagation(this,r,e.type==='status'?e.payload:{}), lastSeq: e.seq, updatedAt: now() };
      if (e.type === 'status' && !terminal.has(r.status)) {
        Object.assign(next, e.payload);
        if(next.status==='running'&&!r.startedAt)next.startedAt=now();
        if(terminal.has(next.status)&&!r.finishedAt)next.finishedAt=now();
        if (r.stopRequested && !terminal.has(next.status) && next.status !== 'reconciling') next.status = 'stopping';
      }
      if (e.type === 'usage') next.usage = e.payload;
      if (e.type === 'context_usage') next.contextUsage = e.payload;
      // Preserve finished business results while accepting the owning Worker's driver-exit facts.
      if(e.type==='status'&&terminal.has(r.status)&&e.payload.runtimeRetained===false&&e.payload.processSettled===true)
        Object.assign(next,{runtimeRetained:false,processSettled:true,driverState:e.payload.driverState,...(e.payload.pid===null?{pid:null,previousPid:e.payload.previousPid||r.pid}:{})});
      if (e.type === 'status' && e.payload.controlLost) {
        for (const a of this.list('approvals').filter(a => a.runId === r.id && ['pending', 'responding'].includes(a.status))) {
          this.put('approvals', { ...a, status: a.status === 'responding' ? 'unconfirmed' : 'expired' });
        }
      }
      if (e.type === 'message' && e.payload.phase === 'final_answer') next.result = e.payload.text;
      if(r.collaborationBatchId&&e.type==='status'){
        const queue=new SessionQueue(this);
        const accepted=e.payload.inputDeliveryState==='accepted'||!r.collaborationBatch.deliveryProtocol&&e.payload.status==='running';
        if(accepted&&!terminal.has(r.status))queue.verify(r.collaborationBatchId,{started:true,runId:r.id})||null;
        if(this.get('sessionBatches',r.collaborationBatchId)?.status==='reserved'&&accepted)queue.confirmStarted(r.collaborationBatchId,{runId:r.id,reservationId:r.collaborationBatch.reservation.id});
      }
      this.put('runs', next);
      if (next.roleSessionId && e.type === 'status' && e.payload.nativeSession?.id) {
        new RoleSessions(this).recordNative(next.roleSessionId,next.id,e.payload.nativeSession,next.workspace);
      }
      if (terminal.has(next.status)) {
        if((next.collaborationBatchId||next.continuationBatchId)&&!terminal.has(r.status)){this.put('runs',next);new SessionQueue(this).finish(next,{queueRejected:Boolean(e.payload.queueRejected||next.inputDeliveryState==='not_delivered'),queueRetryable:e.payload.queueRetryable!==false});}
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
  events(runId, after = 0, limit = -1) { return this.db.prepare('SELECT data FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?').all(runId,after,limit).map(r => JSON.parse(r.data)); }
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
