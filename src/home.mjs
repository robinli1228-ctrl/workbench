import {createHomeNativeTurns} from './native-turns-home.mjs';
import {mergeReportedRuntimes,expireRuntimeQuota} from './runtime-quota.mjs';
import {noteRoleCompaction,dueRoleCompactions,recordRoleCompaction} from './role-compaction.mjs';
import {createRemoteAccessSettings} from './remote-access-settings.mjs';
import http from 'node:http';
import { sendBufferedResponse } from './http-response.mjs';
import { readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Store, terminal } from './store.mjs';
import {ProjectTeamCopy,projectCopyView} from './project-team-copy.mjs';
import {GroupConversations,conversationIdOf,conversationView,agentConversationInput,resolveConversationId,assertConversationRecord,groupConversationIdOfSession} from './group-conversations.mjs';
import {assertAgentSender,allowsPausedAgentOperation} from './agent-bridge.mjs';
import {freezeExecutionConfiguration,supportsMinimalInstructions,instructionProtocolIssue} from './execution-configuration.mjs';
import {validateCliCapacity,reservedTerminalSlots,registrationCapacity} from './device-capacity.mjs';
import { SessionTools } from './session-tools.mjs';
import { RoleSessions } from './role-sessions.mjs';
import {newTerminalBinding,publishNewTerminal} from './role-terminal.mjs';
import {RoleSwitches,roleSwitchView} from './role-switches.mjs';
import {RoleSwitchRuntime} from './role-switch-runtime.mjs';
import { ConversationContext } from './conversation-context.mjs';
import { renderRunPrompt } from './run-context.mjs';
import { buildTeamContext, renderTeamContext } from './team-context.mjs';
import { Rooms } from './rooms.mjs';
import { CollaborationSessions, reviewView, reviewDocumentAllowed, setCollaborationSessionsEnabled } from './collaboration-sessions.mjs';
import { SessionQueue, QueuePump, queueConfig, setQueueConfig, setSessionBroadcast, setTestProject, grantBudget, reassignRequest } from './session-queue.mjs';
import { renderBatch } from './session-queue-worker.mjs';
import { listRoleTemplates, saveRoleTemplate, restoreRoleTemplate } from './role-templates.mjs';
import { Coordinator } from './coordinator.mjs';
import { RoleCalls } from './role-calls.mjs';
import {createAgentCalls} from './agent-calls.mjs';
import {RoleDiscussions} from './role-discussions.mjs';
import {supportsDiscussion} from './discussion-policy.mjs';
import {recentProjectArtifacts} from './run-artifacts.mjs';
import {ProjectFiles} from './project-files.mjs';
import {MediaStreams,MEDIA_CACHE_CONTROL,cachedMediaAllowed} from './media-streams.mjs';
import {MediaCache} from './media-cache.mjs';
import {CrossDeviceRead} from './cross-device-read.mjs';
import { RoleSteering } from './role-steering.mjs';
import { collaborationQueueView } from './coordination-wait.mjs';
import { WorkspaceStateFeed, workspaceScope, WORKSPACE_SUMMARY } from './workspace-state.mjs';
import { pageSummaries } from './workspace-summaries.mjs';
import { messageProgress, messageProgressView, reconcileCallResults } from './message-progress.mjs';
import { Deliveries } from './git-delivery.mjs';
import { visibleRuntimes, runtimeIssue } from './runtime-probe.mjs';
import { defaultPlatformPrompt, defaultSupervisorPrompt, normalizePlatformSettings, updatePlatformPrompts, updatePausedSetting, updateConversationOrganizer,legacyExecutionPrompt,executionRules } from './platform-prompts.mjs';
import { runtimeReportFresh } from './runtime-state.mjs';
import { ProjectSetup, validateLocalSupervisor, setupRules } from './project-setup.mjs';
import { roleWorkspace } from './project-repositories.mjs';
import { folderName } from './project-space.mjs';
import {folderAccessFor,nativeFolderAccess,FolderPreparations} from './folder-access.mjs';
import { CredentialStore, Hosting } from './hosting.mjs';
import { ProjectAdmin } from './project-admin.mjs';
import { DeviceAdmin } from './device-admin.mjs';
import { PlatformAssistant } from './platform-assistant.mjs';
import { TokenUsage, createTokenUsageBackgroundCollector } from './token-usage.mjs';
import { Attachments, AttachmentTransfers } from './attachments.mjs';
import { ExecutionPlans, schedulingRules } from './execution-plans.mjs';
import { History } from './history.mjs';
import { saveRunReport,readReportSubmission,readReportFile } from './run-reports.mjs';
import { receiptList,verifyResultReceipt,archiveHistoricalReceipts } from './result-receipts.mjs';
import { ScheduledJobs } from './scheduled-jobs.mjs';
import {ProactiveFollowup} from './proactive-followup.mjs';
import {CliRecoveryHome} from './cli-session-recovery-home.mjs';
import { TimerAgentActions } from './timer-agent.mjs';
import { inspectRunProgress } from './run-monitor.mjs';
import { projectTerminalLock, nativeSessionProjectIds, nativeTerminalProject, terminalCommand, terminalLaunchView, TERMINAL_PREPARATION_TTL_MS } from './terminal-resume.mjs';
import { ProjectGitVersions } from './project-git-versions.mjs';
import {SourceSyncHome} from './source-sync-transport.mjs';
import {dataStats,cleanupData,vacuumIfWasteful,normalizeRetention} from './data-retention.mjs';
import {acceptSourceProvenance} from './source-sync-provenance.mjs';
import { WechatChannel, wechatTransport } from './wechat-channel.mjs';
import { tr, getLanguage, setLanguage, initLanguage, runWithLanguage } from './i18n.mjs';
import { roleResponsibility } from './role-definition.mjs';
import { resolveNodeKind } from './node-kind.mjs';
import {readSoftwareVersion} from './software-version.mjs';
import {SoftwareUpdates} from './software-updates.mjs';

const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const softwareVersion=await readSoftwareVersion(base);
const softwareUpdates=new SoftwareUpdates({repository:softwareVersion.repository});
const data = resolve(process.env.DATA_DIR || join(base, '.data/home'));
initLanguage(data); // load the saved language (data/language.json) before any text is produced
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4317);
const apiToken = process.env.API_TOKEN || '';
const remoteAccessSettings=createRemoteAccessSettings({configFile:resolve(process.env.REMOTE_ACCESS_CONFIG||join(data,'remote-access','config.json')),homeOrigin:`http://${host==='::1'?'[::1]':host}:${port}`});
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !apiToken) throw new Error(tr('home.nonLoopbackListeningRequiresApi'));
await mkdir(data, { recursive: true, mode: 0o700 });
let workerToken = process.env.WORKER_TOKEN;
if (!workerToken) {
  const tokenFile = join(data, 'worker-token');
  try { workerToken = (await readFile(tokenFile, 'utf8')).trim(); }
  catch { workerToken = randomBytes(32).toString('hex'); await writeFile(tokenFile, workerToken, { mode: 0o600 }); }
  await chmod(tokenFile, 0o600);
}
const db = new Store(join(data, 'home.sqlite'));
for (const project of db.list('projects')) {
  if (!project.folderName) db.put('projects', { ...project, folderName:`project-${project.id.slice(0,8)}` });
}
// Workspace isolation is the unified security boundary; legacy roles no longer keep read-only or manual-approval policies at startup.
for (const role of db.list('roles')) {
  // A copied definition is an accepted exact snapshot, not an old preset awaiting migration.
  if(role.copyOperationId)continue;
  if (role.mode !== 'workspace-write' || role.autoApprove !== true || role.repositoryId || (role.systemSupervisor && !role.platformAssistant && role.instructions !== setupRules())) db.put('roles', { ...role, repositoryId:null, mode: 'workspace-write', autoApprove: true, ...(role.systemSupervisor && !role.platformAssistant ? {instructions:setupRules()} : {}) });
}
/** The fixed project supervisors always carry the platform setup rules in the current language (also refreshed when the language changes). */
function syncSupervisorInstructions() {
  const rules = setupRules();
  for (const role of db.list('roles')) {
    if (role.systemSupervisor && !role.platformAssistant && !role.copyOperationId && role.instructions !== rules) db.put('roles', { ...role, instructions: rules });
  }
}
const rooms = new Rooms(db);
const projectTeamCopy=new ProjectTeamCopy({db,query:workerQuery,online:id=>online(id),change:()=>change()});
const attachments = new Attachments(db, join(data, 'attachments'));
rooms.attachments = attachments;
const attachmentTransfers=new AttachmentTransfers({db,attachments,query:workerQuery,online:id=>online(id),change:()=>change()});
const coordinator = new Coordinator(db);
const calls = new RoleCalls(db);
const discussions=new RoleDiscussions(db,{online:id=>online(id)});
const steering = new RoleSteering(db,calls);
const history = new History(db);
const sessionTools = new SessionTools(db);
const collaborationSessions = new CollaborationSessions(db);

/** Freeze shared document versions before independent reviewers run; a child cannot rebase onto already protected opinions. */
async function reviewDocumentBaselines(projectId,input) {
  if(input.type!=='independent-review')return [];
  const prior=input.id?db.get('collaborationSessions',input.id):null;
  if(prior?.projectId===projectId)return prior.documentBaselines||[];
  const parent=input.parentSessionId?db.get('collaborationSessions',input.parentSessionId):null;
  if(parent?.projectId===projectId&&parent.type==='independent-review'&&!parent.reviewReleasedAt)return parent.documentBaselines||[];
  const nodes=[...new Set((input.participants||[]).map(item=>db.get('roles',typeof item==='string'?item:item.roleId)).filter(role=>role?.projectId===projectId).map(role=>role.nodeId).filter(Boolean))];
  const snapshots=await Promise.all(nodes.map(async nodeId=>{
    const root=db.get('workspaces',`${projectId}:${nodeId}`)?.localRoot;
    if(!root)return [];
    try{const result=await workerQuery({nodeId,projectId},'collaboration_documents',{root,action:'snapshot'},15000);return result.files.map(file=>({...file,nodeId}));}
    catch{return [];}// Unavailable baselines deny unknown documents later; they never grant access to new opinions.
  }));
  return snapshots.flat();
}
const conversationContext = new ConversationContext(db);
conversationContext.recover();
for(const task of db.list('tasks').filter(task=>task.origin==='chat'&&task.status==='ready'&&task.contextState==='pending'))db.put('tasks',{...task,contextState:null});
const scheduledJobs = new ScheduledJobs(db,rooms);
const proactiveFollowup=new ProactiveFollowup(db,rooms);
const timerAgent = new TimerAgentActions(db,scheduledJobs);
const executionPlans = new ExecutionPlans(db,calls,workerQuery,{
  request:(run,items)=>deliveries.request(run,{requestId:'planned-handoff',commit:items[0].commit,items,summary:tr('home.supervisorStageDeliveryContinueWith')}),
  receive:async(nodeId,repositories,records,projectId)=>{
    const prepared=[];for(const r of repositories)prepared.push({...r,credential:await hosting.auth(r.accountId,r.repoUrl)});
    return workerQuery({nodeId,projectId},'execution_receive',{repositories:prepared,deliveries:records},90000);
  }
});
const deliveries = new Deliveries(db);
db.transaction(()=>{
  discussions.recover();
  // Stuck waits from before the resume fix end explicitly here, so replaying results below cannot revive them.
  calls.reconcileStuckWaits();
  calls.recoverTerminalRuns();
  for (const run of db.list('runs').filter(r=>terminal.has(r.status))) rooms.complete(run);
  archiveHistoricalReceipts(db);
});
for (const run of db.list('runs').filter(r => !terminal.has(r.status))) db.put('runs', { ...run, status: run.status === 'stopping' ? 'stopping' : 'reconciling' });
const sockets = new Map();
const reconnectingNodes = new Set();
/** Sessions-page takeover hook (src/native-turns-home.mjs). */
const nativeTurns=createHomeNativeTurns({db,dataDir:data,send:(nodeId,payload)=>{if(!reconnectingNodes.has(nodeId))send(sockets.get(nodeId),{...payload,language:getLanguage()});},online:id=>sockets.get(id)?.readyState===1&&!reconnectingNodes.has(id),change:()=>change(),busy:(projectId,nodeId)=>sourceSync.busy(projectId,nodeId),sessionRecord:ownedNativeSession,
  // A session-bound hosting account becomes the Basic-auth header for that repository only; nothing is resolved without an explicit binding.
  workerQuery,gitCredential:async settings=>{if(!settings?.hostingAccountId||!settings.repoUrl)return null;const auth=await hosting.auth(settings.hostingAccountId,settings.repoUrl);return auth?{...auth,repoUrl:settings.repoUrl}:null;}});
const viewers = new Set();
const queries = new Map();
const cliRecovery=new CliRecoveryHome({db,query:workerQuery,online:id=>online(id),change:()=>change()});
rooms.nativeRecoveryReason=(task,checked)=>cliRecovery.scheduleReason(task,checked);
const workspaceFeed = new WorkspaceStateFeed();
const roleSwitches=new RoleSwitches(db);
const roleSwitchRuntime=new RoleSwitchRuntime({db,switches:roleSwitches,query:workerQuery,dispatch,change:()=>change(),
  stopRun:(runId,commandId)=>{const run=db.requestStop(runId,commandId);dispatch(run.nodeId);}});
const matches = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
let changeTimer;
const change = () => { clearTimeout(changeTimer);changeTimer=null;for (const r of viewers) r.write('event: change\ndata: {}\n\n'); };
const outputChanged=()=>{if(!changeTimer){changeTimer=setTimeout(change,100);changeTimer.unref();}};
const send = (ws, payload) => { if (ws?.readyState === 1) ws.send(JSON.stringify(payload)); };
const online = id => sockets.get(id)?.readyState === 1&&!reconnectingNodes.has(id);
const sourceSync=new SourceSyncHome({db,data,online,socket:id=>online(id)?sockets.get(id):null,change,rooms,query:workerQuery});
const projectFiles=new ProjectFiles({db,online,query:workerQuery});
// The media ticket key survives restarts, so a file version keeps its link (and the browser its cached copy) across them.
const mediaKeyFile=join(data,'media-ticket.key');
let mediaSecret;try{mediaSecret=Buffer.from((await readFile(mediaKeyFile,'utf8')).trim(),'base64');}catch{}
if(mediaSecret?.length!==32){mediaSecret=randomBytes(32);await writeFile(mediaKeyFile,mediaSecret.toString('base64'),{mode:0o600});}
await chmod(mediaKeyFile,0o600);
// Media bytes that came from a device are kept on Home by file version for 10 days (2 GB at most).
const mediaCache=new MediaCache({dir:join(data,'media-cache')});
const mediaStreams=new MediaStreams({db,online,secret:mediaSecret,cache:mediaCache,canReadCached:t=>cachedMediaAllowed(db,t),query:(target,action,payload,timeout)=>workerQuery(target,action,payload,timeout),change:()=>change()});
const crossDeviceRead=new CrossDeviceRead({db,online,query:workerQuery});
const setup = new ProjectSetup(db, rooms, workerQuery, online, change);
const credentials = new CredentialStore(join(data, 'credentials'));
const hosting = new Hosting(db, credentials);
const projectsAdmin = new ProjectAdmin(db, workerQuery, hosting, change);
const projectGitVersions = new ProjectGitVersions({db,query:workerQuery,hosting,online,change});
const devicesAdmin = new DeviceAdmin({ db, credentials, base, data, workerToken, change, online, homePort: port, reconnect:{
  hold:(id,held)=>held?reconnectingNodes.add(id):reconnectingNodes.delete(id),
  connection:id=>{const socket=sockets.get(id);return socket?.readyState===1?{id:socket,heartbeatAt:socket.lastHeartbeatAt||0}:null;},
  assertIdle:id=>{
    const worker=db.get('workers',id),usage=worker?.cliUsage;
    if(!usage||['active','retained','organizer','terminal'].some(key=>!Number.isFinite(usage[key])))throw new Error(tr('deviceAdmin.reconnectUnverified'));
    const taskNode=t=>t.executionBinding?.role?.nodeId||t.roleSnapshot?.nodeId||db.get('roles',t.assignedRoleId||t.roleId)?.nodeId;
    const native=db.db.prepare("SELECT 1 FROM records WHERE kind='nativeTurns' AND json_extract(data,'$.nodeId')=? AND coalesce(json_extract(data,'$.status'),'') NOT IN ('succeeded','failed','interrupted','cancelled','stopped') LIMIT 1").get(id);
    if(Object.values(usage).some(n=>typeof n==='number'&&n>0)||(worker.warmSessions||[]).length||Number(worker.organizerBusy)>0
      ||dispatching.has(id)||db.activeRuns(id).length||native||db.chatTasks().some(t=>taskNode(t)===id)
      ||[...queries.values()].some(q=>q.nodeId===id)
      ||db.list('sourceSyncCommands').some(c=>c.nodeId===id&&c.status==='pending')
      ||db.list('terminalSessions').some(s=>s.nodeId===id&&!['released','cancelled','finished','expired'].includes(s.status))
      ||db.list('roleSwitches').some(s=>s.nodeId===id&&!s.steps?.released))throw new Error(tr('deviceAdmin.reconnectBusy'));
  }
} });
void devicesAdmin.startTunnels();
process.once('exit', () => devicesAdmin.stopTunnels());
setup.projectsAdmin = projectsAdmin;
const assistant = new PlatformAssistant({db,rooms,coordinator,query:workerQuery,online,change,devices:devicesAdmin,projects:projectsAdmin});
const tokenUsage = new TokenUsage(db,workerQuery,online,change);
const usageRetry=createTokenUsageBackgroundCollector({collect:nodeId=>tokenUsage.collect(nodeId),online,getState:nodeId=>db.get('tokenUsageStates',nodeId)});
const collectUsage = nodeId => { if(db.get('workers',nodeId)?.capabilities?.tokenUsage===1) void usageRetry.run(nodeId); };
const wechat = new WechatChannel({ db, rooms, ...wechatTransport(), respondApproval, change, schedule: scheduleChat });

/** The web and WeChat share the same approval validation, so external messages get no extra execution privileges. */
function respondApproval(approvalId, decision, commandId) {
  const a = db.get('approvals', approvalId), repeated = db.get('commands', commandId || '');
  if (repeated) {
    if (repeated.type !== 'approval' || repeated.approvalId !== approvalId || repeated.decision !== decision) throw new Error(tr('home.approvalCommandParameterConflict'));
    return a;
  }
  if (!a || a.status !== 'pending' || !Number.isFinite(Date.parse(a.expiresAt)) || Date.parse(a.expiresAt) < Date.now()) throw new Error(tr('home.approvalNoLongerValid'));
  if (!['accept', 'decline'].includes(decision) || !commandId) throw new Error(tr('home.invalidApprovalResult'));
  const r = db.get('runs', a.runId);
  if (!r || !online(r.nodeId)) throw new Error(tr('home.nodeOfflineApprovalCannotBe'));
  if (terminal.has(r.status) || r.status === 'stopping') throw new Error(tr('home.executionHasEndedStopping'));
  if (decision === 'accept' && db.get('settings', 'main')?.paused) throw new Error(tr('home.remoteExecutionPaused'));
  db.transaction(() => {
    db.put('commands', { id: commandId, type: 'approval', nodeId: r.nodeId, runId: r.id, approvalId: a.id, decision, acked: false });
    db.put('approvals', { ...a, status: 'responding' });
  });
  dispatch(r.nodeId); change(); return db.get('approvals', a.id);
}

/** Dispatch only registers the background organization request; the actual summary version and uncovered messages are frozen within the same transaction in startTask. */
function prepareChatContext(task) {
  conversationContext.enqueue(task.projectId,task.conversationId||task.projectId);
  if(!task.contextPrepared)db.put('tasks',{...task,contextPrepared:true,contextState:null,waitingReason:null});
}

/** Only unacknowledged commands are resent; the Worker returns the original result based on the stable command ID. */
const queuePump=new QueuePump(db,{send:(nodeId,payload)=>send(sockets.get(nodeId),payload),online:id=>online(id)&&sockets.get(id).workerReady,render:renderBatch,
  verify:b=>workerQuery({nodeId:b.workerId},'queue_verification',{batchId:b.id,runId:b.runId,projectId:b.projectId,roleId:b.roleId},10000)});
const dispatching=new Set();
async function dispatch(nodeId) {
  if(!online(nodeId)||!sockets.get(nodeId).workerReady||dispatching.has(nodeId))return;
  dispatching.add(nodeId);
  try {
  for (const c of db.pendingCommands().filter(c => c.nodeId === nodeId)) {
    if(c.lastSentAt&&Date.now()-Date.parse(c.lastSentAt)<5000)continue;
    let run = db.get('runs', c.runId);
    if (!run) continue;
    // Historical launch receipts cannot execute again; reject them before native ownership reads or other admission work.
    if (c.type === 'launch' && (terminal.has(run.status) || run.status === 'stopping')) continue;
    if(c.type==='launch'&&db.get('settings','main')?.paused)continue;
    if(['launch','delivery_publish'].includes(c.type)&&sourceSync.busy(run.projectId,nodeId))continue;
    if (['launch','delivery_publish'].includes(c.type) && projectTerminalLock(db,run.projectId,nodeId)) continue;
    if(c.type==='launch') {
      const issue=instructionProtocolIssue(run,db.get('workers',nodeId));
      if(issue||run.instructionProtocolIssue) {
        const task=db.get('tasks',run.taskId),previous=run.instructionProtocolIssue;
        run={...run,instructionProtocolIssue:issue};db.put('runs',run);
        if(task&&task.currentRunId===run.id&&(issue||task.waitingReason===previous))db.put('tasks',{...task,waitingReason:issue});
        if(issue!==previous)change();
      }
      if(issue)continue;
    }
    if(c.type==='launch'&&!c.firstSentAt&&run.minimalInstructions===undefined) {
      run={...run,minimalInstructions:supportsMinimalInstructions(run,db.get('workers',nodeId))?1:0};db.put('runs',run);
    }
    const minimal=run.minimalInstructions===1;
    if(c.type==='launch'&&!minimal&&run.roleSessionId&&!run.teamContext) {
      run={...run,teamContext:buildTeamContext(conversationView(reviewView(db,{projectId:run.projectId,roleId:run.roleId}),run),run,{online,forExecution:true})};
      db.put('runs',run);
    }
    const storedTask = run.inputTask||db.get('tasks', run.taskId);
    const basePrompt=runWithLanguage('en',()=>[run.contextPacket?renderRunPrompt(run.contextPacket,{minimal}):storedTask.prompt,minimal?executionRules(run,{minimal:true}):run.switchOperationId?'':renderTeamContext(run.teamContext)].filter(Boolean).join('\n\n'));
    const rulesText = runWithLanguage('en',()=>schedulingRules());
    // The timer line is matched in both languages; it is dropped for Workers without timer tools.
    const schedulingRulesText = db.get('workers',nodeId)?.capabilities?.timerTools===1 ? rulesText : rulesText.replace(/^(?:Use wb timer only when given an explicit wall-clock time or recurrence requirement; |\u53ea\u6709\u6536\u5230\u660e\u786e\u7684\u5899\u949f\u65f6\u95f4\/\u5468\u671f\u9700\u6c42\u624d\u7528 wb timer\uff1b).*\n/m,'');
    const supervisorInstructions=runWithLanguage('en',()=>!minimal&&!run.switchOperationId&&(!run.turnPurpose||run.turnPurpose==='task')&&run.roleSnapshot?.systemSupervisor && !run.roleSnapshot.platformAssistant ? tr('home.supervisorWorkingConventions', { supervisorPrompt: legacyExecutionPrompt(normalizePlatformSettings(db.get('settings', 'main')).supervisorPrompt,'supervisor'), schedulingRules: schedulingRulesText }):'');
    // New Workers put the fixed Supervisor conventions in the stable rules area; old Workers still receive the full original format, so rolling upgrades do not lose rules.
    const stableInstructions=db.get('workers',nodeId)?.capabilities?.stableInstructions===1;
    const task = c.launchInput?.task||{...storedTask,prompt:supervisorInstructions&&!stableInstructions?`${basePrompt}\n\n${supervisorInstructions}`:basePrompt,
      runtimeInstructions:stableInstructions?supervisorInstructions:''};
    const storedProject = db.get('projects', run.projectId);
    const project = { ...storedProject, repoUrl: run.repositoryUrl ?? storedProject.repoUrl };
    const request = run.requestId ? db.get('coordinationRequests', run.requestId) : db.list('coordinationRequests').find(r => r.currentRunId === run.id);
    if (['launch', 'delivery_publish'].includes(c.type) && request?.status === 'cancelled') {
      if (c.type === 'delivery_publish') {
        const d = db.get('deliveries', c.deliveryId);
        if (d) db.put('deliveries', { ...d, status: 'cancelled', error: tr('home.sourceCallCancelled') });
        db.put('commands', { ...c, acked: true });
      }
      continue;
    }
    const dispatchSocket=sockets.get(nodeId);
    const gitCredentials = {};
    if (!run.switchOperationId && (c.type === 'launch' || c.type === 'delivery_publish' || run.deliveryId)) {
      try { for (const repo of run.repositories || []) gitCredentials[repo.id] = await hosting.auth(repo.accountId, repo.repoUrl); }
      catch (e) {
        if(c.type === 'delivery_publish') {
          const delivery=db.get('deliveries',c.deliveryId);
          if(delivery) db.put('deliveries',{...delivery,status:'blocked',error:e.message});
        } else { db.put('runs',{...run,status:'failed',error:e.message}); rooms.complete(db.get('runs',run.id)); }
        db.put('commands',{...c,acked:true}); change(); continue;
      }
    }
    const currentCommand=db.get('commands',c.id),currentRun=db.get('runs',run.id);
    if(!online(nodeId)||sockets.get(nodeId)!==dispatchSocket||!dispatchSocket.workerReady||!currentCommand||currentCommand.acked)continue;
    // Authentication yields to pause, cancellation and reconnection. Never send the stale command/run snapshot afterwards.
    if(JSON.stringify(currentCommand)!==JSON.stringify(c)||JSON.stringify(currentRun)!==JSON.stringify(run))continue;
    const settings=normalizePlatformSettings(db.get('settings','main'));
    if(c.type==='launch'){
      const currentTask=db.get('tasks',run.taskId);
      const discussion=run.discussionDeliveryId?db.get('discussionDeliveries',run.discussionDeliveryId):null;
      const currentOwner=run.discussionDeliveryId?discussion?.processingRunId===run.id&&discussion.status==='dispatched':currentTask?.currentRunId===run.id;
      if(settings.paused||terminal.has(currentRun.status)||currentRun.status==='stopping'||!currentTask||!currentOwner||currentTask.status==='cancelled')continue;
    }
    if(['launch','delivery_publish'].includes(c.type)){
      const currentRequest=run.requestId?db.get('coordinationRequests',run.requestId):db.list('coordinationRequests').find(r=>r.currentRunId===run.id);
      if(currentRequest?.status==='cancelled'||sourceSync.busy(run.projectId,nodeId)||projectTerminalLock(db,run.projectId,nodeId))continue;
    }
    const sentAt=new Date().toISOString(),platformPrompt=c.launchInput?.platformPrompt??(run.switchOperationId?'Maintenance only: read existing state; do not perform business actions.':minimal?settings.platformPrompt:legacyExecutionPrompt(settings.platformPrompt));
    // A launch keeps the language it was first sent in, so a re-send after a language change repeats the identical prompt.
    const language=c.launchInput?.language??getLanguage();
    const recorded={...c,firstSentAt:c.firstSentAt||sentAt,lastSentAt:sentAt,sendAttempts:(c.sendAttempts||0)+1,
      ...(c.type==='launch'?{launchInput:{task,platformPrompt,language}}:{})};
    db.put('commands',recorded);
    const {launchInput,...wireCommand}=recorded;
    send(sockets.get(nodeId), { type: 'command', command: wireCommand, run, task, request,
      gitCredentials,folderAccess:folderAccessFor(db,nodeId,`project:${run.projectId}`),
      delivery: (c.deliveryId || run.deliveryId) ? db.get('deliveries', c.deliveryId || run.deliveryId) : null,
      project: { ...project, root: run.projectRoot ?? project.root }, paused: settings.paused, platformPrompt, language });
  }
  } finally {dispatching.delete(nodeId);}
}
/** Deployment identity stays separate from bound project versions and task input commits. */
function softwareInventory() {
  const workers=db.list('workers'),known=new Set(workers.map(w=>w.id));
  return [{id:'home',name:'Home',kind:'home',online:true,softwareVersion},
    ...workers.map(w=>({id:w.id,name:w.name||w.id,kind:w.nodeKind||resolveNodeKind(null,w.platform),online:online(w.id),lastSeen:w.lastSeen,softwareVersion:w.softwareVersion||null})),
    ...db.list('devices').filter(d=>!known.has(d.nodeId)).map(d=>({id:d.nodeId,name:d.name||d.nodeId,kind:'cloud',online:false,softwareVersion:null}))];
}
const workspaceProgress=new WeakMap();
function snapshot(scope=null) {
  // A workspace read takes one project's page summaries straight from SQLite; the unscoped form still returns full records.
  const page=scope?.projectId?pageSummaries(db,scope.projectId):null;
  const runs=page?page.runs:db.list('runs'),tasks=page?page.tasks:db.list('tasks'),requests=page?page.requests:db.list('coordinationRequests');
  // Progress has no wall-clock dependency, but socket/reconnect and language changes must invalidate it even without a DB write.
  const progressKey=page?JSON.stringify([getLanguage(),[...sockets.keys()].filter(online).sort()]):null;
  let progress=page?workspaceProgress.get(page):null;
  if(!progress||progress.key!==progressKey){
    const progressView=messageProgressView({runs,tasks,requests}),launchCommands=page?page.launches:db.list('commands').filter(c=>c.type==='launch');
    const launches=new Map(launchCommands.map(c=>[c.runId,c])),continuationLaunches=new Map(launchCommands.toReversed().map(c=>[c.runId,c]));
    progress={key:progressKey,requests:requests.map(request=>{const {fingerprint,targetSnapshot,...r}=request;return {...r,messageProgress:messageProgress(progressView,request,online,launches.get(request.currentRunId)||null,continuationLaunches)};})};
    if(page)workspaceProgress.set(page,progress);
  }
  // Keep fixed supervisors separate from editable work roles and hide the platform assistant.
  const supervisorIds=new Map(db.list('projects').filter(p=>!p.systemConfig&&p.supervisorRoleId).map(p=>[p.id,p.supervisorRoleId]));
  return { [WORKSPACE_SUMMARY]:page?progress:null,version: tr('home.040ProjectWorkspace'), language: getLanguage(), capabilities: {roleSteering:2,groupConversations:1,projectTeamCopy:1,queueOrder:1,queuePause:1,collaborationWait:1}, homePlatform: process.platform, collaborationWaits: collaborationQueueView(db).states, projects: db.list('projects').filter(p => !p.systemConfig), projectCopies:db.list('projectCopyOperations').map(projectCopyView), conversations:db.list('projects').filter(p=>!p.systemConfig).flatMap(p=>new GroupConversations(db).list(p.id)),  roles: db.list('roles').filter(r => !r.systemSupervisor), rooms: db.list('rooms'), workspaces: db.list('workspaces'), tasks, runs:page?[...runs,...page.otherActiveRuns]:runs,
    supervisorRoles:db.list('roles').filter(r=>supervisorIds.get(r.projectId)===r.id&&r.systemSupervisor&&!r.platformAssistant&&!r.archivedAt).map(({instructions,...r})=>({...r,responsibility:roleResponsibility(r)})),
    discussionThreads:db.list('discussionThreads'),discussionDeliveries:db.list('discussionDeliveries'),
    roleSwitches:db.list('roleSwitches').map(roleSwitchView),
    sessionQueues:Object.fromEntries(db.list('projects').filter(p=>p.features?.collaborationSessions===true).map(p=>[p.id,new SessionQueue(db).status(p.id)])),
    cliRecoveries:db.list('cliRecoveries').filter(r=>!['ready','resolved'].includes(r.state)).map(({binding,fingerprint,...record})=>record),
    sourceSyncSummaries:db.list('projects').map(p=>({id:p.id,projectId:p.id,enabled:sourceSync.sync.config(p.id).enabled,conflicts:db.listProject('sourceSyncConflicts',p.id).filter(c=>!['resolved','cancelled'].includes(c.status)).length})),
    terminalSessions: db.list('terminalSessions').filter(s=>!['released','cancelled'].includes(s.status)).map(s=>terminalLaunchView({...s,roleId:s.roleId||(s.runId?db.get('runs',s.runId)?.roleId:null)})),
    attachmentTransfers:db.list('attachmentTransfers').slice(-200).map(({fingerprint,...t})=>t),
    hostingAccounts: db.list('hostingAccounts'), devices: db.list('devices').map(d => ({ ...d, status: online(d.nodeId) ? 'online' : d.status })), repositoryOperations: db.list('repositoryOperations'),
    repositories: db.list('repositories'), repositoryWorkspaces: db.list('repositoryWorkspaces'), setupProposals: db.list('setupProposals'), projectGitVersions:db.list('projectGitVersions'),
    approvals: db.list('approvals'), gitChecks: db.list('gitChecks'), settings: normalizePlatformSettings(db.get('settings', 'main')), wechat: wechat.status(),
    promptDefaults: { platformPrompt: defaultPlatformPrompt(), supervisorPrompt: defaultSupervisorPrompt() },
    roleTemplates: listRoleTemplates(db), supervisors: db.list('supervisorConfigs'),
    executionPlans: db.list('executionPlans').map(({fingerprint,...p})=>p),
    chatQueuePauses:db.list('chatQueuePauses'),
    roleSessions:db.list('roleSessions').filter(session=>!session.historyClearedAt).map(({nativeSession,...session})=>session),
    // Sidebar decoration only needs active native identities, never complete tool logs.
    nativeTurnExecutions:db.db.prepare("SELECT id,json_extract(data,'$.nodeId') AS nodeId,json_extract(data,'$.runtime') AS runtime,json_extract(data,'$.sessionId') AS sessionId,json_extract(data,'$.status') AS status FROM records INDEXED BY native_turn_active WHERE kind='nativeTurns' AND json_extract(data,'$.status') IN ('starting','running','stopping')").all(),
    scheduledJobs: db.list('scheduledJobs'),scheduledOccurrences:db.list('scheduledOccurrences').slice(-200),runReports:page?page.runReports:db.list('runReports'),runAlerts:db.list('runAlerts').filter(a=>a.status==='open'),
    requests: progress.requests,
    deliveries: db.list('deliveries').map(({ fingerprint, ...r }) => r),
    workers: db.list('workers').map(w => ({ ...w, runtimes: visibleRuntimes(w.runtimes,db.get('workerConfigs',w.id)?.hiddenRuntimes), online: online(w.id) })) };
}
const chatScheduleErrors=new Map();
/** Keep bounded diagnostics without turning a bad persisted request into a process-wide restart loop. */
function chatScheduleError(error,requestId='') {
  const message=String(error?.message||error).slice(0,4000),key=`${requestId}:${message}`,at=Date.now();
  if(!chatScheduleErrors.has(key)||at-chatScheduleErrors.get(key)>=30000){
    console.error('Chat scheduling failed',requestId,message);
    chatScheduleErrors.delete(key);chatScheduleErrors.set(key,at);
    if(chatScheduleErrors.size>100)chatScheduleErrors.delete(chatScheduleErrors.keys().next().value);
  }
}
/** Every entry point (timer, HTTP and Worker events) shares the same exception boundary. */
function scheduleChat() {
  try {scheduleChatTurn();}catch(error){chatScheduleError(error);}
}
/** Scheduling does not call a model; it only issues new executions after the Worker has finished reconnection verification. */
function scheduleChatTurn() {
  cliRecovery.tick();
  void roleSwitchRuntime.tick();
  if(reconcileCallResults(db,calls))change();
  try { if(scheduledJobs.tick()) change(); } catch(error) {console.error(tr('home.scheduledJobCheckFailed'),error.message);}
  void executionPlans.advance().then(changed=>{if(changed)change();}).catch(error=>console.error(tr('home.executionStageAdvanceFailed'),error.message));
  for (const nodeId of deliveries.schedule()) dispatch(nodeId);
  for (const task of db.chatTasks().filter(t => !t.switchOperationId && !t.requestId)) calls.adoptTask(task.id);
  if(calls.expireWaits())change();
  for (const request of db.schedulableRequests()) {
    try {
      if (request.status === 'waiting_call') calls.resume(request.id);
      if (['queued', 'waiting_delivery'].includes(request.status)) {
        const next=calls.reconcile(request.id);
        if(next?.status==='failed'&&next.admissionError)change();
      }
    }catch(error){chatScheduleError(error,request.id);}
  }
  try {if(proactiveFollowup.tick())change();}catch(error){console.error('Proactive follow-up:',error.message);}
  try {if(dueRoleCompactions(db,{online:id=>online(id)&&sockets.get(id).workerReady,send:(nodeId,payload)=>send(sockets.get(nodeId),payload)}))change();}catch(error){console.error('Role compaction:',error.message);}
  for(const task of db.chatTasks(['ready']))prepareChatContext(task);
  const scheduled = rooms.schedule(id => online(id) && sockets.get(id).workerReady);
  for (const nodeId of scheduled.nodes) dispatch(nodeId);
  for(const nodeId of new Set(db.pendingCommands().filter(c=>(!c.lastSentAt||Date.now()-Date.parse(c.lastSentAt)>=5000)).map(c=>c.nodeId)))void dispatch(nodeId);
  if (scheduled.changed) change();
  // Queued work claims capacity first; background organization does not take up the queued waiting stage of business roles.
  void conversationContext.drainOne({
    config:normalizePlatformSettings(db.get('settings','main')).conversationOrganizer,
    canRun:nodeId=>!db.get('settings','main')?.paused && online(nodeId) && sockets.get(nodeId).workerReady
      && db.get('workers',nodeId)?.capabilities?.summaryBatches===1
      && db.activeRuns(nodeId).length+reservedTerminalSlots(db,nodeId)+(db.get('workers',nodeId)?.organizerBusy||0)<(db.get('workers',nodeId)?.capacity||1),
    query:(snapshot,config)=>workerQuery({nodeId:config.nodeId},'conversation_summary',{snapshot,config},125000),change
  }).catch(error=>console.error(tr('home.backgroundConversationOrganizationFailed'),error.message));
}
async function body(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 128000) throw new Error(tr('home.requestTooLarge')); }
  return raw ? JSON.parse(raw) : {};
}
function json(res, data, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
/** Path checks and file reads are both done by the target Worker; Home does not probe the remote filesystem. */
function workerQuery(run, action, path, timeout = 10000) {
  if (!online(run.nodeId)) throw new Error(tr('home.executionNodeOfflineUnableRead'));
  const id = randomUUID();
  return new Promise((resolveQuery, reject) => {
    const timer = setTimeout(() => { queries.delete(id); reject(new Error(tr('home.nodeQueryTimedOut'))); }, timeout);
    queries.set(id, { nodeId: run.nodeId,readProtocol:['source_inspect','source_read','read_query'].includes(action),resolve: value => { clearTimeout(timer); resolveQuery(value); }, reject: e => { clearTimeout(timer); reject(e); } });
    const projectId=['source_read','source_inspect','read_query'].includes(action)?path?.source?.projectId||run.projectId:run.projectId||path?.projectId;
    const folderAccess=projectId&&['native_agents_md','native_agents_md_write'].includes(action)?folderAccessFor(db,run.nodeId,`project:${projectId}`):(action.startsWith('native_')||action.startsWith('media_')&&path?.runtime)?nativeFolderAccess(db,run.nodeId,path?.runtime,path?.sessionId,path?.entryId)||folderAccessFor(db,run.nodeId,projectId?`project:${projectId}`:path?.managedProjectIds?.length===1?`project:${path.managedProjectIds[0]}`:null):folderAccessFor(db,run.nodeId,projectId?`project:${projectId}`:null);
    send(sockets.get(run.nodeId), { type: 'query', id, runId: run.id, projectId,folderAccess,action, path, language: getLanguage() });
  });
}
/** Human creation only: preparation is not authorization; activate in the binding transaction. */
async function prepareFolderBinding(nodeId,scope,path,operationId){
 const worker=db.get('workers',nodeId);
 if(resolveNodeKind(worker?.nodeKind,worker?.platform)!=='local'||worker?.capabilities?.localFolderSelection!==1)throw Error('Upgrade the local Worker to select this folder');
 const bindings=[...db.list('workspaces'),...db.list('repositoryWorkspaces')].filter(b=>b.nodeId===nodeId).map(b=>({projectId:b.projectId,localRoot:b.localRoot}));
 return workerQuery({nodeId},'folder_grant_prepare',{scope,path,operationId,bindings});
}
function activateFolderBinding(grant){if(grant)db.put('folderGrants',{id:`${grant.nodeId}:${grant.scope}`,nodeId:grant.nodeId,scope:grant.scope,grant,status:'active'});}
const folderPreparations=new FolderPreparations({db,prepare:input=>prepareFolderBinding(input.nodeId,input.scope,input.path,input.operationId),cancel:input=>workerQuery({nodeId:input.nodeId},'folder_grant_cancel',input)});
/** Default/remote creation keeps its original path; only explicit local preparations need compensation. */
const withFolderPreparation=(input,apply)=>input?folderPreparations.run(input,apply):apply(null);
/** Stop issuing authorization immediately; Worker cleanup affects only this receipt, not any files. */
async function cancelFolderBinding(row){
 if(!row)return;
 if(db.get('folderGrants',row.id)?.grant?.id===row.grant.id)db.put('folderGrants',{...row,status:'revoked'});
 if(online(row.nodeId))try{await workerQuery({nodeId:row.nodeId},'folder_grant_cancel',{id:row.grant.id,scope:row.scope});}catch{/* Home has revoked it; subsequent requests carry no authorization. */}
}
const terminalRefreshes=new Map();
/** Standalone native terminals reserve a device slot without inventing a collaboration project. */
const terminalScopeExists=projectId=>Boolean(db.get('projects',projectId)||db.listProject('terminalSessions',projectId).some(s=>['native','native-turn'].includes(s.kind)&&projectId===`native-tui:${s.id}`));
/** Only the Worker can inspect remote PIDs; unknown/offline checks retain the lock and released receipts wake the original queue. */
function refreshProjectTerminals(projectId,{automatic=false}={}) {
  const key=`${projectId}:${automatic?'auto':'manual'}`;
  if(terminalRefreshes.has(key))return terminalRefreshes.get(key);
  const operation=(async()=>{
    if(!terminalScopeExists(projectId))throw new Error(tr('store.projectNotFound'));
    const claims=db.listProject('terminalSessions',projectId).filter(s=>{
      if(['released','cancelled'].includes(s.status))return false;
      if(!automatic)return true;
      const worker=db.get('workers',s.nodeId),expired=Date.now()-Date.parse(s.createdAt)>=TERMINAL_PREPARATION_TTL_MS;
      // Older Workers revoke unused links immediately, so never send them a fresh reservation automatically.
      return online(s.nodeId)&&worker?.capabilities?.terminalControl===1&&(s.status!=='preparing'||expired)&&(worker.capabilities.terminalAutoReturn===1||expired);
    }),groups=new Map(),results=[];
    for(const claim of claims){const group=groups.get(claim.nodeId)||[];group.push(claim);groups.set(claim.nodeId,group);}
    await Promise.all([...groups].map(async([nodeId,members])=>{
      let checked;
      try{
        if(!online(nodeId))throw new Error(tr('terminalControl.offline'));
        if(db.get('workers',nodeId)?.capabilities?.terminalControl!==1)throw new Error(tr('terminalControl.upgrade'));
        const reply=await workerQuery({nodeId},'terminal_check',{projectId,nodeId,automatic,claims:members.map(({id,projectId,nodeId})=>({id,projectId,nodeId}))},20000);
        checked=reply.results;
        if(!Array.isArray(checked)||checked.length!==members.length||members.some(s=>!checked.some(c=>c.id===s.id&&['released','active','unknown',...(automatic?['prepared']:[])].includes(c.processState)&&c.checkedAt)))throw new Error(tr('terminalControl.stopPending'));
      }catch(error){checked=members.map(s=>({id:s.id,processState:'unknown',checkedAt:new Date().toISOString(),reason:error.message}));}
      for(const result of checked){db.transaction(()=>{const current=db.get('terminalSessions',result.id);if(!current||current.projectId!==projectId||current.nodeId!==nodeId||['released','cancelled'].includes(current.status))return;
        db.put('terminalSessions',{...current,processState:result.processState,lastCheckedAt:result.checkedAt,processError:result.reason||null,...(result.processState==='released'?{status:'released',releasedAt:result.checkedAt}:result.processState==='active'?{status:result.status==='stopping'?'stopping':'active'}:{})});if(result.catalogEntry?.id&&result.catalogEntry.id===current.catalogEntryId){const cached=db.get('nativeCatalogEntries',result.catalogEntry.id);if(cached?.nodeId===nodeId)db.put('nativeCatalogEntries',{...cached,...result.catalogEntry,nodeId});}});results.push({...result,nodeId});}
    }));
    if(results.length||!automatic){change();scheduleChat();}return {results,released:results.filter(s=>s.processState==='released').length,active:results.filter(s=>s.processState==='active').length,unknown:results.filter(s=>s.processState==='unknown').length};
  })().finally(()=>terminalRefreshes.delete(key));
  terminalRefreshes.set(key,operation);return operation;
}
/** Reconcile without a browser: process proofs survive disconnects and wake only the original queue after release. */
function reconcileTerminals(nodeId) {
  const projects=new Set(db.list('terminalSessions').filter(s=>!['released','cancelled'].includes(s.status)&&(!nodeId||s.nodeId===nodeId)).map(s=>s.projectId));
  return Promise.all([...projects].filter(terminalScopeExists).map(id=>refreshProjectTerminals(id,{automatic:true}))).then(()=>folderPreparations.cleanup(nodeId)).catch(error=>console.error('Terminal reconciliation failed:',error.message));
}
const nativeCatalogRecords=(nodeId,runtime)=>db.list('nativeCatalogEntries').filter(entry=>entry.nodeId===nodeId&&entry.runtime===runtime);
const nativeCatalogItem=entry=>({id:entry.id,entryId:entry.id,nodeId:entry.nodeId,runtime:entry.runtime,sessionId:entry.sessionId||null,title:entry.title,createdAt:entry.createdAt,modifiedAt:entry.modifiedAt||entry.createdAt,workspace:entry.workspace||null,origin:'dialog',status:entry.status||'awaiting_native_id',hasHistory:entry.hasHistory===true,previewAvailable:entry.previewAvailable===true,canReopen:entry.status==='draft',canResume:entry.hasHistory===true&&!['active','prepared'].includes(entry.status),exactLastScan:entry.exactLastScan||null});
function managedNativeSessions(nodeId,runtime){
  const items=new Map();for(const session of db.list('roleSessions')){
    if(session.nodeId!==nodeId||session.runtime!==runtime||session.historyClearedAt||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(session.nativeSessionId||''))continue;
    const role=db.get('roles',session.roleId),project=db.get('projects',session.projectId),title=[project?.name,role?.name].filter(Boolean).join(' · ')||session.nativeSessionId;
    const previous=items.get(session.nativeSessionId),binding={projectId:session.projectId,conversationId:groupConversationIdOfSession(session),roleId:session.roleId,createdAt:session.createdAt||null,generation:session.generation||0};
    const ambiguous=previous&&(previous.ambiguous||previous.roleBinding.projectId!==binding.projectId||previous.roleBinding.roleId!==binding.roleId||previous.roleBinding.conversationId!==binding.conversationId);
    if(previous&&String(previous.createdAt||'')>String(session.createdAt||'')){if(ambiguous){previous.ambiguous=true;previous.roleBinding=null;}continue;}
    items.set(session.nativeSessionId,{sessionId:session.nativeSessionId,title,workspace:session.workspace||session.workspaceRoot||null,createdAt:session.createdAt||null,roleBinding:ambiguous?null:binding,ambiguous:Boolean(ambiguous)});
  }return [...items.values()].sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))||a.sessionId.localeCompare(b.sessionId));
}
/** A saved takeover is explicit provenance; a matching title or project folder is not. */
function adoptedNativeSessions(nodeId,runtime){
  // Clearing a role hides its old native association, including released takeover aliases, not its audit records.
  const cleared=new Set(db.db.prepare("SELECT json_extract(data,'$.nativeSession.id') AS id FROM records WHERE kind='runs' AND json_extract(data,'$.nodeId')=? AND json_extract(data,'$.nativeSession.runtime')=? AND json_extract(data,'$.historyClearedAt') IS NOT NULL").all(nodeId,runtime).map(row=>row.id));
  const records=new Map();for(const claim of db.list('terminalSessions')){
    const sessionId=claim.sessionId||claim.nativeSession?.id;
    if(claim.nodeId!==nodeId||!['native','native-turn'].includes(claim.kind)||(claim.runtime||claim.nativeSession?.runtime)!==runtime||!sessionId||cleared.has(sessionId)||claim.status==='cancelled')continue;
    const previous=records.get(sessionId);
    records.set(sessionId,{runtime,sessionId,workspace:claim.workspace||previous?.workspace||null,createdAt:previous?.createdAt||claim.createdAt});
  }return [...records.values()];
}
/** Resolve browser reads solely from Home's saved Workbench ownership, before contacting a Worker. */
function ownedNativeSession(nodeId,runtime,sessionId){
  return nativeCatalogRecords(nodeId,runtime).find(r=>r.sessionId===sessionId)||managedNativeSessions(nodeId,runtime).find(r=>r.sessionId===sessionId)||adoptedNativeSessions(nodeId,runtime).find(r=>r.sessionId===sessionId)||null;
}
function cacheNativeCatalog(items,nodeId,runtime){
  db.transaction(()=>{for(const item of items||[]){if(item.origin!=='dialog'||item.nodeId!==nodeId||item.runtime!==runtime||!item.entryId)continue;const current=db.get('nativeCatalogEntries',item.entryId);if(current?.nodeId!==nodeId||current.runtime!==runtime)continue;db.put('nativeCatalogEntries',{...current,sessionId:item.sessionId||null,title:item.title,workspace:item.workspace||current.workspace,status:item.status,hasHistory:item.hasHistory===true,previewAvailable:item.previewAvailable===true,exactLastScan:item.exactLastScan||current.exactLastScan||null,modifiedAt:item.modifiedAt||current.modifiedAt});}});
}
/** Stopping is an explicit human action, scoped to the saved lease rather than arbitrary browser-supplied PIDs. */
async function returnTerminal(claim,action) {
  let result;
  if(action==='stop'){
    if(db.get('workers',claim.nodeId)?.capabilities?.terminalControl!==1)throw new Error(tr('terminalControl.upgrade'));
    result=await workerQuery(claim,'terminal_stop',{id:claim.id,projectId:claim.projectId,nodeId:claim.nodeId},30000);
    if(result?.released!==true||result.id!==claim.id)throw new Error(tr('terminalControl.stopPending'));
  }else result=await workerQuery(claim,'terminal_release',{id:claim.id});
  db.transaction(()=>{const current=db.get('terminalSessions',claim.id);if(current&&current.projectId===claim.projectId&&current.nodeId===claim.nodeId)db.put('terminalSessions',{...current,status:'released',processState:'released',releasedAt:new Date().toISOString()});if(result.catalogEntry&&result.catalogEntry.id===claim.catalogEntryId){const cached=db.get('nativeCatalogEntries',result.catalogEntry.id);if(cached?.nodeId===claim.nodeId)db.put('nativeCatalogEntries',{...cached,...result.catalogEntry,nodeId:claim.nodeId});}});
  if(claim.catalogEntryId&&db.get('nativeCatalogEntries',claim.catalogEntryId)?.status==='draft')await cancelFolderBinding(db.get('folderGrants',`${claim.nodeId}:native:${claim.catalogEntryId}`));
  change();scheduleChat();return {released:true,forced:result.forced===true};
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if(pathname.startsWith('/api/worker/source-sync/')&&await sourceSync.workerHttp(req,res,pathname))return;
    // Media bytes: the Worker uploads with a per-relay secret, the browser reads with a signed ticket; neither uses the API token.
    const mediaUpload=pathname.match(/^\/api\/worker\/media-streams\/([a-f0-9-]{36})$/);
    if(mediaUpload)return mediaStreams.receive(req,res,mediaUpload[1]);
    const mediaRead=pathname.match(/^\/media\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/);
    if(mediaRead)return mediaStreams.serve(req,res,mediaRead[1],{download:url.searchParams.get('download')==='1'});
      if (pathname === '/healthz') return json(res, { ok: true, version: '0.4.0', toolProtocol:2 });
    if (pathname.startsWith('/api/')) {
      const bearer = req.headers.authorization || '';
      const workerOk = matches(bearer, `Bearer ${workerToken}`);
      const userOk = !apiToken || matches(bearer, `Bearer ${apiToken}`);
      if (pathname.startsWith('/api/agent/')) {
        if (!workerOk) return json(res, { error: tr('home.agentToolsOnlyAllowedThrough') }, 401);
      } else if (apiToken && !userOk) return json(res, { error: tr('home.accessTokenRequired') }, 401);
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return json(res, { error: tr('home.crossSiteRequestRejected') }, 403);
      if(await remoteAccessSettings.handle(req,res,pathname))return;
      if(pathname==='/api/platform/version'&&req.method==='GET')return json(res,{instances:softwareInventory()});
      // The complete setup guide from docs/, for reading on the page or copying to an AI assistant; no state involved.
      if(pathname==='/api/platform/setup-guide'&&req.method==='GET'){const language=url.searchParams.get('lang')==='zh'?'zh':'en',file=new URL(`../docs/${language==='zh'?'SETUP-GUIDE.zh-CN.md':'SETUP-GUIDE.md'}`,import.meta.url);
        return json(res,{language,version:softwareVersion?.version||null,markdown:await readFile(file,'utf8')});}
      if(pathname==='/api/platform/updates'&&req.method==='GET'){
        const instances=softwareInventory(),result=await softwareUpdates.check(instances.map(item=>item.softwareVersion));
        const {versions,...summary}=result;
        return json(res,{...summary,instances:instances.map((item,index)=>({...item,comparison:versions[index]}))});
      }
      const switchHistory=pathname.match(/^\/api\/agent\/cli-switches\/([^/]+)\/history$/);
      if(switchHistory&&req.method==='GET') {
        const record=db.get('roleSwitchHistory',switchHistory[1]);if(!record)throw new Error('CLI switch history not found.');
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});return res.end(record.text);
      }
      if((pathname.startsWith('/api/agent/source-inputs/')||pathname.startsWith('/api/agent/source-candidates/'))&&await sourceSync.inputHttp(req,res,pathname))return;
      if(await sourceSync.browserHttp(req,res,pathname))return;
      const conversationsRoute=pathname.match(/^\/api\/projects\/([^/]+)\/conversations$/);
      const copyPreviewRoute=pathname.match(/^\/api\/projects\/([^/]+)\/team-copy\/preview$/);
      if(copyPreviewRoute&&req.method==='GET')return json(res,projectTeamCopy.preview(copyPreviewRoute[1],{roleOrder:url.searchParams.has('roleOrder')?JSON.parse(url.searchParams.get('roleOrder')):undefined}));
      const teamCopyRoute=pathname.match(/^\/api\/projects\/([^/]+)\/team-copies$/);
      if(teamCopyRoute&&req.method==='POST'){
        const result=projectTeamCopy.begin(teamCopyRoute[1],await body(req));
        void projectTeamCopy.retry(result.id).catch(error=>console.error('Team copy preparation failed:',error.message));
        return json(res,result,201);
      }
      const copyRetryRoute=pathname.match(/^\/api\/project-copies\/([^/]+)\/retry$/);
      if(copyRetryRoute&&req.method==='POST')return json(res,await projectTeamCopy.retry(copyRetryRoute[1]));
      const copyDetailRoute=pathname.match(/^\/api\/project-copies\/([^/]+)$/);
      if(copyDetailRoute&&req.method==='GET')return db.get('projectCopyOperations',copyDetailRoute[1])?json(res,projectTeamCopy.get(copyDetailRoute[1])):json(res,{error:tr('teamCopy.notFound')},404);
      if(conversationsRoute&&req.method==='GET')return json(res,new GroupConversations(db).list(conversationsRoute[1]));
      if(conversationsRoute&&req.method==='POST'){
        const result=new GroupConversations(db).create(conversationsRoute[1],await body(req));change();return json(res,result,201);
      }
      const uploadMatch = pathname.match(/^\/api\/projects\/([^/]+)\/attachments$/);
      if (uploadMatch && req.method === 'POST') return json(res, await attachments.upload(uploadMatch[1], req), 201);
      const transferMatch=pathname.match(/^\/api\/projects\/([^/]+)\/attachment-transfers$/);
      if(transferMatch && req.method==='POST')return json(res,await attachmentTransfers.copy(transferMatch[1],await body(req)));
      const attachmentMatch = pathname.match(/^\/api\/projects\/([^/]+)\/attachments\/([^/]+)$/);
      const runAttachment = pathname.match(/^\/api\/agent\/attachments\/([^/]+)\/([^/]+)$/);
      const transferAttachment=pathname.match(/^\/api\/agent\/attachment-transfers\/([^/]+)\/([^/]+)$/);
      if ((attachmentMatch || runAttachment || transferAttachment) && req.method === 'GET') {
        let projectId = attachmentMatch?.[1], id = attachmentMatch?.[2];
        if (runAttachment) {
          if (!workerOk) return json(res, { error: tr('home.workerCredentialsRequired') }, 401);
          const run = db.get('runs', runAttachment[1]);
          if (!run || terminal.has(run.status) || !run.attachments?.some(a => a.id === runAttachment[2])) throw new Error(tr('home.attachmentDoesNotBelongCurrent'));
          projectId = run.projectId; id = runAttachment[2];
        }
        if(transferAttachment) {
          if(!workerOk)return json(res,{error:tr('home.workerCredentialsRequired2')},401);
          const transfer=db.get('attachmentTransfers',transferAttachment[1]);
          if(!transfer || transfer.status!=='transferring' || !transfer.attachmentIds.includes(transferAttachment[2]))throw new Error(tr('home.attachmentDoesNotBelongCurrent2'));
          projectId=transfer.projectId;id=transferAttachment[2];
        }
        const { item, bytes } = await attachments.read(projectId, id);
        // An attachment never changes under its ID: the browser keeps it for 10 days instead of fetching it on every render (Workers still read no-store).
        res.writeHead(200, { 'Content-Type': item.mime, 'Content-Length': bytes.length, 'Cache-Control': attachmentMatch ? MEDIA_CACHE_CONTROL : 'private, no-store',
          'Content-Disposition': `${item.mime.startsWith('image/') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(item.name)}` });
        return res.end(bytes);
      }
      if (pathname === '/api/state' && req.method === 'GET') {
        const workspace=url.searchParams.get('view')==='workspace';
        const state=snapshot(workspace?workspaceScope(db,url.searchParams.get('projectId')):null);
        const view=workspace?workspaceFeed.read(state,url.searchParams.get('projectId'),url.searchParams.get('cursor'),url.searchParams.get('conversationId')):state;
        return await sendBufferedResponse(req,res,Buffer.from(JSON.stringify(view)),{ 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
      }
      if (pathname === '/api/wechat' && req.method === 'GET') return json(res, wechat.status());
      if (pathname === '/api/wechat' && req.method === 'POST') { const b=await body(req); return json(res, wechat.configure(b.enabled,b.channelId)); }
      if (pathname === '/api/wechat/health' && req.method === 'POST') return json(res, await wechat.health());
      const wechatAction = pathname.match(/^\/api\/wechat\/([^/]+)\/(retry|cancel)$/);
      if (wechatAction && req.method === 'POST') {
        if (wechatAction[2] === 'retry') wechat.retry(wechatAction[1]); else wechat.close(wechatAction[1]);
        return json(res, wechat.status());
      }
      const wechatProject = pathname.match(/^\/api\/projects\/([^/]+)\/wechat$/);
      if (wechatProject && req.method === 'POST') {
        const link = wechat.openProject(wechatProject[1]); void wechat.tick().catch(() => {}); return json(res, { id: link.id }, 201);
      }
      if(pathname.includes('native-')&&await nativeTurns.http(req,res,{pathname,url,json,body}))return;
      const nativeGit=pathname.match(/^\/api\/native-sessions\/([^/]+)\/git$/);
      if(nativeGit&&req.method==='GET'){
        // Read-only Git facts for the session's own registered working folder; the browser never supplies a path.
        const nodeId=decodeURIComponent(nativeGit[1]),runtime=url.searchParams.get('runtime'),sessionId=url.searchParams.get('sessionId'),entryId=url.searchParams.get('entryId');
        const entry=entryId?nativeCatalogRecords(nodeId,runtime).find(record=>record.id===entryId):null;
        if(entryId&&(!entry||sessionId&&entry.sessionId!==sessionId))throw Error('Session identity does not match its Workbench entry');
        const record=entry||(sessionId&&ownedNativeSession(nodeId,runtime,sessionId))||null;
        if(!record)throw Error('Session is not registered with Workbench');
        const workspace=record.workspace||null,worker=db.get('workers',nodeId);
        if(!workspace)return json(res,{available:false,reason:'no_workspace'});
        if(!worker||!online(nodeId))return json(res,{available:false,reason:'source_offline',workspace});
        if(worker.capabilities?.workspaceGit!==1)return json(res,{available:false,reason:'worker_upgrade',workspace});
        // Use the registered native/project identity to carry its existing scoped folder grant; never infer one from cwd.
        try{return json(res,{available:true,workspace,...await workerQuery({nodeId,projectId:record.roleBinding?.projectId},'native_workspace_git',{workspace,runtime,sessionId:record.sessionId||null,entryId:record.id||null},10000)});}
        catch(error){return json(res,{available:false,reason:'git_read_failed',detail:String(error.message||error).slice(0,300),workspace});}
      }
      const nativeFile=pathname.match(/^\/api\/native-sessions\/([^/]+)\/file$/);
      if(nativeFile&&req.method==='GET'){
        // Read-only text preview of one file inside the session's registered working folder, on its own device.
        const nodeId=decodeURIComponent(nativeFile[1]),runtime=url.searchParams.get('runtime'),sessionId=url.searchParams.get('sessionId'),entryId=url.searchParams.get('entryId'),path=url.searchParams.get('path')||'';
        const entry=entryId?nativeCatalogRecords(nodeId,runtime).find(record=>record.id===entryId):null;
        if(entryId&&(!entry||sessionId&&entry.sessionId!==sessionId))throw Error('Session identity does not match its Workbench entry');
        const record=entry||(sessionId&&ownedNativeSession(nodeId,runtime,sessionId))||null;
        if(!record)throw Error('Session is not registered with Workbench');
        if(!record.workspace)throw Error('No working folder is recorded for this session yet.');
        if(db.get('workers',nodeId)?.capabilities?.nativeFiles!==1)throw Error('Upgrade this Worker to read session files');
        return json(res,await workerQuery({nodeId,projectId:record.roleBinding?.projectId},'native_file',{workspace:record.workspace,path,runtime,sessionId:record.sessionId||null,entryId:record.id||null},15000));
      }
      const nativeAgents=pathname.match(/^\/api\/native-sessions\/([^/]+)\/agents-md$/);
      if(nativeAgents&&['GET','PUT'].includes(req.method)){
        // The AGENTS.md a CLI in this session's folder loads (nearest one upwards), read or written on its own device.
        const nodeId=decodeURIComponent(nativeAgents[1]),runtime=url.searchParams.get('runtime'),sessionId=url.searchParams.get('sessionId'),entryId=url.searchParams.get('entryId');
        const entry=entryId?nativeCatalogRecords(nodeId,runtime).find(record=>record.id===entryId):null;
        if(entryId&&(!entry||sessionId&&entry.sessionId!==sessionId))throw Error('Session identity does not match its Workbench entry');
        const record=entry||(sessionId&&ownedNativeSession(nodeId,runtime,sessionId))||null;
        if(!record)throw Error('Session is not registered with Workbench');
        if(!record.workspace)throw Error('No working folder is recorded for this session yet.');
        if(db.get('workers',nodeId)?.capabilities?.nativeAgentsMd!==1)throw Error('Upgrade this Worker to read or edit AGENTS.md');
        // The project folder on this device that holds the session bounds the lookup and receives a new file; outside a project only the working folder counts.
        const within=(root,path)=>path===root||path.startsWith(root.endsWith('/')?root:`${root}/`);
        const binding=[...db.list('workspaces')].filter(w=>w.nodeId===nodeId&&w.localRoot&&within(w.localRoot,record.workspace)).sort((x,y)=>y.localRoot.length-x.localRoot.length)[0]||null;
        const projectId=record.roleBinding?.projectId||binding?.projectId||null;
        const common={workspace:record.workspace,runtime,sessionId:record.sessionId||null,entryId:record.id||null,stopAt:binding?.localRoot||null,projectId},scope={nodeId,projectId};
        if(req.method==='GET')return json(res,await workerQuery(scope,'native_agents_md',common,15000));
        nativeTurns.switches.assertExecutable({nodeId,runtime,sessionId:record.sessionId});
        const b=await body(req);
        return json(res,await workerQuery(scope,'native_agents_md_write',{...common,path:typeof b.path==='string'?b.path:null,content:b.content,expectedModifiedAt:typeof b.expectedModifiedAt==='string'?b.expectedModifiedAt:null,create:b.create===true,createDir:binding?.localRoot||null},20000));
      }
      // Branch and delete from the session settings. Branch copies the session's folder next to it and forks the CLI session into
      // the copy; delete removes a folder Workbench made for the session and drops the entry (the CLI's own history stays).
      const nativeBranch=pathname.match(/^\/api\/native-sessions\/([^/]+)\/(branch|delete)$/);
      if(nativeBranch&&(req.method==='POST'||nativeBranch[2]==='delete'&&req.method==='GET')){
        const nodeId=decodeURIComponent(nativeBranch[1]),worker=db.get('workers',nodeId),check=req.method==='GET';
        const b=check?{runtime:url.searchParams.get('runtime'),sessionId:url.searchParams.get('sessionId'),entryId:url.searchParams.get('entryId')}:await body(req);
        const runtime=b.runtime,sessionId=typeof b.sessionId==='string'&&b.sessionId?b.sessionId:null;
        if(!check)nativeTurns.switches.assertExecutable({nodeId,runtime,sessionId});
        const entry=typeof b.entryId==='string'&&b.entryId?db.get('nativeCatalogEntries',b.entryId):sessionId?nativeCatalogRecords(nodeId,runtime).find(r=>r.sessionId===sessionId):null;
        if(entry&&(entry.nodeId!==nodeId||entry.runtime!==runtime||sessionId&&entry.sessionId&&entry.sessionId!==sessionId))throw Error('Session identity does not match its Workbench entry');
        const refuse=reason=>{if(check)return json(res,{ok:false,reason});throw Error(reason);};
        if(!worker||!online(nodeId))return refuse('Device is offline; reconnect it first');
        if(worker.capabilities?.nativeBranch!==1)return refuse('Upgrade this Worker to branch or delete sessions');
        const turns=nativeTurns.turns,busy=Boolean(sessionId&&(turns.active(nodeId,runtime,sessionId)||turns.waiting(nodeId,runtime,sessionId).length));
        const bindings=[...db.list('workspaces'),...db.list('repositoryWorkspaces')].filter(w=>w.nodeId===nodeId).map(w=>({projectId:w.projectId,localRoot:w.localRoot}));
        if(nativeBranch[2]==='delete'){
          if(!entry)return refuse('Only sessions created in Workbench can delete their folder');
          if(sessionId&&turns.process(nodeId,runtime,sessionId))return refuse('End the page takeover first');
          if(busy)return refuse('This session is still replying or has queued messages');
          const input={runtime,sessionId:entry.sessionId||sessionId,entryId:entry.id,bindings};
          if(check)return json(res,await workerQuery({nodeId},'native_session_delete',{...input,dryRun:true},15000));
          const result=await workerQuery({nodeId},'native_session_delete',input,120000);
          if(result?.deleted!==true||result.entryId!==entry.id)throw Error('The device did not confirm the deletion');
          db.remove('nativeCatalogEntries',entry.id);change();return json(res,result);
        }
        if(!['claude','codex'].includes(runtime))throw Error('Only Claude Code and Codex sessions can be branched for now');
        const record=sessionId?ownedNativeSession(nodeId,runtime,sessionId):null;
        if(!record)throw Error('Session is not registered with Workbench');
        if(db.get('settings','main')?.paused)throw Error('Remote execution is paused');
        if(busy)throw Error('This session is still replying or has queued messages; wait for it to finish first');
        const branchEntryId=randomUUID(),title=`${String((entry||record).title||'').trim().slice(0,90)||runtime} · ${tr('nativeBranch.titleSuffix')}`;
        const result=await workerQuery({nodeId},'native_session_branch',{runtime,sessionId,record,branchEntryId,newSessionId:runtime==='claude'?randomUUID():null,title},15*60000);
        if(result?.entryId!==branchEntryId||!result.sessionId||!result.workspace)throw Error('The device did not confirm the branch');
        const now=new Date().toISOString();
        db.put('nativeCatalogEntries',{id:branchEntryId,nodeId,runtime,sessionId:result.sessionId,title:result.title,workspace:result.workspace,origin:'dialog',status:'ready',hasHistory:true,previewAvailable:true,folderCreated:true,branchOf:{sessionId},createdAt:now,modifiedAt:now});
        change();return json(res,result,201);
      }
      const nativeTitle=pathname.match(/^\/api\/native-sessions\/([^/]+)\/title$/);
      if(nativeTitle&&req.method==='POST'){
        // Renames only a Workbench-created session: the Worker's catalog entry is the source the list is refreshed from,
        // so it is updated first and Home's copy follows. Native ID, workspace, status and takeover records are untouched.
        const nodeId=decodeURIComponent(nativeTitle[1]),b=await body(req),title=typeof b.title==='string'?b.title.trim():'';
        if(!title||title.length>120)throw Error('Session title is required and must be at most 120 characters');
        const entry=db.get('nativeCatalogEntries',typeof b.entryId==='string'?b.entryId:'');
        if(!entry||entry.nodeId!==nodeId||entry.runtime!==b.runtime||(entry.sessionId||null)!==(b.sessionId||null))throw Error('Only sessions created in Workbench can be renamed here');
        const worker=db.get('workers',nodeId);
        if(!worker||!online(nodeId))throw Error('Device is offline; reconnect it to rename this session');
        if(worker.capabilities?.nativeSessionTitle!==1)throw Error('Upgrade this Worker to rename sessions');
        const result=await workerQuery({nodeId},'native_session_title',{entryId:entry.id,runtime:entry.runtime,sessionId:entry.sessionId||null,title},10000);
        if(result?.entryId!==entry.id||result.title!==title)throw Error('The device did not confirm the new session name');
        const current=db.get('nativeCatalogEntries',entry.id),updated=db.put('nativeCatalogEntries',{...current,title,renamedAt:new Date().toISOString()});
        change();return json(res,nativeCatalogItem(updated));
      }
      const nativeMedia=pathname.match(/^\/api\/native-sessions\/([^/]+)\/media$/);
      if(nativeMedia&&req.method==='GET'){
        const nodeId=decodeURIComponent(nativeMedia[1]),record=ownedNativeSession(nodeId,url.searchParams.get('runtime'),url.searchParams.get('sessionId'));
        if(!record)throw Error('Session is not registered with Workbench');
        return json(res,await mediaStreams.describe(mediaStreams.sourceForNative(nodeId,{...record,runtime:url.searchParams.get('runtime')},url.searchParams.get('path'))));
      }
      const mediaTransferRoute=pathname.match(/^\/api\/projects\/([^/]+)\/media-transfers(?:\/([a-f0-9-]{36}))?$/);
      if(mediaTransferRoute&&req.method==='POST'&&!mediaTransferRoute[2])return json(res,await mediaStreams.transfer(mediaTransferRoute[1],await body(req)),202);
      if(mediaTransferRoute&&req.method==='GET'&&mediaTransferRoute[2]){
        const transfer=db.get('mediaTransfers',mediaTransferRoute[2]);
        if(transfer?.projectId!==mediaTransferRoute[1])return json(res,{error:'Transfer not found'},404);
        const {fingerprint,...visible}=transfer;return json(res,visible);
      }
      const nativeMatch=pathname.match(/^\/api\/native-sessions\/([^/]+)(?:\/(terminal|folders|default-folder))?$/);
      if(nativeMatch){
        const nodeId=decodeURIComponent(nativeMatch[1]),worker=db.get('workers',nodeId);
        if(!worker)throw Error('Device is unavailable');
        if(worker.capabilities?.nativeSessions!==2)throw Error('Upgrade this Worker to use the native session catalog');
        if(req.method==='GET'&&!nativeMatch[2]){
          const runtime=url.searchParams.get('runtime'),sessionId=url.searchParams.get('sessionId'),scope=url.searchParams.get('scope')||'created';
          if(!['created','group','all'].includes(scope))throw Error('Invalid native session scope');
          if(worker.capabilities?.nativeSessionOwnership!==1)throw Error('Upgrade this Worker to read only Workbench sessions; external history scanning is disabled');
          const record=sessionId?ownedNativeSession(nodeId,runtime,sessionId):null;
          if(sessionId&&!record)throw Error('Session is not registered with Workbench');
          if(!online(nodeId)){
            // Offline All can show cached independent entries, but must not imply complete native history.
            if(!sessionId&&['created','all'].includes(scope))return json(res,{items:nativeTurns.switches.decorateCatalog(nodeId,nativeCatalogRecords(nodeId,runtime).map(nativeCatalogItem)),partial:scope==='all',offline:true});
            throw Error('Device is offline');
          }
          // Page authoritative cross-project bindings before the Worker catalogue's limit and WebSocket envelope.
          const managed=!sessionId&&['group','all'].includes(scope)?managedNativeSessions(nodeId,runtime):[];
          const offset=Number(url.searchParams.get('offset')||0);
          if(!Number.isSafeInteger(offset)||offset<0)throw Error('Invalid native session offset');
          const revision=scope==='group'?createHash('sha256').update(JSON.stringify(managed)).digest('hex'):null;
          if(!sessionId&&scope==='group'&&offset&&url.searchParams.get('revision')!==revision)return json(res,{restart:true});
          const page=scope==='group'?managed.slice(offset,offset+50):managed.map(({sessionId})=>({sessionId}));
          const paged=Boolean(sessionId&&url.searchParams.get('historyPage')==='1'),cursor=url.searchParams.get('cursor'),historySnapshot=url.searchParams.get('snapshot'),delta=Boolean(historySnapshot&&url.searchParams.get('delta')==='1');
          if((cursor||historySnapshot)&&(!paged||cursor?.length>2048||historySnapshot?.length>2048||cursor&&historySnapshot))throw Error('Invalid native history cursor');
          if(paged&&worker.capabilities?.nativeHistoryPages!==1)throw Error('Upgrade this Worker to load older native history.');
          if(sessionId&&cursor?.startsWith('home-turns:')){const stored=nativeTurns.switches.historyPage({nodeId,runtime,sessionId},{cursor});if(!stored)throw Error('Conversation history is unavailable');return json(res,stored);}
          const nativeSnapshot=historySnapshot?.startsWith('home-turns:')?null:historySnapshot;
          const result=await workerQuery({nodeId},sessionId?'native_session':'native_sessions',{runtime,sessionId,scope,record,managedSessions:page,adoptedSessions:scope==='all'?adoptedNativeSessions(nodeId,runtime):[],...(paged?{historyPage:true,cursor,snapshot:nativeSnapshot,...(delta&&nativeSnapshot?{delta:true}:{})}:{})},30000);
          if(sessionId&&result.previewAvailable===false){const stored=nativeTurns.switches.historyPage({nodeId,runtime,sessionId});if(stored)return json(res,{...result,...stored,workspace:record.workspace,notice:undefined});}
          if(!sessionId&&scope==='group'){
            const bindings=new Map(page.map(record=>[record.sessionId,record.roleBinding]));
            return json(res,{...result,items:(result.items||[]).map(item=>({...item,roleBinding:bindings.get(item.sessionId||item.id)||null})),revision,hasMore:offset+50<managed.length,nextOffset:offset+50});
          }
          if(!sessionId&&['created','all'].includes(scope))cacheNativeCatalog(result.items,nodeId,runtime);
          if(!sessionId&&scope==='created'){const merged=new Map(nativeCatalogRecords(nodeId,runtime).map(entry=>[entry.id,nativeCatalogItem(entry)]));for(const item of result.items||[])merged.set(item.entryId||item.id,item);return json(res,{...result,items:nativeTurns.switches.decorateCatalog(nodeId,[...merged.values()])});}
          if(!sessionId&&result.items)result.items=nativeTurns.switches.decorateCatalog(nodeId,result.items);
          return json(res,result);
        }
        if(!online(nodeId))throw Error('Device is offline');
        if(req.method==='POST'&&nativeMatch[2]==='default-folder'){
          if(worker.capabilities?.nativeDefaultFolder!==1)throw Error('Upgrade this Worker to prepare the default session folder.');
          const bindings=[...db.list('workspaces'),...db.list('repositoryWorkspaces')].filter(w=>w.nodeId===nodeId).map(w=>({localRoot:w.localRoot}));
          // With a project: its own folder on this device holds the session, under native-sessions/<name>.
          const input=await body(req),projectId=typeof input?.projectId==='string'&&input.projectId?input.projectId:null;
          if(projectId&&worker.capabilities?.nativeProjectFolder!==1)throw Error('Upgrade this Worker to prepare a project session folder.');
          const binding=projectId?db.get('workspaces',`${projectId}:${nodeId}`):null;
          if(projectId&&!binding?.localRoot)throw Error('Bind the project folder on this device first');
          return json(res,await workerQuery({nodeId,projectId},'native_default_folder',{bindings,...(binding?{projectRoot:binding.localRoot,name:typeof input.name==='string'?input.name.slice(0,120):''}:{})},15000));
        }
        if(req.method==='GET'&&nativeMatch[2]==='folders')return json(res,await workerQuery({nodeId},'directories',{
          path:url.searchParams.get('path')||null,offset:Number(url.searchParams.get('offset')||0),includeFiles:true},15000));
        if(req.method!=='POST'||nativeMatch[2]!=='terminal')throw Error('Invalid session action');
        const b=await body(req);
        if(b.action==='release'||b.action==='stop'){const claim=db.get('terminalSessions',b.operationId);if(claim?.kind!=='native'||claim.nodeId!==nodeId)throw Error('Invalid native terminal binding');return json(res,await returnTerminal(claim,b.action));}
        // Open on the Sessions page: the prepared link is consumed by the Worker itself; the finished claim returns through the usual terminal checks.
        if(b.action==='start'){
          const claim=db.get('terminalSessions',b.operationId);
          if(claim?.kind!=='native'||claim.nodeId!==nodeId||claim.status!=='prepared')throw Error('Terminal request is already used or changed');
          nativeTurns.switches.assertExecutable({nodeId,runtime:claim.runtime,sessionId:claim.sessionId});
          if(worker.capabilities?.nativePageOpen!==1)throw Error('Upgrade this Worker to open sessions on this page');
          const started=await workerQuery(claim,'native_terminal_start',{id:claim.id},20000);
          db.transaction(()=>{const current=db.get('terminalSessions',claim.id);if(current?.status==='prepared')db.put('terminalSessions',{...current,status:'active',openedOn:'page',startedAt:new Date().toISOString()});});
          change();return json(res,{started:true,pid:started.pid});
        }
        if(worker.capabilities?.nativeSessionOwnership!==1)throw Error('Upgrade this Worker to read only Workbench sessions; external history scanning is disabled');
        const historyRecord=b.sessionId?ownedNativeSession(nodeId,b.runtime,b.sessionId):null;
        nativeTurns.switches.assertExecutable({nodeId,runtime:b.runtime,sessionId:b.sessionId});
        if(b.sessionId&&!historyRecord)throw Error('Session is not registered with Workbench');
        if(worker.capabilities?.nativeTakeover!==1)throw Error('Upgrade this Worker to safely take over native sessions');
        if(typeof b.operationId!=='string'||!/^[a-zA-Z0-9-]{8,100}$/.test(b.operationId)||typeof b.allowAll!=='boolean')throw Error('Invalid terminal request');
        const fresh=!b.sessionId,catalogEntryId=b.entryId||(fresh?b.operationId:nativeCatalogRecords(nodeId,b.runtime).find(entry=>entry.sessionId===b.sessionId)?.id||null),entry=catalogEntryId?db.get('nativeCatalogEntries',catalogEntryId):null,prior=db.get('terminalSessions',b.operationId);
        if(fresh&&(typeof b.title!=='string'||!b.title.trim()||b.title.trim().length>120))throw Error('Session title is required and must be at most 120 characters');
        if(b.entryId&&(typeof b.entryId!=='string'||!/^[a-zA-Z0-9-]{8,100}$/.test(b.entryId)))throw Error('Invalid native catalog entry');
        if(fresh&&entry&&(entry.nodeId!==nodeId||entry.runtime!==b.runtime||entry.title!==b.title.trim()||entry.status!=='draft'&&!(prior?.catalogEntryId===entry.id&&prior.status==='prepared')))throw Error('Native catalog entry cannot be reused for a different or active session');
        const freshSessionId=fresh&&['claude','grok'].includes(b.runtime)?entry?.sessionId||randomUUID():null;
        const fingerprint=JSON.stringify({nodeId,runtime:b.runtime,sessionId:b.sessionId||null,freshSessionId,entryId:catalogEntryId,workspace:b.workspace||null,title:fresh?b.title.trim():null,allowAll:b.allowAll});
        if(prior){if(prior.nativeFingerprint!==fingerprint||prior.status!=='prepared')throw Object.assign(Error('Terminal request is already used or changed'),{folderPreparationReleased:db.get('folderPreparations',`${nodeId}:${b.operationId}`)?.status==='cancelled'});return json(res,terminalLaunchView(prior));}
        if(db.get('settings','main')?.paused)throw Error('Remote execution is paused');
        const device=db.list('devices').find(d=>d.nodeId===nodeId);
        if(worker.nodeKind==='cloud'&&!device)throw Error('Register SSH access for this server first');
        const bindings=[...db.list('workspaces'),...db.list('repositoryWorkspaces')].filter(w=>w.nodeId===nodeId).map(w=>({projectId:w.projectId,localRoot:w.localRoot}));
        return await withFolderPreparation(fresh&&worker.capabilities?.localFolderSelection===1&&b.workspace?{nodeId,scope:`native:${catalogEntryId}`,path:b.workspace,operationId:b.operationId}:null,async folderCandidate=>{
        const gitCredential=b.sessionId?await nativeTurns.gitCredentialFor(nodeId,b.runtime,b.sessionId):null;
        const input={runtime:b.runtime,sessionId:b.sessionId||null,record:historyRecord,freshSessionId,entryId:catalogEntryId,title:fresh?b.title.trim():null,workspace:folderCandidate?.root||b.workspace,folderCandidate,allowAll:b.allowAll,bindings,managedProjectIds:nativeSessionProjectIds(db,{nodeId,runtime:b.runtime,sessionId:b.sessionId}),...(gitCredential?{gitCredential}:{})};
        const preview=await workerQuery({nodeId},'native_terminal_preview',input,30000);
        input.managedProjectIds=nativeSessionProjectIds(db,{nodeId,runtime:b.runtime,sessionId:b.sessionId});
        const owner=nativeTerminalProject(db,{nodeId,runtime:b.runtime,sessionId:b.sessionId,folderProjectIds:preview.projectId?[preview.projectId]:[]}),projectId=owner||`native-tui:${b.operationId}`;
        if(owner&&!db.get('projects',owner))throw Error('The owning group chat is unavailable; its session was not reassigned');
        // Share the existing reservation/return lifecycle when a native folder belongs to a group chat.
        if(db.get('settings','main')?.paused||projectTerminalLock(db,projectId,nodeId)||sourceSync.busy(projectId,nodeId)||db.list('runs').some(r=>r.nodeId===nodeId&&(r.status==='reconciling'||r.projectId===projectId&&!terminal.has(r.status))))throw Error('The related group chat is busy; finish its current work first');
        if(db.get('terminalSessions',b.operationId))throw Error('Terminal request is being prepared');
        const createdAt=entry?.createdAt||new Date().toISOString(),claim={id:b.operationId,kind:'native',catalogEntryId,projectId,nodeId,runtime:b.runtime,sessionId:b.sessionId||null,nativeFingerprint:fingerprint,status:'preparing',createdAt:new Date().toISOString()};
        db.transaction(()=>{if(fresh)db.put('nativeCatalogEntries',{...entry,id:catalogEntryId,nodeId,runtime:b.runtime,sessionId:freshSessionId,title:b.title.trim(),workspace:preview.workspace,origin:'dialog',status:'preparing',hasHistory:false,previewAvailable:false,createdAt,modifiedAt:new Date().toISOString()});activateFolderBinding(folderCandidate);db.put('terminalSessions',claim);});change();
        try{
          const info=await workerQuery(claim,'native_terminal_prepare',{...input,workspace:preview.workspace,id:claim.id,projectId,nodeId},30000);
          const identityFile=b.useLocalSshKey===true&&process.platform==='darwin'&&device?(await credentials.get(device.id))?.keyPath:null;
          const value=terminalLaunchView({...claim,...info,status:'prepared',command:terminalCommand(info,device||null,identityFile)});
          if(db.get('terminalSessions',claim.id)?.status!=='preparing')throw Error('Terminal preparation expired');
          db.transaction(()=>{db.put('terminalSessions',value);if(fresh){const current=db.get('nativeCatalogEntries',catalogEntryId);db.put('nativeCatalogEntries',{...current,sessionId:info.sessionId||current.sessionId,status:'prepared',workspace:info.workspace,modifiedAt:new Date().toISOString()});}});change();return json(res,value,201);
        }catch(error){let status='blocked';try{await workerQuery(claim,'terminal_release',{id:claim.id});status='released';}catch{}const current=db.get('terminalSessions',claim.id);db.transaction(()=>{if(!['released','cancelled'].includes(current?.status))db.put('terminalSessions',{...claim,status,error:error.message});if(fresh&&status==='released'){const catalog=db.get('nativeCatalogEntries',catalogEntryId);if(catalog)db.put('nativeCatalogEntries',{...catalog,status:'draft',modifiedAt:new Date().toISOString()});}});change();throw error;}
        });
      }
      if (pathname === '/api/token-usage' && req.method === 'GET') {
        const nodeIds=(url.searchParams.get('nodeIds')||'').split(',').filter(Boolean);
        return json(res,tokenUsage.report({from:url.searchParams.get('from'),to:url.searchParams.get('to'),nodeIds}));
      }
      if (pathname === '/api/token-usage/refresh' && req.method === 'POST') {
        const b=await body(req),nodeIds=[...new Set(b.nodeIds||[])];
        if(nodeIds.length!==2)throw new Error(tr('home.selectTwoDifferentDevices'));
        await Promise.allSettled(nodeIds.map(nodeId=>tokenUsage.collect(nodeId,{from:b.from||null,to:b.to||null})));
        return json(res,tokenUsage.report({from:b.from,to:b.to,nodeIds}));
      }
      if (pathname === '/api/platform/assistant' && req.method === 'GET') return json(res,assistant.state());
      if (pathname === '/api/platform/assistant' && req.method === 'POST') {
        const result=await assistant.send(await body(req));scheduleChat();return json(res,result);
      }
      const proposalAction=pathname.match(/^\/api\/platform\/proposals\/([^/]+)\/(approve|reject)$/);
      if(proposalAction&&req.method==='POST'){
        if(proposalAction[2]==='approve')return json(res,await assistant.approve(proposalAction[1]));
        const p=db.get('platformProposals',proposalAction[1]);if(p?.status!=='pending')throw new Error(tr('home.proposalHasAlreadyBeenHandled'));
        const result=db.put('platformProposals',{...p,status:'rejected'});change();return json(res,result);
      }
      if (pathname === '/api/hosting/accounts' && req.method === 'POST') {
        const result = await hosting.save(await body(req)); change(); return json(res, result);
      }
      if (pathname === '/api/devices' && req.method === 'POST') return json(res, await devicesAdmin.save(await body(req)));
      const deleteRuntime=pathname.match(/^\/api\/workers\/([^/]+)\/runtimes\/([^/]+)$/);
      if(deleteRuntime&&req.method==='DELETE')return json(res,devicesAdmin.removeRuntime(decodeURIComponent(deleteRuntime[1]),decodeURIComponent(deleteRuntime[2])));
      const deleteDevice=pathname.match(/^\/api\/(devices|workers)\/([^/]+)$/);
      if(deleteDevice&&req.method==='DELETE')return json(res,await devicesAdmin.remove({[deleteDevice[1]==='devices'?'deviceId':'nodeId']:decodeURIComponent(deleteDevice[2])}));
      const desktopAction = pathname.match(/^\/api\/devices\/([^/]+)\/desktop\/(prepare|launch|open)$/);
      if (desktopAction && req.method === 'POST') {
        const action = { prepare: 'prepareDesktop', launch: 'launchDesktop', open: 'openDesktop' }[desktopAction[2]];
        return json(res, await devicesAdmin[action](desktopAction[1]));
      }
      const deviceAction = pathname.match(/^\/api\/devices\/([^/]+)\/(check|connect)$/);
      const reconnectAction = pathname.match(/^\/api\/devices\/([^/]+)\/reconnect$/);
      if(reconnectAction&&req.method==='GET')return json(res,devicesAdmin.reconnectStatus(reconnectAction[1]));
      if(reconnectAction&&req.method==='POST')return json(res,await devicesAdmin.reconnect(reconnectAction[1]));
      if (deviceAction && req.method === 'POST') {
        if (db.get('settings','main')?.paused) throw new Error(tr('home.remoteExecutionPaused2'));
        const result = await (deviceAction[2] === 'check' ? devicesAdmin.check(deviceAction[1]) : devicesAdmin.provision(deviceAction[1]));
        return json(res, result);
      }
      const workerCapacity=pathname.match(/^\/api\/workers\/([^/]+)\/capacity$/);
      if(workerCapacity && req.method==='POST') {
        const b=await body(req),capacity=validateCliCapacity(b.capacity),worker=db.get('workers',workerCapacity[1]);
        if(!worker)throw new Error(tr('home.deviceNotFound'));
        if(online(worker.id)&&worker.capabilities?.cliCapacity!==1)throw new Error(tr('capacity.upgrade'));
        db.put('workerConfigs',{...db.get('workerConfigs',worker.id),id:worker.id,capacity});
        db.put('workers',{...worker,desiredCapacity:capacity,capacity:Math.min(capacity,worker.appliedCapacity||worker.capacity||1)});change();
        // Persist the desired value even offline. Reconnection applies it before dispatching work.
        let applied=false;
        if(online(worker.id)) {
          try {const result=await workerQuery({nodeId:worker.id},'cli_capacity',{capacity},30000);applied=result.capacity===capacity&&db.get('workerConfigs',worker.id)?.capacity===capacity;}
          catch { /* saved, but pending reconnection or an in-flight update */ }
        }
        scheduleChat();return json(res,{capacity,applied});
      }
      const workerConfig = pathname.match(/^\/api\/workers\/([^/]+)\/configuration$/);
      if (workerConfig && req.method === 'POST') {
        if (db.get('settings','main')?.paused) throw new Error(tr('home.remoteExecutionPaused3'));
        const b = await body(req), worker = db.get('workers',workerConfig[1]);
        if (!worker) throw new Error(tr('home.deviceNotFound'));
        const checked = await workerQuery({nodeId:worker.id},'workspace_root',b.workspaceRoot);
        const config = db.put('workerConfigs',{...db.get('workerConfigs',worker.id),id:worker.id, workspaceRoot:checked.localRoot, name:String(b.name || worker.name).slice(0,80)});
        db.put('workers',{...db.get('workers',worker.id),name:config.name,workspaceRoot:config.workspaceRoot}); change(); return json(res,config);
      }
      if (pathname.startsWith('/api/agent/') && req.method === 'POST') {
        const b = await body(req);
        assertAgentSender(b);
        const run = db.get('runs', b.runId);
        if(pathname==='/api/agent/report') {
          if(!run)throw Object.assign(new Error(tr('home.currentExecutionHasEndedStopping')),{code:'run_ended'});
          if(run.switchOperationId)throw new Error('CLI handoff maintenance permits history reads only.');
          if(b.action==='status')return json(res,readReportSubmission(db,run,b));
          if(b.action==='file')return json(res,readReportFile(conversationView(reviewView(db,{projectId:run.projectId,roleId:run.roleId}),run),run,b));
          const result=saveRunReport(db,run,b);if(!result.replayed&&!result.ignored)change();return json(res,result);
        }
        // Distinct codes: reconciling is retryable with the same request; stopping and ended are final for this Run.
        if (run?.status === 'reconciling') throw Object.assign(new Error(tr('home.runReconciling')),{code:'run_reconciling'});
        if (run?.status === 'stopping') throw Object.assign(new Error(tr('home.runStopping')),{code:'run_stopping'});
        if (!run || terminal.has(run.status)) throw Object.assign(new Error(tr('home.currentExecutionHasEndedStopping')),{code:'run_ended'});
        if(db.get('settings','main')?.paused&&!allowsPausedAgentOperation(pathname,b))throw Object.assign(new Error(tr('home.remoteExecutionPaused')),{code:'paused'});
        if(run.switchOperationId&&!['/api/agent/setup/catalog','/api/agent/history/search','/api/agent/history/read','/api/agent/sessions/current','/api/agent/sessions/list','/api/agent/sessions/summary','/api/agent/sessions/read','/api/agent/conversation/summary'].includes(pathname))throw new Error('CLI handoff maintenance permits history reads only.');
        if (pathname === '/api/agent/progress') {
          // Receipts and derived progress belong to the calling role; verification is its explicit, recorded decision.
          if(b.action==='list'||b.action===undefined)return json(res,receiptList(db,{projectId:run.projectId,roleId:run.roleId}));
          if(b.action==='verify'){const result=verifyResultReceipt(db,run,b.input||{});if(!result.replayed)change();return json(res,result);}
          throw new Error(tr('resultReceipts.invalidAction'));
        }
        if (pathname === '/api/agent/notify') {
          if (Object.keys(b).some(key=>!['runId','action','input'].includes(key))) throw new Error(tr('wechatChannel.toolGuide'));
          const result=wechat.notify(run,b.action,b.input); void wechat.tick().catch(()=>{}); return json(res,result);
        }
        if(['/api/agent/read-source','/api/agent/node-query','/api/agent/file-read'].includes(pathname)){
          if(Object.keys(b).some(k=>!['runId','input'].includes(k)))throw Error('invalid_read_request');
          const method=pathname==='/api/agent/read-source'?'inspect':pathname==='/api/agent/node-query'?'query':'read';
          return json(res,await crossDeviceRead[method](run,b.input));
        }
        if(pathname==='/api/agent/source-sync'){const result=await sourceSync.agent.execute(run,b.action,b.input||{});change();return json(res,result);}
        if(pathname==='/api/agent/source-candidates'){const result=b.finish?await sourceSync.agent.completeCandidate(run,b.candidateId):sourceSync.agent.stageCandidate(run,b);change();return json(res,result);}
        if(pathname==='/api/agent/discussions') {
          if(Object.keys(b).some(k=>!['runId','action','input'].includes(k)))throw new Error(tr('home.discussionRequestContainsUnauthorizedFields'));
          // Read/reply/resolve for an already started turn still finish under the frozen identity; a probe withdrawal only blocks new questions and does not swallow in-flight answers.
          if(b.action!=='peers'&&(run.discussionProtocol!==2||(b.action==='ask'&&!supportsDiscussion(db.get('workers',run.nodeId),run.roleSnapshot?.runtime,run.roleSnapshot?.model))))throw new Error(tr('home.discussionProtocolV2NotEnabled'));
          if(!['peers','ask','reply','read','resolve','budget_extend'].includes(b.action))throw new Error(tr('home.unknownDiscussionAction'));
          const reader=['peers','read'].includes(b.action)?new RoleDiscussions(conversationView(reviewView(db,{projectId:run.projectId,roleId:run.roleId}),run),{online:id=>online(id)}):discussions;
          const result=b.action==='budget_extend'?discussions.extendBudget({kind:'agent',runId:run.id},b.input):reader[b.action](run,b.input||{});
          scheduleChat();change();return json(res,result);
        }
        // Independent-review isolation is applied to the data the read tools see, before search, pagination or summaries.
        const readView=conversationView(reviewView(db,{projectId:run.projectId,roleId:run.roleId}),run);
        if (pathname === '/api/agent/history/search') return json(res,new History(readView).search(run.projectId,agentConversationInput(run,b)));
        if (pathname === '/api/agent/history/read') return json(res,new History(readView).read(run.projectId,agentConversationInput(run,b)));
        if (pathname === '/api/agent/sessions/current') return json(res,sessionTools.current(run));
        if (pathname === '/api/agent/sessions/list') return json(res,new SessionTools(readView).list(run,b));
        if (pathname === '/api/agent/sessions/summary') return json(res,new SessionTools(readView).summary(run,b.roleSessionId));
        if (pathname === '/api/agent/sessions/read') return json(res,new SessionTools(readView).read(run,b.roleSessionId,b));
        if (pathname === '/api/agent/conversation/summary') return json(res,new SessionTools(readView).chatSummary(run,b));
        if (pathname === '/api/agent/setup/catalog') return json(res, run.roleSnapshot?.platformAssistant ? assistant.catalog(run) : { ...setup.catalog(run), roleTemplates: listRoleTemplates(db) });
        if (pathname === '/api/agent/schedule') { const p=executionPlans.submit(run,b);change();return json(res,{planId:p.id,status:p.status,note:tr('home.waitScheduledEndCurrentTurn')},201); }
        if (pathname === '/api/agent/timers') {
          if (db.get('workers',run.nodeId)?.capabilities?.timerTools!==1) throw new Error(tr('home.upgradeCurrentWorkerUseScheduled'));
          const result=timerAgent.execute(run,b.action,Object.fromEntries(Object.entries(b).filter(([key])=>!['runId','action'].includes(key))));
          if(b.action!=='list')change();
          return json(res,result);
        }
        if (pathname === '/api/agent/setup/propose') return json(res, run.roleSnapshot?.platformAssistant ? assistant.propose(run,b) : setup.propose(run, b));
        if (pathname === '/api/agent/roles/prompt') return json(res, setup.updateRolePrompt(run, b));
        if (pathname === '/api/agent/pass') { const result=new SessionQueue(db).pass(run);change();return json(res,result); }
        if (pathname === '/api/agent/collaboration-sessions') {
          if(b.action==='create'&&db.get('projects',run.projectId)?.supervisorRoleId!==run.roleId)throw new Error(tr('collabSessions.supervisorOnly'));
          const baselines=b.action==='create'?await reviewDocumentBaselines(run.projectId,b.input||{}):[];
          const result=new CollaborationSessions(db).agent(run,b.action,b.input,baselines);change();return json(res,result);
        }
        if(pathname==='/api/agent/documents'){
          const root=db.get('workspaces',`${run.projectId}:${run.nodeId}`)?.localRoot;
          if(!root)throw new Error(tr('store.bindProjectWorkspaceOnNode'));
          const privatePath=readView.reviewGuarded?`handoffs/private/${run.roleId}/LATEST.md`:'handoffs/LATEST.md';
          const deviceHandoffs=db.get('workers',run.nodeId)?.capabilities?.sourceSyncOutputs===1;
          const result=await workerQuery(run,'collaboration_documents',{root,action:b.action==='last'?(deviceHandoffs?'last':'read'):b.action,path:b.action==='last'?privatePath:b.path,...(b.action==='last'&&deviceHandoffs?{reviewPrivate:readView.reviewGuarded?run.roleId:'',...(db.get('workers',run.nodeId)?.capabilities?.groupConversations===1?{roleSessionId:run.roleSessionId||''}:{})}:{})});
          if(b.action==='list')return json(res,{docs:result.files.filter(file=>reviewDocumentAllowed(db,run,file)&&file.path.startsWith('docs/')).map(file=>file.path.slice(5)),partial:result.partial});
          if(!reviewDocumentAllowed(db,run,result))throw new Error(tr('collabSessions.documentNotReleased'));
          return json(res,{path:result.path,text:result.text});
        }
        if (pathname === '/api/agent/note') {
          const r = rooms.agentNote(run, b.text); change(); return json(res, r, 201);
        }
        if (pathname === '/api/agent/calls' || pathname === '/api/agent/ask') {
          const result=createAgentCalls({db,calls,rooms},run,b,{legacyAsk:pathname.endsWith('/ask')});
          scheduleChat(); change(); return json(res,result,201);
        }
        if (pathname === '/api/agent/wait') {
          const r = calls.wait(run, b.summary,{requestIds:b.requestIds,timeoutSeconds:b.timeoutSeconds}); change(); return json(res, { requestId: r.id, status: r.status,requestIds:r.waitRequestIds,deadlineAt:r.waitDeadlineAt,note: tr('home.endTurnNowExecutionSlot') });
        }
        if (pathname === '/api/agent/deliveries') {
          const r = deliveries.request(run, b); change(); return json(res, r, 201);
        }
        throw new Error(tr('home.unknownCollaborationEndpoint'));
      }
      if (pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write('event: change\ndata: {}\n\n'); viewers.add(res);
        req.on('close', () => viewers.delete(res)); return;
      }
      const readAccessRoute=pathname.match(/^\/api\/projects\/([^/]+)\/read-access$/);
      if(readAccessRoute&&req.method==='GET')return json(res,crossDeviceRead.configuration(readAccessRoute[1]));
      if(readAccessRoute&&req.method==='PUT'){const result=crossDeviceRead.updateConfiguration(readAccessRoute[1],await body(req));change();return json(res,result);}
      const collabFlagRoute=pathname.match(/^\/api\/projects\/([^/]+)\/collaboration-sessions\/feature$/);
      if(collabFlagRoute&&req.method==='POST'){const p=setCollaborationSessionsEnabled(db,collabFlagRoute[1],(await body(req)).enabled);change();return json(res,{enabled:p.features.collaborationSessions});}
      const queueRoute=pathname.match(/^\/api\/projects\/([^/]+)\/collaboration-sessions\/(queue|queue-config)$/);
      if(queueRoute&&req.method==='GET')return json(res,queueRoute[2]==='queue'?new SessionQueue(db).status(queueRoute[1]):queueConfig(db,queueRoute[1]));
      if(queueRoute&&queueRoute[2]==='queue-config'&&req.method==='POST'){const c=setQueueConfig(db,queueRoute[1],await body(req));change();return json(res,c);}
      const collabListRoute=pathname.match(/^\/api\/projects\/([^/]+)\/collaboration-sessions$/);
      if(collabListRoute&&req.method==='GET')return json(res,{items:collaborationSessions.list(collabListRoute[1])});
      if(collabListRoute&&req.method==='POST'){const input=await body(req),baselines=await reviewDocumentBaselines(collabListRoute[1],input);const s=collaborationSessions.create(collabListRoute[1],input,{kind:'human'},baselines);change();return json(res,s,201);}
      const reassignRoute=pathname.match(/^\/api\/projects\/([^/]+)\/requests\/([^/]+)\/reassign$/);
      if(reassignRoute&&req.method==='POST'){const r=reassignRequest(db,calls,reassignRoute[1],decodeURIComponent(reassignRoute[2]),(await body(req)).roleId);scheduleChat();change();return json(res,r);}
      const testProjectRoute=pathname.match(/^\/api\/projects\/([^/]+)\/collaboration-sessions\/test-project$/);
      if(testProjectRoute&&req.method==='POST'){const p=setTestProject(db,testProjectRoute[1],(await body(req)).enabled);change();return json(res,{testProject:p.testProject});}
      const grantRoute=pathname.match(/^\/api\/projects\/([^/]+)\/collaboration-sessions\/([^/]+)\/budget$/);
      if(grantRoute&&req.method==='POST'){const c=grantBudget(db,grantRoute[1],grantRoute[2],await body(req),{kind:'human'});change();return json(res,c);}
      const broadcastRoute=pathname.match(/^\/api\/projects\/([^/]+)\/collaboration-sessions\/([^/]+)\/broadcast$/);
      if(broadcastRoute&&req.method==='POST'){const r=setSessionBroadcast(db,broadcastRoute[1],broadcastRoute[2],await body(req));change();return json(res,r);}
      const collabActionRoute=pathname.match(/^\/api\/projects\/([^/]+)\/collaboration-sessions\/([^/]+)\/(members\/add|members\/remove|link|release|close)$/);
      if(collabActionRoute&&req.method==='POST'){
        const [,projectId,id,action]=collabActionRoute,input=await body(req);
        const s=action==='members/add'?collaborationSessions.addMember(projectId,id,input):action==='members/remove'?collaborationSessions.removeMember(projectId,id,input)
          :action==='link'?collaborationSessions.link(projectId,id,input):collaborationSessions[action](projectId,id);
        change();return json(res,s);
      }
      const discussionBudgetRoute=pathname.match(/^\/api\/projects\/([^/]+)\/discussions\/budget$/);
      if(discussionBudgetRoute&&req.method==='POST') {
        const result=discussions.extendBudget({kind:'human',projectId:discussionBudgetRoute[1]},await body(req));change();return json(res,result);
      }
      const discussionReplyRoute=pathname.match(/^\/api\/projects\/([^/]+)\/discussions\/([^/]+)\/(reply|resolve)$/);
      // GET .../reply?requestId= answers only whether this user reply request was already accepted; it changes nothing.
      if(discussionReplyRoute&&discussionReplyRoute[3]==='reply'&&req.method==='GET')return json(res,discussions.userReplyReceipt(discussionReplyRoute[1],discussionReplyRoute[2],url.searchParams.get('requestId')));
      if(discussionReplyRoute&&req.method==='POST') {
        const input=await body(req);if(input.threadId&&input.threadId!==discussionReplyRoute[2])throw new Error(tr('home.threadIdMismatch'));
        const result=discussions[discussionReplyRoute[3]==='reply'?'userReply':'userResolve'](discussionReplyRoute[1],{...input,threadId:discussionReplyRoute[2]});scheduleChat();change();return json(res,result);
      }
      if (pathname === '/api/projects' && req.method === 'POST') {
        const b = await body(req);
        const supervisor = b.supervisor || {};
        validateLocalSupervisor(db.get('workers', supervisor.nodeId), supervisor, online(supervisor.nodeId));
        if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 80) throw new Error(tr('home.projectNameMustBe1'));
        if (b.description !== undefined && (typeof b.description !== 'string' || b.description.length > 12000)) throw new Error(tr('home.projectDescriptionMustBeAt'));
        if (db.get('settings', 'main')?.paused) throw new Error(tr('home.remoteExecutionPausedResumeIt'));
        const id = b.requestId || randomUUID();
        if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error(tr('home.invalidCreateRequestId'));
        const folder = folderName(b.folderName || `project-${id.slice(0,8)}`);
        if(b.localRoot!==undefined&&typeof b.localRoot!=='string')throw Error('Select an absolute folder path');
        const localRoot=b.localRoot?.trim()||'';
        const creationSignature=JSON.stringify([b.name.trim(),b.description||'',folder,supervisor.nodeId,supervisor.runtime,supervisor.model,supervisor.effort||'',supervisor.permissionScope||null,...(localRoot?[localRoot]:[])]);
        const previousProject=db.get('projects',id);
        if (previousProject) {
          if(previousProject.creationSignature && previousProject.creationSignature!==creationSignature) throw new Error(tr('home.createRequestHasAlreadyCompleted'));
          return json(res, previousProject);
        }
        if (db.list('projects').some(p => p.folderName === folder)) throw new Error(tr('home.projectFolderNameAlreadyIn'));
        const worker = db.get('workers',supervisor.nodeId);
        if (worker.capabilities?.projectSpace !== 1) throw new Error(tr('home.upgradeWorkerOnSupervisorDevice'));
        return await withFolderPreparation(localRoot?{nodeId:supervisor.nodeId,scope:`project:${id}`,path:localRoot,operationId:id}:null,async selectedGrant=>{
        const checked = selectedGrant?{localRoot:selectedGrant.root,git:null,managed:false,folderName:folder}:await workerQuery({ nodeId: supervisor.nodeId }, 'project_directory', { projectId: id, folder, workspaceRoot:worker.workspaceRoot || worker.allowedRoots?.[0] });
        // The node may disconnect during the check; the project, Supervisor, and initialization message must be persisted together.
        validateLocalSupervisor(db.get('workers', supervisor.nodeId), supervisor, online(supervisor.nodeId));
        const r = db.transaction(() => {
          const repeated=db.get('projects',id);if(repeated){if(repeated.creationSignature!==creationSignature)throw Error(tr('home.createRequestHasAlreadyCompleted'));return repeated;}
          const p = db.createProject({ ...b, id, root: '', repoUrl: '' });
          db.bindWorkspace(p.id, supervisor.nodeId, checked);
          activateFolderBinding(selectedGrant);
          const supervisorConfig=coordinator.saveSupervisor(p.id, supervisor.nodeId, { ...supervisor, enabled: true });
          const roleId = `supervisor-${p.id}`;
          db.put('roles', { id: roleId, projectId: p.id, name: tr('home.supervisor'), systemSupervisor: true,
            nodeId: supervisor.nodeId, runtime: supervisor.runtime, model: supervisor.model, effort: supervisor.effort || null,
            mode: 'workspace-write', autoApprove: true, enabled: true, configured: true,permissionScope:supervisorConfig.permissionScope,
            instructions: setupRules(), revision: 1 });
          const project = db.put('projects', { ...p, folderName:folder, creationSignature, projectScope:true, supervisorNodeId: supervisor.nodeId, supervisorRoleId: roleId, setupStatus: 'ready' });
          db.put('roomMessages', { id: `welcome-${id}`, projectId: id, sender: 'system', senderName: tr('home.projectAssistant'), taskIds: [],
            text: tr('home.projectDirectorySupervisorReadyYou'), createdAt: new Date().toISOString() });
          rooms.touch(id);
          return project;
        });
        change(); return json(res, r, 201);
        });
      }
      if (pathname === '/api/tasks' && req.method === 'POST') { const r = db.createTask(await body(req)); change(); return json(res, r, 201); }
      let m;
      if((m=pathname.match(/^\/api\/projects\/([^/]+)\/proactive-followup$/))){
        if(req.method==='GET')return json(res,proactiveFollowup.view(m[1],url.searchParams.get('conversationId')??undefined));
        if(req.method==='POST'){const result=proactiveFollowup.save(m[1],await body(req));change();return json(res,result);}
      }
      if((m=pathname.match(/^\/api\/tasks\/([^/]+)\/detail$/)) && req.method==='GET') {
        const task=db.get('tasks',decodeURIComponent(m[1]));
        if(!task)return json(res,{error:tr('home.taskNotFound')},404);
        return json(res,{task});
      }
      if((m=pathname.match(/^\/api\/projects\/([^/]+)\/history\/(search|read)$/)) && req.method==='GET') {
        const input=Object.fromEntries(url.searchParams);for(const key of ['offset','limit'])if(input[key]!==undefined)input[key]=Number(input[key]);
        return json(res,history[m[2]](m[1],input));
      }
      if((m=pathname.match(/^\/api\/projects\/([^/]+)\/scheduled-jobs$/))) {
        if(req.method==='GET')return json(res,scheduledJobs.list(m[1],url.searchParams.get('conversationId')??undefined));
        if(req.method==='POST'){const result=scheduledJobs.save(m[1],await body(req));change();return json(res,result);}
      }
      if((m=pathname.match(/^\/api\/projects\/([^/]+)\/scheduled-jobs\/([^/]+)\/(toggle|run|delete)$/)) && req.method==='POST') {
        const b=await body(req);
        assertConversationRecord({projectId:m[1],conversationId:resolveConversationId(db,m[1],b.conversationId)},db.get('scheduledJobs',m[2]));
        const result=m[3]==='toggle'?scheduledJobs.pause(m[1],m[2],b.enabled,b.revision):m[3]==='run'?scheduledJobs.runNow(m[1],m[2]):scheduledJobs.remove(m[1],m[2],b.revision);
        scheduleChat();change();return json(res,result);
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/prepare\/([^/]+)$/)) && req.method === 'POST') return json(res,await projectsAdmin.prepare(m[1],m[2]));
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/repositories$/)) && req.method === 'POST') return json(res,await projectsAdmin.repository(m[1],await body(req)));
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/setup-proposals\/([^/]+)\/(approve|reject)$/)) && req.method === 'POST') {
        if (m[3] === 'reject') { setup.reject(m[1], m[2]); return json(res, { rejected: true }); }
        return json(res, await setup.approve(m[1], m[2]));
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/deliveries\/([^/]+)\/approve$/)) && req.method === 'POST') {
        const r = deliveries.approve(m[1], m[2]); scheduleChat(); change(); return json(res, r);
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/calls\/([^/]+)\/cancel$/)) && req.method === 'POST') {
        const id = decodeURIComponent(m[2]);
        if (db.get('coordinationRequests', id)?.projectId !== m[1]) throw new Error(tr('home.callDoesNotBelongProject'));
        for (const runId of calls.cancel(id)) { const run = db.requestStop(runId, `cancel-call:${runId}`); dispatch(run.nodeId); }
        change(); return json(res, db.get('coordinationRequests', id));
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/supervisors\/([^/]+)$/)) && req.method === 'PUT') {
        const b = await body(req);
        validateLocalSupervisor(db.get('workers', m[2]), b, online(m[2]));
        const project = db.get('projects', m[1]);
        if (project?.supervisorNodeId !== m[2] && db.list('runs').some(r => r.projectId === m[1] && !terminal.has(r.status))) throw new Error(tr('home.supervisorDeviceCanOnlyBe'));
        if (!db.get('workspaces',`${m[1]}:${m[2]}`)) await projectsAdmin.prepare(m[1],m[2]);
        if (b.enabled && !runtimeReportFresh(db.get('workers', m[2]), b.runtime)) {
          if (!online(m[2])) throw new Error(tr('home.supervisorDeviceOfflineConnectIt'));
          await workerQuery({ nodeId: m[2] }, 'runtimes', null, 25000);
        }
        const r = coordinator.saveSupervisor(m[1], m[2], b); change(); return json(res, r);
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/coordination-settings$/)) && req.method === 'POST') {
        const r = coordinator.configureProject(m[1], await body(req)); change(); return json(res, r);
      }
      if ((m = pathname.match(/^\/api\/workers\/([^/]+)\/runtimes$/)) && req.method === 'POST') {
        if (!db.get('workers', m[1])?.capabilities?.runtimeDiscovery) throw new Error(tr('home.upgradeWorkerOnDevice'));
        const result = await workerQuery({ nodeId: m[1] }, 'runtimes', null, 25000);
        change(); return json(res, result);
      }
      if ((m = pathname.match(/^\/api\/workers\/([^/]+)\/directories$/)) && req.method === 'POST') {
        if (db.get('workers', m[1])?.capabilities?.directoryCreate !== 1) throw new Error(tr('folders.upgradeCreateFolder'));
        const input = await body(req);
        return json(res, await workerQuery({ nodeId: m[1] }, 'directory_create', { path: input.path, name: input.name }), 201);
      }
      if ((m = pathname.match(/^\/api\/workers\/([^/]+)\/directories$/)) && req.method === 'GET') {
        if (!db.get('workers', m[1])?.capabilities?.projectBrowser) throw new Error(tr('home.upgradeNodeUseDirectorySelection'));
        return json(res, await workerQuery({ nodeId: m[1] }, 'directories', { path: url.searchParams.get('path'), offset: Number(url.searchParams.get('offset') || 0) }));
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/workspaces\/([^/]+)\/open$/)) && req.method === 'POST') {
        const project=db.get('projects',m[1]),worker=db.get('workers',m[2]),binding=db.get('workspaces',`${m[1]}:${m[2]}`);
        if(!project||!binding?.localRoot)throw new Error(tr('folders.projectBindingRequired'));
        if(!worker||resolveNodeKind(worker.nodeKind,worker.platform)!=='local')throw new Error(tr('folders.localDeviceRequired'));
        if(worker.capabilities?.openProjectFolder!==1)throw new Error(tr('folders.upgradeLocalWorker'));
        return json(res,await workerQuery({nodeId:worker.id,projectId:project.id},'open_project_folder',binding.localRoot,15000));
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)$/)) && req.method === 'POST') {
        const r = db.updateProject(m[1], await body(req)); change(); return json(res, r);
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)$/)) && req.method === 'DELETE') {
        const grants=db.list('folderGrants').filter(g=>g.scope===`project:${m[1]}`);
        const r = db.deleteProject(m[1]);for(const grant of grants)await cancelFolderBinding(grant);change(); return json(res, r);
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/git-check$/)) && req.method === 'POST') {
        const p = db.get('projects', m[1]), b = await body(req);
        if (!p?.repoUrl) throw new Error(tr('home.saveGiteeRepositoryUrlFirst'));
        const binding = db.get('workspaces', `${p.id}:${b.nodeId}`);
        if (!binding || !db.get('workers', b.nodeId)?.capabilities?.projectBrowser) throw new Error(tr('home.selectNodeHasBoundDirectory'));
        const result = await workerQuery({ nodeId: b.nodeId,projectId:p.id }, 'git_check', { repoUrl: p.repoUrl, localRoot: binding.localRoot }, 15000);
        if (db.get('projects', p.id).repoUrl !== p.repoUrl || db.get('workspaces', binding.id)?.localRoot !== binding.localRoot) throw new Error(tr('home.configurationChangedDuringCheckCheck'));
        db.put('gitChecks', { ...result, id: `${p.id}:${b.nodeId}`, projectId: p.id, nodeId: b.nodeId }); change(); return json(res, result);
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/git-versions$/)) && req.method === 'POST') {
        return json(res,await projectGitVersions.refresh(m[1]));
      }
      if((m=pathname.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/cli-recovery$/))&&req.method==='POST'){
        return json(res,await cliRecovery.confirm(m[1],m[2],await body(req)));
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/roles\/([^/]+)\/archive$/)) && req.method === 'POST') {
        const r = rooms.archiveRole(m[1], m[2]); change(); return json(res, r);
      }
      if((m=pathname.match(/^\/api\/projects\/([^/]+)\/roles\/([^/]+)\/cli-switch\/preview$/))&&req.method==='POST') {
        const preview=roleSwitches.preview(m[1],m[2],await body(req));
        return json(res,{supported:true,from:preview.role.runtime,to:preview.candidate.runtime});
      }
      if((m=pathname.match(/^\/api\/projects\/([^/]+)\/roles\/([^/]+)\/cli-switches(?:\/([^/]+)(?:\/(renew|cancel))?)?$/))) {
        if(!m[3]&&req.method==='POST') {const op=roleSwitches.begin(m[1],m[2],await body(req));change();return json(res,roleSwitchView(op));}
        if(m[3]) {
          let op=roleSwitches.get(m[1],m[2],m[3]);
          if(req.method==='POST'&&m[4]==='renew')op=roleSwitches.renew(op.id,(await body(req)).leaseId);
          else if(req.method==='POST'&&m[4]==='cancel')op=roleSwitches.cancel(op.id,'operator');
          else if(req.method!=='GET'||m[4])throw new Error('Unsupported CLI switch action.');
          if(req.method==='POST')change();return json(res,roleSwitchView(op));
        }
      }
      if((m=pathname.match(/^\/api\/projects\/([^/]+)\/roles\/([^/]+)\/history\/clear$/))&&req.method==='POST') {
        const input=await body(req),result=new RoleSessions(db).clearHistory(m[1],m[2],input.sessionId||null,input);
        change();return json(res,result);
      }
      if((m=pathname.match(/^\/api\/projects\/([^/]+)\/roles\/([^/]+)\/session\/reset$/))&&req.method==='POST') {
        const input=await body(req),conversationId=resolveConversationId(db,m[1],input.conversationId);
        const role=db.get('roles',m[2]);if(role?.projectId!==m[1])throw new Error(tr('home.roleDoesNotBelongProject'));
        if(db.list('tasks').some(task=>task.projectId===m[1]&&conversationIdOf(task)===conversationId&&task.roleId===m[2]&&['ready','in_progress'].includes(task.status)))throw new Error(tr('home.roleStillHasUnfinishedAssignments'));
        if(db.list('coordinationRequests').some(request=>request.projectId===m[1]&&conversationIdOf(request)===conversationId&&request.targetRoleId===m[2]&&!['succeeded','failed','cancelled'].includes(request.status)))throw new Error(tr('home.roleStillHasUnfinishedCollaboration'));
        const session=new RoleSessions(db).currentForGroup(m[1],m[2],input);
        if(!session)throw new Error(tr('home.roleHasNoCurrentSession'));
        if(projectTerminalLock(db,m[1],role.nodeId))throw new Error(tr('home.deviceStillUnderManualTakeover'));
        const archived=new RoleSessions(db).archive(session.id);change();return json(res,archived);
      }
      if((m=pathname.match(/^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/read$/))&&req.method==='GET') {
        if(!db.get('projects',m[1]))throw new Error(tr('home.projectNotFound'));
        return json(res,sessionTools.read({projectId:m[1],conversationId:resolveConversationId(db,m[1],url.searchParams.get('conversationId')??undefined)},m[2],{
          offset:Number(url.searchParams.get('offset')||0),limit:Number(url.searchParams.get('limit')||4000),version:url.searchParams.get('version')}));
      }
      if((m=pathname.match(/^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/summary$/))&&req.method==='GET') {
        if(!db.get('projects',m[1]))throw new Error(tr('home.projectNotFound2'));
        return json(res,sessionTools.summary({projectId:m[1],conversationId:resolveConversationId(db,m[1],url.searchParams.get('conversationId')??undefined)},m[2]));
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/roles\/([^/]+)\/definition$/)) && req.method === 'PATCH') {
        const r = rooms.updateRoleDefinition(m[1], m[2], await body(req)); change(); return json(res, r);
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/roles$/)) && req.method === 'POST') {
        const b = await body(req);
        if (!(b.id && b.enabled === false)) {
          if (!online(b.nodeId)) throw new Error(tr('home.selectedDeviceOfflineChooseOnline'));
          if (!db.get('workers', b.nodeId)?.capabilities?.runtimeDiscovery) throw new Error(tr('home.upgradeWorkerOnDevice2'));
          const binding = roleWorkspace(db, m[1], b.nodeId, b.repositoryId); if (!binding) throw new Error(tr('home.configureRepositoryDirectoryForSelected'));
          if (!runtimeReportFresh(db.get('workers', b.nodeId), b.runtime)) await workerQuery({ nodeId: b.nodeId }, 'runtimes', null, 25000);
          await workerQuery({ nodeId: b.nodeId,projectId:m[1] }, 'workspace_check', binding.localRoot);
          if (roleWorkspace(db, m[1], b.nodeId, b.repositoryId)?.localRoot !== binding.localRoot) throw new Error(tr('home.projectDirectoryHasChangedSave'));
          if (!online(b.nodeId)) throw new Error(tr('home.deviceHasGoneOfflineTry'));
        }
        const r = rooms.saveRole(m[1], b); scheduleChat(); change(); return json(res, r);
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/messages$/))) {
        // ?id= is a read-only receipt for one composer send (same route, authentication and project scope as the list).
        if (req.method === 'GET' && url.searchParams.has('id')) return json(res, rooms.messageReceipt(m[1], url.searchParams.get('id'), url.searchParams.get('conversationId') ?? undefined));
        if (req.method === 'GET') return await sendBufferedResponse(req,res,Buffer.from(JSON.stringify(rooms.messages(m[1],url.searchParams.get('before'),url.searchParams.get('conversationId')??undefined,url.searchParams.get('afterReceipt')))),{ 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
        if (req.method === 'POST') {
          const input = await body(req);
          const r = db.transaction(() => { const message = rooms.post(m[1], input); wechat.webReply(message); return message; });
          scheduleChat(); change(); return json(res, r, 201);
        }
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/steer$/)) && req.method === 'POST') {
        const input=await body(req),result=steering.request(m[1],m[2],input.commandId,input);
        // A non-destructive yield stops nothing; only a replacing steer has runs to wait for.
        for(const id of result.waitForRunIds||[])dispatch(db.get('runs',id).nodeId);
        scheduleChat();change();return json(res,result);
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/queue\/pause$/)) && req.method === 'POST') {
        const r = rooms.setQueuePaused(m[1], await body(req)); scheduleChat(); change(); return json(res, r);
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/queue\/order$/)) && req.method === 'POST') {
        const r = rooms.reorderQueue(m[1], await body(req)); scheduleChat(); change(); return json(res, r);
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/edit-queued$/)) && req.method === 'POST') {
        const input=await body(req),result=db.transaction(()=>{const recalled=rooms.editQueuedMessage(m[1],m[2],input);for(const id of recalled.requestIds)calls.cancel(id);return recalled;});
        change();return json(res,result);
      }
      if ((m = pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/)) && req.method === 'POST') {
        const r = rooms.cancel(m[1]); if (r.requestId) calls.cancel(r.requestId); change(); return json(res, r);
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/workspaces\/([^/]+)$/)) && req.method === 'POST') {
        if (!db.get('projects', m[1])) throw new Error(tr('home.projectNotFound3'));
        projectsAdmin.check(m[1]);
        if (!db.get('workers', m[2])?.capabilities?.workspaceBindings) throw new Error(tr('home.upgradeWorkerBeforeConfiguringWorkspace'));
        const b = await body(req);
        const oldGrant=db.get('folderGrants',`${m[2]}:project:${m[1]}`),worker=db.get('workers',m[2]);
        return await withFolderPreparation(worker.capabilities?.localFolderSelection===1?{nodeId:m[2],scope:`project:${m[1]}`,path:b.localRoot,operationId:b.requestId||randomUUID()}:null,async grant=>{
        const checked = grant?{localRoot:grant.root,git:null}:await workerQuery({ nodeId: m[2],projectId:m[1] }, 'workspace_check', b.localRoot);
        const r = db.transaction(()=>{projectsAdmin.check(m[1]);const binding=db.bindWorkspace(m[1],m[2],checked);activateFolderBinding(grant);return binding;});
        if(oldGrant?.grant?.id!==grant?.id)await cancelFolderBinding(oldGrant);change(); return json(res, r);
        });
      }
      if ((m = pathname.match(/^\/api\/tasks\/([^/]+)\/accept$/)) && req.method === 'POST') {
        const r = db.acceptTask(m[1], (await body(req)).runId); change(); return json(res, r);
      }
      if ((m = pathname.match(/^\/api\/tasks\/([^/]+)\/start$/)) && req.method === 'POST') {
        const b = await body(req);
        if (db.get('tasks', m[1])?.origin === 'chat') throw new Error(tr('home.groupChatExecutionsScheduledAutomatically'));
        if (!db.get('commands', b.commandId || '') && !online(b.nodeId)) throw new Error(tr('home.selectOnlineWorker'));
        const r = db.startTask(m[1], b); dispatch(r.nodeId); change(); return json(res, r);
      }
      if ((m = pathname.match(/^\/api\/runs\/([^/]+)\/stop$/)) && req.method === 'POST') {
        const b = await body(req), run = db.get('runs', m[1]);
        if (!run || typeof b.commandId !== 'string' || !b.commandId) throw new Error(tr('home.executionNotFoundInvalidCommand'));
        if(b.conversationId!==undefined)assertConversationRecord({projectId:run.projectId,conversationId:resolveConversationId(db,run.projectId,b.conversationId)},run);
        if(b.roleSessionId&&b.roleSessionId!==run.roleSessionId)throw new Error(tr('conversations.recordMismatch'));
        const stopped=calls.stopRun(run.id,b.commandId);
        for(const id of stopped.stopRunIds){const target=db.get('runs',id);if(target)dispatch(target.nodeId);}
        change();return json(res,stopped.run);
      }
      if((m=pathname.match(/^\/api\/projects\/([^/]+)\/terminals\/refresh$/))&&req.method==='POST')return json(res,await refreshProjectTerminals(m[1]));
      if((m=pathname.match(/^\/api\/projects\/([^/]+)\/roles\/([^/]+)\/terminal$/)) && req.method==='POST') {
        const [_,projectId,roleId]=m,b=await body(req);
        const conversationId=resolveConversationId(db,projectId,b.conversationId);
        if(b.roleSessionId)new RoleSessions(db).currentForGroup(projectId,roleId,b);
        if(['release','stop'].includes(b.action)) {
          const claim=db.get('terminalSessions',b.id);
          assertConversationRecord({projectId,conversationId},claim);
          if(claim?.kind!=='new'||claim.projectId!==projectId||claim.roleId!==roleId)throw new Error(tr('home.thereNoTerminalTakeoverFor'));
          return json(res,await returnTerminal(claim,b.action));
        }
        if(b.action!=='prepare'||typeof b.operationId!=='string'||!/^[a-zA-Z0-9-]{8,100}$/.test(b.operationId))throw new Error(tr('home.invalidTakeoverAction'));
        const repeated=db.get('terminalSessions',b.operationId);
        if(repeated) {
          assertConversationRecord({projectId,conversationId},repeated);
          if(repeated.kind!=='new'||repeated.projectId!==projectId||repeated.roleId!==roleId)throw new Error(tr('home.invalidTakeoverAction'));
          if(repeated.status==='prepared')return json(res,terminalLaunchView(repeated));
          throw new Error(tr('roleTerminal.pending'));
        }
        const {role,worker,workspace}=newTerminalBinding(db,projectId,roleId,id=>online(id)&&sockets.get(id).workerReady),device=db.list('devices').find(d=>d.nodeId===role.nodeId);
        if(worker.nodeKind==='cloud'&&!device)throw new Error(tr('home.cloudDeviceMissingSshRegistration'));
        // A scoped role needs a Worker that applies the scope to terminals too; an older Worker would silently use legacy flags.
        if(role.permissionScope&&worker.capabilities?.permissionContract!==1)throw new Error(tr('rolePermissions.worker_unsupported',{scope:role.permissionScope}));
        const claim={id:b.operationId,kind:'new',projectId,conversationId,roleId,nodeId:role.nodeId,runtime:role.runtime,model:role.model,status:'preparing',createdAt:new Date().toISOString()};
        db.put('terminalSessions',claim);change();
        try {
          const settings=normalizePlatformSettings(db.get('settings','main'));
          const info=await workerQuery(claim,'terminal_new',{id:claim.id,projectId,roleId,nodeId:role.nodeId,workspace,
            roleSettings:{runtime:role.runtime,model:role.model,effort:role.effort||null,name:role.name,instructions:role.instructions||'',...(role.permissionScope?{permissionScope:role.permissionScope}:{})},
            platformPrompt:settings.platformPrompt,supervisorPrompt:role.systemSupervisor&&!role.platformAssistant?settings.supervisorPrompt:''},30000);
          const identityFile=b.useLocalSshKey===true&&process.platform==='darwin'&&device?(await credentials.get(device.id))?.keyPath:null;
          const command=terminalCommand(info,device||null,identityFile),value=terminalLaunchView({...claim,...info,status:'prepared',command});
          publishNewTerminal(db,claim,value);change();return json(res,value);
        }catch(error){
          const current=db.get('terminalSessions',claim.id);
          if(['released','cancelled'].includes(current?.status))throw error;
          let status='blocked';try{await workerQuery(claim,'terminal_release',{id:claim.id});status='released';}catch{}
          const after=db.get('terminalSessions',claim.id);
          if(!['released','cancelled'].includes(after?.status))db.put('terminalSessions',{...claim,status,error:error.message});change();throw error;
        }
      }
      if ((m = pathname.match(/^\/api\/runs\/([^/]+)\/terminal$/)) && req.method === 'POST') {
        const b=await body(req), r=db.get('runs',m[1]);
        if(!r)throw new Error(tr('home.runNotFound'));
        if(b.conversationId!==undefined)assertConversationRecord({projectId:r.projectId,conversationId:resolveConversationId(db,r.projectId,b.conversationId)},r);
        if(b.roleSessionId&&b.roleSessionId!==r.roleSessionId)throw new Error(tr('conversations.recordMismatch'));
        const existing=['release','stop'].includes(b.action)&&b.id?db.get('terminalSessions',b.id):projectTerminalLock(db,r.projectId,r.nodeId);
        if(['release','stop'].includes(b.action)) {
          if(!existing || existing.runId!==r.id||existing.projectId!==r.projectId||existing.nodeId!==r.nodeId)throw new Error(tr('home.thereNoTerminalTakeoverFor'));
          return json(res,await returnTerminal(existing,b.action));
        }
        if(b.action!=='prepare')throw new Error(tr('home.invalidTakeoverAction'));
        if(r.historyClearedAt)throw new Error(tr('roleSessions.historyWasCleared'));
        if(existing) {
          if(existing.runId===r.id && existing.status==='prepared')return json(res,terminalLaunchView(existing));
          throw new Error(tr('home.projectOnDeviceAlreadyUnder'));
        }
        if(db.get('settings','main')?.paused)throw new Error(tr('home.remoteExecutionPaused4'));
        if(!terminal.has(r.status) || db.list('runs').some(other=>other.projectId===r.projectId&&other.nodeId===r.nodeId&&!terminal.has(other.status)))throw new Error(tr('home.projectStillExecutingOnDevice'));
        const worker=db.get('workers',r.nodeId);
        if(worker?.capabilities?.terminalResume!==1)throw new Error(tr('home.upgradeWorkerOnDeviceFirst'));
        const device=db.list('devices').find(d=>d.nodeId===r.nodeId);
        if(worker.nodeKind==='cloud' && !device)throw new Error(tr('home.cloudDeviceMissingSshRegistration'));
        const claim={id:randomUUID(),projectId:r.projectId,conversationId:conversationIdOf(r),nodeId:r.nodeId,runId:r.id,status:'preparing',createdAt:new Date().toISOString()};
        db.put('terminalSessions',claim);change();
        try {
          const info=await workerQuery(r,'terminal_prepare',{id:claim.id},30000);
          // The registered key path is reused only when accessed from the same Mac; when accessed from another computer, that computer's own SSH configuration is responsible.
          const identityFile=b.useLocalSshKey===true && process.platform==='darwin' && device ? (await credentials.get(device.id))?.keyPath : null;
          const command=terminalCommand(info,device || null,identityFile);
          const value=terminalLaunchView({...claim,...info,status:'prepared',command});
          db.transaction(()=>{if(db.get('terminalSessions',claim.id)?.status!=='preparing')throw new Error(tr('roleTerminal.pending'));db.put('terminalSessions',value);});change();return json(res,value);
        } catch(error) {
          if(['released','cancelled'].includes(db.get('terminalSessions',claim.id)?.status))throw error;
          let status='blocked';
          try { await workerQuery(r,'terminal_release',{id:claim.id});status='released'; } catch {}
          const current=db.get('terminalSessions',claim.id);
          if(!['released','cancelled'].includes(current?.status))db.put('terminalSessions',{...current,...claim,status,error:error.message});change();throw error;
        }
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/artifacts$/)) && req.method === 'GET') {
        return json(res,await recentProjectArtifacts(db,m[1],workerQuery,online,projectFiles));
      }
      if((m=pathname.match(/^\/api\/projects\/([^/]+)\/(local-files|local-file)$/))&&req.method==='GET'){
        return json(res,m[2]==='local-files'?await projectFiles.list(m[1]):await projectFiles.read(m[1],url.searchParams.get('scopeId'),url.searchParams.get('path'),{metadata:url.searchParams.get('metadata')==='1'}));
      }
      if ((m = pathname.match(/^\/api\/runs\/([^/]+)\/media$/)) && req.method === 'GET') {
        const r = db.get('runs', m[1]); if (!r) throw new Error(tr('home.runNotFound2'));
        return json(res, await mediaStreams.describe(mediaStreams.sourceForRun(r, url.searchParams.get('path'))));
      }
      if ((m = pathname.match(/^\/api\/runs\/([^/]+)\/(detail|events|files|file|document)$/)) && req.method === 'GET') {
        const r = db.get('runs', m[1]); if (!r) throw new Error(tr('home.runNotFound2'));
        if(m[2]==='detail')return json(res,{run:r,task:db.get('tasks',r.taskId)});
        if (m[2] === 'events') {
          const after=Number(url.searchParams.get('after')||0);
          if(!Number.isSafeInteger(after)||after<0)throw new Error(tr('home.invalidEventCursor'));
          const limit=url.searchParams.has('limit')?Number(url.searchParams.get('limit')):null;
          if(limit!==null&&(!Number.isSafeInteger(limit)||limit<1||limit>1000))throw new Error(tr('home.invalidEventCursor'));
          const events=db.events(r.id,after,limit===null?-1:limit+1);
          return json(res, { events:limit===null?events:events.slice(0,limit),...(limit===null?{}:{hasMore:events.length>limit,runState:{status:r.status,lastSeq:r.lastSeq,finishedAt:r.finishedAt}}) });
        }
        if(['file','document'].includes(m[2])){const ref=projectFiles.reference(r,url.searchParams.get('path'));if(ref&&!projectFiles.legacyReadable(r))return json(res,await projectFiles.read(r.projectId,ref.scopeId,ref.path,{metadata:url.searchParams.get('metadata')==='1'}));}
        const result = await workerQuery(r, m[2], url.searchParams.get('path'),m[2]==='document'?30000:10000);
        return json(res, result);
      }
      if ((m = pathname.match(/^\/api\/approvals\/([^/]+)$/)) && req.method === 'POST') {
        const b = await body(req);
        return json(res, respondApproval(m[1], b.decision, b.commandId));
      }
      if (pathname === '/api/language' && req.method === 'GET') return json(res, { language: getLanguage() });
      if (pathname === '/api/language' && req.method === 'PUT') {
        const b = await body(req);
        const language = setLanguage(b?.language);
        syncSupervisorInstructions();
        // Workers learn the new language immediately; viewers refresh via the change event.
        for (const ws of sockets.values()) send(ws, { type: 'language', language });
        change(); return json(res, { language });
      }
      if (pathname === '/api/settings' && req.method === 'POST') {
        const b = await body(req);
        const settings = db.put('settings', updatePausedSetting(db.get('settings', 'main'), b.paused));
        for (const ws of sockets.values()) send(ws, { type: 'settings', ...settings, retention:retentionPolicy() });
        change(); return json(res, settings);
      }
      // Data page: what Home and each device hold, what the retention policy lets go, and a cleanup on demand.
      if (pathname === '/api/settings/retention' && req.method === 'POST') {
        const b = await body(req), retention = normalizeRetention(b);
        db.put('settings', { ...(db.get('settings', 'main') || {}), id: 'main', retention });
        for (const ws of sockets.values()) send(ws, { type: 'settings', ...db.get('settings', 'main'), retention });
        change(); return json(res, { retention });
      }
      if (pathname === '/api/data/stats' && req.method === 'GET') {
        const home = { ...await dataStats(db, { policy: retentionPolicy() }), mediaCache: await mediaCache.stats().catch(() => null) };
        const devices = await Promise.all(db.list('workers').filter(w => !db.get('removedDevices', w.id)).map(async w => {
          if (!online(w.id)) return { nodeId: w.id, name: w.name, online: false };
          if (w.capabilities?.dataRetention !== 1) return { nodeId: w.id, name: w.name, online: true, upgrade: true };
          try { return { nodeId: w.id, name: w.name, online: true, stats: await workerQuery({ nodeId: w.id }, 'data_stats', { policy: retentionPolicy() }, 20000) }; }
          catch (e) { return { nodeId: w.id, name: w.name, online: true, error: e.message }; }
        }));
        return json(res, { home, devices, retention: retentionPolicy() });
      }
      if (pathname === '/api/data/cleanup' && req.method === 'POST') {
        const b = await body(req), target = typeof b.target === 'string' ? b.target : 'all', results = {};
        if (target === 'home' || target === 'all') results.home = await runHomeMaintenance();
        for (const w of db.list('workers')) {
          if (target !== 'all' && target !== w.id) continue;
          if (!online(w.id) || w.capabilities?.dataRetention !== 1) { if (target === w.id) throw new Error(online(w.id) ? 'Upgrade this Worker to clean its data' : tr('home.executionNodeOfflineUnableRead')); continue; }
          try { results[w.id] = await workerQuery({ nodeId: w.id }, 'data_cleanup', { policy: retentionPolicy() }, 120000); } catch (e) { results[w.id] = { error: e.message }; }
        }
        change(); return json(res, results);
      }
      if (pathname === '/api/settings/role-templates' && req.method === 'POST') {
        const template = saveRoleTemplate(db, await body(req)); change(); return json(res, template);
      }
      if ((m = pathname.match(/^\/api\/settings\/role-templates\/([^/]+)\/restore$/)) && req.method === 'POST') {
        const input = await body(req);
        const template = restoreRoleTemplate(db, decodeURIComponent(m[1]), input.revision); change(); return json(res, template);
      }
      if (pathname === '/api/settings/prompts' && req.method === 'POST') {
        const settings = db.put('settings', updatePlatformPrompts(db.get('settings', 'main'), await body(req)));
        change(); return json(res, settings);
      }
      if(pathname==='/api/settings/conversation-organizer' && req.method==='POST') {
        const input=await body(req);
        if(input.nodeId) {
          const worker=db.get('workers',input.nodeId);
          if(!worker || !online(input.nodeId))throw new Error(tr('home.organizerDeviceNotOnline'));
          const issue=runtimeIssue(worker,input.runtime,input.model);
          if(issue)throw new Error(issue);
        }
        const settings=db.put('settings',updateConversationOrganizer(db.get('settings','main'),input));
        change();return json(res,settings.conversationOrganizer);
      }
      return json(res, { error: tr('home.endpointNotFound') }, 404);
    }
    if (req.method !== 'GET') return json(res, { error: tr('home.unsupportedRequest') }, 405);
    const files = { '/': 'index.html', '/platform-admin.js':'platform-admin.js', '/project-space.js':'project-space.js', '/token-usage.js':'token-usage.js', '/app-icon.png': 'app-icon.png', '/agent-codex.png':'agent-codex.png', '/agent-antigravity.png':'agent-antigravity.png', '/app.js': 'app.js', '/run-log-data.js':'run-log-data.js', '/room.js': 'room.js', '/markdown.js':'markdown.js', '/project-settings.js': 'project-settings.js', '/role-icons.js': 'role-icons.js', '/settings-page.js': 'settings-page.js', '/supervisor-settings.js':'supervisor-settings.js', '/elapsed.js':'elapsed.js', '/send-state.js':'send-state.js', '/permission-scope.js':'permission-scope.js', '/project-setup.js':'project-setup.js', '/styles.css':'styles.css' };
    Object.assign(files,{'/history-view.js':'history-view.js','/scheduled-jobs.js':'scheduled-jobs.js','/git-version.js':'git-version.js','/plan-dock.js':'plan-dock.js','/document.html':'document.html','/document.js':'document.js','/manifest.webmanifest':'manifest.webmanifest','/sw.js':'sw.js','/app-icon-192.png':'app-icon-192.png'});
    files['/workspace-inspector.js']='workspace-inspector.js';
    files['/source-sync.js']='source-sync.js';
    files['/quota-state.js']='quota-state.js';
    files['/chat-card-state.js']='chat-card-state.js';
    files['/state-data.js']='state-data.js';
    files['/group-conversations.js']='group-conversations.js';
    files['/project-team-copy.js']='project-team-copy.js';
    files['/execution-progress.js']='execution-progress.js';
    files['/live-scene.js']='live-scene.js';
    files['/cli-recovery.js']='cli-recovery.js';
    files['/session-queue.js']='session-queue.js';
    files['/browser-token.js']='browser-token.js';
    files['/configuration-information.js']='configuration-information.js';
    files['/role-switch.js']='role-switch.js';
    files['/role-history.js']='role-history.js';
    files['/role-templates.js']='role-templates.js';
    files['/i18n.js']='i18n.js';
    files['/output-language.js']='output-language.js';
    files['/native-sessions.js']='native-sessions.js';
    files['/native-agent-switch.js']='native-agent-switch.js';
    files['/native-transcript.js']='native-transcript.js';
    files['/media.js']='media.js';
    files['/pasted-text.js']='pasted-text.js';
    files['/side-preview.js']='side-preview.js';
    files['/history-prompt.js']='history-prompt.js';
    files['/history-cache.js']='history-cache.js';
    files['/data-settings.js']='data-settings.js';
    files['/remote-access-settings.js']='remote-access-settings.js';
    files['/native-history-timeline.js']='native-history-timeline.js';
    files['/native-session-groups.js']='native-session-groups.js';
    files['/create-folder.js']='create-folder.js';
    files['/list-order.js']='list-order.js';files['/select-controls.js']='select-controls.js';files['/model-usage.js']='model-usage.js';
    files['/mention-input.js']='mention-input.js';
    files['/context-usage.js']='context-usage.js';
    files['/vendor/opencc-t2cn.js']='vendor/opencc-t2cn.js';
    files['/locales/zh.js']='locales/zh.js';
    files['/locales/native-takeover-zh.js']='locales/native-takeover-zh.js';
    const file = files[pathname]; if (!file) return json(res, { error: tr('home.pageNotFound') }, 404);
    const bytes = await readFile(join(base, 'public', file));
    await sendBufferedResponse(req,res,bytes,{ 'Content-Type': { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json; charset=utf-8' }[extname(file)], 'Cache-Control': 'no-cache' });
  } catch (e) { if (!res.headersSent) json(res, { error: e.message,...(e.folderPreparationReleased===true?{folderPreparationReleased:true}:{}),...(e.code?{code:e.code}:{}),...(e.limit?{limit:e.limit}:{}) }, 400); else res.end(); }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/worker' || !matches(req.headers.authorization || '', `Bearer ${workerToken}`)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
});
wss.on('connection', ws => {
  let nodeId;
  // Receiver errors (including oversized frames) close this socket, never the Home process or other Workers.
  ws.on('error',error=>console.error('Worker WebSocket rejected',JSON.stringify({nodeId:nodeId||null,code:error.code||'socket_error'})));
  const registerTimer = setTimeout(() => { if (!nodeId) ws.close(); }, 10000);
  // Any frame proves the connection; a Worker whose pong queues behind a large reply on a slow tunnel is not dead.
  ws.alive = true; ws.missed = 0; ws.on('pong', () => { ws.alive = true; });
  ws.on('message', data => {
    ws.alive = true;
    try {
      const m = JSON.parse(data);
      if (m.type === 'register') {
        if (nodeId || typeof m.node?.id !== 'string') throw new Error(tr('home.invalidNodeRegistration'));
        nodeId = m.node.id;
        if (db.get('removedDevices',nodeId)) { ws.close(1008, 'Device registration was deleted'); nodeId = null; return; }
        if (sockets.get(nodeId)?.readyState===1) { ws.close(1008, tr('home.workerAlreadyConnected')); nodeId = null; return; }
        sockets.set(nodeId, ws); clearTimeout(registerTimer);
        const config=db.get('workerConfigs',nodeId),limits=registrationCapacity(m.node,config);
        // A restarted Worker reports a fresh probe; the saved quota of the same account survives it.
        db.put('workers', { ...m.node, ...config,...limits,id:nodeId,runtimes:mergeReportedRuntimes(db.get('workers',nodeId)?.runtimes,m.node.runtimes), lastSeen: new Date().toISOString() });
        // Turns the Worker kept running through the disconnect continue; the ones it no longer has ended while it was away.
        nativeTurns.reconnected(nodeId, Array.isArray(m.nativeTurns) ? m.nativeTurns.filter(id => typeof id === 'string').slice(0, 200) : []);
        send(ws, { type: 'registered', retention:retentionPolicy(), folderGrantIds:db.list('folderGrants').filter(g=>g.nodeId===m.node.id&&folderAccessFor(db,g.nodeId,g.scope)).map(g=>g.grant.id),paused: !!db.get('settings', 'main')?.paused, language: getLanguage(),cliRecovery:1,readTools:m.node.capabilities?.readSourceBindings===1?1:0,...(m.node.capabilities?.cliCapacity===1?{capacity:limits.desiredCapacity}:{}) }); change(); return;
      }
      if (!nodeId || sockets.get(nodeId) !== ws) throw new Error(tr('home.nodeNotRegisteredYet'));
      if(['source_sync_receipt','source_sync_command_ack','source_sync_watch_ack','source_sync_watch_status','source_sync_dirty'].includes(m.type)){
        void sourceSync.message(nodeId,m).catch(e=>send(ws,{type:'error',error:e.message}));return;
      }
      if (m.type === 'ready') { ws.workerReady = true; void reconcileTerminals(nodeId); dispatch(nodeId); scheduleChat(); collectUsage(nodeId); nativeTurns.switches.resume(nodeId); }
      if (m.type === 'queue_reservation') { if(queuePump.onReservation(nodeId,m)){change();dispatch(nodeId);} return; }
      if (m.type === 'heartbeat') {ws.lastHeartbeatAt=Date.now();db.put('workers', { ...db.get('workers', nodeId), lastSeen: new Date().toISOString() });}
      if(m.type==='launch_deferred') {
        const c=db.get('commands',m.id);
        if(c?.nodeId===nodeId&&c.type==='launch'&&c.runId===m.runId&&!c.acked)db.put('commands',{...c,capacityDeferred:true});
      }
      if(m.type==='capacity_state') {
        const appliedCapacity=validateCliCapacity(m.capacity),worker=db.get('workers',nodeId),desiredCapacity=db.get('workerConfigs',nodeId)?.capacity??appliedCapacity;
        const usage={};for(const key of ['active','retained','organizer','terminal'])usage[key]=Math.max(0,Math.min(128,Number(m.usage?.[key])||0));
        db.put('workers',{...worker,appliedCapacity,desiredCapacity,capacity:Math.min(desiredCapacity,appliedCapacity),cliUsage:usage});
        if(usage.active+usage.organizer+usage.terminal<Math.min(desiredCapacity,appliedCapacity))for(const c of db.list('commands').filter(c=>c.nodeId===nodeId&&!c.acked&&c.capacityDeferred))db.put('commands',{...c,lastSentAt:null});
        dispatch(nodeId);scheduleChat();change();
      }
      if(m.type==='role_session_compacted'){if(recordRoleCompaction(db,nodeId,m))change();}
      if(m.type==='warm_sessions') {
        db.put('workers',{...db.get('workers',nodeId),warmSessions:Array.isArray(m.sessions)?m.sessions.slice(0,64):[]});change();
      }
      if(m.type==='organizer_busy') {
        db.put('workers',{...db.get('workers',nodeId),organizerBusy:Math.max(0,Math.min(10,Number(m.count)||0))});
        scheduleChat();change();
      }
      if (m.type === 'runtime_report') {
        const runtimes = mergeReportedRuntimes(db.get('workers', nodeId)?.runtimes, m.runtimes);
        const worker=db.get('workers',nodeId);
        const discussion=m.discussionCapabilities;
        const next={ ...worker, runtimes,...(discussion?{capabilities:{...worker.capabilities,
          discussionProtocol:discussion.discussionProtocol===2?2:0,
          discussionRuntimes:Array.isArray(discussion.discussionRuntimes)?discussion.discussionRuntimes:[],
          discussionConfigurations:Array.isArray(discussion.discussionConfigurations)?discussion.discussionConfigurations:[]}}:{}) };
        // A repeated identical report (a quota resend, a reconnect) does not push a state refresh to every open page.
        if(JSON.stringify(next.runtimes)!==JSON.stringify(worker?.runtimes)||JSON.stringify(next.capabilities)!==JSON.stringify(worker?.capabilities)){db.put('workers',next);change();}
      }
      if(m.type==='execution_config') {
        try {
          if(db.get('runs',m.runId)?.nodeId!==nodeId)throw new Error(tr('home.runDoesNotBelongCurrent'));
          send(ws,{type:'execution_config',id:m.id,result:freezeExecutionConfiguration(db,m.runId)});change();
        } catch(error) {send(ws,{type:'execution_config',id:m.id,error:error.message});}
        return;
      }
      if (m.type === 'event') {
        if(!db.get('runs',m.event?.runId||'')&&db.get('deletedRuns',m.event?.runId||'')?.nodeId===nodeId) {
          send(ws,{type:'ack',id:m.event.id,disposition:'project_deleted'});return;
        }
        if (db.get('runs', m.event?.runId)?.nodeId !== nodeId) throw new Error(tr('home.runDoesNotBelongCurrent'));
        db.transaction(()=>{
          const current=db.event(m.event);
          roleSwitchRuntime.onRunSettled(current);
          if(m.event.type==='source_provenance')acceptSourceProvenance(db,current,m.event.payload);
          if (m.event.type === 'delivery') deliveries.accept(current.id, m.event.payload);
          if(!discussions.finishRun(current.id).handled)calls.finish(current.id);
          rooms.complete(current);
          // A role whose work has ended with a large context is marked for compaction in its retained process once it stays idle.
          if(m.event.type==='status')noteRoleCompaction(db,db.get('runs',current.id),{online});
        });
        send(ws, { type: 'ack', id: m.event.id });
        if(['message','tool','usage','context_usage'].includes(m.event.type))outputChanged();else change();
      }
      if (nativeTurns.message(nodeId,m)) return;
      if (m.type === 'command_ack') { const c = db.get('commands', m.id); if (c?.nodeId === nodeId&&!c.acked) {db.put('commands', { ...c, acked: true,ackedAt:new Date().toISOString() });change();} }
      if (m.type === 'reply') { const q = queries.get(m.id); if (q?.nodeId === nodeId) {
        queries.delete(m.id);
        if(m.error){const error=new Error(m.error);if(q.readProtocol&&typeof m.error==='string'&&/^[a-z_]{1,64}$/.test(m.error))error.code=m.error;q.reject(error);}
        else q.resolve(m.result);
      } }
    } catch (e) { send(ws, { type: 'error', error: e.message }); }
  });
  ws.on('close', () => {
    clearTimeout(registerTimer);
    if (nodeId && sockets.get(nodeId) === ws) {
      sockets.delete(nodeId);
      nativeTurns.disconnected(nodeId);
      for (const [id, q] of queries) if (q.nodeId === nodeId) { queries.delete(id); q.reject(new Error(tr('home.executionNodeDisconnectedTryAgain'))); }
      for (const r of db.list('runs').filter(r => r.nodeId === nodeId && !terminal.has(r.status))) db.put('runs', { ...r, status: r.status === 'stopping' ? 'stopping' : 'reconciling', updatedAt: new Date().toISOString() });
      change();
    }
  });
});
const heartbeat = setInterval(() => {
  let quotaChanged=false;
  for(const worker of db.list('workers')) {
    const runtimes=(worker.runtimes||[]).map(r=>expireRuntimeQuota(r));
    if(runtimes.some((r,i)=>r!==worker.runtimes[i])){db.put('workers',{...worker,runtimes});quotaChanged=true;}
  }
  if(quotaChanged)change();
  // Three silent intervals (45 s) end a connection, not one: on a 170 ms, lossy tunnel one pong is easily late.
  for (const ws of wss.clients) { if (!ws.alive && ++ws.missed >= 3) { ws.terminate(); continue; } if (ws.alive) ws.missed = 0; ws.alive = false; ws.ping(); }
  for (const r of viewers) r.write(': keepalive\n\n');
}, 15000);
const chatScheduler = setInterval(scheduleChat, 1000);
/** Data retention on Home: a pass a minute after start and daily; VACUUM only while nothing runs (see src/data-retention.mjs). */
function retentionPolicy() { return normalizeRetention(db.get('settings', 'main')?.retention || {}); }
const homeQuiet = () => db.activeRuns().length === 0 && queries.size === 0 && !db.listSourceSyncCommands({ pending: true }).length
  && !db.db.prepare("SELECT 1 FROM records WHERE kind='nativeTurns' AND json_extract(data,'$.status') IN ('queued','starting','running','waiting_user','stopping') LIMIT 1").get();
let homeVacuumRetry = null;
function homeVacuumWhenQuiet() { clearTimeout(homeVacuumRetry); homeVacuumRetry = null;
  if (!homeQuiet()) { homeVacuumRetry = setTimeout(homeVacuumWhenQuiet, 10 * 60000); homeVacuumRetry.unref(); return { vacuumed: false, deferred: true }; }
  try { const result = vacuumIfWasteful(db); if (result.vacuumed) console.log(`Data: VACUUM ${Math.round(result.before / 1048576)} MB -> ${Math.round(result.after / 1048576)} MB`); return result; } catch (e) { console.error('Data: VACUUM failed', e.message); return { vacuumed: false, error: e.message }; } }
async function runHomeMaintenance() {
  try { const summary = await cleanupData(db, { policy: retentionPolicy(), log: line => console.error('Data:', line) });
    const n = Object.values(summary.deleted).reduce((a, b) => a + b, 0); if (n) console.log(`Data: removed ${n} records (${Math.round(summary.bytes / 1048576)} MB)`);
    const media = await mediaCache.sweep().catch(e => ({ error: e.message })); if (media.deleted) console.log(`Data: media cache dropped ${media.deleted} files (${Math.round(media.freed / 1048576)} MB)`);
    return { ...summary, mediaCache: media, vacuum: homeVacuumWhenQuiet() }; }
  catch (e) { console.error('Data: cleanup failed', e.message); return { error: e.message }; }
}
const maintenanceFirst = setTimeout(() => void runHomeMaintenance(), 60000); maintenanceFirst.unref();
const maintenanceDaily = setInterval(() => void runHomeMaintenance(), 24 * 3600000); maintenanceDaily.unref();
const sessionQueueTimer=setInterval(()=>{try{queuePump.tick();void queuePump.reconcileVerifications().then(changed=>{if(changed)change();}).catch(e=>console.error(e.message));}catch(e){console.error(e.message);}},2000);sessionQueueTimer.unref();
const terminalMonitor=setInterval(()=>{void reconcileTerminals();},15000);terminalMonitor.unref();
const sourceSyncTimer=setInterval(()=>{void sourceSync.tick().catch(e=>console.error(e.message));},1000);sourceSyncTimer.unref();
const wechatPoll = setInterval(() => { void wechat.tick().catch(error => { console.error(tr('home.wechatChannelCheckFailed'), error.message); }); }, 4000);
wechatPoll.unref();
const progressMonitor=setInterval(()=>{if(inspectRunProgress(db,online))change();},60000);progressMonitor.unref();
const usageCollector = setInterval(() => { for(const nodeId of sockets.keys())collectUsage(nodeId); }, 6*60*60*1000);
server.listen(port, host, () => console.log(tr('home.agentWorkbenchHttpData', { host, port, data })));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { clearInterval(heartbeat); clearInterval(chatScheduler); clearInterval(terminalMonitor); clearInterval(usageCollector); usageRetry.stop(); for (const ws of wss.clients) ws.terminate(); for (const r of viewers) r.end(); server.close(() => { db.close(); process.exit(0); }); });
