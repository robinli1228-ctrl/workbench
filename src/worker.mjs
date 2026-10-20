import { WebSocket } from 'ws';
import { randomUUID, createHash } from 'node:crypto';
import { WarmSessions, warmSessionFingerprint } from './warm-sessions.mjs';
import {RoleSwitchWorker,recordSwitchOutput} from './role-switch-worker.mjs';
import {discussionPolicy,validatedDiscussionConfigurations,supportsDiscussion} from './discussion-policy.mjs';
import {inspectArtifactFiles} from './run-artifacts.mjs';
import { writeTurnContext, turnToolCommand } from './turn-context.mjs';
import { hostname, platform, homedir } from 'node:os';
import { readFile, mkdir, realpath, readdir, stat } from 'node:fs/promises';
import {acquireWorkerLock} from './worker-lock.mjs';
import { resolve, dirname, join, relative, isAbsolute, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Store, terminal } from './store.mjs';
import {validateCliCapacity,reservedTerminalSlots} from './device-capacity.mjs';
import { readRunDocument } from './run-document.mjs';
import {readProjectFile,listProjectFiles} from './project-file-read.mjs';
import {budgetReadReply} from './read-query-response.mjs';
import {inspectReadSource,readSourceCurrent} from './cross-device-read-worker.mjs';
import {executeReadQuery,normalizeFileRead,normalizeReadQuery,readError} from './node-query-recipes.mjs';
import { CodexSession } from './codex.mjs';
import { CliPrintSession } from './cli-print-session.mjs';
import { supportedPermissionScopes, workerPermissionScopes, PERMISSION_CONTRACT_VERSION } from './role-permissions.mjs';
import { browseFolders, createFolder, prepareNativeSessionFolder } from './folders.mjs';
import {FolderAccess} from './folder-access.mjs';
import {createWorkerNativeTurns} from './native-turns-worker.mjs';
import {listNativeSessions,readNativeSession,registeredNativeSession,nativeTuiArgs,assertNativeSessionIdle} from './native-sessions.mjs';
import { giteeRepository } from './repository.mjs';
import { inspectRuntimes, runtimeIssue, mergeRuntimeReports } from './runtime-probe.mjs';
import { writeHandoff } from './wb-tools.mjs';
import {handoffReadPaths} from './handoff-paths.mjs';
import { resolveNodeKind } from './node-kind.mjs';
import { normalizeRemoteDesktopUrl } from './remote-desktop.mjs';
import { validateLaunch, afterProcessExit, recordDeliveryResult, recoverDeliveryCommands, continuationSource } from './worker-coordinator.mjs';
import {CliSessionRecovery,driverIdentity} from './cli-session-recovery.mjs';
import { publishDelivery, receiveDelivery } from './git-delivery.mjs';
import { composeAgentInstructions, englishExecutionRules } from './platform-prompts.mjs';
import { runtimeGuidance } from './runtime-guidance.mjs';
import { prepareSupervisorDirectory, setupRepository } from './setup-workspace.mjs';
import { startAgentBridge, agentProcessEnv, canSendAgentOperation, agentOperationBlock } from './agent-bridge.mjs';
import { QueueSlots,terminalDeliveryFacts } from './session-queue-worker.mjs';
import { TurnStates } from './session-queue-adapters.mjs';
import { outboxBatch } from './worker-outbox.mjs';
import { prepareProjectSpace } from './project-space.mjs';
import { publishProjectDelivery, receiveProjectDelivery, fetchExecutionDeliveries } from './project-delivery.mjs';
import { collectCcusageReport } from './token-usage.mjs';
import { scopedTerminalArgs, nativeEnvironment, findSessionHistory, projectTerminalLock, nativeTerminalProject, managedRunProcessState, releaseTerminalSession, checkTerminalSession, stopTerminalSession, resumeEnvironment, freshTerminalArgs } from './terminal-resume.mjs';
import { receiveAttachments } from './attachments.mjs';
import {statMedia,streamMedia,hashMedia,receiveMedia} from './media-files.mjs';
import {inspectWorkspaceGit} from './workspace-git.mjs';
import { inspectExecutionRepositories, prepareExecutionWorkspace, executionConflict, verifyExecutionVersions,resolveExecutionRepositories,inspectExecutionInput,assertExecutionInputVersions,executionInputBaselines } from './execution-workspace.mjs';
import { createRunInput, instructionDelivery,executionInstructionComponents,executionEnvironmentHint } from './run-input.mjs';
import { inspectGitRepositoryVersion } from './git-version.mjs';
import { prepareProjectBaseline, advanceProjectBaseline } from './project-baseline.mjs';
import { runOrganizer } from './conversation-organizer.mjs';
import { runtimeGitEnvironment, nativeGitConfigKey } from './hosting.mjs';
import { tr, getLanguage, setLanguage, initLanguage, runWithLanguage } from './i18n.mjs';
import { executionText, traditionalInput } from './input-language.mjs';
import {SourceSyncClient} from './source-sync-transport.mjs';
import {syncError} from './source-sync-manifest.mjs';
import {SourceProvenanceTracker} from './source-sync-provenance.mjs';
import {prepareSourceInputs,sourceOverlayUnchanged} from './source-sync-input.mjs';
import {captureSourceCandidate,captureDirectoryCandidate} from './source-sync-candidate.mjs';
import {readSourceBlob} from './source-sync-files.mjs';
import {recordSourceBinding} from './source-sync-scopes.mjs';
import {readSoftwareVersion} from './software-version.mjs';

const SYSTEM_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const exec = promisify(execFile);
const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const softwareVersion=await readSoftwareVersion(base);
const data = resolve(process.env.WORKER_DATA_DIR || join(base, '.data/worker'));
initLanguage(data); // saved language (data/language.json, written when Home announces its language); WB_LANGUAGE is only the first-run default
await mkdir(data, { recursive: true, mode: 0o700 });
// Acquire ownership before opening business state; the lock module releases only this process's receipt on exit.
acquireWorkerLock(data);
const db = new Store(join(data, 'worker.sqlite'));
const identity = db.get('identity', 'node') || db.put('identity', { id: 'node', nodeId: process.env.NODE_ID || randomUUID() });
// External session queue: turn facts per role session and short-lived reservations; nothing here writes to a CLI.
const turnStates = new TurnStates({ nodeId: identity.nodeId }), queueSlots = new QueueSlots();
const roots = await Promise.all((process.env.WORKER_ROOTS || base).split(delimiter).map(p => realpath(p)));
const folderAccess=new FolderAccess({db,roots,nodeId:identity.nodeId,local:resolveNodeKind(process.env.NODE_KIND,platform())==='local'});
let defaultRoot = db.get('settings','workspace')?.localRoot || process.env.WORKSPACE_ROOT || roots[0];
const homeUrl = process.env.HOME_URL || 'ws://127.0.0.1:4317/worker';
const token = process.env.WORKER_TOKEN || (await readFile(join(base, '.data/home/worker-token'), 'utf8')).trim();
const sessions = new Map();
let organizerRunning = 0;
const organizerControllers = new Set();
let capacity = validateCliCapacity(db.get('settings','cli-capacity')?.capacity??Number(process.env.WORKER_CONCURRENCY||2));
let ws, paused = true, quitting = false, registered = false, readySent = false, reconnectCleanup,cliRecoveryEnabled=false,readToolsEnabled=false;
const eventSent = new Map();
let runtimes = await inspectRuntimes(), probing, runtimeFailures = {}, runtimeRetry = null, runtimeRetryDue = false;
{ const first = mergeRuntimeReports([], runtimes, {}); runtimes = first.runtimes; runtimeFailures = first.failures; if (first.retryMs) scheduleRuntimeRetry(first.retryMs); }
// The first version is still in isolated acceptance testing; only adapters that are explicitly enabled and have version-tested evidence report the capability.
const discussionCapabilities=()=>{
  const bins={codex:process.env.CODEX_BIN||'codex',claude:process.env.CLAUDE_BIN||'claude',grok:process.env.GROK_BIN||'grok',agy:process.env.AGY_BIN||'agy'};
  const configurations=process.env.WB_DISCUSSION_PREVIEW==='1'?validatedDiscussionConfigurations(process.env.WB_DISCUSSION_VALIDATED_CONFIGS,runtimes,bins):[];
  return {discussionProtocol:configurations.length?2:0,discussionRuntimes:[...new Set(configurations.map(c=>c.runtime))],discussionConfigurations:configurations};
};
if(process.env.WB_DISCUSSION_PREVIEW==='1'&&!discussionCapabilities().discussionConfigurations.length)console.warn(tr('worker.discussionPreviewNotEnabledNo'));
async function refreshRuntimes() {
  if (!probing) probing = inspectRuntimes().then(r => { const merged = mergeRuntimeReports(runtimes, r, runtimeFailures); runtimes = merged.runtimes; runtimeFailures = merged.failures; scheduleRuntimeRetry(merged.retryMs); send({ type: 'runtime_report', runtimes,discussionCapabilities:discussionCapabilities() }); return runtimes; }).finally(() => { probing = null; });
  return probing;
}
/** One pending retry at a time; it reuses the single in-flight probe instead of starting another App Server. */
function scheduleRuntimeRetry(ms) {
  clearTimeout(runtimeRetry); runtimeRetry = null;
  runtimeRetryDue = false;
  if (ms) { runtimeRetry = setTimeout(() => { runtimeRetry = null; if (ws?.readyState === 1 && registered) void refreshRuntimes(); else runtimeRetryDue = true; }, ms); runtimeRetry.unref?.(); }
}
const send = m => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); };
const configurationQueries=new Map();
/** This control-channel query is not an agent tool: Home resolves the sender from the registered Worker and Run. */
function currentExecutionConfiguration(runId) {
  return new Promise((resolve,reject)=>{
    if(ws?.readyState!==1)return reject(new Error('Home disconnected before execution configuration was read.'));
    const id=randomUUID(),timer=setTimeout(()=>{configurationQueries.delete(id);reject(new Error('Execution configuration query timed out; no old configuration was used.'));},20000);
    configurationQueries.set(id,{resolve,reject,timer});send({type:'execution_config',id,runId});
  });
}
/** Events are kept until acknowledged; after a reconnect, old events are reconciled first, and only then may Home dispatch new tasks. */
function flushOutbox() {
  if(!registered||ws?.readyState!==1)return;
  const events=db.list('outbox'),now=Date.now();
  for(const event of outboxBatch(events,eventSent,now,{bufferedAmount:ws.bufferedAmount})) {
    send({type:'event',event});eventSent.set(event.id,now);
  }
  if(!events.length&&!readySent){readySent=true;send({type:'ready'});}
}
const warmSessions = new WarmSessions({max:capacity,changed:()=>{send({type:'warm_sessions',sessions:warmSessions.snapshot()});reportCapacity();},retired:(metadata,pid)=>{if(!quitting&&metadata.runId&&db.get('runs',metadata.runId))emit(metadata.runId,'status',{pid:null,previousPid:pid,runtimeRetained:false,processSettled:true,driverState:'exited'});}});
const cliRecovery=new CliSessionRecovery({db,warmSessions,activeSessions:sessions,emit});
const recoveryBinding=m=>({taskId:m.run.taskId||m.task.id,projectId:m.run.projectId,roleId:m.run.roleId,nodeId:identity.nodeId,roleSessionId:m.run.roleSessionId||null,
  nativeSessionId:m.run.resumeNativeSessionId||db.get('runs',m.run.continuationRunId||'')?.nativeSession?.id||null,priorRunId:m.run.continuationRunId||null,runId:m.run.id});
async function checkNativeDriver(m){const binding=recoveryBinding(m);if(!binding.nativeSessionId&&!binding.priorRunId)return;if(!cliRecoveryEnabled){const owned=sessions.get(binding.runId),pid=(owned?.preparing?owned.session:owned)?.proc?.pid;if(cliRecovery.records(binding).some(r=>r.pid!==pid&&!warmSessions.owns(r.pid)&&managedRunProcessState(r)!=='exited'))throw Error(tr('worker.nativeSessionStillHasProcess'));return;}const result=await cliRecovery.check(binding);if(result.state!=='ready'){const error=Error(result.reason||tr('cliRecovery.waiting'));error.code='CLI_RECOVERY_WAIT';error.recovery=result;throw error;}}
/** Slot reservations count before asynchronous preparation; retained processes are reclaimed, never active work. */
let nativeTurns=null;
function occupiedSlots(){return sessions.size+organizerRunning+reservedTerminalSlots(db,identity.nodeId);}
/** Session-page takeover hook (src/native-turns-worker.mjs); idle unless a native session is taken over. */
nativeTurns=createWorkerNativeTurns({db,send:m=>send(m),data,homeHttp:homeUrl.replace(/^ws/i,'http').replace(/\/worker\/?$/,''),token,projectRoot:path=>projectRoot(path),
  isPaused:()=>paused||quitting,runtimes:()=>runtimes,capacity:()=>capacity,occupiedSlots:()=>occupiedSlots(),nodeId:identity.nodeId,changed:()=>reportCapacity(),trim:()=>warmSessions.trim(occupiedSlots())});
function reportCapacity(){send({type:'capacity_state',capacity,usage:{active:sessions.size,retained:warmSessions.snapshot().length,organizer:organizerRunning,terminal:reservedTerminalSlots(db,identity.nodeId)}});}
const terminalStops=new Map();
async function applyCapacity(value) {
  capacity=validateCliCapacity(value);db.put('settings',{id:'cli-capacity',capacity});warmSessions.max=capacity;
  await warmSessions.trim(occupiedSlots());reportCapacity();return {capacity};
}
const roleSwitchWorker=new RoleSwitchWorker({db,warmSessions,activeSessions:sessions,roots:()=>folderAccess.allowedRoots(),runtimes:()=>runtimes,readHistory:async id=>{
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw new Error('Invalid CLI switch history ID.');
  const response=await fetch(homeUrl.replace(/^ws/i,'http').replace(/\/worker\/?$/,'')+`/api/agent/cli-switches/${id}/history`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error('Unable to retrieve CLI switch history.');return response.text();
}});
const inside = (root, path) => { const rel = relative(root, path); return !rel || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel)); };
const sourceSync=new SourceSyncClient({db,data,home:homeUrl.replace(/^ws/i,'http').replace(/\/worker\/?$/,''),send,
  withFolderAccess:(message,command,fn)=>folderAccess.run(message.folderAccess?{...message.folderAccess,scope:`project:${command.projectId}`}:null,fn),
  paused:()=>paused||quitting,
  activeRuns:()=>[...db.activeRuns(),...db.list('sourceSyncOperations')],
  takeoverState:projectId=>Boolean(projectTerminalLock(db,projectId,identity.nodeId)),
  resolveBinding:command=>folderAccess.run(command.folderAccess?{...command.folderAccess,scope:`project:${command.projectId}`}:folderAccess.context.getStore(),async()=>{
    if(command.nodeId!==identity.nodeId)throw syncError('receipt_owner_mismatch');
    const root=await projectRoot(command.root);
    if(command.sourceRunId){const source=db.get('runs',command.sourceRunId),repo=source?.repositories?.find(r=>r.id===command.repositoryId);
      if(source?.projectId!==command.projectId||!repo||await projectRoot(repo.localRoot)!==root)throw syncError('binding_changed');}
    return recordSourceBinding(db,command,root);
  })});

/** The local outbox is written to disk first and deleted only after Home confirms, so "sent" is never treated as "received". */
function queueState(q, excludeRunId) {
  const state=turnStates.state(q.key,{ownerNodeId:q.ownerNodeId,runtime:q.runtime,excludeRunId});
  const active=db.list('runs').some(r=>r.id!==excludeRunId && r.projectId===q.projectId && r.roleId===q.roleId && !terminal.has(r.status));
  return state&&{...state,turnActive:state.turnActive||active,manualTakeover:state.manualTakeover||Boolean(projectTerminalLock(db,q.projectId,identity.nodeId))};
}
function emit(runId, type, payload) {
  recordSwitchOutput(db,runId,type,payload);
  const r = db.get('runs', runId);
  if (!r) return;
  if(type==='status')payload=terminalDeliveryFacts(r,payload);
  const seq = (r.seq || 0) + 1;
  if (type === 'approval') payload = { ...payload, rpcId: payload.id, id: `${runId}:${payload.id}`, runId, status: 'pending' };
  if (type === 'approval_resolved') payload = { ...payload, id: `${runId}:${payload.id}` };
  if(type==='status'&&payload.nativeSession?.id&&r.processIdentity)payload={...payload,processIdentity:{...r.processIdentity,nativeSessionId:payload.nativeSession.id,runtime:payload.nativeSession.runtime}};
  const next = { ...r, seq, ...(type === 'status' ? payload : {}) };
  const event = { id: randomUUID(), runId, seq, type, payload, createdAt: new Date().toISOString() };
  turnStates.observe(runId,type,payload);
  db.transaction(() => { db.put('runs', next); db.put('outbox', event); });
  flushOutbox();
  return event;
}
/** Paths and symlinks are resolved on the execution node; the allowed root directories are checked at registration and on every launch. */
async function projectRoot(path) {
  return folderAccess.resolve(path);
}
/** Match the request's project/native registration, never infer its identity from a requested path. */
function folderEnvelope(m){
 const envelope=m.folderAccess;if(!envelope)return null;
 const input=m.path||m,projectId=m.run?.projectId||m.projectId||input.projectId||(input.managedProjectIds?.length===1?input.managedProjectIds[0]:null);
 const entry=input.entryId?db.get('nativeCatalogEntries',input.entryId):db.list('nativeCatalogEntries').find(e=>e.runtime===input.runtime&&e.sessionId===input.sessionId);
 const nativeScope=input.entryId?`native:${input.entryId}`:entry?`native:${entry.id}`:null;
 const scope=envelope.scope.startsWith('native:')?nativeScope:projectId?`project:${projectId}`:null;
 return scope?{...envelope,scope}:null;
}
/** Writable space must stay under configured or identity-scoped roots; Git uses a worktree at a fixed baseline. */
async function workspace(project, run) {
  const root = await projectRoot(run.projectRoot ?? project.root);
  if (run.execution?.isolated) return prepareExecutionWorkspace(root,run,run.repositories||[]);
  if (run.projectScope) return { folder:root, baseCommit:null };
  const folder = join(root, '.worktrees', `run-${run.id}`);
  await mkdir(join(root, '.worktrees'), { recursive: true });
  const canonicalParent = await realpath(join(root, '.worktrees'));
  if (!inside(root, canonicalParent)) throw new Error(tr('worker.workingDirectoryLinkEscapesAllowed'));
  let head;
  try {
    const top = (await exec('git', ['rev-parse', '--show-toplevel'], { cwd: root })).stdout.trim();
    if (await realpath(top) === root) head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  } catch {}
  if (head) await exec('git', ['worktree', 'add', '-b', `agent/${run.id}`, folder, head], { cwd: root, timeout: 30000 });
  else await mkdir(folder, { recursive: false });
  return { folder, baseCommit: head || null };
}
async function command(m) {
  const c = m.command;
  if (!c?.id || !m.run?.id) throw new Error(tr('worker.commandFieldsIncomplete'));
  const signature = JSON.stringify({ type: c.type, runId: c.runId, decision: c.decision, approvalId: c.approvalId, task: c.type === 'launch' ? m.task : null, projectRoot: c.type === 'launch' ? m.run.projectRoot : undefined,
    roleSnapshot: c.type === 'launch' ? m.run.roleSnapshot : undefined, sourceRunId: c.type === 'launch' ? m.run.sourceRunId : undefined,
    roleSessionId:c.type==='launch'?m.run.roleSessionId:undefined,resumeNativeSessionId:c.type==='launch'?m.run.resumeNativeSessionId:undefined,
    switchOperationId:m.run.switchOperationId,switchPhase:m.run.switchPhase,switchHandoffHash:m.run.switchHandoffHash,
    contextVersion:c.type==='launch'?m.run.contextVersion:undefined,turnPurpose:m.run.turnPurpose,permissionProfile:m.run.permissionProfile,
    requestId: m.run.requestId, continuationRunId: m.run.continuationRunId, deliveryId: c.deliveryId || m.run.deliveryId, deliveryCommit: m.delivery?.commit, planVersion: m.run.planVersion,
    ...(m.run.execution ? {execution:m.run.execution}:{}),...(m.run.sourceInputs?.length?{sourceInputs:m.run.sourceInputs}:{}),...(m.run.attachments?.length ? {attachments:m.run.attachments}:{}),
    ...(m.run.permissionScope!==undefined?{permissionScope:m.run.permissionScope,permissionContract:m.run.permissionContract}:{}) });
  const prior = db.get('commands', c.id);
  if (prior) {
    if (prior.signature !== signature) throw new Error(tr('worker.duplicateCommandParameterConflict'));
    if ((!prior.deferred || db.get('runs',c.runId))&&!db.get('runs',c.runId)?.cliRecoveryWait) {
    if (!db.get('runs', c.runId)) {
      db.put('runs', { id: c.runId, seq: 0 });
      emit(c.runId, 'status', { status: 'reconciling', error: tr('worker.commandWasRegisteredButExecution') });
    }
    send({ type: 'command_ack', id: c.id }); return;
    }
  }
  // Home may have sent a launch just before the limit changed. Keep the same command/session pinned and retry, not fail it.
  if(c.type==='launch'&&!db.get('runs',c.runId)&&occupiedSlots()>=capacity) {
    db.put('commands',{id:c.id,signature,runId:c.runId,type:c.type,deferred:true});
    send({type:'launch_deferred',id:c.id,runId:c.runId});return;
  }
  db.put('commands', { id: c.id, signature, runId: c.runId, type: c.type, deliveryId: c.deliveryId });
  if (c.type === 'launch') {
    const deferred=db.get('runs',c.runId);
    if (deferred&&!deferred.cliRecoveryWait) { send({ type: 'command_ack', id: c.id }); return; }
    // Reconnect and terminal resume retain this run's frozen policy, never the role's mutable current settings.
    db.put('runs', { ...deferred,id: c.runId, projectId: m.run.projectId, nodeId:identity.nodeId,execution:m.run.execution||null,roleId: m.run.roleId,roleSessionId:m.run.roleSessionId, status: 'starting', seq: deferred?.seq||0,cliRecoveryWait:false,error:null,
      ...(m.run.permissionScope!==undefined?{permissionScope:m.run.permissionScope,permissionContract:m.run.permissionContract}:{}),
      collaborationBatchId:m.run.collaborationBatchId||null,collaborationBatch:m.run.collaborationBatch||null,
      collaborationCycleId:m.run.collaborationCycleId||null,propagationBudget:m.run.propagationBudget||null,
      switchOperationId:m.run.switchOperationId,switchPhase:m.run.switchPhase,switchHandoffHash:m.run.switchHandoffHash });
    // Clearing only the Worker record leaves Home retrying the accepted launch and preserving a false terminal wait.
    // Send an ordered transition for this recovery retry; later guards may report a fresh wait, failure or cancellation.
    if(deferred?.cliRecoveryWait)emit(c.runId,'status',{status:'starting',cliRecoveryWait:false,cliRecovery:null,error:null});
    send({ type: 'command_ack', id: c.id });
    let bridge, ending=false,provenance;
    const reservation = { preparing: true, stopRequested: false };
    sessions.set(c.runId,reservation);
    try {
      const policy=discussionPolicy(m.run),discussionTurn=policy.turnPurpose!=='task';
      roleSwitchWorker.assertLaunch(m.run);
      const discussionEnabled=supportsDiscussion({capabilities:discussionCapabilities(),runtimes},m.run.roleSnapshot?.runtime,m.run.roleSnapshot?.model);
      if((discussionTurn||m.run.discussionProtocol===2)&&(!discussionEnabled||m.run.discussionProtocol!==2))throw new Error(tr('worker.discussionProtocolV2NotEnabled'));
      if (paused || m.paused) throw new Error(tr('worker.remoteCommandsPaused'));
      if(!sourceSync.worker.canStart(m.run.projectId))throw syncError('sync_busy');
      if (projectTerminalLock(db,m.run.projectId,identity.nodeId)) throw new Error(tr('worker.projectUnderManualTerminalTakeover'));
      turnStates.begin({...m.run,runtime:m.run.roleSnapshot?.runtime});
      if (m.run.nodeId !== identity.nodeId) throw new Error(tr('worker.assignmentDoesNotBelongMachine'));
      if (m.run.requestId) validateLaunch({ request: m.request, roleSnapshot: m.run.roleSnapshot, delivery: m.delivery, currentPlanVersion: m.run.planVersion });
      const issue = runtimeIssue({ capabilities: { runtimeDiscovery: true }, runtimes }, m.run.roleSnapshot?.runtime || 'codex', m.task.model);
      if (issue) throw new Error(issue);
      await checkNativeDriver(m);
      if(reservation.stopRequested){emit(c.runId,'status',{status:'interrupted',cliRecoveryWait:false,processSettled:true,error:tr('worker.taskHadNotStartedWas')});return;}
      if (db.list('runs').some(r => r.id !== c.runId && r.status === 'reconciling')) throw new Error(tr('worker.workerFullHasProcessesAwaiting'));
      if (executionConflict(m.run,db.list('runs').filter(r=>r.id!==c.runId && !terminal.has(r.status)).map(r=>({...r,nodeId:identity.nodeId})))) throw new Error(tr('worker.projectWorkspaceExclusiveOperationStill'));
      emit(c.runId, 'status', { status: 'starting' });
      if(reservation.stopRequested || paused || ws?.readyState!==1){emit(c.runId,'status',{status:'interrupted',error:tr('worker.interruptedByStopDisconnectWhile')});return;}
      let executionRepositories = m.run.repositories || [];
      for (const repository of executionRepositories) if (repository.localRoot) await projectRoot(repository.localRoot);
      let source;
      if (m.run.deliveryId && (m.delivery?.projectId !== m.run.projectId || m.delivery?.status !== 'ready')) throw new Error(tr('worker.crossDeviceDeliveryDoesNot'));
      if (m.run.sourceRunId && !m.run.deliveryId) {
        source = db.get('runs', m.run.sourceRunId);
        if (source?.projectId !== m.run.projectId || source.status !== 'succeeded' || !source.workspace) throw new Error(tr('worker.referencedExecutionDoesNotBelong'));
        source = { ...source, workspace: await projectRoot(source.workspace) };
      }
      // Read-only reviews inspect the source workspace directly; writing roles use a new workspace and must not overwrite the source output.
      const continued = m.run.continuationRunId ? continuationSource(db, m.run,pid=>warmSessions.owns(pid)) : null;
      const prepared = continued
        ? { folder: await projectRoot(continued.workspace), baseCommit: continued.baseCommit }
        : m.run.resumeWorkspace && !m.run.deliveryId
        ? { folder: await projectRoot(m.run.resumeWorkspace), baseCommit: null }
        : m.run.deliveryId && m.delivery.items
        ? await receiveProjectDelivery(await projectRoot(m.run.projectRoot),c.runId,executionRepositories.map(r=>({...r,credential:m.gitCredentials?.[r.id]})),m.delivery)
        : m.run.deliveryId
        ? await receiveDelivery({ root: await projectRoot(m.run.projectRoot), runId: c.runId, delivery: m.delivery })
        : source && m.task.mode === 'read-only'
        ? { folder: source.workspace, baseCommit: source.baseCommit }
        : m.run.switchOperationId ? {folder:await projectRoot(m.run.resumeWorkspace||m.run.projectRoot),baseCommit:null}
        : await workspace(m.project, m.run);
      const { folder, baseCommit } = prepared;
      if(m.run.resumeNativeSessionId && folder!==m.run.resumeWorkspace)throw new Error(tr('worker.nativeSessionWorkingDirectoryDiffers'));
      executionRepositories = prepared.repositories || continued?.repositories || executionRepositories;
      const nativeHistory=m.run.resumeNativeSessionId&&m.run.roleId?db.readNativeDriverRecords(recoveryBinding(m)).records:[];
      const priorWorkspace=m.run.resumeWorkspace?nativeHistory.findLast(r=>r.id!==c.runId&&r.projectId===m.run.projectId&&r.roleSessionId===m.run.roleSessionId
        &&r.workspace===folder&&r.nativeSession?.id===m.run.resumeNativeSessionId):null;
      executionRepositories=await resolveExecutionRepositories({workspace:folder,projectRoot:m.run.projectRoot??m.project.root,repositories:executionRepositories,
        previousRepositories:continued?.repositories||(source&&m.task.mode==='read-only'?source.repositories:null)||priorWorkspace?.repositories||[],
        resuming:Boolean(continued||m.run.resumeWorkspace&&!m.run.deliveryId||source&&m.task.mode==='read-only')});
      for(const repository of executionRepositories)if(repository.localRoot)await projectRoot(repository.localRoot);
      const inputBaselines=executionInputBaselines(m.run,continued);
      let inputRepositoryVersions=await inspectExecutionInput(executionRepositories,m.run.repositories||[],inputBaselines);
      const workspaceRunId = continued ? continued.workspaceRunId || continued.id : c.runId;
      emit(c.runId, 'status', { status: 'starting', workspace: folder, baseCommit, workspaceRunId, repositories:executionRepositories, projectScope:m.run.projectScope, ...(source ? { sourceWorkspace: source.workspace } : {}) });
      emit(c.runId,'status',{inputRepositoryVersions,inputVersionsObservedAt:new Date().toISOString()});
      // Check before applying overlays or claiming an old workspace, not merely before the model starts.
      assertExecutionInputVersions(inputRepositoryVersions,inputBaselines);
      let sourceInputReceipts=[],sourceInputAccess;
      if(m.run.sourceInputs?.length){
        const get=async(input,hash)=>{const response=await fetch(`${homeUrl.replace(/^ws/i,'http').replace(/\/worker\/?$/,'')}/api/agent/source-inputs/${c.runId}/${input.manifestId}${hash?'/blobs/'+hash:''}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(60000)});if(!response.ok)throw syncError('source_input_not_ready');return hash?Buffer.from(await response.arrayBuffer()):response.json();};
        sourceInputAccess={run:m.run,repositories:executionRepositories,db,blobRoot:sourceSync.blobRoot,readManifest:input=>get(input),fetchBlob:get};
        const inherited=continued?.sourceInputReceipts;
        if(inherited?.length===m.run.sourceInputs.length&&m.run.sourceInputs.every(i=>inherited.some(v=>v.repositoryId===i.repositoryId&&v.manifestHash===i.manifestHash&&v.generation===i.generation)))sourceInputReceipts=inherited.map(i=>({...i,inheritedFrom:continued.id}));
        else sourceInputReceipts=await prepareSourceInputs({...sourceInputAccess,freshIsolated:Boolean(m.run.execution?.isolated&&!continued&&!m.run.resumeWorkspace)});
        inputRepositoryVersions=await inspectExecutionInput(executionRepositories,m.run.repositories||[],inputBaselines);
        emit(c.runId,'status',{inputRepositoryVersions,inputVersionsObservedAt:new Date().toISOString()});
        assertExecutionInputVersions(inputRepositoryVersions,inputBaselines);
      }
      const repositoryRoots = executionRepositories.filter(r=>r.localRoot).map(r=>r.localRoot);
      if (!source || m.task.mode !== 'read-only') db.put('workspaceOwners', { id: folder, runId: c.runId });
      if(m.run.sourceInputs?.length||m.run.sourceConflictId)emit(c.runId,'status',{sourceInputs:m.run.sourceInputs||[],sourceInputReceipts,sourceConflictId:m.run.sourceConflictId||null,sourceConflictGeneration:m.run.sourceConflictGeneration,sourceConflictAssignmentId:m.run.sourceConflictAssignmentId});
      if (reservation.stopRequested || paused || ws?.readyState !== 1) { emit(c.runId, 'status', { status: 'interrupted', error: tr('worker.interruptedByStopDisconnectBefore') }); return; }
      const runtimeType = m.run.roleSnapshot?.runtime || 'codex';
      if (!['codex', 'grok', 'agy', 'claude'].includes(runtimeType)) throw new Error(tr('worker.runtimeNotSupportedYet', { runtimeType }));
      const modelEffort = runtimes.find(r => r.type === runtimeType)?.models?.find(model => model.id === m.task.model)?.effort;
      const effort = m.run.roleSnapshot?.effort || modelEffort || null;
      const Session = runtimeType === 'codex' ? CodexSession : CliPrintSession;
      // The scope was frozen by Home at admission; this Worker re-checks it against its own CLI/OS before any input is sent.
      const permissionScope = m.run.permissionScope ?? null;
      if (permissionScope !== null && !supportedPermissionScopes(runtimeType, platform()).includes(permissionScope)) throw new Error(`Permission scope ${permissionScope} is not supported for ${runtimeType} on this device.`);
      const root = await projectRoot(m.run.projectRoot ?? m.project.root);
      const knowledge = join(m.run.execution?.isolated ? folder : root,'.workbench');
      await mkdir(join(knowledge, 'docs'), { recursive: true });await mkdir(join(knowledge, 'handoffs'), { recursive: true });
      const homeHttp = homeUrl.replace(/^ws/i, 'http').replace(/\/worker\/?$/, '');
      const inputFiles = await receiveAttachments({ items: m.run.attachments, workspace: folder, runId: c.runId, home: homeHttp, token });
      if(inputFiles.length)emit(c.runId,'status',{attachmentFiles:inputFiles});
      if(m.run.reportRequired) {
        const check=await exec(process.execPath,[join(base,'src','wb-cli.mjs'),'capabilities'],{timeout:5000});
        if(JSON.parse(check.stdout).protocol!==2)throw new Error(tr('worker.collaborationToolVersionMismatchUpgrade'));
      }
      if (reservation.stopRequested || paused || ws?.readyState !== 1) { emit(c.runId,'status',{status:'interrupted',error:tr('worker.executionInterruptedByStopDisconnect')});return; }
      bridge = await startAgentBridge({ workspace: folder, runId: c.runId, home: homeHttp, token,
        canSend: (pathname,input) => canSendAgentOperation({paused,quitting,connected:ws?.readyState===1,status:db.get('runs',c.runId)?.status},pathname,input),
        blockReason: (pathname,input) => agentOperationBlock({paused,quitting,connected:ws?.readyState===1,status:db.get('runs',c.runId)?.status},pathname,input) });
      const wbEnv = agentProcessEnv(await runtimeGitEnvironment({directory:join(data,'git-auth'),key:m.run.roleSessionId||c.runId,repositories:executionRepositories,credentials:m.gitCredentials,env:process.env}), {
        PATH: `${join(base, 'bin')}${delimiter}${process.env.PATH || ''}`,
        WB_PROJECT_ROOT: m.run.execution?.isolated ? folder : root,
        WB_KNOWLEDGE: knowledge,
        WB_NODE_ID: identity.nodeId,
        WB_WORKSPACE: folder,
        WB_RUN_ID: c.runId,
        WB_ROLE_SESSION_ID: m.run.roleSessionId || '',
        WB_SOURCE_SYNC:'1',
        WB_READ_TOOLS:readToolsEnabled?'1':'0',
        WB_CONVERSATION_ID: m.run.conversationId || m.run.projectId,
        WB_REQUEST_ID: m.run.requestId || '',
        WB_ROLE: m.run.roleSnapshot?.name || '',
        WB_SYSTEM_SUPERVISOR: m.run.roleSnapshot?.systemSupervisor && !m.run.roleSnapshot?.platformAssistant ? '1' : '0',
        WB_CLI: join(base, 'src', 'wb-cli.mjs'),
        WB_BRIDGE: bridge.directory,
        WB_HOP: String(m.run.hop || m.task?.hop || 0),
        WB_HOME: homeHttp,
        WB_MODE: m.task.mode,
        WB_REVIEW_PRIVATE: m.run.reviewGuarded ? m.run.roleId : '',
        WB_DOCUMENT_VIEWS: m.run.documentViews===1?'1':'0',
        WB_QUEUE_BATCH: m.run.collaborationBatchId||m.run.continuationBatchId?'1':'0',
        WB_LANGUAGE: getLanguage()
      });
      wbEnv.WB_REPOSITORIES = JSON.stringify(executionRepositories);
      wbEnv.WB_TURN_PURPOSE=policy.turnPurpose;
      wbEnv.WB_DISCUSSION_PROTOCOL=m.run.discussionProtocol===2?'2':'0';
      const keepAlive=Boolean(!m.run.switchOperationId && m.run.roleSessionId && ['codex','claude','agy'].includes(runtimeType));
      const explicitTurn=keepAlive&&runtimeType==='agy';
      wbEnv.WB_REQUIRE_TURN=explicitTurn?'1':'0';
      const contextFile=join(bridge.directory,'turn-context.json');
      wbEnv.WB_TURN_CONTEXT=contextFile;
      const wbCommand=turnToolCommand(contextFile,join(base,'src','wb-cli.mjs'),process.execPath,{boundCli:runtimeType==='codex'&&m.run.discussionProtocol===2,...(explicitTurn?{turnId:c.runId}:{})});
      let endRun, finalStatus;
      const ended = new Promise(resolve => { endRun = resolve; });
      const native = await nativeEnvironment(runtimeType);
      if(m.run.resumeNativeSessionId) {
        const prior=m.run.resumeNativeSession;
        if(!prior || prior.id!==m.run.resumeNativeSessionId || prior.runtime!==runtimeType || prior.user!==native.user || prior.home!==native.home)throw new Error(tr('worker.nativeSessionIdentityHasChanged'));
        await findSessionHistory(prior,folder);
        await checkNativeDriver(m);
      }
      db.put('runtimeEnvironments',{id:c.runId,env:resumeEnvironment(wbEnv)});
      if(m.run.sourceSyncTracking){
        const watched=db.get('sourceSyncWatchConfig','main')?.scopes.filter(s=>s.projectId===m.run.projectId)||[];
        const tracking=watched.length?watched.map(s=>({id:s.repositoryId,localRoot:s.root,scopeKind:s.scopeKind,scopePolicy:s.scopePolicy})):executionRepositories;
        provenance=new SourceProvenanceTracker({db,run:{...m.run,workspace:folder},repositories:tracking,blobRoot:sourceSync.blobRoot,
          publish:proof=>emit(c.runId,'source_provenance',proof)});
        const preparationScan=await provenance.start();
        emit(c.runId,'status',{preparationScan});
        emit(c.runId,'log',{text:tr('sourceSync.preparationScan',{scopes:preparationScan.scopes,files:preparationScan.files,seconds:(preparationScan.elapsedMs/1000).toFixed(2),unavailable:preparationScan.unavailableScopes})});
      }
      emit(c.runId, 'status', { nativeSession: native });
      // The turn purpose goes into the dynamic input, so switching between Q&A and business stages does not needlessly recycle the warm process.
      const executionConfiguration=m.run.minimalInstructions===1?await currentExecutionConfiguration(c.runId):null;
      if(reservation.stopRequested||paused||quitting||ws?.readyState!==1)throw new Error(tr('worker.interruptedByStopDisconnectBefore'));
      const components=executionConfiguration?executionInstructionComponents({run:m.run,configuration:executionConfiguration}):undefined;
      const roleInstructions = components?Object.values(components).filter(Boolean).join('\n\n'):traditionalInput(executionText('worker.projectDescriptionRepositoriesForRun', { p1: runWithLanguage('en',()=>composeAgentInstructions(m.platformPrompt,m.run.roleSnapshot?.instructions??'')), p2: String(m.project.description||'').slice(0,4000), p3: executionRepositories.filter(r=>r.localRoot).map(r=>`${r.key}: ${r.localRoot}`).join('\n'), p4: runtimeGuidance(runtimeType), p5: m.task.runtimeInstructions||'' }));
      const priorInput=nativeHistory.findLast(r=>r.id!==c.runId && r.projectId===m.run.projectId && r.roleSessionId===m.run.roleSessionId && r.nativeSession?.id===m.run.resumeNativeSessionId);
      let instructions=instructionDelivery({runtime:runtimeType,run:m.run,prior:priorInput,instructions:roleInstructions,roleName:m.run.roleSnapshot?.name,components});
      const fingerprint=warmSessionFingerprint({folder,runtimeType,model:m.task.model,effort,roleName:m.run.roleSnapshot?.name,roleInstructions,env:{...resumeEnvironment(wbEnv),WB_REQUIRE_TURN:wbEnv.WB_REQUIRE_TURN},permissionScope});
      let session;
      const options={ cwd: folder, writableRoots:repositoryRoots, attachments: inputFiles, model: m.task.model, mode: m.task.mode, effort, runtime: runtimeType, autoApprove: m.run.roleSnapshot?.autoApprove !== false,permissionScope,toolRoots:[base],keepAlive,maintenance:Boolean(m.run.switchOperationId),
        onProcess:proc=>{if(proc?.pid)emit(c.runId,'status',{pid:proc.pid,processIdentity:driverIdentity({...db.get('runs',c.runId),runtime:runtimeType},proc.pid)});},
        beforeInput:async()=>{
          if(m.run.collaborationBatch){const q={...m.run.collaborationBatch,roleId:m.run.roleId};try{await queueSlots.deliver(q.key,q.reservation,queueState(q,c.runId),()=>true);}catch(error){error.queueRetryable=true;throw error;}}
          if(paused||quitting||ws?.readyState!==1||db.get('runs',c.runId)?.stopRequested)throw new Error(tr('worker.interruptedByStopDisconnectBefore'));
          emit(c.runId,'status',{inputDeliveryState:'attempted'});
        },
        resumeSessionId:m.run.resumeNativeSessionId || null,
        inheritInstructions:Boolean(instructions.inheritedFrom),
        minimalInstructions:Boolean(executionConfiguration),instructionMessage:instructions.instructions,configurationUpdate:instructions.configurationUpdate||'',
        roleInstructions,
        roleName: m.run.roleSnapshot?.name, env: wbEnv, emit: (type, p) => {
        if(type==='status'&&p.nativeSessionId&&m.run.resumeNativeSessionId&&p.nativeSessionId!==m.run.resumeNativeSessionId) {
          p={status:'failed',error:tr('worker.afterResumingRuntimeReturnedDifferent')};
          void session.stop();
        }
        if(type==='status' && p.nativeSessionId) p={...p,nativeSession:{...native,id:p.nativeSessionId}};
        if (type === 'status' && terminal.has(p.status)) {
          if (ending) return;
          ending = true;
          const retained=p.status==='succeeded' && session.keepAlive && session.done && !session.stopping && warmSessions.alive(session);
          const warning = retained?null:setTimeout(() => emit(c.runId, 'status', { status: 'reconciling', error: tr('worker.modelTurnHasEndedBut') }), 15000);
          warning?.unref();
          const complete=async () => {
            if(warning)clearTimeout(warning);
            if(p.status==='succeeded'&&!db.get('runs',c.runId)?.nativeSession?.id)
              p={...p,status:'failed',error:tr('worker.runtimeDidNotReturnResumable')};
            if(m.run.execution?.baselines?.length||m.run.sourceInputs?.length) {
              try { p={...p,repositoryVersions:await inspectExecutionRepositories(executionRepositories)}; }
              catch(error) { p={...p,status:'failed',error:tr('worker.unableVerifyExecutionArtifacts', { message: error.message })}; }
            }
            if(sourceInputAccess&&p.repositoryVersions){const unchanged=await sourceOverlayUnchanged(sourceInputAccess).catch(()=>false);
              p={...p,repositoryVersions:p.repositoryVersions.map(v=>({...v,sourceInputVerified:unchanged&&m.run.sourceInputs.some(i=>i.repositoryId===v.id)}))};}
            if(m.run.minimalInstructions===1)p={...p,configurationState:p.status==='succeeded'?'applied':'failed',...(p.error?{configurationError:p.error}:{})};
            finalStatus=p;endRun();
          };
          void (retained?complete():afterProcessExit(session.proc,complete));
        } else {const event=emit(c.runId,type,p);if(type==='tool')provenance?.observe(event);}
      } };
      session=keepAlive?await warmSessions.take(m.run.roleSessionId,fingerprint):null;
      reservation.session=session;
      await warmSessions.trim(occupiedSlots());
      await writeTurnContext(contextFile,wbEnv);
      if(reservation.stopRequested || paused || quitting || ws?.readyState!==1) {
        session?.shutdown();await afterProcessExit(session?.proc,()=>{});
        await bridge.stop();bridge=null;sessions.delete(c.runId);
        emit(c.runId,'status',{status:'interrupted',error:tr('worker.interruptedByStopDisconnectBefore2')});return;
      }
      if(session && !warmSessions.alive(session)){await afterProcessExit(session.proc,()=>{});session=null;}
      const sessionReuse=session?'process':m.run.resumeNativeSessionId?'resume':'new';
      if(session)instructions=instructionDelivery({runtime:runtimeType,run:m.run,prior:priorInput,instructions:roleInstructions,roleName:m.run.roleSnapshot?.name,processReused:true,components});
      if(session)session.reuse(options);else session=new Session(options);
      sessions.set(c.runId, session);
      emit(c.runId,'status',{sessionReuse,instructionFingerprint:instructions.fingerprint,instructionsInheritedFrom:instructions.inheritedFrom,
        ...(executionConfiguration?{instructionVersions:executionConfiguration.versions,instructionComponents:instructions.components,configurationState:'starting',...(instructions.configurationEventProtocol?{configurationEventProtocol:instructions.configurationEventProtocol}:{})}:{})});
      const context = source ? executionText('worker.referencedExecutionSFilesLocated', { workspace: source.workspace, p2: source.baseCommit || executionText('worker.plainDirectory'), p3: source.workspace === folder && m.run.projectScope ? executionText('worker.currentDirectorySharedDirectorySame') : m.task.mode === 'read-only' ? executionText('worker.currentDirectorySourceWorkspacePerform') : executionText('worker.directoryReadOnlyChangesFor') }) : '';
      const setupHint = !m.run.switchOperationId && m.run.roleSnapshot?.systemSupervisor ? executionText('worker.supervisorSetupToolsCanBe', { wbCommand }) : '';
      const boundary = m.run.projectScope && !m.run.deliveryId && !m.run.execution?.isolated ? executionText('worker.projectDirectoryCurrentDirectoryListed', { root }) : executionText('worker.originalProjectDirectoryItMay', { root });
      const attachmentHint = inputFiles.length ? executionText('worker.userAttachmentsForTurnUntrusted', { p1: inputFiles.map(a => JSON.stringify({name:a.name,path:a.path,mime:a.mime})).join('\n') }) : '';
      const toolGuide=executionConfiguration?executionText('minimal.toolEntry',{wbCommand}):[executionText('worker.wbCommandPrefixForTurn', { wbCommand }),(m.run.sourceSyncTracking||m.run.sourceConflictId||m.run.sourceConflictPeerId||m.run.sourceConflictAssignmentRequestId)?executionText('sourceSync.toolGuide'):''].filter(Boolean).join('\n\n');
      const taskPrompt=[m.task.prompt,executionConfiguration?.dependencyEvents?.length?executionText('minimal.dependencyEvent',{events:JSON.stringify(executionConfiguration.dependencyEvents)}):''].filter(Boolean).join('\n\n');
      const environmentHint=executionEnvironmentHint({cwd:folder,projectRoot:root,boundary,repositories:executionRepositories,inputRepositoryVersions});
      const input = createRunInput({ minimal:Boolean(executionConfiguration),environmentHint,configurationUpdate:instructions.configurationUpdate,taskPrompt, boundary, context, runtimeGuidance:toolGuide, setupHint, attachmentHint,
        executionInstructions:m.run.switchOperationId?'Read-only CLI handoff maintenance. Return the requested final answer; do not execute business work or write handoff files.':englishExecutionRules(m.run,{minimal:Boolean(executionConfiguration)}),roleInstructions:instructions.instructions,sourceInputs:sourceInputReceipts });
      if(instructions.inheritedFrom)input.instructionsInheritedFrom=instructions.inheritedFrom;
      await checkNativeDriver(m);
      if(db.get('runs',c.runId)?.stopRequested||session.stopping||paused||quitting||ws?.readyState!==1){session.shutdown();await afterProcessExit(session.proc,()=>{});await provenance?.finish();sessions.delete(c.runId);emit(c.runId,'status',{status:'interrupted',cliRecoveryWait:false,processSettled:true,error:tr('worker.interruptedByStopDisconnectBefore2')});return;}
      emit(c.runId, 'input', input);
      const result = session.start(input.prompt);
      await result;
      await ended;
      await provenance?.finish();
      await bridge.stop(); bridge = null;
      const rec = {...db.get('runs', c.runId),...finalStatus};
      try {
        if(!discussionTurn&&!m.run.switchOperationId)await writeHandoff({
          auto: true,
          done: rec.result || rec.error || tr('worker.turnStatus', { p1: rec.status || 'ended' }),
          next: rec.status === 'succeeded' ? tr('worker.nextRoleShouldFirstRun') : tr('worker.turnDidNotSucceedCheck'),
          blocked: rec.status === 'succeeded' ? tr('worker.none') : (rec.error || rec.status || tr('worker.unsuccessful'))
        }, {
          knowledge,
          nodeId:identity.nodeId,
          roleSessionId:m.run.roleSessionId||'',
          reviewPrivate:m.run.reviewGuarded?m.run.roleId:'',
          projectRoot: root,
          workspace: folder,
          runId: c.runId,
          role: m.run.roleSnapshot?.name || ''
        });
      } catch (error) {
        emit(c.runId, 'log', { text: tr('worker.writtenHandoffWasNotRecorded', { message: error.message }) });
      }
      if(finalStatus?.status==='succeeded' && keepAlive && !paused && !quitting && !session.stopping) {
        sessions.delete(c.runId);
        warmSessions.keep(m.run.roleSessionId,fingerprint,session,{projectId:m.run.projectId,roleId:m.run.roleId,runtime:runtimeType,runId:c.runId});
        await warmSessions.trim(occupiedSlots());
      } else {session.shutdown();await afterProcessExit(session.proc,()=>{});sessions.delete(c.runId);}
      emit(c.runId,'status',{...finalStatus,runtimeRetained:warmSessions.owns(session.proc?.pid),processSettled:!warmSessions.owns(session.proc?.pid),...(m.run.discussionProtocol===2?{discussionCleanup:{turnEnded:true,toolsClosed:true,effectsKnown:false}}:{})});
    } catch (e) {
      ending=true;
      await provenance?.finish();
      const entry = sessions.get(c.runId),s=entry?.preparing?entry.session:entry;
      if(entry?.stopRequested||db.get('runs',c.runId)?.stopRequested){s?.shutdown();await afterProcessExit(s?.proc,()=>{});await bridge?.stop();bridge=null;sessions.delete(c.runId);emit(c.runId,'status',{status:'interrupted',cliRecoveryWait:false,processSettled:true,error:tr('worker.taskHadNotStartedWas')});return;}
      if(e.code==='CLI_RECOVERY_WAIT'){
        s?.shutdown();await afterProcessExit(s?.proc,()=>{});await bridge?.stop();bridge=null;sessions.delete(c.runId);
        emit(c.runId,'status',{status:'waiting_user',cliRecoveryWait:true,cliRecovery:e.recovery,error:e.message});return;
      }
      if (typeof s?.finish === 'function') { s.finish('failed', e.message); s.shutdown(); await afterProcessExit(s.proc, () => sessions.delete(c.runId)); }
      await bridge?.stop();bridge=null;
      if(s){s.shutdown();await afterProcessExit(s.proc,()=>{});}
      emit(c.runId, 'status', { status: 'failed', error: e.message,processSettled:true,
        ...(!s?.inputAttempted?{inputDeliveryState:'not_delivered',queueRejected:true,queueRetryable:e.queueRetryable===true}:{}),
        ...(m.run.minimalInstructions===1?{configurationState:'failed',configurationError:e.message}:{}) }); sessions.delete(c.runId);
    } finally { await bridge?.stop(); if (sessions.get(c.runId)?.preparing) sessions.delete(c.runId);reportCapacity(); }
    return;
  }
  if (c.type === 'delivery_publish') {
    let payload;
    try {
      const source = db.get('runs', c.runId);
      if(!sourceSync.worker.canStart(source?.projectId))throw syncError('sync_busy');
      db.put('sourceSyncOperations',{id:c.id,projectId:source?.projectId||'*',status:'running'});
      if (projectTerminalLock(db,source?.projectId,identity.nodeId)) throw new Error(tr('worker.projectUnderManualTerminalTakeover2'));
      if (paused || m.paused) throw new Error(tr('worker.remoteExecutionPaused'));
      if (m.request?.status === 'cancelled' || (!m.delivery?.items && m.project.repoUrl !== m.delivery?.repoUrl)) throw new Error(tr('worker.sourceCallWasCancelledRepository'));
      if (source?.status !== 'succeeded' || source.projectId !== m.delivery?.projectId || m.delivery.sourceRunId !== c.runId || !m.delivery.approvedAt) throw new Error(tr('worker.deliverySourceDidNotSucceed'));
      const owner = db.get('workspaceOwners', source.workspace);
      if (owner && owner.runId !== c.runId) throw new Error(tr('worker.workspaceHasAlreadyBeenContinued'));
      const result = m.delivery.items
        ? await publishProjectDelivery((source.repositories || m.run.repositories).map(r=>({...r,credential:m.gitCredentials?.[r.id]})),m.delivery)
        : await publishDelivery({ root: await projectRoot(m.run.projectRoot), workspace: source.workspace,
          runId: source.workspaceRunId || c.runId, repoUrl: m.delivery.repoUrl, commit: m.delivery.commit, ref: m.delivery.ref, projectScope:source.projectScope });
      payload = { deliveryId: c.deliveryId, ...result };
    } catch (error) { payload = { deliveryId: c.deliveryId, status: 'blocked', error: error.message }; }
    finally {db.remove('sourceSyncOperations',c.id);}
    const event = recordDeliveryResult(db, c.id, payload);
    if (event) send({ type: 'event', event });
  }
  if (c.type === 'stop') {
    let r = db.get('runs', c.runId);
    if (!r) { r = db.put('runs', { id: c.runId, seq: 0 }); emit(c.runId, 'status', { status: 'interrupted',processSettled:true,error: tr('worker.taskHadNotStartedWas') }); }
    else if (!terminal.has(r.status)) {
      db.put('runs',{...r,stopRequested:true});
      const s = sessions.get(c.runId);
      if (s?.preparing) {s.stopRequested = true;db.put('runs',{...r,stopRequested:true});}
      else if (s) { emit(c.runId, 'status', { status: 'stopping' }); void s.stop(); }
      else if(r.cliRecoveryWait)emit(c.runId,'status',{status:'interrupted',cliRecoveryWait:false,processSettled:true,error:tr('worker.taskHadNotStartedWas')});
      else emit(c.runId, 'status', { status: 'reconciling', error: tr('worker.originalProcessNotControlledBy') });
    }
  }
  if (c.type === 'approval') {
    try {
      if (paused && c.decision === 'accept') throw new Error(tr('worker.remoteCommandsPaused2'));
      const s = sessions.get(c.runId);
      if (s instanceof CliPrintSession) throw new Error(tr('worker.runtimeAutoApprovesInPrint'));
      if (!(s instanceof CodexSession) || s.stopping) throw new Error(tr('worker.sessionCannotAcceptApprovals'));
      s.approve(c.approvalId.slice(c.runId.length + 1), c.decision);
    } catch (e) { emit(c.runId, 'approval_resolved', { id: c.approvalId.slice(c.runId.length + 1), status: 'expired' }); emit(c.runId, 'log', { text: e.message }); }
  }
  send({ type: 'command_ack', id: c.id });
}
/** Only serves plain text files inside registered workspaces and does not follow symlinks that escape them. */
async function query(m) {
  if(m.action==='cli_capacity') {
    try{send({type:'reply',id:m.id,result:await applyCapacity(m.path?.capacity)});}catch(e){send({type:'reply',id:m.id,error:e.message});}return;
  }
  const modifies=['repository_setup','execution_receive','execution_baseline_advance','terminal_prepare','terminal_new','native_terminal_prepare'].includes(m.action);
  const guarded=['source_inspect','source_read','read_query','project_file','file','document','collaboration_documents'].includes(m.action);
  const reply=result=>send(guarded?budgetReadReply({id:m.id,result}).message:{type:'reply',id:m.id,result});
  try {
    if(m.action==='folder_grant_prepare'){
      if(paused)throw Error('Remote execution is paused');
      const candidate=await realpath(m.path?.path);
      assertNativeSessionIdle(db,{nodeId:identity.nodeId,workspace:candidate,projectId:m.path.scope?.startsWith('project:')?m.path.scope.slice(8):null});
      reply(await folderAccess.prepare(m.path));return;
    }
    if(m.action==='folder_grant_cancel'){
      if(m.path.preparedOnly&&m.path.scope?.startsWith('native:')){
        if(m.path.id!==`${identity.nodeId}:${m.path.operationId}`||!/^[a-zA-Z0-9-]{8,100}$/.test(m.path.operationId||''))throw Error('Invalid folder preparation cleanup');
        // This checks actual process identities and leaves a tombstone against a late terminal preparation.
        releaseTerminalSession(db,m.path.operationId);
      }
      reply(folderAccess.cancel(m.path));return;
    }
    if(['source_inspect','source_read','read_query'].includes(m.action)){
      const source=m.path?.source;
      if(!source)throw readError('invalid_read_request');
      const proof=await inspectReadSource({db,descriptor:source,projectRoot,nodeId:identity.nodeId});
      if(m.action==='source_inspect'){reply(proof);return;}
      if(!Number.isSafeInteger(source.generation)||source.generation<1||JSON.stringify(proof)!==JSON.stringify(source.proof))throw readError('configuration_changed');
      let result;
      if(m.action==='source_read'){
        const input=normalizeFileRead(m.path.input);
        if(input.sourceNodeId!==source.sourceNodeId||input.scopeId!==source.scopeId||input.sourceWorkspace.workspaceId!==source.workspaceId||input.sourceWorkspace.generation!==source.generation)throw readError('source_workspace_mismatch');
        result=await readSourceCurrent({source,input});
      }else{
        const request=normalizeReadQuery(m.path.input);
        if(request.params.scopeId!==source.scopeId||request.params.sourceWorkspace.workspaceId!==source.workspaceId||request.params.sourceWorkspace.generation!==source.generation)throw readError('source_workspace_mismatch');
        result=await executeReadQuery({request,source,
          workspaceCheck:async()=>{
            let git=null;
            try{
              const options={cwd:source.root,timeout:1000,maxBuffer:16000,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}};
              const top=(await exec('git',['rev-parse','--show-toplevel'],options)).stdout.trim();
              if(await realpath(top)===source.root)git={head:(await exec('git',['rev-parse','HEAD'],options)).stdout.trim(),branch:(await exec('git',['rev-parse','--abbrev-ref','HEAD'],options)).stdout.trim()};
            }catch{}
            return {exists:true,git};
          },
          observeSession:()=>{
            const run=db.get('runs',source.sourceRunId);
            return cliRecovery.observe({projectId:run.projectId,roleId:run.roleId,taskId:run.taskId,roleSessionId:run.roleSessionId,nativeSessionId:run.nativeSession?.id,priorRunId:run.id});
          }});
        result={...result,workspaceId:source.workspaceId,generation:source.generation,scopeId:source.scopeId,scopeGeneration:source.scopeGeneration,proof};
      }
      if(JSON.stringify(await inspectReadSource({db,descriptor:source,projectRoot,nodeId:identity.nodeId}))!==JSON.stringify(proof))throw readError('configuration_changed');
      reply(result);return;
    }
    if(m.action==='queue_verification'){
      const input=m.path,r=db.get('runs',input?.runId||'');
      if(!r||r.projectId!==input.projectId||r.roleId!==input.roleId||r.collaborationBatchId!==input.batchId)throw new Error(tr('sessionQueue.reservationMismatch'));
      const started=r.inputDeliveryState==='accepted'?true:r.inputDeliveryState==='not_delivered'&&r.processSettled===true?false:null;
      send({type:'reply',id:m.id,result:{started,runId:r.id,processSettled:r.processSettled===true,nativeSessionId:r.nativeSession?.id||null}});return;
    }
    if(m.action==='collaboration_documents'){
      const input=m.path,root=await projectRoot(input?.root),knowledge=join(root,'.workbench');
      const read=async path=>{
        if(typeof path!=='string'||isAbsolute(path)||!['docs/','handoffs/'].some(prefix=>path.startsWith(prefix)))throw new Error(tr('wbTools.onlyFilesInsideWorkbenchCan'));
        const target=await realpath(resolve(knowledge,path));
        if(!inside(root,target)||!inside(knowledge,target))throw new Error(tr('wbTools.onlyFilesInsideWorkbenchCan'));
        const info=await stat(target);if(!info.isFile()||info.size>200000)throw new Error(tr('wbTools.fileExceeds200kbUseShorter'));
        const bytes=await readFile(target);return {path:relative(knowledge,target),text:bytes.toString('utf8'),hash:createHash('sha256').update(bytes).digest('hex')};
      };
      if(input.action==='read'){reply(await read(input.path));return;}
      if(input.action==='last'){
        for(const path of handoffReadPaths(identity.nodeId,input.reviewPrivate||'',input.roleSessionId||'')){try{reply(await read(path));return;}catch(e){if(e.code!=='ENOENT')throw e;}}
        reply({path:handoffReadPaths(identity.nodeId,input.reviewPrivate||'',input.roleSessionId||'')[0],text:'',hash:createHash('sha256').update('').digest('hex')});return;
      }
      if(!['list','snapshot'].includes(input.action))throw new Error(tr('collabSessions.invalidAction'));
      const files=[];let partial=false;
      const walk=async path=>{
        const target=await realpath(join(knowledge,path)).catch(()=>null);if(!target||!inside(root,target)||!inside(knowledge,target))return;
        for(const entry of await readdir(target,{withFileTypes:true})){
          if(files.length>=2000){partial=true;return;}
          if(entry.name.startsWith('.')||entry.isSymbolicLink())continue;
          const next=`${path}/${entry.name}`;
          if(entry.isDirectory())await walk(next);
          else if(entry.isFile()){try{const {text,...file}=await read(next);files.push(file);}catch{partial=true;}}
        }
      };
      await walk('docs');await walk('handoffs');reply({files,partial});return;
    }
    if(m.action==='cli_session_check'||m.action==='cli_session_stop'){
      if(!cliRecoveryEnabled)throw Error(tr('cliRecovery.bindingChanged'));
      if(m.path?.nodeId!==identity.nodeId)throw Error(tr('cliRecovery.bindingChanged'));
      const result=m.action==='cli_session_check'?await cliRecovery.check(m.path):await cliRecovery.reclaim(m.path,m.path.fingerprint,true);
      send({type:'reply',id:m.id,result});return;
    }
    if(m.action==='project_file'||m.action==='project_files'){
      const root=await projectRoot(m.path?.root),args={...m.path,root};
      const result=m.action==='project_files'?await listProjectFiles(args):await readProjectFile(args);
      reply(result);return;
    }
    if(['role_switch_inspect','role_switch_prepare','role_switch_release','role_switch_status'].includes(m.action)) {
      if(m.path?.nodeId!==identity.nodeId)throw new Error('CLI switch addressed to another Worker.');
      const method=m.action.slice('role_switch_'.length);
      if(method!=='status'&&projectTerminalLock(db,m.path.projectId,identity.nodeId))throw new Error('Project is under terminal takeover');
      const result=method==='status'?roleSwitchWorker.status(m.path.operationId):await roleSwitchWorker[method](m.path);
      send({type:'reply',id:m.id,result});return;
    }
    if(modifies){if(db.list('sourceSyncReservations').length)throw syncError('sync_busy');db.put('sourceSyncOperations',{id:m.id,projectId:m.path?.projectId||db.get('runs',m.runId)?.projectId||'*',status:'running'});}
    if(m.action==='source_sync_candidate'){
      const run=db.get('runs',m.runId),input=m.path,repo=run?.repositories?.find(r=>r.id===input.repositoryId),frozen=run?.sourceInputs?.find(r=>r.repositoryId===input.repositoryId);
      const directory=input.scopeKind==='directory';
      if(!run||terminal.has(run.status)||!run.sourceConflictId||run.sourceConflictId!==input.conflictId||(!directory&&(!repo||!frozen))||(directory&&input.assignmentId!==run.sourceConflictAssignmentId))throw syncError('candidate_not_ready');
      const home=homeUrl.replace(/^ws/i,'http').replace(/\/worker\/?$/,'');
      const request=async(path,method='GET',body)=>{const response=await fetch(home+path,{method,headers:{Authorization:`Bearer ${token}`,...(body&&!Buffer.isBuffer(body)?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});if(!response.ok){const error=await response.json();throw syncError(error.code||'candidate_failed');}return response.json();};
      const baseline=directory?null:await request(`/api/agent/source-inputs/${run.id}/${frozen.manifestId}`);
      const candidate=directory?await captureDirectoryCandidate({root:await projectRoot(input.root),path:input.path,scopePolicy:input.scopePolicy,assignmentId:input.assignmentId,blobRoot:sourceSync.blobRoot}):await captureSourceCandidate({root:await projectRoot(repo.localRoot),path:input.path,baseline,blobRoot:sourceSync.blobRoot});
      await request('/api/agent/source-candidates','POST',{runId:run.id,candidateId:input.candidateId,baselineManifestId:frozen?.manifestId,...candidate});
      if(candidate.entry)await request(`/api/agent/source-candidates/${run.id}/${input.candidateId}/blob`,'PUT',await readSourceBlob(sourceSync.blobRoot,candidate.entry.hash));
      const result=await request('/api/agent/source-candidates','POST',{runId:run.id,candidateId:input.candidateId,finish:true});
      send({type:'reply',id:m.id,result});return;
    }
    if(m.action==='open_project_folder'){
      if(platform()!=='darwin'||resolveNodeKind(process.env.NODE_KIND,platform())!=='local')throw new Error(tr('folders.localDeviceRequired'));
      const folder=await projectRoot(m.path);
      await exec('/usr/bin/open',[folder],{timeout:10000});
      send({type:'reply',id:m.id,result:{opened:true,path:folder}});return;
    }
    if(m.action==='conversation_summary') {
      if(paused || quitting)throw new Error(tr('worker.remoteOperationsPaused'));
      if(occupiedSlots()>=capacity)throw new Error(tr('worker.organizerDeviceCurrentlyHasNo'));
      const {snapshot,config}=m.path||{};
      if(!snapshot?.projectId || !Array.isArray(snapshot.delta) || !config?.model)throw new Error(tr('worker.conversationOrganizerParametersIncomplete'));
      if(JSON.stringify(snapshot).length>50000)throw new Error(tr('worker.conversationOrganizerInputTooLong'));
      const issue=runtimeIssue({capabilities:{runtimeDiscovery:true},runtimes},config.runtime,config.model);
      if(issue)throw new Error(issue);
      organizerRunning++;
      const controller=new AbortController();organizerControllers.add(controller);
      let release;controller.finished=new Promise(resolve=>{release=resolve;});
      send({type:'organizer_busy',count:organizerRunning});
      try {await warmSessions.trim(occupiedSlots());reportCapacity();send({type:'reply',id:m.id,result:await runOrganizer({snapshot,config,dataRoot:data,signal:controller.signal})});}
      finally {organizerControllers.delete(controller);organizerRunning--;send({type:'organizer_busy',count:organizerRunning});release();reportCapacity();}
      return;
    }
    if(m.action==='attachments_receive') {
      if(paused)throw new Error(tr('worker.remoteOperationsPaused2'));
      const input=m.path;
      if(!input?.projectId || !Array.isArray(input.items) || input.items.some(a=>a.projectId!==input.projectId))throw new Error(tr('worker.attachmentsDoNotMatchProject'));
      const workspace=await projectRoot(input.workspace);
      const home=homeUrl.replace(/^ws/i,'http').replace(/\/worker\/?$/,'');
      const files=await receiveAttachments({items:input.items,workspace,transferId:input.transferId,home,token});
      send({type:'reply',id:m.id,result:{files}});return;
    }
    // Large files stay where they are: stat, hash and ranged reads are served from allowed roots; bytes go over HTTP.
    if(['media_stat','media_stream','media_hash','media_receive'].includes(m.action)) {
      const input=m.path||{},homeHttp=homeUrl.replace(/^ws/i,'http').replace(/\/worker\/?$/,'');
      if(m.action==='media_receive'){
        if(paused)throw new Error(tr('worker.remoteOperationsPaused2'));
        if(typeof input.path!=='string'||!/^\/media\/[A-Za-z0-9_.-]+\?download=1$/.test(input.path))throw new Error('invalid_media_path');
        const workspace=await projectRoot(input.workspace);
        send({type:'reply',id:m.id,result:await receiveMedia({url:homeHttp+input.path,size:input.size,sha256:input.sha256,name:input.name,transferId:input.transferId,workspace})});return;
      }
      const root=await projectRoot(input.root);
      if(m.action==='media_stat'){send({type:'reply',id:m.id,result:await statMedia({root,path:input.file})});return;}
      if(m.action==='media_hash'){send({type:'reply',id:m.id,result:await hashMedia({root,path:input.file,version:input.version})});return;}
      if(typeof input.path!=='string'||!/^\/api\/worker\/media-streams\/[a-f0-9-]{36}$/.test(input.path)||typeof input.secret!=='string'||!input.secret)throw new Error('invalid_media_path');
      const info=await statMedia({root,path:input.file}),expected=input.version||{};
      if(info.size!==expected.size||info.mtimeMs!==expected.mtimeMs||info.ino!==expected.ino||info.dev!==expected.dev)throw new Error('file_changed');
      // Acknowledge first, then upload this range on its own request; a later failure simply ends that request.
      send({type:'reply',id:m.id,result:{accepted:true}});
      void streamMedia({root,path:input.file,version:expected,start:input.start,end:input.end,url:homeHttp+input.path,secret:input.secret}).catch(error=>{
        // Players cancel ranges while seeking and Home closes relays for closed viewers; only unexpected failures are logged.
        if(!/HTTP 4\d\d|abort|ECONNRESET|socket|terminated|fetch failed/i.test(error.message))console.error('Media stream failed:',error.message);
      });
      return;
    }
    // Session sidebar facts: offline Git state of an allowed working folder, and the name of a Workbench-created session.
    if(m.action==='native_file'){
      // One text file inside the registered working folder; the folder grant arrives with the query envelope.
      const root=await realpath(await projectRoot(m.path?.workspace)),requested=String(m.path?.path||'');
      const real=await realpath(isAbsolute(requested)?requested:join(root,requested)).catch(()=>null);
      if(!real||real!==root&&!real.startsWith(`${root}/`))throw new Error('File is outside the session working folder');
      const info=await stat(real);if(!info.isFile())throw new Error('Not a file');
      const common={path:real,relativePath:relative(root,real),size:info.size,modifiedAt:info.mtime.toISOString()};
      if(info.size>600000){send({type:'reply',id:m.id,result:{...common,preview:'too_large',content:null}});return;}
      const bytes=await readFile(real),content=bytes.toString('utf8'),binary=bytes.includes(0)||!Buffer.from(content).equals(bytes);
      send({type:'reply',id:m.id,result:{...common,preview:binary?'binary':'text',content:binary?null:content}});return;
    }
    if(m.action==='native_workspace_git'){send({type:'reply',id:m.id,result:await inspectWorkspaceGit(await projectRoot(m.path?.workspace),{authorizeRoot:projectRoot})});return;}
    if(m.action==='native_session_title'){
      const input=m.path||{},title=typeof input.title==='string'?input.title.trim():'';
      if(!title||title.length>120)throw new Error('Session title is required and must be at most 120 characters');
      const entry=db.get('nativeCatalogEntries',input.entryId||'');
      if(!entry||entry.runtime!==input.runtime||(entry.sessionId||null)!==(input.sessionId||null))throw new Error('Native catalog entry not found for this session');
      // Only the display name changes: native ID, workspace, status, timestamps and takeover records stay as they are.
      const updated=db.put('nativeCatalogEntries',{...entry,title,renamedAt:new Date().toISOString()});
      send({type:'reply',id:m.id,result:{entryId:updated.id,sessionId:updated.sessionId||null,title:updated.title}});return;
    }
    if(m.action==='native_terminal_start'){
      const id=m.path?.id,s=typeof id==='string'&&/^[a-zA-Z0-9-]{8,100}$/.test(id)?db.get('terminalSessions',id):null;
      if(s?.kind!=='native'||s.nodeId!==identity.nodeId||s.status!=='prepared')throw Error('Terminal request is already used or changed');
      // The iTerm launcher itself, run headlessly on this device: it claims, observes and returns the session exactly like a terminal.
      const child=spawn(process.execPath,[join(base,'src','terminal-resume.mjs'),join(data,'worker.sqlite'),s.id],{cwd:s.workspace,env:{...process.env,WB_NATIVE_HELLO:'1'},stdio:'ignore',detached:process.platform!=='win32'});
      child.unref();
      const claimed=await new Promise(resolve=>{
        const onExit=code=>{clearInterval(poll);clearTimeout(limit);resolve({exited:code??1});};
        const poll=setInterval(()=>{if(db.get('terminalSessions',s.id)?.status==='active'){clearInterval(poll);clearTimeout(limit);child.removeListener('exit',onExit);resolve({pid:child.pid});}},100);
        const limit=setTimeout(()=>{clearInterval(poll);child.removeListener('exit',onExit);resolve({timeout:true});},10000);
        child.once('exit',onExit);child.once('error',()=>onExit(1));
      });
      if(claimed.exited!==undefined)throw Error(db.get('terminalSessions',s.id)?.status==='prepared'?'The CLI did not start; check that the working folder and CLI are available on this device':'The CLI exited before it finished starting');
      if(claimed.timeout)throw Error('The CLI did not start in time');
      reportCapacity();send({type:'reply',id:m.id,result:{id:s.id,pid:claimed.pid}});return;
    }
    if(['native_sessions','native_session','native_terminal_preview','native_terminal_prepare'].includes(m.action)) {
      const input=m.path||{},runtime=input.runtime;
      if(m.action!=='native_sessions'&&!runtimes.some(r=>r.type===runtime&&r.available&&r.supported!==false))throw Error('CLI is not available on this device');
      if(m.action==='native_sessions'){send({type:'reply',id:m.id,result:await listNativeSessions(runtime,{scope:input.scope||'created',registry:db.list('nativeCatalogEntries'),managedSessions:input.managedSessions||[],adoptedSessions:input.adoptedSessions||[],nodeId:identity.nodeId})});return;}
      const record=input.record||registeredNativeSession(db,runtime,input.sessionId);
      if(m.action==='native_session'){send({type:'reply',id:m.id,result:await readNativeSession(runtime,input.sessionId,{record,historyPage:input.historyPage===true,cursor:input.cursor,snapshot:input.snapshot})});return;}
      if(paused)throw Error('Remote execution is paused');
      const freshId=input.sessionId?null:input.freshSessionId||null;
      if(!input.sessionId&&['claude','grok'].includes(runtime)&&!freshId)throw Error('Upgrade Home to create an exact native session ID');
      nativeTuiArgs(runtime,{id:input.sessionId,freshId,allowAll:input.allowAll??false});
      const history=input.sessionId?await readNativeSession(runtime,input.sessionId,{record}):null;
      if(history?.workspace&&input.workspace&&await realpath(input.workspace)!==await realpath(history.workspace))throw Error('Resume must use the original working folder');
      const workspace=m.action==='native_terminal_preview'&&input.folderCandidate?.scope===`native:${input.entryId}`
        ?await folderAccess.run({scope:input.folderCandidate.scope,active:true,previewOnly:true,grant:input.folderCandidate},()=>projectRoot(input.workspace))
        :await projectRoot(history?.workspace||input.workspace);
      const projectIds=new Set();
      for(const binding of input.bindings||[]){const root=await realpath(binding.localRoot).catch(()=>null);if(root&&(inside(root,workspace)||inside(workspace,root)))projectIds.add(binding.projectId);}
      const owner=nativeTerminalProject(db,{nodeId:identity.nodeId,runtime,sessionId:input.sessionId,folderProjectIds:[...projectIds],managedProjectIds:input.managedProjectIds||[]});
      const projectId=owner||input.projectId;
      const assertIdle=()=>assertNativeSessionIdle(db,{nodeId:identity.nodeId,runtime,sessionId:input.sessionId,workspace,projectId});
      assertIdle();
      if(m.action==='native_terminal_preview'){send({type:'reply',id:m.id,result:{workspace,projectId:owner,runtime,sessionId:input.sessionId||null}});return;}
      if(typeof input.id!=='string'||!/^[a-zA-Z0-9-]{8,100}$/.test(input.id)||!input.projectId||input.nodeId!==identity.nodeId||projectId!==input.projectId)throw Error('Terminal binding changed; refresh and try again');
      const nativeSession={...await nativeEnvironment(runtime),id:input.sessionId||null};
      // The terminal inherits the session's private gitconfig (a bound hosting account, or just the user's own includes).
      const credential=input.gitCredential?.token?input.gitCredential:null;
      const terminalEnv=await runtimeGitEnvironment({directory:join(data,'git-auth'),key:nativeGitConfigKey(runtime,input.sessionId||freshId||input.entryId||input.id),repositories:credential?[{id:'session',repoUrl:credential.repoUrl}]:[],credentials:credential?{session:credential}:{}});
      assertIdle();
      if(db.get('terminalSessions',input.id)||projectTerminalLock(db,projectId,identity.nodeId)||db.get('sourceSyncReservations',projectId))throw Error('Session is occupied; no second CLI was started');
      if(occupiedSlots()>=capacity)throw Error('Device CLI capacity is full');
      const now=new Date().toISOString(),catalogEntryId=input.entryId||(!input.sessionId?input.id:null),priorEntry=catalogEntryId?db.get('nativeCatalogEntries',catalogEntryId):null;
      if(!input.sessionId){
        if(typeof input.title!=='string'||!input.title.trim()||input.title.trim().length>120)throw Error('Session title is required and must be at most 120 characters');
        if(priorEntry&&(priorEntry.runtime!==runtime||priorEntry.workspace!==workspace||priorEntry.status!=='draft'))throw Error('Native catalog entry cannot be reused for a different or active session');
      }
      if(input.sessionId&&priorEntry&&(priorEntry.runtime!==runtime||priorEntry.sessionId!==input.sessionId))throw Error('Native catalog entry does not match this history');
      db.transaction(()=>{if(!input.sessionId)db.put('nativeCatalogEntries',{...priorEntry,id:catalogEntryId,runtime,title:input.title.trim(),workspace,origin:'dialog',status:'prepared',sessionId:freshId,createdAt:priorEntry?.createdAt||now,modifiedAt:now,exactLastScan:priorEntry?.exactLastScan||null});db.put('terminalSessions',{id:input.id,kind:'native',catalogEntryId,projectId,nodeId:identity.nodeId,status:'prepared',workspace,nativeSession,nativeOptions:{allowAll:input.allowAll===true,freshId},privateEnv:resumeEnvironment(terminalEnv),createdAt:now});});
      reportCapacity();send({type:'reply',id:m.id,result:{id:input.id,entryId:catalogEntryId,kind:'native',workspace,user:nativeSession.user,runtime,sessionId:nativeSession.id||freshId,launcher:[process.execPath,join(base,'src','terminal-resume.mjs'),join(data,'worker.sqlite'),input.id]}});return;
    }
    if(m.action==='terminal_check') {
      const input=m.path;
      if(!Array.isArray(input?.claims)||input.nodeId!==identity.nodeId)throw new Error(tr('worker.invalidTakeoverId'));
      const results=input.claims.map(binding=>{if(binding.projectId!==input.projectId||binding.nodeId!==identity.nodeId||typeof binding.id!=='string'||!/^[a-zA-Z0-9-]{8,100}$/.test(binding.id))throw new Error(tr('worker.invalidTakeoverId'));return db.get('terminalSessions',binding.id)?.kind==='native-turn'?nativeTurns.check(binding):checkTerminalSession(db,binding,join(data,'worker.sqlite'),{automatic:input.automatic===true});});
      reportCapacity();send({type:'reply',id:m.id,result:{results}});return;
    }
    if(m.action==='terminal_stop') {
      const binding=m.path;
      if(binding?.nodeId!==identity.nodeId||typeof binding.id!=='string'||!/^[a-zA-Z0-9-]{8,100}$/.test(binding.id))throw new Error(tr('worker.invalidTakeoverId'));
      let pending=terminalStops.get(binding.id);
      if(!pending){pending=stopTerminalSession(db,binding,join(data,'worker.sqlite')).finally(()=>terminalStops.delete(binding.id));terminalStops.set(binding.id,pending);}
      const result=await pending;reportCapacity();send({type:'reply',id:m.id,result});return;
    }
    if(m.action==='terminal_prepare' || m.action==='terminal_release' || m.action==='terminal_new') {
      const id=m.path?.id;
      if(typeof id!=='string' || !/^[a-zA-Z0-9-]{8,100}$/.test(id))throw new Error(tr('worker.invalidTakeoverId'));
      const prior=db.get('terminalSessions',id);
      if(m.action==='terminal_release') {
        // Even if the prepare request timed out, the revocation is recorded so that a delayed request cannot re-prepare an old link.
        const released=releaseTerminalSession(db,id),catalogEntry=released.catalogEntryId?db.get('nativeCatalogEntries',released.catalogEntryId):null;
        reportCapacity();
        send({type:'reply',id:m.id,result:{released:true,...(catalogEntry?{catalogEntry}: {})}});return;
      }
      if(paused)throw new Error(tr('worker.remoteExecutionPaused2'));
      if(m.action==='terminal_new') {
        const input=m.path,role=input.roleSettings;
        if(input.nodeId!==identity.nodeId||typeof input.projectId!=='string'||!input.projectId||typeof input.roleId!=='string'||!input.roleId||!role)throw new Error(tr('worker.invalidTakeoverId'));
        const issue=runtimeIssue({capabilities:{runtimeDiscovery:true},runtimes},role.runtime,role.model);if(issue)throw new Error(issue);
        const busy=()=>db.list('runs').some(r=>r.status==='reconciling'||r.projectId===input.projectId&&!terminal.has(r.status))||db.list('workerRoleSwitches').some(s=>s.projectId===input.projectId&&s.roleId===input.roleId&&!s.released);
        if(busy())throw new Error(tr('home.projectStillExecutingOnDevice'));
        await warmSessions.closeProject(input.projectId);
        const workspace=await projectRoot(input.workspace),nativeSession={...await nativeEnvironment(role.runtime),id:null};
        const instructions=[runWithLanguage('en',()=>composeAgentInstructions(input.platformPrompt,[role.instructions,input.supervisorPrompt].filter(Boolean).join('\n\n'))),executionText('roleTerminal.manualContext')].filter(Boolean).join('\n\n');
        const roleSettings={runtime:role.runtime,model:role.model,effort:role.effort||null,instructions,...(role.permissionScope?{permissionScope:role.permissionScope,toolRoots:[base]}:{})};
        freshTerminalArgs({...roleSettings,workspace});
        // Preparation can race a dispatch, a duplicate request or revocation while directories are checked.
        if(db.get('terminalSessions',id)||projectTerminalLock(db,input.projectId,identity.nodeId)||busy())throw new Error(tr('worker.executionStateHasChangedCheck'));
        if(occupiedSlots()>=capacity)throw new Error(tr('capacity.full'));
        const info={id,kind:'new',projectId:input.projectId,roleId:input.roleId,nodeId:identity.nodeId,status:'prepared',workspace,nativeSession,roleSettings,privateEnv:resumeEnvironment(process.env),createdAt:new Date().toISOString()};
        db.put('terminalSessions',info);
        try{await warmSessions.trim(occupiedSlots());}catch(e){releaseTerminalSession(db,id);reportCapacity();throw e;}
        if(db.get('terminalSessions',id)?.status!=='prepared')throw new Error(tr('worker.executionStateHasChangedCheck'));
        reportCapacity();send({type:'reply',id:m.id,result:{id,kind:'new',workspace,user:nativeSession.user,runtime:role.runtime,model:role.model,sessionId:null,launcher:[process.execPath,join(base,'src','terminal-resume.mjs'),join(data,'worker.sqlite'),id]}});return;
      }
      const r=db.get('runs',m.runId);
      if(r)await warmSessions.closeProject(r.projectId);
      if(!r || !terminal.has(r.status) || sessions.has(r.id) || managedRunProcessState(r)!=='exited')throw new Error(tr('worker.originalCliHasNotExited'));
      if(db.list('runs').some(other=>other.projectId===r.projectId&&!terminal.has(other.status)))throw new Error(tr('worker.projectStillHasExecutionsOn'));
      const lock=projectTerminalLock(db,r.projectId,identity.nodeId);
      if(lock && lock.id!==id)throw new Error(tr('worker.projectHasBeenTakenOver'));
      if(prior)throw new Error(tr('worker.takeoverIdHasAlreadyBeen'));
      if(occupiedSlots()>=capacity)throw new Error(tr('capacity.full'));
      const workspace=await projectRoot(r.workspace);
      const privateEnv=db.get('runtimeEnvironments',r.id)?.env;
      if(!privateEnv)throw new Error(tr('worker.olderExecutionDidNotSave'));
      const native=r.nativeSession || await nativeEnvironment('codex');
      const nativeSession={...native,id:native.id || r.nativeSessionId || r.threadId};
      if(nativeSession.user!==(await nativeEnvironment(nativeSession.runtime)).user)throw new Error(tr('worker.workerUserDoesNotMatch'));
      const historyFile=await findSessionHistory(nativeSession,workspace);
      // The resumed terminal keeps the scope frozen on the original run; refuse here rather than after the terminal opens.
      if(r.permissionScope)scopedTerminalArgs(nativeSession.runtime,r.permissionScope,[base]);
      const info={id,projectId:r.projectId,nodeId:identity.nodeId,runId:r.id,status:'prepared',workspace,nativeSession,privateEnv,historyFile,...(r.permissionScope?{permissionScope:r.permissionScope,toolRoots:[base]}:{}),createdAt:new Date().toISOString()};
      // A dispatch/revocation that occurred during the file check must be rejected again.
      if(db.get('terminalSessions',id) || projectTerminalLock(db,r.projectId,identity.nodeId) || db.list('runs').some(other=>other.projectId===r.projectId&&!terminal.has(other.status)))throw new Error(tr('worker.executionStateHasChangedCheck'));
      if(occupiedSlots()>=capacity)throw new Error(tr('capacity.full'));
      db.put('terminalSessions',info);
      try{await warmSessions.trim(occupiedSlots());}catch(e){releaseTerminalSession(db,id);reportCapacity();throw e;}
      if(db.get('terminalSessions',id)?.status!=='prepared')throw new Error(tr('worker.executionStateHasChangedCheck'));
      reportCapacity();
      send({type:'reply',id:m.id,result:{id,workspace,user:nativeSession.user,runtime:nativeSession.runtime,sessionId:nativeSession.id,launcher:[process.execPath,join(base,'src','terminal-resume.mjs'),join(data,'worker.sqlite'),id]}});return;
    }
    if(m.action==='execution_receive') {
      if(paused)throw new Error(tr('worker.remoteExecutionPaused3'));
      const repositories=m.path?.repositories,deliveries=m.path?.deliveries;
      if(!Array.isArray(repositories)||!Array.isArray(deliveries)||deliveries.length>12)throw new Error(tr('worker.invalidDeliveryParameters'));
      for(const r of repositories)await projectRoot(r.localRoot);
      send({type:'reply',id:m.id,result:await fetchExecutionDeliveries(repositories,deliveries)});return;
    }
    if(m.action==='execution_snapshot' || m.action==='execution_versions') {
      const repositories=m.path?.repositories;
      if(!Array.isArray(repositories) || repositories.length>30) throw new Error(tr('worker.invalidRepositorySet'));
      for(const r of repositories) await projectRoot(r.localRoot);
      const result=m.action==='execution_versions' ? await verifyExecutionVersions(repositories,m.path.versions||[]) : await inspectExecutionRepositories(repositories);
      send({type:'reply',id:m.id,result});return;
    }
    if(m.action==='execution_baseline_advance') {
      if(paused)throw new Error(tr('worker.remoteExecutionPaused4'));
      const repositories=m.path?.repositories,versions=m.path?.versions;
      if(!Array.isArray(repositories)||!Array.isArray(versions)||versions.length>30)throw new Error(tr('worker.invalidProjectBaselineAdvanceParameters'));
      const result=[];
      for(const version of versions) {
        const repo=repositories.find(r=>r.id===version.id);
        if(!repo?.baselineRoot||!repo.baselineBranch)continue;
        await projectRoot(repo.baselineRoot);
        result.push(await advanceProjectBaseline({localRoot:repo.baselineRoot,branch:repo.baselineBranch,
          commit:version.commit,repoUrl:repo.repoUrl}));
      }
      send({type:'reply',id:m.id,result});return;
    }
    if(m.action==='cli_install'){
      if(paused)throw new Error(tr('worker.remoteExecutionPaused5'));
      if(sessions.size)throw new Error(tr('worker.deviceExecutingInstallCliOnce'));
      const packages={codex:'@openai/codex',claude:'@anthropic-ai/claude-code'};
      const packageName=packages[m.path?.runtime];if(!packageName)throw new Error(tr('worker.installCliUsingVendorS'));
      const prefix=join(homedir(),'.local');await mkdir(prefix,{recursive:true});
      try{await exec('npm',['install','--global','--prefix',prefix,packageName],{timeout:150000,maxBuffer:1000000});}
      catch{throw new Error(tr('worker.cliInstallationFailedCheckDevice'));}
      process.env.PATH=`${join(prefix,'bin')}${delimiter}${process.env.PATH || ''}`;
      send({type:'reply',id:m.id,result:{runtimes:await refreshRuntimes(),note:tr('worker.youStillNeedSignIn')}});return;
    }
    if (m.action === 'supervisor_directory') {
      send({ type: 'reply', id: m.id, result: await prepareSupervisorDirectory(roots, m.path?.projectId) }); return;
    }
    if (m.action === 'project_directory') {
      if (paused) throw new Error(tr('worker.remoteExecutionPaused6'));
      const result = await prepareProjectSpace(roots, { ...m.path, workspaceRoot:m.path.workspaceRoot || defaultRoot });
      send({type:'reply',id:m.id,result}); return;
    }
    if (m.action === 'workspace_root') {
      const checked = await projectRoot(m.path);
      const { access, constants } = await import('node:fs/promises');
      await access(checked,constants.R_OK|constants.W_OK|constants.X_OK);
      db.put('settings',{id:'workspace',localRoot:checked}); defaultRoot=checked;
      send({type:'reply',id:m.id,result:{localRoot:checked}}); return;
    }
    if (m.action === 'repository_setup') {
      if (paused) throw new Error(tr('worker.remoteExecutionPaused7'));
      const key = m.path?.operationId;
      if (!/^[a-f0-9-]{36}-[0-7]$/.test(key || '')) throw new Error(tr('worker.invalidSetupOperationId'));
      const { credential, ...publicInput } = m.path;
      const previous = db.get('setupOperations', key), signature = JSON.stringify(publicInput);
      if (previous && previous.signature !== signature) throw new Error(tr('worker.setupOperationParameterConflict'));
      if (previous?.result) { send({ type: 'reply', id: m.id, result: previous.result }); return; }
      if (previous) throw new Error(tr('worker.operationHasAlreadyStartedIts'));
      db.put('setupOperations', { id: key, signature, status: 'running' });
      try {
        const source = await setupRepository(await folderAccess.allowedRoots(), m.path);
        const result = m.path.projectId
          ? await prepareProjectBaseline({projectId:m.path.projectId,projectRoot:await projectRoot(m.path.projectRoot),
            sourceRoot:source.localRoot,key:m.path.key,baseBranch:m.path.baseBranch,baseCommit:m.path.baseCommit,
            expectedCommit:m.path.expectedCommit,publishBaseline:m.path.publishBaseline,
            repoUrl:m.path.repoUrl,credential:m.path.credential}) : source;
        db.put('setupOperations', { id: key, signature, status: 'succeeded', result });
        send({ type: 'reply', id: m.id, result });
      } catch (error) { db.put('setupOperations', { id: key, signature, status: 'blocked', error: error.message }); throw error; }
      return;
    }
    if (m.action === 'runtimes') { send({ type: 'reply', id: m.id, result: { runtimes: await refreshRuntimes() } }); return; }
    if (m.action === 'token_usage') { send({type:'reply',id:m.id,result:await collectCcusageReport({base,since:m.path?.since||null,until:m.path?.until||null,timezone:m.path?.timezone||SYSTEM_TIME_ZONE})}); return; }
    if (m.action === 'directories') {
      send({ type: 'reply', id: m.id, result: await browseFolders(folderAccess.browseRoots(), m.path?.path, m.path?.offset ?? 0,
        { includeFiles: m.path?.includeFiles === true,allDirectories:folderAccess.local }) }); return;
    }
    if (m.action === 'directory_create') {
      send({ type: 'reply', id: m.id, result: await createFolder(folderAccess.browseRoots(), m.path?.path, m.path?.name) }); return;
    }
    if (m.action === 'native_default_folder') {
      send({type:'reply',id:m.id,result:await prepareNativeSessionFolder(roots,defaultRoot,m.path?.bindings)});return;
    }
    if (m.action === 'git_check') {
      const root = await projectRoot(m.path?.localRoot);
      const repo = giteeRepository(m.path?.repoUrl); if (!repo) throw new Error(tr('worker.configureGiteeRepositoryUrlFirst'));
      let origin = null;
      try { origin = giteeRepository((await exec('git', ['remote', 'get-url', 'origin'], { cwd: root, timeout: 2000 })).stdout.trim()); } catch {}
      let reachable = false;
      try {
        await exec('git', ['ls-remote', '--', repo.url, 'HEAD'], { cwd: root, timeout: 8000, maxBuffer: 65536,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oStrictHostKeyChecking=yes -oConnectTimeout=5' } });
        reachable = true;
      } catch {}
      send({ type: 'reply', id: m.id, result: { repoUrl: repo.url, localRoot: root, reachable, origin: origin?.url || null,
        remoteMatches: origin ? origin.webUrl === repo.webUrl : null, checkedAt: new Date().toISOString(),
        message: reachable ? tr('worker.repositoryReadableCheckDoesNot') : tr('worker.unableReadRepositoryCheckUrl') } }); return;
    }
    if (m.action === 'project_git_versions') {
      if (!Array.isArray(m.path?.repositories) || m.path.repositories.length > 30) throw new Error(tr('worker.invalidProjectRepositorySet'));
      const results=[];
      const inspectOne=async repository=>{
        const checkedAt=()=>new Date().toISOString();
        try {
          const root=await projectRoot(repository.localRoot);
          const expected=giteeRepository(repository.repoUrl);
          const actual=giteeRepository((await exec('git',['remote','get-url','origin'],{cwd:root,timeout:3000})).stdout.trim());
          if(!expected || actual?.webUrl!==expected.webUrl)throw new Error(tr('worker.repositoryOriginDoesNotMatch'));
          const result=await inspectGitRepositoryVersion({...repository,localRoot:root});
          return {repositoryId:repository.id,key:repository.key,localRoot:root,...result};
        } catch(error) {
          return {repositoryId:repository.id,key:repository.key,localRoot:repository.localRoot,status:'unknown',ahead:0,behind:0,checkedAt:checkedAt(),error:error.message};
        }
      };
      for(let offset=0;offset<m.path.repositories.length;offset+=4) {
        results.push(...await Promise.all(m.path.repositories.slice(offset,offset+4).map(inspectOne)));
      }
      send({type:'reply',id:m.id,result:results});return;
    }
    if (m.action === 'workspace_check') {
      const localRoot = await projectRoot(m.path);
      let git = null;
      // Only detects the repository root; does not run clone or fetch, or switch the user's branch.
      try {
        const options = { cwd: localRoot, timeout: 2000 };
        const top = (await exec('git', ['rev-parse', '--show-toplevel'], options)).stdout.trim();
        if (await realpath(top) === localRoot) {
          const head = (await exec('git', ['rev-parse', 'HEAD'], options)).stdout.trim();
          const branch = (await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], options)).stdout.trim();
          git = { head, branch };
        }
      } catch {}
      send({ type: 'reply', id: m.id, result: { localRoot, git } }); return;
    }
    if (!['file', 'files', 'document','artifact_files'].includes(m.action)) throw new Error(tr('worker.unknownNodeQuery'));
    const r = db.get('runs', m.runId); if (!r?.workspace) throw new Error(tr('worker.noTaskWorkspaceYet'));
    const root = await realpath(r.workspace);
    if(m.action==='artifact_files'){send({type:'reply',id:m.id,result:await inspectArtifactFiles(root,m.path)});return;}
    if (m.action === 'document') {
      reply(await readRunDocument(root,m.path));return;
    }
    if (m.action === 'file') {
      if (!m.path || m.path.split(/[\\/]/).some(p => p.startsWith('.') || /credential|secret/i.test(p))) throw new Error(tr('worker.readingPathNotAllowed'));
      const file = await realpath(resolve(root, m.path));
      if (!inside(root, file)) throw new Error(tr('worker.fileOutsideAllowedRoot'));
      const info = await stat(file); if (!info.isFile() || info.size > 200000) throw new Error(tr('worker.onlyTextPreviewsUp200kb'));
      const content = await readFile(file, 'utf8'); if (content.includes('\0')) throw new Error(tr('worker.binaryFilesDoNotSupport'));
      reply({path:m.path,content});
    } else {
      const files = [];
      const walk = async (dir, depth) => {
        if (depth > 4 || files.length >= 200) return;
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (entry.name.startsWith('.') || ['node_modules', 'vendor'].includes(entry.name) || /credential|secret/i.test(entry.name)) continue;
          const path = join(dir, entry.name);
          if (entry.isDirectory()) await walk(path, depth + 1);
          else if (entry.isFile() && files.length < 200) files.push({ path: relative(root, path), size: (await stat(path)).size });
        }
      };
      await walk(root, 0); send({ type: 'reply', id: m.id, result: { files } });
    }
  } catch (e) { send(guarded?budgetReadReply({id:m.id,error:['source_inspect','source_read','read_query'].includes(m.action)?e.code||'read_failed':e.message}).message:{type:'reply',id:m.id,error:e.message}); }
  finally {if(modifies)db.remove('sourceSyncOperations',m.id);}
}
// Reconcile saved startup identities after restart; PID reuse never authorizes a signal or native resume.
recoverDeliveryCommands(db);
for (const r of db.list('runs').filter(r => !terminal.has(r.status))) {
  if(r.cliRecoveryWait){emit(r.id,'status',{status:'waiting_user',cliRecoveryWait:true});continue;}
  const exited=managedRunProcessState(r)==='exited';
  emit(r.id, 'status', { status: exited ? 'interrupted' : 'reconciling', controlLost: true,
    ...(exited?{pid:null,previousPid:r.pid||null,processSettled:true,driverState:'exited'}:{}),
    error: exited ? tr('worker.workerRestartedOriginalManagedProcess') : tr('worker.leftoverProcessFoundAwaitingManual') });
}
function connect() {
  if (quitting) return;
  ws = new WebSocket(homeUrl, { headers: { Authorization: `Bearer ${token}` }, maxPayload: 1024 * 1024 });
  ws.on('open', () => {
    const systemPlatform = platform();
    send({ type: 'register', node: { id: identity.nodeId, name: process.env.NODE_NAME || hostname(), platform: systemPlatform,organizerBusy:organizerRunning,
      nodeKind: resolveNodeKind(process.env.NODE_KIND, systemPlatform),softwareVersion,
      remoteDesktopUrl: normalizeRemoteDesktopUrl(process.env.REMOTE_DESKTOP_URL),
      workspaceRoot:defaultRoot,warmSessions:warmSessions.snapshot(), capabilities: { localFolderSelection:folderAccess.local?1:0,permissionScopes:workerPermissionScopes(systemPlatform),permissionContract:PERMISSION_CONTRACT_VERSION,nativeDefaultFolder:1,groupConversations:1,projectTeamCopy:1,queryRecipes:1,fileReadFreshness:1,readSourceBindings:1,fileReadModes:['source_current','expected_version'],nativeSessions:2,nativeSessionOwnership:1,nativeHistoryPages:1,nativeTakeover:1,nativePageOpen:1,nativeFiles:1,nativeControls:1,nativeTurns:3,cliRecovery:1,minimalInstructions:1,terminalFresh:1,terminalControl:['darwin','linux'].includes(systemPlatform)?1:0,terminalAutoReturn:1,cliCapacity:1,roleSwitch:1,sourceSync:1,sourceSyncDirectory:1,sourceSyncOutputs:1,sourceSyncTools:1,projectFiles:1,openProjectFolder:systemPlatform==='darwin'&&resolveNodeKind(process.env.NODE_KIND,systemPlatform)==='local'?1:0,peerStatus:1,...discussionCapabilities(),summaryBatches:1,stableInstructions:1,warmSessions:1,gitVersions:1,attachmentTransfer:1,mediaStream:1,workspaceGit:1,nativeSessionTitle:1,managedResume:1,sessionTools:1,timerTools:1,terminalResume:1,collaborationTools:2,sessionQueue:2,executionScheduling:1,attachments:1, projectSpace:1, workspaceBindings: true, roomRoles: true, projectBrowser: true, directoryCreate:1, runtimeDiscovery: true, tokenUsage:1, coordinationVersion: 1, projectSetup: 1 }, allowedRoots: roots, runtimes, capacity } });
  });
  ws.on('message', async bytes => {
    try {
      const m = JSON.parse(bytes);
      if(m.type==='execution_config') {
        const query=configurationQueries.get(m.id);if(!query)return;
        configurationQueries.delete(m.id);clearTimeout(query.timer);m.error?query.reject(new Error(m.error)):query.resolve(m.result);return;
      }
      if(m.type==='source_sync_command'){void sourceSync.execute(m);return;}
      if(m.type==='source_sync_watch_config'){await sourceSync.watch.configure(m);return;}
      if(m.type==='source_sync_dirty_ack'){sourceSync.watch.acknowledge(m.noticeId);return;}
      if(m.type==='source_sync_cancel'){sourceSync.cancel(m.commandId);return;}
      if(m.type==='source_sync_receipt_ack'){sourceSync.acknowledge(m.commandId,m);return;}
      if (m.type === 'registered') {
        folderAccess.reconcile(Array.isArray(m.folderGrantIds)?m.folderGrantIds:[]);
        cliRecoveryEnabled=m.cliRecovery===1;
        readToolsEnabled=m.readTools===1;
        paused = m.paused;
        // Home announces its language; run payloads carry their own, this covers Worker-originated text outside a run.
        if (m.language) try { setLanguage(m.language); } catch { /* keep current */ }
        const connection=ws;
        if(m.capacity!==undefined)await applyCapacity(m.capacity);
        if(ws!==connection||connection.readyState!==1)return;
        registered=true;readySent=false;eventSent.clear();clearTimeout(reconnectCleanup);
        if(paused)void warmSessions.closeAll();
        for (const r of db.list('runs').filter(r => !terminal.has(r.status))) emit(r.id, 'status', { status: r.status });
        flushOutbox();console.log(tr('worker.workerConnected', { homeUrl, nodeId: identity.nodeId }));
        if (runtimeRetryDue) { runtimeRetryDue = false; void refreshRuntimes(); }
      }
      if (m.type === 'settings') {paused = m.paused;if(paused)void warmSessions.closeAll();}
      if (m.type === 'language') { try { setLanguage(m.language); } catch { /* ignore unsupported values */ } }
      if (m.type === 'ack') {db.remove('outbox', m.id);eventSent.delete(m.id);flushOutbox();}
      // Each command/query runs under the language Home put on the message, so prompts and errors built on this Worker match it.
      if (m.type === 'command') void runWithLanguage(m.language, () => folderAccess.run(folderEnvelope(m),()=>command(m))).catch(e => console.error(tr('worker.commandRejected'), e.message));
      if (m.type === 'queue_reserve') {
        turnStates.prune();
        const result=queueSlots.reserve(m.key,queueState(m));
        send({type:'queue_reservation',id:m.id,projectId:m.projectId,roleId:m.roleId,key:m.key,...result});return;
      }
      if (m.type === 'queue_cancel') {queueSlots.cancel(m.key,{id:m.reservationId});return;}
      if (m.type === 'query') void runWithLanguage(m.language, () => folderAccess.run(folderEnvelope(m),()=>query(m)));
      if (m.type === 'native_turn') void runWithLanguage(m.language, () => folderAccess.run(folderEnvelope(m),()=>nativeTurns.start(m)));
      if (m.type === 'native_turn_stop') void nativeTurns.stop(m.id);
      if (m.type === 'native_takeover_release') void nativeTurns.releaseLease(m.runtime,m.sessionId,m.leaseId).catch(e=>console.error('Native takeover release:',e.message));
      if (m.type === 'error') console.error(tr('worker.rejectedByHome'), m.error);
    } catch (e) { console.error(tr('worker.protocolError'), e.message); }
  });
  ws.on('error', e => console.error(tr('worker.connectionError'), e.message));
  ws.on('close', () => {
    for(const query of configurationQueries.values()){clearTimeout(query.timer);query.reject(new Error('Home disconnected during execution configuration query.'));}configurationQueries.clear();
    paused=true;registered=false;readySent=false;eventSent.clear();
    void nativeTurns.stopAll();
    // A brief network blip keeps idle processes, still subject to the original identity fingerprint and idle deadline; an explicit pause/quit closes them immediately.
    clearTimeout(reconnectCleanup);reconnectCleanup=setTimeout(()=>{void warmSessions.closeAll();},30000);reconnectCleanup.unref();
    for(const controller of organizerControllers)controller.abort();if(!quitting)setTimeout(connect,5000);
  });
}
const outboxTimer=setInterval(flushOutbox,1000);outboxTimer.unref();
const sourceSyncTimer=setInterval(()=>{if(registered)sourceSync.flush();void sourceSync.watch.tick().catch(e=>console.error('Source sync observation failed:',e.code||e.message));},500);sourceSyncTimer.unref();
const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 15000);
const runtimeTimer = setInterval(() => { if (ws?.readyState === 1) void refreshRuntimes(); }, 300000);
await nativeTurns.recover();
connect();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if(quitting)return;
  quitting = true; clearInterval(heartbeat); clearInterval(runtimeTimer);clearInterval(outboxTimer);clearTimeout(reconnectCleanup);
  clearInterval(sourceSyncTimer);sourceSync.watch.close();
  void warmSessions.closeAll();
  for(const controller of organizerControllers)controller.abort();
  for (const s of sessions.values()) { if (typeof s.stop === 'function' && !s.preparing) void s.stop(); else s.stopRequested = true; }
  await nativeTurns.stopAll();
  setTimeout(() => { ws?.close(); db.close(); process.exit(0); }, 1500);
});
