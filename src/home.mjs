import http from 'node:http';
import { readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Store, terminal } from './store.mjs';
import { SessionTools } from './session-tools.mjs';
import { RoleSessions } from './role-sessions.mjs';
import { ConversationContext } from './conversation-context.mjs';
import { renderRunPrompt } from './run-context.mjs';
import { buildTeamContext, renderTeamContext } from './team-context.mjs';
import { Rooms } from './rooms.mjs';
import { defaultRoleTemplates, isSupervisorName } from './default-roles.mjs';
import { Coordinator } from './coordinator.mjs';
import { RoleCalls } from './role-calls.mjs';
import {RoleDiscussions} from './role-discussions.mjs';
import {supportsDiscussion} from './discussion-policy.mjs';
import {recentProjectArtifacts} from './run-artifacts.mjs';
import { RoleSteering } from './role-steering.mjs';
import { WorkspaceStateFeed } from './workspace-state.mjs';
import { messageProgress, reconcileCallResults } from './message-progress.mjs';
import { Deliveries } from './git-delivery.mjs';
import { visibleRuntimes, runtimeIssue } from './runtime-probe.mjs';
import { defaultPlatformPrompt, defaultSupervisorPrompt, normalizePlatformSettings, updatePlatformPrompts, updatePausedSetting, updateConversationOrganizer } from './platform-prompts.mjs';
import { runtimeReportFresh } from './runtime-state.mjs';
import { ProjectSetup, validateLocalSupervisor, setupRules } from './project-setup.mjs';
import { roleWorkspace } from './project-repositories.mjs';
import { folderName } from './project-space.mjs';
import { CredentialStore, Hosting } from './hosting.mjs';
import { ProjectAdmin } from './project-admin.mjs';
import { DeviceAdmin } from './device-admin.mjs';
import { PlatformAssistant } from './platform-assistant.mjs';
import { TokenUsage, createTokenUsageBackgroundCollector } from './token-usage.mjs';
import { Attachments, AttachmentTransfers } from './attachments.mjs';
import { ExecutionPlans, schedulingRules } from './execution-plans.mjs';
import { History } from './history.mjs';
import { saveRunReport } from './run-reports.mjs';
import { ScheduledJobs } from './scheduled-jobs.mjs';
import { TimerAgentActions } from './timer-agent.mjs';
import { inspectRunProgress } from './run-monitor.mjs';
import { projectTerminalLock, terminalCommand } from './terminal-resume.mjs';
import { ProjectGitVersions } from './project-git-versions.mjs';
import { WechatChannel, wechatTransport } from './wechat-channel.mjs';
import { tr, getLanguage, setLanguage, initLanguage } from './i18n.mjs';

const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = resolve(process.env.DATA_DIR || join(base, '.data/home'));
initLanguage(data); // load the saved language (data/language.json) before any text is produced
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4317);
const apiToken = process.env.API_TOKEN || '';
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
  if (role.mode !== 'workspace-write' || role.autoApprove !== true || role.repositoryId || (role.systemSupervisor && !role.platformAssistant && role.instructions !== setupRules())) db.put('roles', { ...role, repositoryId:null, mode: 'workspace-write', autoApprove: true, ...(role.systemSupervisor && !role.platformAssistant ? {instructions:setupRules()} : {}) });
}
/** The fixed project supervisors always carry the platform setup rules in the current language (also refreshed when the language changes). */
function syncSupervisorInstructions() {
  const rules = setupRules();
  for (const role of db.list('roles')) {
    if (role.systemSupervisor && !role.platformAssistant && role.instructions !== rules) db.put('roles', { ...role, instructions: rules });
  }
}
const rooms = new Rooms(db);
const attachments = new Attachments(db, join(data, 'attachments'));
rooms.attachments = attachments;
const attachmentTransfers=new AttachmentTransfers({db,attachments,query:workerQuery,online:id=>online(id),change:()=>change()});
const coordinator = new Coordinator(db);
const calls = new RoleCalls(db);
const discussions=new RoleDiscussions(db,{online:id=>online(id)});
const steering = new RoleSteering(db,calls);
const history = new History(db);
const sessionTools = new SessionTools(db);
const conversationContext = new ConversationContext(db);
conversationContext.recover();
for(const task of db.list('tasks').filter(task=>task.origin==='chat'&&task.status==='ready'&&task.contextState==='pending'))db.put('tasks',{...task,contextState:null});
const scheduledJobs = new ScheduledJobs(db,rooms);
const timerAgent = new TimerAgentActions(db,scheduledJobs);
const executionPlans = new ExecutionPlans(db,calls,workerQuery,{
  request:(run,items)=>deliveries.request(run,{requestId:'planned-handoff',commit:items[0].commit,items,summary:tr('home.supervisorStageDeliveryContinueWith')}),
  receive:async(nodeId,repositories,records)=>{
    const prepared=[];for(const r of repositories)prepared.push({...r,credential:await hosting.auth(r.accountId,r.repoUrl)});
    return workerQuery({nodeId},'execution_receive',{repositories:prepared,deliveries:records},90000);
  }
});
const deliveries = new Deliveries(db);
db.transaction(()=>{
  discussions.recover();
  calls.recoverTerminalRuns();
  for (const run of db.list('runs').filter(r=>terminal.has(r.status))) rooms.complete(run);
});
for (const run of db.list('runs').filter(r => !terminal.has(r.status))) db.put('runs', { ...run, status: run.status === 'stopping' ? 'stopping' : 'reconciling' });
const sockets = new Map();
const viewers = new Set();
const queries = new Map();
const workspaceFeed = new WorkspaceStateFeed();
const matches = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
let changeTimer;
const change = () => { clearTimeout(changeTimer);changeTimer=null;for (const r of viewers) r.write('event: change\ndata: {}\n\n'); };
const outputChanged=()=>{if(!changeTimer){changeTimer=setTimeout(change,100);changeTimer.unref();}};
const send = (ws, payload) => { if (ws?.readyState === 1) ws.send(JSON.stringify(payload)); };
const online = id => sockets.get(id)?.readyState === 1;
const setup = new ProjectSetup(db, rooms, workerQuery, online, change);
const credentials = new CredentialStore(join(data, 'credentials'));
const hosting = new Hosting(db, credentials);
const projectsAdmin = new ProjectAdmin(db, workerQuery, hosting, change);
const projectGitVersions = new ProjectGitVersions({db,query:workerQuery,hosting,online,change});
const devicesAdmin = new DeviceAdmin({ db, credentials, base, data, workerToken, change, homePort: port });
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
const dispatching=new Set();
async function dispatch(nodeId) {
  if(!online(nodeId)||!sockets.get(nodeId).workerReady||dispatching.has(nodeId))return;
  dispatching.add(nodeId);
  try {
  for (const c of db.list('commands').filter(c => c.nodeId === nodeId && !c.acked)) {
    if(c.lastSentAt&&Date.now()-Date.parse(c.lastSentAt)<5000)continue;
    let run = db.get('runs', c.runId);
    if (!run) continue;
    if(c.type==='launch'&&db.get('settings','main')?.paused)continue;
    if (['launch','delivery_publish'].includes(c.type) && projectTerminalLock(db,run.projectId,nodeId)) continue;
    if (c.type === 'launch' && (terminal.has(run.status) || run.status === 'stopping')) continue;
    if(c.type==='launch'&&run.roleSessionId&&!run.teamContext) {
      run={...run,teamContext:buildTeamContext(db,run,{online,forExecution:true})};
      db.put('runs',run);
    }
    const storedTask = run.inputTask||db.get('tasks', run.taskId);
    const basePrompt=[run.contextPacket?renderRunPrompt(run.contextPacket):storedTask.prompt,renderTeamContext(run.teamContext)].filter(Boolean).join('\n\n');
    const rulesText = schedulingRules();
    // The timer line is matched in both languages; it is dropped for Workers without timer tools.
    const schedulingRulesText = db.get('workers',nodeId)?.capabilities?.timerTools===1 ? rulesText : rulesText.replace(/^(?:Use wb timer only when given an explicit wall-clock time or recurrence requirement; |\u53ea\u6709\u6536\u5230\u660e\u786e\u7684\u5899\u949f\u65f6\u95f4\/\u5468\u671f\u9700\u6c42\u624d\u7528 wb timer\uff1b).*\n/m,'');
    const supervisorInstructions=(!run.turnPurpose||run.turnPurpose==='task')&&run.roleSnapshot?.systemSupervisor && !run.roleSnapshot.platformAssistant ? tr('home.supervisorWorkingConventions', { supervisorPrompt: normalizePlatformSettings(db.get('settings', 'main')).supervisorPrompt, schedulingRules: schedulingRulesText }):'';
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
    const settings = normalizePlatformSettings(db.get('settings', 'main'));
    const gitCredentials = {};
    if (c.type === 'launch' || c.type === 'delivery_publish' || run.deliveryId) {
      try { for (const repo of run.repositories || []) gitCredentials[repo.id] = await hosting.auth(repo.accountId, repo.repoUrl); }
      catch (e) {
        if(c.type === 'delivery_publish') {
          const delivery=db.get('deliveries',c.deliveryId);
          if(delivery) db.put('deliveries',{...delivery,status:'blocked',error:e.message});
        } else { db.put('runs',{...run,status:'failed',error:e.message}); rooms.complete(db.get('runs',run.id)); }
        db.put('commands',{...c,acked:true}); change(); continue;
      }
    }
    if(!online(nodeId)||db.get('commands',c.id)?.acked)continue;
    const sentAt=new Date().toISOString(),platformPrompt=c.launchInput?.platformPrompt??settings.platformPrompt;
    // A launch keeps the language it was first sent in, so a re-send after a language change repeats the identical prompt.
    const language=c.launchInput?.language??getLanguage();
    const recorded={...c,firstSentAt:c.firstSentAt||sentAt,lastSentAt:sentAt,sendAttempts:(c.sendAttempts||0)+1,
      ...(c.type==='launch'?{launchInput:{task,platformPrompt,language}}:{})};
    db.put('commands',recorded);
    const {launchInput,...wireCommand}=recorded;
    send(sockets.get(nodeId), { type: 'command', command: wireCommand, run, task, request,
      gitCredentials,
      delivery: (c.deliveryId || run.deliveryId) ? db.get('deliveries', c.deliveryId || run.deliveryId) : null,
      project: { ...project, root: run.projectRoot ?? project.root }, paused: settings.paused, platformPrompt, language });
  }
  } finally {dispatching.delete(nodeId);}
}
function snapshot() {
  const launches=new Map(db.list('commands').filter(c=>c.type==='launch').map(c=>[c.runId,c]));
  return { version: tr('home.040ProjectWorkspace'), language: getLanguage(), capabilities: {roleSteering:1}, homePlatform: process.platform, projects: db.list('projects').filter(p => !p.systemConfig), roles: db.list('roles').filter(r => !r.systemSupervisor), rooms: db.list('rooms'), workspaces: db.list('workspaces'), tasks: db.list('tasks'), runs: db.list('runs'),
    discussionThreads:db.list('discussionThreads'),discussionDeliveries:db.list('discussionDeliveries'),
    terminalSessions: db.list('terminalSessions').filter(s=>!['released','cancelled'].includes(s.status)),
    attachmentTransfers:db.list('attachmentTransfers').slice(-200).map(({fingerprint,...t})=>t),
    hostingAccounts: db.list('hostingAccounts'), devices: db.list('devices').map(d => ({ ...d, status: online(d.nodeId) ? 'online' : d.status })), repositoryOperations: db.list('repositoryOperations'),
    repositories: db.list('repositories'), repositoryWorkspaces: db.list('repositoryWorkspaces'), setupProposals: db.list('setupProposals'), projectGitVersions:db.list('projectGitVersions'),
    approvals: db.list('approvals'), gitChecks: db.list('gitChecks'), settings: normalizePlatformSettings(db.get('settings', 'main')), wechat: wechat.status(),
    promptDefaults: { platformPrompt: defaultPlatformPrompt(), supervisorPrompt: defaultSupervisorPrompt() },
    roleTemplates: defaultRoleTemplates(), supervisors: db.list('supervisorConfigs'),
    executionPlans: db.list('executionPlans').map(({fingerprint,...p})=>p),
    roleSessions:db.list('roleSessions').map(({nativeSession,...session})=>session),
    scheduledJobs: db.list('scheduledJobs'),scheduledOccurrences:db.list('scheduledOccurrences').slice(-200),runReports:db.list('runReports'),runAlerts:db.list('runAlerts').filter(a=>a.status==='open'),
    requests: db.list('coordinationRequests').map(request => {const {fingerprint,targetSnapshot,...r}=request;return {...r,messageProgress:messageProgress(db,request,online,launches.get(request.currentRunId)||null)};}),
    deliveries: db.list('deliveries').map(({ fingerprint, ...r }) => r),
    workers: db.list('workers').map(w => ({ ...w, runtimes: visibleRuntimes(w.runtimes), online: online(w.id) })) };
}
/** Scheduling does not call a model; it only issues new executions after the Worker has finished reconnection verification. */
function scheduleChat() {
  if(reconcileCallResults(db,calls))change();
  try { if(scheduledJobs.tick()) change(); } catch(error) {console.error(tr('home.scheduledJobCheckFailed'),error.message);}
  void executionPlans.advance().then(changed=>{if(changed)change();}).catch(error=>console.error(tr('home.executionStageAdvanceFailed'),error.message));
  for (const nodeId of deliveries.schedule()) dispatch(nodeId);
  for (const task of db.list('tasks').filter(t => t.origin === 'chat' && !t.requestId && ['ready', 'in_progress'].includes(t.status))) calls.adoptTask(task.id);
  for (const request of db.list('coordinationRequests')) {
    if (request.status === 'waiting_call') calls.resume(request.id);
    if (['queued', 'waiting_delivery'].includes(request.status)) calls.reconcile(request.id);
  }
  for(const task of db.list('tasks').filter(task=>task.origin==='chat'&&task.status==='ready'))prepareChatContext(task);
  const scheduled = rooms.schedule(id => online(id) && sockets.get(id).workerReady);
  for (const nodeId of scheduled.nodes) dispatch(nodeId);
  for(const nodeId of new Set(db.list('commands').filter(c=>!c.acked&&(!c.lastSentAt||Date.now()-Date.parse(c.lastSentAt)>=5000)).map(c=>c.nodeId)))void dispatch(nodeId);
  if (scheduled.changed) change();
  // Queued work claims capacity first; background organization does not take up the queued waiting stage of business roles.
  void conversationContext.drainOne({
    config:normalizePlatformSettings(db.get('settings','main')).conversationOrganizer,
    canRun:nodeId=>!db.get('settings','main')?.paused && online(nodeId) && sockets.get(nodeId).workerReady
      && db.get('workers',nodeId)?.capabilities?.summaryBatches===1
      && db.list('runs').filter(r=>r.nodeId===nodeId&&!terminal.has(r.status)).length+(db.get('workers',nodeId)?.organizerBusy||0)<(db.get('workers',nodeId)?.capacity||1),
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
    queries.set(id, { nodeId: run.nodeId, resolve: value => { clearTimeout(timer); resolveQuery(value); }, reject: e => { clearTimeout(timer); reject(e); } });
    send(sockets.get(run.nodeId), { type: 'query', id, runId: run.id, action, path, language: getLanguage() });
  });
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
      if (pathname === '/healthz') return json(res, { ok: true, version: '0.4.0', toolProtocol:2 });
    if (pathname.startsWith('/api/')) {
      const bearer = req.headers.authorization || '';
      const workerOk = matches(bearer, `Bearer ${workerToken}`);
      const userOk = !apiToken || matches(bearer, `Bearer ${apiToken}`);
      if (pathname.startsWith('/api/agent/')) {
        if (!workerOk) return json(res, { error: tr('home.agentToolsOnlyAllowedThrough') }, 401);
      } else if (apiToken && !userOk) return json(res, { error: tr('home.accessTokenRequired') }, 401);
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return json(res, { error: tr('home.crossSiteRequestRejected') }, 403);
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
        res.writeHead(200, { 'Content-Type': item.mime, 'Content-Length': bytes.length, 'Cache-Control': 'private, no-store',
          'Content-Disposition': `${item.mime.startsWith('image/') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(item.name)}` });
        return res.end(bytes);
      }
      if (pathname === '/api/state' && req.method === 'GET') {
        const state=snapshot();
        return json(res,url.searchParams.get('view')==='workspace'?workspaceFeed.read(state,url.searchParams.get('projectId'),url.searchParams.get('cursor')):state);
      }
      if (pathname === '/api/wechat' && req.method === 'GET') return json(res, wechat.status());
      if (pathname === '/api/wechat' && req.method === 'POST') return json(res, wechat.configure((await body(req)).enabled));
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
      const desktopAction = pathname.match(/^\/api\/devices\/([^/]+)\/desktop\/(prepare|launch|open)$/);
      if (desktopAction && req.method === 'POST') {
        const action = { prepare: 'prepareDesktop', launch: 'launchDesktop', open: 'openDesktop' }[desktopAction[2]];
        return json(res, await devicesAdmin[action](desktopAction[1]));
      }
      const deviceAction = pathname.match(/^\/api\/devices\/([^/]+)\/(check|connect)$/);
      if (deviceAction && req.method === 'POST') {
        if (db.get('settings','main')?.paused) throw new Error(tr('home.remoteExecutionPaused2'));
        const result = await (deviceAction[2] === 'check' ? devicesAdmin.check(deviceAction[1]) : devicesAdmin.provision(deviceAction[1]));
        return json(res, result);
      }
      const workerConfig = pathname.match(/^\/api\/workers\/([^/]+)\/configuration$/);
      if (workerConfig && req.method === 'POST') {
        if (db.get('settings','main')?.paused) throw new Error(tr('home.remoteExecutionPaused3'));
        const b = await body(req), worker = db.get('workers',workerConfig[1]);
        if (!worker) throw new Error(tr('home.deviceNotFound'));
        const checked = await workerQuery({nodeId:worker.id},'workspace_root',b.workspaceRoot);
        const config = db.put('workerConfigs',{id:worker.id, workspaceRoot:checked.localRoot, name:String(b.name || worker.name).slice(0,80)});
        db.put('workers',{...worker,...config}); change(); return json(res,config);
      }
      if (pathname.startsWith('/api/agent/') && req.method === 'POST') {
        const b = await body(req);
        const run = db.get('runs', b.runId);
        if (!run || terminal.has(run.status) || ['stopping', 'reconciling'].includes(run.status)) throw new Error(tr('home.currentExecutionHasEndedStopping'));
        if(pathname==='/api/agent/discussions') {
          if(Object.keys(b).some(k=>!['runId','action','input'].includes(k)))throw new Error(tr('home.discussionRequestContainsUnauthorizedFields'));
          // Read/reply/resolve for an already started turn still finish under the frozen identity; a probe withdrawal only blocks new questions and does not swallow in-flight answers.
          if(b.action!=='peers'&&(run.discussionProtocol!==2||(b.action==='ask'&&!supportsDiscussion(db.get('workers',run.nodeId),run.roleSnapshot?.runtime,run.roleSnapshot?.model))))throw new Error(tr('home.discussionProtocolV2NotEnabled'));
          if(!['peers','ask','reply','read','resolve','budget_extend'].includes(b.action))throw new Error(tr('home.unknownDiscussionAction'));
          const result=b.action==='budget_extend'?discussions.extendBudget({kind:'agent',runId:run.id},b.input):discussions[b.action](run,b.input||{});
          scheduleChat();change();return json(res,result);
        }
        if (pathname === '/api/agent/report') { const result=saveRunReport(db,run,b);change();return json(res,result); }
        if (pathname === '/api/agent/history/search') return json(res,history.search(run.projectId,b));
        if (pathname === '/api/agent/history/read') return json(res,history.read(run.projectId,b));
        if (pathname === '/api/agent/sessions/current') return json(res,sessionTools.current(run));
        if (pathname === '/api/agent/sessions/list') return json(res,sessionTools.list(run,b));
        if (pathname === '/api/agent/sessions/summary') return json(res,sessionTools.summary(run,b.roleSessionId));
        if (pathname === '/api/agent/sessions/read') return json(res,sessionTools.read(run,b.roleSessionId,b));
        if (pathname === '/api/agent/conversation/summary') return json(res,sessionTools.chatSummary(run,b));
        if (pathname === '/api/agent/setup/catalog') return json(res, run.roleSnapshot?.platformAssistant ? assistant.catalog(run) : { ...setup.catalog(run), roleTemplates: defaultRoleTemplates() });
        if (pathname === '/api/agent/schedule') { const p=executionPlans.submit(run,b);change();return json(res,{planId:p.id,status:p.status,note:tr('home.waitScheduledEndCurrentTurn')},201); }
        if (pathname === '/api/agent/timers') {
          if (db.get('workers',run.nodeId)?.capabilities?.timerTools!==1) throw new Error(tr('home.upgradeCurrentWorkerUseScheduled'));
          const result=timerAgent.execute(run,b.action,Object.fromEntries(Object.entries(b).filter(([key])=>!['runId','action'].includes(key))));
          if(b.action!=='list')change();
          return json(res,result);
        }
        if (pathname === '/api/agent/setup/propose') return json(res, run.roleSnapshot?.platformAssistant ? assistant.propose(run,b) : setup.propose(run, b));
        if (pathname === '/api/agent/roles/prompt') return json(res, setup.updateRolePrompt(run, b));
        if (pathname === '/api/agent/note') {
          const r = rooms.agentNote(run, b.text); change(); return json(res, r, 201);
        }
        if (pathname === '/api/agent/calls' || pathname === '/api/agent/ask') {
          const target = String(b.role || '').replace(/^@/, '');
          const projectRoles = db.list('roles').filter(r => r.projectId === run.projectId);
          let role = projectRoles.find(r => r.id === target) || projectRoles.find(r => r.name === target) || (isSupervisorName(target) ? projectRoles.find(r => r.systemSupervisor && !r.platformAssistant) : undefined);
          if (!role) throw new Error(tr('home.targetRoleNotFoundUse'));
          if (role.archivedAt) throw new Error(tr('home.targetRoleArchivedCannotBe'));
          const parent = calls.forRun(run);
          if (!parent) throw new Error(tr('home.currentExecutionHasNoRole'));
          let summary=b.text;
          if((b.kind||'consult')!=='consult' && !run.roleSnapshot.systemSupervisor && role.nodeId!==run.nodeId) {
            if(run.planId) throw new Error(tr('home.forNewCrossDeviceWork'));
            const target=role;role=db.get('roles',db.get('projects',run.projectId)?.supervisorRoleId);
            if(!role?.enabled) throw new Error(tr('home.crossDeviceCallsRequireProject'));
            summary=tr('home.crossDeviceRequestFromTarget', { name: run.roleSnapshot.name, name2: target.name, text: b.text });
          }
          const request = calls.create({ id: b.requestId || (pathname.endsWith('/ask') ? `ask:${run.id}:${role.id}` : ''),
            projectId: run.projectId, targetRoleId: role.id, parentRequestId: parent.id, originNodeId: run.nodeId,
            sourceMessageId: run.sourceMessageId, kind: b.kind || 'consult', summary, deliveryId: b.deliveryId, attachments:run.attachments||[],
            // A consultation uses the receiving role's own workspace; it must not inherit the asker's deployment permissions or device version snapshot.
            ...((b.kind||'consult')==='consult'?{}:{planId:run.planId,planVersion:run.planVersion,stepId:run.stepId,execution:run.execution}) });
          const messageId = `call:${request.id}`;
          if (!db.get('roomMessages', messageId)) {
            db.put('roomMessages', { id: messageId, projectId: run.projectId, sender: 'agent', senderName: run.roleSnapshot.name,
              roleId: run.roleId, kind: 'handoff', runId: run.id, requestId: request.id, taskIds: [], text: b.text,
              handoff: { kind:request.kind,fromRoleId: run.roleId, fromRole: run.roleSnapshot.name, toRoleId: role.id, toRole: role.name, summary: b.text }, createdAt: new Date().toISOString() });
            rooms.touch(run.projectId);
          }
          scheduleChat(); change(); return json(res, { requestId: request.id, status: db.get('coordinationRequests', request.id).status,
            note: tr('home.deliveredDirectlyTargetRoleWhen') }, 201);
        }
        if (pathname === '/api/agent/wait') {
          const r = calls.wait(run, b.summary); change(); return json(res, { requestId: r.id, status: r.status, note: tr('home.endTurnNowExecutionSlot') });
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
      const discussionBudgetRoute=pathname.match(/^\/api\/projects\/([^/]+)\/discussions\/budget$/);
      if(discussionBudgetRoute&&req.method==='POST') {
        const result=discussions.extendBudget({kind:'human',projectId:discussionBudgetRoute[1]},await body(req));change();return json(res,result);
      }
      const discussionReplyRoute=pathname.match(/^\/api\/projects\/([^/]+)\/discussions\/([^/]+)\/(reply|resolve)$/);
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
        const creationSignature=JSON.stringify([b.name.trim(),b.description||'',folder,supervisor.nodeId,supervisor.runtime,supervisor.model,supervisor.effort||'']);
        const previousProject=db.get('projects',id);
        if (previousProject) {
          if(previousProject.creationSignature && previousProject.creationSignature!==creationSignature) throw new Error(tr('home.createRequestHasAlreadyCompleted'));
          return json(res, previousProject);
        }
        if (db.list('projects').some(p => p.folderName === folder)) throw new Error(tr('home.projectFolderNameAlreadyIn'));
        const worker = db.get('workers',supervisor.nodeId);
        if (worker.capabilities?.projectSpace !== 1) throw new Error(tr('home.upgradeWorkerOnSupervisorDevice'));
        const checked = await workerQuery({ nodeId: supervisor.nodeId }, 'project_directory', { projectId: id, folder, workspaceRoot:worker.workspaceRoot || worker.allowedRoots?.[0] });
        // The node may disconnect during the check; the project, Supervisor, and initialization message must be persisted together.
        validateLocalSupervisor(db.get('workers', supervisor.nodeId), supervisor, online(supervisor.nodeId));
        const r = db.transaction(() => {
          const p = db.createProject({ ...b, id, root: '', repoUrl: '' });
          db.bindWorkspace(p.id, supervisor.nodeId, checked);
          coordinator.saveSupervisor(p.id, supervisor.nodeId, { ...supervisor, enabled: true });
          const roleId = `supervisor-${p.id}`;
          db.put('roles', { id: roleId, projectId: p.id, name: tr('home.supervisor'), systemSupervisor: true,
            nodeId: supervisor.nodeId, runtime: supervisor.runtime, model: supervisor.model, effort: supervisor.effort || null,
            mode: 'workspace-write', autoApprove: true, enabled: true, configured: true,
            instructions: setupRules(), revision: 1 });
          const project = db.put('projects', { ...p, folderName:folder, creationSignature, projectScope:true, supervisorNodeId: supervisor.nodeId, supervisorRoleId: roleId, setupStatus: 'ready' });
          db.put('roomMessages', { id: `welcome-${id}`, projectId: id, sender: 'system', senderName: tr('home.projectAssistant'), taskIds: [],
            text: tr('home.projectDirectorySupervisorReadyYou'), createdAt: new Date().toISOString() });
          rooms.touch(id);
          return project;
        });
        change(); return json(res, r, 201);
      }
      if (pathname === '/api/tasks' && req.method === 'POST') { const r = db.createTask(await body(req)); change(); return json(res, r, 201); }
      let m;
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
        if(req.method==='GET')return json(res,scheduledJobs.list(m[1]));
        if(req.method==='POST'){const result=scheduledJobs.save(m[1],await body(req));change();return json(res,result);}
      }
      if((m=pathname.match(/^\/api\/projects\/([^/]+)\/scheduled-jobs\/([^/]+)\/(toggle|run|delete)$/)) && req.method==='POST') {
        const b=await body(req),result=m[3]==='toggle'?scheduledJobs.pause(m[1],m[2],b.enabled,b.revision):m[3]==='run'?scheduledJobs.runNow(m[1],m[2]):scheduledJobs.remove(m[1],m[2],b.revision);
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
      if ((m = pathname.match(/^\/api\/workers\/([^/]+)\/directories$/)) && req.method === 'GET') {
        if (!db.get('workers', m[1])?.capabilities?.projectBrowser) throw new Error(tr('home.upgradeNodeUseDirectorySelection'));
        return json(res, await workerQuery({ nodeId: m[1] }, 'directories', { path: url.searchParams.get('path'), offset: Number(url.searchParams.get('offset') || 0) }));
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)$/)) && req.method === 'POST') {
        const r = db.updateProject(m[1], await body(req)); change(); return json(res, r);
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)$/)) && req.method === 'DELETE') {
        const r = db.deleteProject(m[1]); change(); return json(res, r);
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/git-check$/)) && req.method === 'POST') {
        const p = db.get('projects', m[1]), b = await body(req);
        if (!p?.repoUrl) throw new Error(tr('home.saveGiteeRepositoryUrlFirst'));
        const binding = db.get('workspaces', `${p.id}:${b.nodeId}`);
        if (!binding || !db.get('workers', b.nodeId)?.capabilities?.projectBrowser) throw new Error(tr('home.selectNodeHasBoundDirectory'));
        const result = await workerQuery({ nodeId: b.nodeId }, 'git_check', { repoUrl: p.repoUrl, localRoot: binding.localRoot }, 15000);
        if (db.get('projects', p.id).repoUrl !== p.repoUrl || db.get('workspaces', binding.id)?.localRoot !== binding.localRoot) throw new Error(tr('home.configurationChangedDuringCheckCheck'));
        db.put('gitChecks', { ...result, id: `${p.id}:${b.nodeId}`, projectId: p.id, nodeId: b.nodeId }); change(); return json(res, result);
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/git-versions$/)) && req.method === 'POST') {
        return json(res,await projectGitVersions.refresh(m[1]));
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/roles\/([^/]+)\/archive$/)) && req.method === 'POST') {
        const r = rooms.archiveRole(m[1], m[2]); change(); return json(res, r);
      }
      if((m=pathname.match(/^\/api\/projects\/([^/]+)\/roles\/([^/]+)\/session\/reset$/))&&req.method==='POST') {
        const role=db.get('roles',m[2]);if(role?.projectId!==m[1])throw new Error(tr('home.roleDoesNotBelongProject'));
        if(db.list('tasks').some(task=>task.projectId===m[1]&&task.roleId===m[2]&&['ready','in_progress'].includes(task.status)))throw new Error(tr('home.roleStillHasUnfinishedAssignments'));
        if(db.list('coordinationRequests').some(request=>request.projectId===m[1]&&request.targetRoleId===m[2]&&!['succeeded','failed','cancelled'].includes(request.status)))throw new Error(tr('home.roleStillHasUnfinishedCollaboration'));
        const session=new RoleSessions(db).list(m[1],{conversationId:m[1],roleId:m[2]}).find(item=>item.status!=='archived');
        if(!session)throw new Error(tr('home.roleHasNoCurrentSession'));
        if(db.list('terminalSessions').some(item=>item.projectId===m[1]&&item.nodeId===role.nodeId&&!['released','cancelled'].includes(item.status)))throw new Error(tr('home.deviceStillUnderManualTakeover'));
        const archived=new RoleSessions(db).archive(session.id);change();return json(res,archived);
      }
      if((m=pathname.match(/^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/read$/))&&req.method==='GET') {
        if(!db.get('projects',m[1]))throw new Error(tr('home.projectNotFound'));
        return json(res,sessionTools.read({projectId:m[1],conversationId:m[1]},m[2],{
          offset:Number(url.searchParams.get('offset')||0),limit:Number(url.searchParams.get('limit')||4000),version:url.searchParams.get('version')}));
      }
      if((m=pathname.match(/^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/summary$/))&&req.method==='GET') {
        if(!db.get('projects',m[1]))throw new Error(tr('home.projectNotFound2'));
        return json(res,sessionTools.summary({projectId:m[1],conversationId:m[1]},m[2]));
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/roles$/)) && req.method === 'POST') {
        const b = await body(req);
        if (!(b.id && b.enabled === false)) {
          if (!online(b.nodeId)) throw new Error(tr('home.selectedDeviceOfflineChooseOnline'));
          if (!db.get('workers', b.nodeId)?.capabilities?.runtimeDiscovery) throw new Error(tr('home.upgradeWorkerOnDevice2'));
          const binding = roleWorkspace(db, m[1], b.nodeId, b.repositoryId); if (!binding) throw new Error(tr('home.configureRepositoryDirectoryForSelected'));
          if (!runtimeReportFresh(db.get('workers', b.nodeId), b.runtime)) await workerQuery({ nodeId: b.nodeId }, 'runtimes', null, 25000);
          await workerQuery({ nodeId: b.nodeId }, 'workspace_check', binding.localRoot);
          if (roleWorkspace(db, m[1], b.nodeId, b.repositoryId)?.localRoot !== binding.localRoot) throw new Error(tr('home.projectDirectoryHasChangedSave'));
          if (!online(b.nodeId)) throw new Error(tr('home.deviceHasGoneOfflineTry'));
        }
        const r = rooms.saveRole(m[1], b); scheduleChat(); change(); return json(res, r);
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/messages$/))) {
        if (req.method === 'GET') return json(res, rooms.messages(m[1], url.searchParams.get('before')));
        if (req.method === 'POST') {
          const input = await body(req);
          const r = db.transaction(() => { const message = rooms.post(m[1], input); wechat.webReply(message); return message; });
          scheduleChat(); change(); return json(res, r, 201);
        }
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/steer$/)) && req.method === 'POST') {
        const result=steering.request(m[1],m[2],(await body(req)).commandId);
        for(const id of result.waitForRunIds)dispatch(db.get('runs',id).nodeId);
        scheduleChat();change();return json(res,result);
      }
      if ((m = pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/)) && req.method === 'POST') {
        const r = rooms.cancel(m[1]); if (r.requestId) calls.cancel(r.requestId); change(); return json(res, r);
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/workspaces\/([^/]+)$/)) && req.method === 'POST') {
        if (!db.get('projects', m[1])) throw new Error(tr('home.projectNotFound3'));
        projectsAdmin.check(m[1]);
        if (!db.get('workers', m[2])?.capabilities?.workspaceBindings) throw new Error(tr('home.upgradeWorkerBeforeConfiguringWorkspace'));
        const b = await body(req);
        const checked = await workerQuery({ nodeId: m[2] }, 'workspace_check', b.localRoot);
        const r = db.bindWorkspace(m[1], m[2], checked); change(); return json(res, r);
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
        const stopped=calls.stopRun(run.id,b.commandId);
        for(const id of stopped.stopRunIds){const target=db.get('runs',id);if(target)dispatch(target.nodeId);}
        change();return json(res,stopped.run);
      }
      if ((m = pathname.match(/^\/api\/runs\/([^/]+)\/terminal$/)) && req.method === 'POST') {
        const r=db.get('runs',m[1]), b=await body(req);
        if(!r)throw new Error(tr('home.runNotFound'));
        const existing=projectTerminalLock(db,r.projectId,r.nodeId);
        if(b.action==='release') {
          if(!existing || existing.runId!==r.id)throw new Error(tr('home.thereNoTerminalTakeoverFor'));
          await workerQuery(r,'terminal_release',{id:existing.id});
          db.put('terminalSessions',{...existing,status:'released'});change();scheduleChat();return json(res,{released:true});
        }
        if(b.action!=='prepare')throw new Error(tr('home.invalidTakeoverAction'));
        if(existing) {
          if(existing.runId===r.id && existing.status==='prepared')return json(res,existing);
          throw new Error(tr('home.projectOnDeviceAlreadyUnder'));
        }
        if(db.get('settings','main')?.paused)throw new Error(tr('home.remoteExecutionPaused4'));
        if(!terminal.has(r.status) || db.list('runs').some(other=>other.projectId===r.projectId&&other.nodeId===r.nodeId&&!terminal.has(other.status)))throw new Error(tr('home.projectStillExecutingOnDevice'));
        const worker=db.get('workers',r.nodeId);
        if(worker?.capabilities?.terminalResume!==1)throw new Error(tr('home.upgradeWorkerOnDeviceFirst'));
        const device=db.list('devices').find(d=>d.nodeId===r.nodeId);
        if(worker.nodeKind==='cloud' && !device)throw new Error(tr('home.cloudDeviceMissingSshRegistration'));
        const claim={id:randomUUID(),projectId:r.projectId,nodeId:r.nodeId,runId:r.id,status:'preparing',createdAt:new Date().toISOString()};
        db.put('terminalSessions',claim);change();
        try {
          const info=await workerQuery(r,'terminal_prepare',{id:claim.id},30000);
          // The registered key path is reused only when accessed from the same Mac; when accessed from another computer, that computer's own SSH configuration is responsible.
          const identityFile=b.useLocalSshKey===true && process.platform==='darwin' && device ? (await credentials.get(device.id))?.keyPath : null;
          const command=terminalCommand(info,device || null,identityFile);
          const value={...claim,...info,status:'prepared',command,url:`iterm2:/command?${new URLSearchParams({c:command})}`};
          db.put('terminalSessions',value);change();return json(res,value);
        } catch(error) {
          let status='blocked';
          try { await workerQuery(r,'terminal_release',{id:claim.id});status='released'; } catch {}
          db.put('terminalSessions',{...claim,status,error:error.message});change();throw error;
        }
      }
      if ((m = pathname.match(/^\/api\/projects\/([^/]+)\/artifacts$/)) && req.method === 'GET') {
        return json(res,await recentProjectArtifacts(db,m[1],workerQuery,online));
      }
      if ((m = pathname.match(/^\/api\/runs\/([^/]+)\/(detail|events|files|file|document)$/)) && req.method === 'GET') {
        const r = db.get('runs', m[1]); if (!r) throw new Error(tr('home.runNotFound2'));
        if(m[2]==='detail')return json(res,{run:r,task:db.get('tasks',r.taskId)});
        if (m[2] === 'events') {
          const after=Number(url.searchParams.get('after')||0);
          if(!Number.isSafeInteger(after)||after<0)throw new Error(tr('home.invalidEventCursor'));
          return json(res, { events: db.events(r.id,after) });
        }
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
        for (const ws of sockets.values()) send(ws, { type: 'settings', ...settings });
        change(); return json(res, settings);
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
    const files = { '/': 'index.html', '/platform-admin.js':'platform-admin.js', '/project-space.js':'project-space.js', '/token-usage.js':'token-usage.js', '/app-icon.png': 'app-icon.png', '/agent-codex.png':'agent-codex.png', '/agent-antigravity.png':'agent-antigravity.png', '/app.js': 'app.js', '/run-log-data.js':'run-log-data.js', '/room.js': 'room.js', '/markdown.js':'markdown.js', '/project-settings.js': 'project-settings.js', '/role-icons.js': 'role-icons.js', '/settings-page.js': 'settings-page.js', '/supervisor-settings.js':'supervisor-settings.js', '/project-setup.js':'project-setup.js', '/styles.css':'styles.css' };
    Object.assign(files,{'/history-view.js':'history-view.js','/scheduled-jobs.js':'scheduled-jobs.js','/git-version.js':'git-version.js','/plan-dock.js':'plan-dock.js','/document.html':'document.html','/document.js':'document.js','/manifest.webmanifest':'manifest.webmanifest','/sw.js':'sw.js','/app-icon-192.png':'app-icon-192.png'});
    files['/workspace-inspector.js']='workspace-inspector.js';
    files['/state-data.js']='state-data.js';
    const file = files[pathname]; if (!file) return json(res, { error: tr('home.pageNotFound') }, 404);
    const bytes = await readFile(join(base, 'public', file));
    res.writeHead(200, { 'Content-Type': { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json; charset=utf-8' }[extname(file)], 'Cache-Control': 'no-cache' }); res.end(bytes);
  } catch (e) { if (!res.headersSent) json(res, { error: e.message,...(e.code?{code:e.code}:{}) }, 400); else res.end(); }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/worker' || !matches(req.headers.authorization || '', `Bearer ${workerToken}`)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
});
wss.on('connection', ws => {
  let nodeId;
  const registerTimer = setTimeout(() => { if (!nodeId) ws.close(); }, 10000);
  ws.alive = true; ws.on('pong', () => { ws.alive = true; });
  ws.on('message', data => {
    try {
      const m = JSON.parse(data);
      if (m.type === 'register') {
        if (nodeId || typeof m.node?.id !== 'string') throw new Error(tr('home.invalidNodeRegistration'));
        nodeId = m.node.id;
        if (online(nodeId)) { ws.close(1008, tr('home.workerAlreadyConnected')); nodeId = null; return; }
        sockets.set(nodeId, ws); clearTimeout(registerTimer);
        db.put('workers', { ...m.node, ...db.get('workerConfigs',nodeId), id:nodeId, lastSeen: new Date().toISOString() });
        send(ws, { type: 'registered', paused: !!db.get('settings', 'main')?.paused, language: getLanguage() }); change(); return;
      }
      if (!nodeId || sockets.get(nodeId) !== ws) throw new Error(tr('home.nodeNotRegisteredYet'));
      if (m.type === 'ready') { ws.workerReady = true; dispatch(nodeId); scheduleChat(); collectUsage(nodeId); }
      if (m.type === 'heartbeat') db.put('workers', { ...db.get('workers', nodeId), lastSeen: new Date().toISOString() });
      if(m.type==='warm_sessions') {
        db.put('workers',{...db.get('workers',nodeId),warmSessions:Array.isArray(m.sessions)?m.sessions.slice(0,4):[]});change();
      }
      if(m.type==='organizer_busy') {
        db.put('workers',{...db.get('workers',nodeId),organizerBusy:Math.max(0,Math.min(10,Number(m.count)||0))});
        scheduleChat();change();
      }
      if (m.type === 'runtime_report') {
        const prev = db.get('workers', nodeId)?.runtimes || [];
        const runtimes = (m.runtimes || []).map(rt => {
          const old = prev.find(p => p.type === rt.type);
          const hasQuota = rt.quota && typeof rt.quota === 'object' && (rt.quota.fiveHour || rt.quota.weekly || rt.quota.groups || rt.quota.credits || rt.quota.remainingPercent != null);
          if (hasQuota) return rt;
          if (old?.quota && (old.quota.fiveHour || old.quota.weekly || old.quota.groups || old.quota.credits)) {
            return { ...rt, quota: old.quota, quotaStatus: old.quotaStatus || 'ok', quotaStale: true };
          }
          return rt;
        });
        const worker=db.get('workers',nodeId);
        const discussion=m.discussionCapabilities;
        db.put('workers', { ...worker, runtimes,...(discussion?{capabilities:{...worker.capabilities,
          discussionProtocol:discussion.discussionProtocol===2?2:0,
          discussionRuntimes:Array.isArray(discussion.discussionRuntimes)?discussion.discussionRuntimes:[],
          discussionConfigurations:Array.isArray(discussion.discussionConfigurations)?discussion.discussionConfigurations:[]}}:{}) });
        change();
      }
      if (m.type === 'event') {
        if(!db.get('runs',m.event?.runId||'')&&db.get('deletedRuns',m.event?.runId||'')?.nodeId===nodeId) {
          send(ws,{type:'ack',id:m.event.id,disposition:'project_deleted'});return;
        }
        if (db.get('runs', m.event?.runId)?.nodeId !== nodeId) throw new Error(tr('home.runDoesNotBelongCurrent'));
        db.transaction(()=>{
          const current=db.event(m.event);
          if (m.event.type === 'delivery') deliveries.accept(current.id, m.event.payload);
          if(!discussions.finishRun(current.id).handled)calls.finish(current.id);
          rooms.complete(current);
        });
        send(ws, { type: 'ack', id: m.event.id });
        if(['message','tool','usage'].includes(m.event.type))outputChanged();else change();
      }
      if (m.type === 'command_ack') { const c = db.get('commands', m.id); if (c?.nodeId === nodeId&&!c.acked) {db.put('commands', { ...c, acked: true,ackedAt:new Date().toISOString() });change();} }
      if (m.type === 'reply') { const q = queries.get(m.id); if (q?.nodeId === nodeId) { queries.delete(m.id); m.error ? q.reject(new Error(m.error)) : q.resolve(m.result); } }
    } catch (e) { send(ws, { type: 'error', error: e.message }); }
  });
  ws.on('close', () => {
    clearTimeout(registerTimer);
    if (nodeId && sockets.get(nodeId) === ws) {
      sockets.delete(nodeId);
      for (const [id, q] of queries) if (q.nodeId === nodeId) { queries.delete(id); q.reject(new Error(tr('home.executionNodeDisconnectedTryAgain'))); }
      for (const r of db.list('runs').filter(r => r.nodeId === nodeId && !terminal.has(r.status))) db.put('runs', { ...r, status: r.status === 'stopping' ? 'stopping' : 'reconciling', updatedAt: new Date().toISOString() });
      change();
    }
  });
});
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } }
  for (const r of viewers) r.write(': keepalive\n\n');
}, 15000);
const chatScheduler = setInterval(scheduleChat, 1000);
const wechatPoll = setInterval(() => { void wechat.tick().catch(error => { console.error(tr('home.wechatChannelCheckFailed'), error.message); }); }, 4000);
wechatPoll.unref();
const progressMonitor=setInterval(()=>{if(inspectRunProgress(db,online))change();},60000);progressMonitor.unref();
const usageCollector = setInterval(() => { for(const nodeId of sockets.keys())collectUsage(nodeId); }, 6*60*60*1000);
server.listen(port, host, () => console.log(tr('home.agentWorkbenchHttpData', { host, port, data })));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { clearInterval(heartbeat); clearInterval(chatScheduler); clearInterval(usageCollector); usageRetry.stop(); for (const ws of wss.clients) ws.terminate(); for (const r of viewers) r.end(); server.close(() => { db.close(); process.exit(0); }); });
