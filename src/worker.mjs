import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { WarmSessions, warmSessionFingerprint } from './warm-sessions.mjs';
import {RoleSwitchWorker,recordSwitchOutput} from './role-switch-worker.mjs';
import {discussionPolicy,validatedDiscussionConfigurations,supportsDiscussion} from './discussion-policy.mjs';
import {inspectArtifactFiles} from './run-artifacts.mjs';
import { writeTurnContext, turnToolCommand } from './turn-context.mjs';
import { hostname, platform, homedir } from 'node:os';
import { readFile, mkdir, realpath, readdir, stat } from 'node:fs/promises';
import { openSync, writeFileSync, readFileSync, unlinkSync, closeSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store, terminal } from './store.mjs';
import {validateCliCapacity,reservedTerminalSlots} from './device-capacity.mjs';
import { readRunDocument } from './run-document.mjs';
import { CodexSession } from './codex.mjs';
import { CliPrintSession } from './cli-print-session.mjs';
import { browseFolders } from './folders.mjs';
import { giteeRepository } from './repository.mjs';
import { inspectRuntimes, runtimeIssue } from './runtime-probe.mjs';
import { writeHandoff } from './wb-tools.mjs';
import { resolveNodeKind } from './node-kind.mjs';
import { normalizeRemoteDesktopUrl } from './remote-desktop.mjs';
import { validateLaunch, afterProcessExit, recordDeliveryResult, recoverDeliveryCommands, continuationSource } from './worker-coordinator.mjs';
import { publishDelivery, receiveDelivery } from './git-delivery.mjs';
import { composeAgentInstructions, executionRules } from './platform-prompts.mjs';
import { runtimeGuidance } from './runtime-guidance.mjs';
import { prepareSupervisorDirectory, setupRepository } from './setup-workspace.mjs';
import { startAgentBridge, agentProcessEnv } from './agent-bridge.mjs';
import { outboxBatch } from './worker-outbox.mjs';
import { prepareProjectSpace } from './project-space.mjs';
import { publishProjectDelivery, receiveProjectDelivery, fetchExecutionDeliveries } from './project-delivery.mjs';
import { collectCcusageReport } from './token-usage.mjs';
import { nativeEnvironment, findSessionHistory, projectTerminalLock, processAlive, releaseTerminalSession, resumeEnvironment, freshTerminalArgs } from './terminal-resume.mjs';
import { receiveAttachments } from './attachments.mjs';
import { inspectExecutionRepositories, prepareExecutionWorkspace, executionConflict, verifyExecutionVersions } from './execution-workspace.mjs';
import { createRunInput, instructionDelivery,executionInstructionComponents,executionEnvironmentHint } from './run-input.mjs';
import { inspectGitRepositoryVersion } from './git-version.mjs';
import { prepareProjectBaseline, advanceProjectBaseline } from './project-baseline.mjs';
import { runOrganizer } from './conversation-organizer.mjs';
import { runtimeGitEnvironment } from './hosting.mjs';
import { tr, getLanguage, setLanguage, initLanguage, runWithLanguage } from './i18n.mjs';
import {SourceSyncClient} from './source-sync-transport.mjs';
import {syncError} from './source-sync-manifest.mjs';
import {SourceProvenanceTracker} from './source-sync-provenance.mjs';
import {prepareSourceInputs,sourceOverlayUnchanged} from './source-sync-input.mjs';
import {captureSourceCandidate} from './source-sync-candidate.mjs';
import {readSourceBlob} from './source-sync-files.mjs';

const SYSTEM_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const exec = promisify(execFile);
const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = resolve(process.env.WORKER_DATA_DIR || join(base, '.data/worker'));
initLanguage(data); // saved language (data/language.json, written when Home announces its language); WB_LANGUAGE is only the first-run default
await mkdir(data, { recursive: true, mode: 0o700 });
// Only one Worker may use a data directory at a time; a second process must not rewrite run records first.
const lockFile = join(data, 'worker.lock');
try {
  const pid = Number(readFileSync(lockFile, 'utf8'));
  if (Number.isInteger(pid) && pid > 0) {
    let alive = true; try { process.kill(pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
    if (alive) throw new Error(tr('worker.dataDirectoryAlreadyHasWorker'));
  }
  unlinkSync(lockFile);
} catch (e) { if (e.code !== 'ENOENT') throw e; }
const lock = openSync(lockFile, 'wx', 0o600); writeFileSync(lock, String(process.pid)); closeSync(lock);
process.on('exit', () => { try { if (Number(readFileSync(lockFile, 'utf8')) === process.pid) unlinkSync(lockFile); } catch {} });
const db = new Store(join(data, 'worker.sqlite'));
const identity = db.get('identity', 'node') || db.put('identity', { id: 'node', nodeId: process.env.NODE_ID || randomUUID() });
const roots = await Promise.all((process.env.WORKER_ROOTS || base).split(delimiter).map(p => realpath(p)));
let defaultRoot = db.get('settings','workspace')?.localRoot || process.env.WORKSPACE_ROOT || roots[0];
const homeUrl = process.env.HOME_URL || 'ws://127.0.0.1:4317/worker';
const token = process.env.WORKER_TOKEN || (await readFile(join(base, '.data/home/worker-token'), 'utf8')).trim();
const sessions = new Map();
let organizerRunning = 0;
const organizerControllers = new Set();
let capacity = validateCliCapacity(db.get('settings','cli-capacity')?.capacity??Number(process.env.WORKER_CONCURRENCY||2));
let ws, paused = true, quitting = false, registered = false, readySent = false, reconnectCleanup;
const eventSent = new Map();
let runtimes = await inspectRuntimes(), probing;
// The first version is still in isolated acceptance testing; only adapters that are explicitly enabled and have version-tested evidence report the capability.
const discussionCapabilities=()=>{
  const bins={codex:process.env.CODEX_BIN||'codex',claude:process.env.CLAUDE_BIN||'claude',grok:process.env.GROK_BIN||'grok',agy:process.env.AGY_BIN||'agy'};
  const configurations=process.env.WB_DISCUSSION_PREVIEW==='1'?validatedDiscussionConfigurations(process.env.WB_DISCUSSION_VALIDATED_CONFIGS,runtimes,bins):[];
  return {discussionProtocol:configurations.length?2:0,discussionRuntimes:[...new Set(configurations.map(c=>c.runtime))],discussionConfigurations:configurations};
};
if(process.env.WB_DISCUSSION_PREVIEW==='1'&&!discussionCapabilities().discussionConfigurations.length)console.warn(tr('worker.discussionPreviewNotEnabledNo'));
async function refreshRuntimes() {
  if (!probing) probing = inspectRuntimes().then(r => { runtimes = r; send({ type: 'runtime_report', runtimes,discussionCapabilities:discussionCapabilities() }); return runtimes; }).finally(() => { probing = null; });
  return probing;
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
const warmSessions = new WarmSessions({max:capacity,changed:()=>{send({type:'warm_sessions',sessions:warmSessions.snapshot()});reportCapacity();}});
/** Slot reservations count before asynchronous preparation; retained processes are reclaimed, never active work. */
function occupiedSlots(){return sessions.size+organizerRunning+reservedTerminalSlots(db,identity.nodeId);}
function reportCapacity(){send({type:'capacity_state',capacity,usage:{active:sessions.size,retained:warmSessions.snapshot().length,organizer:organizerRunning,terminal:reservedTerminalSlots(db,identity.nodeId)}});}
async function applyCapacity(value) {
  capacity=validateCliCapacity(value);db.put('settings',{id:'cli-capacity',capacity});warmSessions.max=capacity;
  await warmSessions.trim(occupiedSlots());reportCapacity();return {capacity};
}
const roleSwitchWorker=new RoleSwitchWorker({db,warmSessions,activeSessions:sessions,roots,runtimes:()=>runtimes,readHistory:async id=>{
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw new Error('Invalid CLI switch history ID.');
  const response=await fetch(homeUrl.replace(/^ws/i,'http').replace(/\/worker\/?$/,'')+`/api/agent/cli-switches/${id}/history`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error('Unable to retrieve CLI switch history.');return response.text();
}});
const inside = (root, path) => { const rel = relative(root, path); return !rel || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel)); };
const sourceSync=new SourceSyncClient({db,data,home:homeUrl.replace(/^ws/i,'http').replace(/\/worker\/?$/,''),send,
  paused:()=>paused||quitting,
  activeRuns:()=>[...db.list('runs'),...db.list('sourceSyncOperations')],
  takeoverState:projectId=>Boolean(projectTerminalLock(db,projectId,identity.nodeId)),
  resolveBinding:async command=>{
    if(command.nodeId!==identity.nodeId)throw syncError('receipt_owner_mismatch');
    const root=await projectRoot(command.root),id=`${command.projectId}:${command.repositoryId}${command.sourceRunId?':'+command.sourceRunId:''}`;
    if(command.sourceRunId){const source=db.get('runs',command.sourceRunId),repo=source?.repositories?.find(r=>r.id===command.repositoryId);
      if(source?.projectId!==command.projectId||!repo||await projectRoot(repo.localRoot)!==root)throw syncError('binding_changed');}
    const old=db.get('sourceSyncBindings',id);
    if(old&&(old.generation>command.generation||old.generation===command.generation&&old.root!==root))throw syncError('binding_changed');
    const binding={id,projectId:command.projectId,repositoryId:command.repositoryId,root,generation:command.generation};db.put('sourceSyncBindings',binding);return binding;
  }});

/** The local outbox is written to disk first and deleted only after Home confirms, so "sent" is never treated as "received". */
function emit(runId, type, payload) {
  recordSwitchOutput(db,runId,type,payload);
  const r = db.get('runs', runId);
  if (!r) return;
  const seq = (r.seq || 0) + 1;
  if (type === 'approval') payload = { ...payload, rpcId: payload.id, id: `${runId}:${payload.id}`, runId, status: 'pending' };
  if (type === 'approval_resolved') payload = { ...payload, id: `${runId}:${payload.id}` };
  const next = { ...r, seq, ...(type === 'status' ? payload : {}) };
  const event = { id: randomUUID(), runId, seq, type, payload, createdAt: new Date().toISOString() };
  db.transaction(() => { db.put('runs', next); db.put('outbox', event); });
  flushOutbox();
  return event;
}
/** Paths and symlinks are resolved on the execution node; the allowed root directories are checked at registration and on every launch. */
async function projectRoot(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new Error(tr('worker.projectDirectoryMustBeAbsolute'));
  const root = await realpath(path);
  if (!roots.some(r => inside(r, root))) throw new Error(tr('worker.projectPathNotInsideWorker'));
  if (!(await stat(root)).isDirectory()) throw new Error(tr('worker.projectPathMustBeDirectory'));
  return root;
}
/** The writable space must be under a configured root directory; Git uses an independent worktree at a fixed baseline. */
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
    ...(m.run.execution ? {execution:m.run.execution}:{}),...(m.run.sourceInputs?.length?{sourceInputs:m.run.sourceInputs}:{}),...(m.run.attachments?.length ? {attachments:m.run.attachments}:{}) });
  const prior = db.get('commands', c.id);
  if (prior) {
    if (prior.signature !== signature) throw new Error(tr('worker.duplicateCommandParameterConflict'));
    if (!prior.deferred || db.get('runs',c.runId)) {
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
    if (db.get('runs', c.runId)) { send({ type: 'command_ack', id: c.id }); return; }
    db.put('runs', { id: c.runId, projectId: m.run.projectId, nodeId:identity.nodeId,execution:m.run.execution||null,roleId: m.run.roleId,roleSessionId:m.run.roleSessionId, status: 'starting', seq: 0,
      switchOperationId:m.run.switchOperationId,switchPhase:m.run.switchPhase,switchHandoffHash:m.run.switchHandoffHash });
    send({ type: 'command_ack', id: c.id });
    let bridge, ending=false,provenance;
    try {
      const policy=discussionPolicy(m.run),discussionTurn=policy.turnPurpose!=='task';
      roleSwitchWorker.assertLaunch(m.run);
      const discussionEnabled=supportsDiscussion({capabilities:discussionCapabilities(),runtimes},m.run.roleSnapshot?.runtime,m.run.roleSnapshot?.model);
      if((discussionTurn||m.run.discussionProtocol===2)&&(!discussionEnabled||m.run.discussionProtocol!==2))throw new Error(tr('worker.discussionProtocolV2NotEnabled'));
      if (paused || m.paused) throw new Error(tr('worker.remoteCommandsPaused'));
      if(!sourceSync.worker.canStart(m.run.projectId))throw syncError('sync_busy');
      if (projectTerminalLock(db,m.run.projectId,identity.nodeId)) throw new Error(tr('worker.projectUnderManualTerminalTakeover'));
      if (m.run.nodeId !== identity.nodeId) throw new Error(tr('worker.assignmentDoesNotBelongMachine'));
      if (m.run.requestId) validateLaunch({ request: m.request, roleSnapshot: m.run.roleSnapshot, delivery: m.delivery, currentPlanVersion: m.run.planVersion });
      const issue = runtimeIssue({ capabilities: { runtimeDiscovery: true }, runtimes }, m.run.roleSnapshot?.runtime || 'codex', m.task.model);
      if (issue) throw new Error(issue);
      if (db.list('runs').some(r => r.id !== c.runId && r.status === 'reconciling')) throw new Error(tr('worker.workerFullHasProcessesAwaiting'));
      if (executionConflict(m.run,db.list('runs').filter(r=>r.id!==c.runId && !terminal.has(r.status)).map(r=>({...r,nodeId:identity.nodeId})))) throw new Error(tr('worker.projectWorkspaceExclusiveOperationStill'));
      const reservation = { preparing: true, stopRequested: false };
      sessions.set(c.runId, reservation);
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
      let sourceInputReceipts=[],sourceInputAccess;
      if(m.run.sourceInputs?.length){
        const get=async(input,hash)=>{const response=await fetch(`${homeUrl.replace(/^ws/i,'http').replace(/\/worker\/?$/,'')}/api/agent/source-inputs/${c.runId}/${input.manifestId}${hash?'/blobs/'+hash:''}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(60000)});if(!response.ok)throw syncError('source_input_not_ready');return hash?Buffer.from(await response.arrayBuffer()):response.json();};
        sourceInputAccess={run:m.run,repositories:executionRepositories,db,blobRoot:sourceSync.blobRoot,readManifest:input=>get(input),fetchBlob:get};
        const inherited=continued?.sourceInputReceipts;
        if(inherited?.length===m.run.sourceInputs.length&&m.run.sourceInputs.every(i=>inherited.some(v=>v.repositoryId===i.repositoryId&&v.manifestHash===i.manifestHash&&v.generation===i.generation)))sourceInputReceipts=inherited.map(i=>({...i,inheritedFrom:continued.id}));
        else sourceInputReceipts=await prepareSourceInputs({...sourceInputAccess,freshIsolated:Boolean(m.run.execution?.isolated&&!continued&&!m.run.resumeWorkspace)});
      }
      const repositoryRoots = executionRepositories.filter(r=>r.localRoot).map(r=>r.localRoot);
      const workspaceRunId = continued ? continued.workspaceRunId || continued.id : c.runId;
      if (!source || m.task.mode !== 'read-only') db.put('workspaceOwners', { id: folder, runId: c.runId });
      emit(c.runId, 'status', { status: 'starting', workspace: folder, baseCommit, workspaceRunId, repositories:executionRepositories, projectScope:m.run.projectScope, ...(source ? { sourceWorkspace: source.workspace } : {}) });
      if(m.run.sourceInputs?.length||m.run.sourceConflictId)emit(c.runId,'status',{sourceInputs:m.run.sourceInputs||[],sourceInputReceipts,sourceConflictId:m.run.sourceConflictId||null,sourceConflictGeneration:m.run.sourceConflictGeneration,sourceConflictAssignmentId:m.run.sourceConflictAssignmentId});
      if (reservation.stopRequested || paused || ws?.readyState !== 1) { emit(c.runId, 'status', { status: 'interrupted', error: tr('worker.interruptedByStopDisconnectBefore') }); return; }
      const runtimeType = m.run.roleSnapshot?.runtime || 'codex';
      if (!['codex', 'grok', 'agy', 'claude'].includes(runtimeType)) throw new Error(tr('worker.runtimeNotSupportedYet', { runtimeType }));
      const modelEffort = runtimes.find(r => r.type === runtimeType)?.models?.find(model => model.id === m.task.model)?.effort;
      const effort = m.run.roleSnapshot?.effort || modelEffort || null;
      const Session = runtimeType === 'codex' ? CodexSession : CliPrintSession;
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
        canSend: () => !paused && !quitting && !terminal.has(db.get('runs', c.runId)?.status) && !['stopping', 'reconciling'].includes(db.get('runs', c.runId)?.status) });
      const wbEnv = agentProcessEnv(await runtimeGitEnvironment({directory:join(data,'git-auth'),key:m.run.roleSessionId||c.runId,repositories:executionRepositories,credentials:m.gitCredentials,env:process.env}), {
        PATH: `${join(base, 'bin')}${delimiter}${process.env.PATH || ''}`,
        WB_PROJECT_ROOT: m.run.execution?.isolated ? folder : root,
        WB_KNOWLEDGE: knowledge,
        WB_WORKSPACE: folder,
        WB_RUN_ID: c.runId,
        WB_ROLE_SESSION_ID: m.run.roleSessionId || '',
        WB_SOURCE_SYNC:'1',
        WB_CONVERSATION_ID: m.run.projectId,
        WB_REQUEST_ID: m.run.requestId || '',
        WB_ROLE: m.run.roleSnapshot?.name || '',
        WB_SYSTEM_SUPERVISOR: m.run.roleSnapshot?.systemSupervisor && !m.run.roleSnapshot?.platformAssistant ? '1' : '0',
        WB_CLI: join(base, 'src', 'wb-cli.mjs'),
        WB_BRIDGE: bridge.directory,
        WB_HOP: String(m.run.hop || m.task?.hop || 0),
        WB_HOME: homeHttp,
        WB_MODE: m.task.mode,
        WB_LANGUAGE: getLanguage()
      });
      wbEnv.WB_REPOSITORIES = JSON.stringify(executionRepositories);
      wbEnv.WB_TURN_PURPOSE=policy.turnPurpose;
      wbEnv.WB_DISCUSSION_PROTOCOL=m.run.discussionProtocol===2?'2':'0';
      const keepAlive=Boolean(!m.run.switchOperationId && m.run.roleSessionId && ['codex','claude','agy'].includes(runtimeType));
      const contextFile=join(bridge.directory,'turn-context.json');
      wbEnv.WB_TURN_CONTEXT=contextFile;
      const wbCommand=turnToolCommand(contextFile,join(base,'src','wb-cli.mjs'),process.execPath,{boundCli:runtimeType==='codex'&&m.run.discussionProtocol===2});
      let endRun, finalStatus;
      const ended = new Promise(resolve => { endRun = resolve; });
      const native = await nativeEnvironment(runtimeType);
      if(m.run.resumeNativeSessionId) {
        const prior=m.run.resumeNativeSession;
        if(!prior || prior.id!==m.run.resumeNativeSessionId || prior.runtime!==runtimeType || prior.user!==native.user || prior.home!==native.home)throw new Error(tr('worker.nativeSessionIdentityHasChanged'));
        await findSessionHistory(prior);
        if(db.list('runs').some(r=>r.id!==c.runId && r.runtimeRetained && r.nativeSession?.id===prior.id && processAlive(r.pid) && !warmSessions.owns(r.pid)))throw new Error(tr('worker.nativeSessionStillHasProcess'));
      }
      db.put('runtimeEnvironments',{id:c.runId,env:resumeEnvironment(wbEnv)});
      if(m.run.sourceSyncTracking){
        provenance=new SourceProvenanceTracker({db,run:{...m.run,workspace:folder},repositories:executionRepositories,blobRoot:sourceSync.blobRoot,
          publish:proof=>emit(c.runId,'source_provenance',proof)});
        await provenance.start();
      }
      emit(c.runId, 'status', { nativeSession: native });
      // The turn purpose goes into the dynamic input, so switching between Q&A and business stages does not needlessly recycle the warm process.
      const executionConfiguration=m.run.minimalInstructions===1?await currentExecutionConfiguration(c.runId):null;
      if(reservation.stopRequested||paused||quitting||ws?.readyState!==1)throw new Error(tr('worker.interruptedByStopDisconnectBefore'));
      const components=executionConfiguration?executionInstructionComponents({run:m.run,configuration:executionConfiguration}):undefined;
      const roleInstructions = components?Object.values(components).filter(Boolean).join('\n\n'):tr('worker.projectDescriptionRepositoriesForRun', { p1: composeAgentInstructions(m.platformPrompt,m.run.roleSnapshot?.instructions??''), p2: String(m.project.description||'').slice(0,4000), p3: executionRepositories.filter(r=>r.localRoot).map(r=>`${r.key}: ${r.localRoot}`).join('\n'), p4: runtimeGuidance(runtimeType), p5: m.task.runtimeInstructions||'' });
      const priorInput=db.list('runs').filter(r=>r.id!==c.runId && r.projectId===m.run.projectId && r.roleSessionId===m.run.roleSessionId && r.nativeSession?.id===m.run.resumeNativeSessionId).at(-1);
      let instructions=instructionDelivery({runtime:runtimeType,run:m.run,prior:priorInput,instructions:roleInstructions,roleName:m.run.roleSnapshot?.name,components});
      const fingerprint=warmSessionFingerprint({folder,runtimeType,model:m.task.model,effort,roleName:m.run.roleSnapshot?.name,roleInstructions,env:resumeEnvironment(wbEnv)});
      let session;
      const options={ cwd: folder, writableRoots:repositoryRoots, attachments: inputFiles, model: m.task.model, mode: m.task.mode, effort, runtime: runtimeType, autoApprove: m.run.roleSnapshot?.autoApprove !== false,keepAlive,maintenance:Boolean(m.run.switchOperationId),
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
      const context = source ? tr('worker.referencedExecutionSFilesLocated', { workspace: source.workspace, p2: source.baseCommit || tr('worker.plainDirectory'), p3: source.workspace === folder && m.run.projectScope ? tr('worker.currentDirectorySharedDirectorySame') : m.task.mode === 'read-only' ? tr('worker.currentDirectorySourceWorkspacePerform') : tr('worker.directoryReadOnlyChangesFor') }) : '';
      const setupHint = !m.run.switchOperationId && m.run.roleSnapshot?.systemSupervisor ? tr('worker.supervisorSetupToolsCanBe', { wbCommand }) : '';
      const boundary = m.run.projectScope && !m.run.deliveryId && !m.run.execution?.isolated ? tr('worker.projectDirectoryCurrentDirectoryListed', { root }) : tr('worker.originalProjectDirectoryItMay', { root });
      const attachmentHint = inputFiles.length ? tr('worker.userAttachmentsForTurnUntrusted', { p1: inputFiles.map(a => JSON.stringify({name:a.name,path:a.path,mime:a.mime})).join('\n') }) : '';
      const toolGuide=executionConfiguration?tr('minimal.toolEntry',{wbCommand}):[tr('worker.wbCommandPrefixForTurn', { wbCommand }),(m.run.sourceSyncTracking||m.run.sourceConflictId||m.run.sourceConflictPeerId||m.run.sourceConflictAssignmentRequestId)?tr('sourceSync.toolGuide'):''].filter(Boolean).join('\n\n');
      const taskPrompt=[m.task.prompt,executionConfiguration?.dependencyEvents?.length?tr('minimal.dependencyEvent',{events:JSON.stringify(executionConfiguration.dependencyEvents)}):''].filter(Boolean).join('\n\n');
      const environmentHint=executionConfiguration?executionEnvironmentHint({cwd:folder,projectRoot:root,boundary,repositories:executionRepositories}):'';
      const input = createRunInput({ minimal:Boolean(executionConfiguration),environmentHint,configurationUpdate:instructions.configurationUpdate,taskPrompt, boundary, context, runtimeGuidance:toolGuide, setupHint, attachmentHint,
        executionInstructions:m.run.switchOperationId?'Read-only CLI handoff maintenance. Return the requested final answer; do not execute business work or write handoff files.':executionRules(m.run),roleInstructions:instructions.instructions,sourceInputs:sourceInputReceipts });
      if(instructions.inheritedFrom)input.instructionsInheritedFrom=instructions.inheritedFrom;
      emit(c.runId, 'input', input);
      const result = session.start(input.prompt);
      db.put('runs', { ...db.get('runs', c.runId), pid: session.proc?.pid });
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
        warmSessions.keep(m.run.roleSessionId,fingerprint,session,{projectId:m.run.projectId,roleId:m.run.roleId,runtime:runtimeType});
        await warmSessions.trim(occupiedSlots());
      } else {session.shutdown();await afterProcessExit(session.proc,()=>{});sessions.delete(c.runId);}
      emit(c.runId,'status',{...finalStatus,runtimeRetained:warmSessions.owns(session.proc?.pid),processSettled:!warmSessions.owns(session.proc?.pid),...(m.run.discussionProtocol===2?{discussionCleanup:{turnEnded:true,toolsClosed:true,effectsKnown:false}}:{})});
    } catch (e) {
      ending=true;
      await provenance?.finish();
      const entry = sessions.get(c.runId),s=entry?.preparing?entry.session:entry;
      if (typeof s?.finish === 'function') { s.finish('failed', e.message); s.shutdown(); await afterProcessExit(s.proc, () => sessions.delete(c.runId)); }
      await bridge?.stop();bridge=null;
      emit(c.runId, 'status', { status: 'failed', error: e.message,...(m.run.minimalInstructions===1?{configurationState:'failed',configurationError:e.message}:{}) }); sessions.delete(c.runId);
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
      const s = sessions.get(c.runId);
      if (s?.preparing) s.stopRequested = true;
      else if (s) { emit(c.runId, 'status', { status: 'stopping' }); void s.stop(); }
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
  const modifies=['repository_setup','execution_receive','execution_baseline_advance','terminal_prepare','terminal_new'].includes(m.action);
  try {
    if(['role_switch_inspect','role_switch_prepare','role_switch_release','role_switch_status'].includes(m.action)) {
      if(m.path?.nodeId!==identity.nodeId)throw new Error('CLI switch addressed to another Worker.');
      const method=m.action.slice('role_switch_'.length);
      const result=method==='status'?roleSwitchWorker.status(m.path.operationId):await roleSwitchWorker[method](m.path);
      send({type:'reply',id:m.id,result});return;
    }
    if(modifies){if(db.list('sourceSyncReservations').length)throw syncError('sync_busy');db.put('sourceSyncOperations',{id:m.id,projectId:m.path?.projectId||db.get('runs',m.runId)?.projectId||'*',status:'running'});}
    if(m.action==='source_sync_candidate'){
      const run=db.get('runs',m.runId),input=m.path,repo=run?.repositories?.find(r=>r.id===input.repositoryId),frozen=run?.sourceInputs?.find(r=>r.repositoryId===input.repositoryId);
      if(!run||terminal.has(run.status)||!run.sourceConflictId||run.sourceConflictId!==input.conflictId||!repo||!frozen)throw syncError('candidate_not_ready');
      const home=homeUrl.replace(/^ws/i,'http').replace(/\/worker\/?$/,'');
      const request=async(path,method='GET',body)=>{const response=await fetch(home+path,{method,headers:{Authorization:`Bearer ${token}`,...(body&&!Buffer.isBuffer(body)?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});if(!response.ok){const error=await response.json();throw syncError(error.code||'candidate_failed');}return response.json();};
      const baseline=await request(`/api/agent/source-inputs/${run.id}/${frozen.manifestId}`);
      const candidate=await captureSourceCandidate({root:await projectRoot(repo.localRoot),path:input.path,baseline,blobRoot:sourceSync.blobRoot});
      await request('/api/agent/source-candidates','POST',{runId:run.id,candidateId:input.candidateId,baselineManifestId:frozen.manifestId,...candidate});
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
    if(m.action==='terminal_prepare' || m.action==='terminal_release' || m.action==='terminal_new') {
      const id=m.path?.id;
      if(typeof id!=='string' || !/^[a-zA-Z0-9-]{8,100}$/.test(id))throw new Error(tr('worker.invalidTakeoverId'));
      const prior=db.get('terminalSessions',id);
      if(m.action==='terminal_release') {
        // Even if the prepare request timed out, the revocation is recorded so that a delayed request cannot re-prepare an old link.
        releaseTerminalSession(db,id);
        reportCapacity();
        send({type:'reply',id:m.id,result:{released:true}});return;
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
        const instructions=[composeAgentInstructions(input.platformPrompt,[role.instructions,input.supervisorPrompt].filter(Boolean).join('\n\n')),tr('roleTerminal.manualContext')].filter(Boolean).join('\n\n');
        const roleSettings={runtime:role.runtime,model:role.model,effort:role.effort||null,instructions};
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
      if(!r || !terminal.has(r.status) || sessions.has(r.id) || processAlive(r.pid))throw new Error(tr('worker.originalCliHasNotExited'));
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
      const historyFile=await findSessionHistory(nativeSession);
      const info={id,projectId:r.projectId,nodeId:identity.nodeId,runId:r.id,status:'prepared',workspace,nativeSession,privateEnv,historyFile,createdAt:new Date().toISOString()};
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
        const source = await setupRepository(roots, m.path);
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
      send({ type: 'reply', id: m.id, result: await browseFolders(roots, m.path?.path, m.path?.offset || 0) }); return;
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
      send({type:'reply',id:m.id,result:await readRunDocument(root,m.path)});return;
    }
    if (m.action === 'file') {
      if (!m.path || m.path.split(/[\\/]/).some(p => p.startsWith('.') || /credential|secret/i.test(p))) throw new Error(tr('worker.readingPathNotAllowed'));
      const file = await realpath(resolve(root, m.path));
      if (!inside(root, file)) throw new Error(tr('worker.fileOutsideAllowedRoot'));
      const info = await stat(file); if (!info.isFile() || info.size > 200000) throw new Error(tr('worker.onlyTextPreviewsUp200kb'));
      const content = await readFile(file, 'utf8'); if (content.includes('\0')) throw new Error(tr('worker.binaryFilesDoNotSupport'));
      send({ type: 'reply', id: m.id, result: { path: m.path, content } });
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
  } catch (e) { send({ type: 'reply', id: m.id, error: e.message }); }
  finally {if(modifies)db.remove('sourceSyncOperations',m.id);}
}
// On Worker restart, only known PIDs are verified; no --resume is attempted and no replacement process is started.
recoverDeliveryCommands(db);
for (const r of db.list('runs').filter(r => !terminal.has(r.status))) {
  let alive = false; if (r.pid) try { process.kill(r.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
  emit(r.id, 'status', { status: alive ? 'reconciling' : 'interrupted', controlLost: true, error: alive ? tr('worker.leftoverProcessFoundAwaitingManual') : tr('worker.workerRestartedOriginalManagedProcess') });
}
function connect() {
  if (quitting) return;
  ws = new WebSocket(homeUrl, { headers: { Authorization: `Bearer ${token}` }, maxPayload: 1024 * 1024 });
  ws.on('open', () => {
    const systemPlatform = platform();
    send({ type: 'register', node: { id: identity.nodeId, name: process.env.NODE_NAME || hostname(), platform: systemPlatform,organizerBusy:organizerRunning,
      nodeKind: resolveNodeKind(process.env.NODE_KIND, systemPlatform),
      remoteDesktopUrl: normalizeRemoteDesktopUrl(process.env.REMOTE_DESKTOP_URL),
      workspaceRoot:defaultRoot,warmSessions:warmSessions.snapshot(), capabilities: { minimalInstructions:1,terminalFresh:1,cliCapacity:1,roleSwitch:1,sourceSync:1,sourceSyncTools:1,openProjectFolder:systemPlatform==='darwin'&&resolveNodeKind(process.env.NODE_KIND,systemPlatform)==='local'?1:0,peerStatus:1,...discussionCapabilities(),summaryBatches:1,stableInstructions:1,warmSessions:1,gitVersions:1,attachmentTransfer:1,managedResume:1,sessionTools:1,timerTools:1,terminalResume:1,collaborationTools:2,executionScheduling:1,attachments:1, projectSpace:1, workspaceBindings: true, roomRoles: true, projectBrowser: true, runtimeDiscovery: true, tokenUsage:1, coordinationVersion: 1, projectSetup: 1 }, allowedRoots: roots, runtimes, capacity } });
  });
  ws.on('message', async bytes => {
    try {
      const m = JSON.parse(bytes);
      if(m.type==='execution_config') {
        const query=configurationQueries.get(m.id);if(!query)return;
        configurationQueries.delete(m.id);clearTimeout(query.timer);m.error?query.reject(new Error(m.error)):query.resolve(m.result);return;
      }
      if(m.type==='source_sync_command'){void sourceSync.execute(m);return;}
      if(m.type==='source_sync_cancel'){sourceSync.cancel(m.commandId);return;}
      if(m.type==='source_sync_receipt_ack'){sourceSync.acknowledge(m.commandId);return;}
      if (m.type === 'registered') {
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
      }
      if (m.type === 'settings') {paused = m.paused;if(paused)void warmSessions.closeAll();}
      if (m.type === 'language') { try { setLanguage(m.language); } catch { /* ignore unsupported values */ } }
      if (m.type === 'ack') {db.remove('outbox', m.id);eventSent.delete(m.id);flushOutbox();}
      // Each command/query runs under the language Home put on the message, so prompts and errors built on this Worker match it.
      if (m.type === 'command') void runWithLanguage(m.language, () => command(m)).catch(e => console.error(tr('worker.commandRejected'), e.message));
      if (m.type === 'query') void runWithLanguage(m.language, () => query(m));
      if (m.type === 'error') console.error(tr('worker.rejectedByHome'), m.error);
    } catch (e) { console.error(tr('worker.protocolError'), e.message); }
  });
  ws.on('error', e => console.error(tr('worker.connectionError'), e.message));
  ws.on('close', () => {
    for(const query of configurationQueries.values()){clearTimeout(query.timer);query.reject(new Error('Home disconnected during execution configuration query.'));}configurationQueries.clear();
    paused=true;registered=false;readySent=false;eventSent.clear();
    // A brief network blip keeps idle processes, still subject to the original identity fingerprint and idle deadline; an explicit pause/quit closes them immediately.
    clearTimeout(reconnectCleanup);reconnectCleanup=setTimeout(()=>{void warmSessions.closeAll();},30000);reconnectCleanup.unref();
    for(const controller of organizerControllers)controller.abort();if(!quitting)setTimeout(connect,5000);
  });
}
const outboxTimer=setInterval(flushOutbox,1000);outboxTimer.unref();
const sourceSyncTimer=setInterval(()=>{if(registered)sourceSync.flush();},1000);sourceSyncTimer.unref();
const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 15000);
const runtimeTimer = setInterval(() => { if (ws?.readyState === 1) void refreshRuntimes(); }, 300000);
connect();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  quitting = true; clearInterval(heartbeat); clearInterval(runtimeTimer);clearInterval(outboxTimer);clearTimeout(reconnectCleanup);
  void warmSessions.closeAll();
  for(const controller of organizerControllers)controller.abort();
  for (const s of sessions.values()) { if (typeof s.stop === 'function' && !s.preparing) void s.stop(); else s.stopRequested = true; }
  setTimeout(() => { ws?.close(); db.close(); process.exit(0); }, 1500);
});
