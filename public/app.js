import { t, getLanguage, setLanguage, onLanguageChange, syncLanguageWithBackend, dateLocale } from './i18n.js';
import { createRoomUI, createRoleRefresh } from './room.js';
import { projectSettings } from './project-settings.js';
import { agentIconEl, machineIconEl, quotaForRole, roleActivity, roleNameQuota, UI_ICON, deviceIconEl, workerDisplayName, workerKind, setActionIcon, projectIconAssignments, projectIconEl } from './role-icons.js';
import { activateSettingsTab, normalizeSettingsTab, settingsView } from './settings-page.js';
import { supervisorSettings } from './supervisor-settings.js';
import { projectSetupUI } from './project-setup.js';
import { deviceEntries, platformAdminUI } from './platform-admin.js';
import { projectSpaceUI } from './project-space.js';
import { tokenUsageUI } from './token-usage.js';
import { createScheduledJobsUI } from './scheduled-jobs.js';
import { formatGitVersionStatus, formatProjectGitSummary } from './git-version.js';
import { partitionRunLog, displayRunInput, contextUsageLabel, mergeRunEvents, shouldShowFinalResult, toolStatusLabel, stripAnsi, taskRunDisplayStatus } from './run-log-data.js';
import { planDismissKey, planDockState, planMemberLabel } from './plan-dock.js';
import {createWorkspaceInspector,initWorkspaceColumns} from './workspace-inspector.js';
import {applyStateUpdate} from './state-data.js';
import { TOKEN_KEY, readApiToken, saveApiToken } from './browser-token.js';

const DRAFT_KEY = 'agent-workbench.drafts';
const COMMAND_KEY = 'agent-workbench.commands';
const POLL_INTERVAL = 10_000;
const SSE_RETRY_INTERVAL = 15_000;

const dom = {
  apiToken: document.querySelector('#api-token'),
  saveToken: document.querySelector('#save-token'),
  connectionNote: document.querySelector('#connection-note'),
  projectList: document.querySelector('#project-list'),
  roleList: document.querySelector('#role-list'),
  projectGitSummary: document.querySelector('#project-git-summary'),
  settingsDeviceList: document.querySelector('#settings-device-list'),
  promptsForm: document.querySelector('#platform-prompts-form'),
  promptsDialog: document.querySelector('#platform-prompts-dialog'),
  promptsPreview: document.querySelector('#platform-prompt-preview'),
  promptsUpdated: document.querySelector('#platform-prompts-updated'),
  promptsFeedback: document.querySelector('#platform-prompts-feedback'),
  workspaceTitle: document.querySelector('#workspace-title'),
  versionLabel: document.querySelector('#version-label'),
  globalError: document.querySelector('#global-error'),
  desktopDialog: document.querySelector('#remote-desktop-dialog'),
  desktopDevice: document.querySelector('#remote-desktop-device'),
  desktopFeedback: document.querySelector('#remote-desktop-feedback'),
  emptyState: document.querySelector('#empty-state'),
  contentGrid: document.querySelector('#content-grid'),
  projectFormPanel: document.querySelector('#project-form-panel'),
  settingsPage: document.querySelector('#settings-page'),
  projectForm: document.querySelector('#project-form'),
  runDialog: document.querySelector('#run-dialog'),
  runTitle: document.querySelector('#run-dialog-title'),
  runCreated: document.querySelector('#run-dialog-created'),
  runStatus: document.querySelector('#run-dialog-status'),
  taskList: document.querySelector('#task-list'),
  taskDetail: document.querySelector('#task-detail'),
  pauseRemote: document.querySelector('#pause-remote'),
  fileDialog: document.querySelector('#file-dialog'),
  fileDialogTitle: document.querySelector('#file-dialog-title'),
  fileContent: document.querySelector('#file-content')
};
dom.settingsPauseRemote = document.querySelector('#settings-pause-remote');
dom.settingsHomeVersion = document.querySelector('#settings-home-version');
dom.workspaceDialog = document.querySelector('#workspace-dialog');
dom.bindingForm = document.querySelector('#binding-form');
dom.bindingError = document.querySelector('#binding-error');

const app = {
  data: { projects: [], roles: [], roleTemplates: [], tasks: [], runs: [], workers: [], approvals: [], settings: { paused: false }, promptDefaults: {}, version: '' },
  selectedProjectId: sessionStorage.getItem('agent-workbench.project') || null,
  selectedTaskId: sessionStorage.getItem('agent-workbench.task') || null,
  token: readApiToken(),
  authPromptShown: false,
  drafts: readSessionJson(DRAFT_KEY, { project: {}, tasks: {} }),
  commands: readSessionJson(COMMAND_KEY, {}),
  nodeSelections: {},
  bindingTarget: null,
  events: [],
  files: [],
  detailTab: 'output',
  detailRunId: null,
  loadedRunId: null,
  detailError: '',
  eventSource: null,
  pollTimer: null,
  sseRetryTimer: null,
  requestVersion: 0,
  loadingState: false,
  stateCache: null,
  stateGeneration: 0,
  fullRun: null,
  fullTask: null,
  detailFetch: null,
  pendingStateRefresh: false,
  refreshWaiters: [],
  desktopChainVersion: 0,
  fileReadVersion: 0
};
app.view = 'workspace';
app.settingsTab = 'devices';

const statusLabels = {
  draft: 'Draft', ready: 'Ready', in_progress: 'In progress', in_review: 'In review',
  awaiting_acceptance: 'Awaiting acceptance', blocked: 'Blocked', done: 'Accepted', completed: 'Completed', cancelled: 'Cancelled',
  queued: 'Queued', starting: 'Starting', running: 'Running', waiting_user: 'Awaiting confirmation',
  stopping: 'Stopping', reconciling: 'Awaiting node confirmation', succeeded: 'Succeeded',
  failed: 'Failed', interrupted: 'Stopped'
};

if (dom.apiToken) dom.apiToken.value = app.token;
for (const [id, name, label] of [
  ['refresh-state', 'refresh', 'Refresh'],
  ['show-project-settings', 'project', 'Project Settings'],
  ['show-history', 'history', 'History'],
  ['add-role-sidebar', 'plus', 'Add role'],
  ['refresh-role-status', 'refresh', 'Refresh role status and remaining quota'],
  ['pause-remote', 'pause', 'Pause remote']
]) {
  const el = document.querySelector(`#${id}`);
  if (el) { el.innerHTML = UI_ICON[name]; el.title = label; el.setAttribute('aria-label', label); }
}
const roleRefresh=createRoleRefresh({api,refreshState,getData:()=>({...app.data,roles:[...(app.data.supervisorRoles||[]),...app.data.roles]}),getProject:getCurrentProject,
  button:document.querySelector('#refresh-role-status'),feedback:document.querySelector('#role-refresh-feedback'),onUpdate:()=>renderRoles()});
const room = createRoomUI({ api, refreshState, openTask, stopRun, decideApproval, create, formatTime, setError, configureDevice(projectId, nodeId) {
  if (app.data.projects.some(p => p.id === projectId)) { app.selectedProjectId=projectId;openSettings('project'); }
} });
// Action icons apply only to explicit entry points; tabs, project names and the text confirm buttons at the bottom of dialogs are unchanged.
for(const [selector,icon,label] of [
  ['#close-settings-page','back'],['#show-device-enroll','plus'],['#edit-assistant-runtime','edit'],
  ['[data-prompt-edit]','edit'],['#edit-conversation-organizer','edit','Edit conversation organizer model'],['#edit-api-token','edit'],
  ['#manage-wechat','settings'],['#assistant-stop','stop'],['#configuration-assistant-form > .form-actions [type=submit]','send'],
  ['#token-usage-form [type=submit]','search'],['#token-usage-refresh','refresh'],['#open-project-timers','history'],
  ['#pick-settings-folder','folder'],['#project-prepare-form [type=submit]','refresh'],
  ['#project-repository-form [type=submit]','git'],['#save-settings-folder','save'],
  ['#supervisor-form [type=submit]','save'],
  ['#delete-project','trash'],['#save-project-settings','save']
])document.querySelectorAll(selector).forEach(button=>setActionIcon(button,icon,label));
const projectsUI = projectSettings({ api, getData: () => app.data, getProject: getCurrentProject, refreshState, create, setError, openSettings, closeSettings });
const supervisorsUI = supervisorSettings({ api, getData: () => app.data, getProject: getCurrentProject, refreshState, create });
const setupUI = projectSetupUI({ api, getData: () => app.data, getProject: getCurrentProject, refreshState, create, setError });
const platformUI = platformAdminUI({api,getData:()=>app.data,refreshState,create});
const spacesUI = projectSpaceUI({api,getData:()=>app.data,getProject:getCurrentProject,refreshState,create});
const tokenUI = tokenUsageUI({api,getData:()=>app.data,create});
const schedulesUI = createScheduledJobsUI({api,getData:()=>app.data,getProject:getCurrentProject,refreshState,create,
  openTask:(projectId,taskId)=>{app.selectedProjectId=projectId;closeSettings();openTask(taskId);}});

/** Recognize only clear short horizontal gestures; do not hijack vertical scrolling while reading. */
function swipePanel(panel, dx, dy, elapsed) {
  if (elapsed > 2000 || Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.6) return panel;
  if (panel === 'projects') return dx < 0 ? 'chat' : panel;
  if (panel === 'roles') return dx > 0 ? 'chat' : panel;
  return dx > 0 ? 'projects' : 'roles';
}

/** Drawers reuse the existing DOM; closing does not rebuild the chat, so drafts and reading position are kept. */
function createMobileDrawers() {
  const media = window.matchMedia('(max-width: 1000px)');
  const workspace = document.querySelector('.workspace');
  const panels = { projects: document.querySelector('.project-sidebar'), roles: document.querySelector('.node-sidebar') };
  const buttons = { projects: document.querySelector('#mobile-projects'), roles: document.querySelector('#mobile-roles') };
  const backdrop = document.querySelector('#mobile-drawer-backdrop');
  const toolbar = document.querySelector('.topbar-actions');
  const anchor = document.createComment('desktop toolbar');
  toolbar.before(anchor);
  let previousFocus;
  const focusable = panel => [...panel.querySelectorAll('button:not(:disabled), a[href], input, select, textarea, [tabindex="0"]')].filter(node => node.getClientRects().length);
  function set(panel = 'chat') {
    const next = media.matches && ['projects', 'roles'].includes(panel) ? panel : 'chat';
    const wasOpen = document.body.dataset.mobilePanel !== 'chat';
    if (next !== 'chat' && !wasOpen) previousFocus = document.activeElement;
    document.body.dataset.mobilePanel = next;
    workspace.inert = next !== 'chat';
    backdrop.hidden = next === 'chat';
    for (const [name, aside] of Object.entries(panels)) {
      aside.inert = media.matches && next !== name;
      buttons[name].setAttribute('aria-expanded', String(next === name));
    }
    if (next !== 'chat') requestAnimationFrame(() => {
      if (document.body.dataset.mobilePanel === next && !document.querySelector('dialog[open]')) focusable(panels[next])[0]?.focus({ preventScroll: true });
    });
    else if (wasOpen && previousFocus?.isConnected && !document.querySelector('dialog[open]')) previousFocus.focus({ preventScroll: true });
  }
  function resize() {
    if (media.matches) document.querySelector('.mobile-toolbar-slot').append(toolbar);
    else anchor.after(toolbar);
    set('chat');
  }
  // Restore focus after the visibility transition ends, since some browsers reject focus on the first animation frame.
  for (const [name, aside] of Object.entries(panels)) aside.addEventListener('transitionend', event => {
    if (event.target === aside && document.body.dataset.mobilePanel === name && !aside.contains(document.activeElement) && !document.querySelector('dialog[open]')) focusable(aside)[0]?.focus({ preventScroll: true });
  });
  for (const [name, button] of Object.entries(buttons)) button.addEventListener('click', () => set(name));
  backdrop.addEventListener('click', () => set('chat'));
  document.addEventListener('keydown', event => {
    const panel = document.body.dataset.mobilePanel;
    if (!media.matches || panel === 'chat' || document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape') { event.preventDefault(); set('chat'); }
    if (event.key === 'Tab') {
      const items = focusable(panels[panel]);
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    }
  });
  let gesture;
  function start(event, x, y) {
    if (!media.matches || document.body.dataset.workspaceView === 'settings' || document.querySelector('dialog[open]')) return;
    if (event.target.closest('button,a,input,textarea,select,label,summary,pre,code,table,[contenteditable="true"],[role="button"]')) return;
    if (window.getSelection()?.toString().trim()) return;
    // Horizontally scrollable content keeps its own gestures (e.g. wide Markdown tables, tabs).
    for (let node = event.target; node && node !== document.body; node = node.parentElement) {
      if (node.scrollWidth > node.clientWidth + 2 && /auto|scroll/.test(getComputedStyle(node).overflowX)) return;
    }
    gesture = { x, y, time: performance.now(), panel: document.body.dataset.mobilePanel };
  }
  function end(x, y) {
    if (!gesture) return;
    const initial = gesture; gesture = null;
    if (window.getSelection()?.toString().trim()) return;
    const next = swipePanel(initial.panel, x - initial.x, y - initial.y, performance.now() - initial.time);
    if (next !== initial.panel) set(next);
  }
  document.addEventListener('touchstart', event => {
    gesture = null;
    if (event.touches.length === 1) start(event, event.touches[0].clientX, event.touches[0].clientY);
  }, { passive: true });
  document.addEventListener('touchmove', event => {
    if (!gesture) return;
    if (event.touches.length !== 1) { gesture = null; return; }
    const dx = event.touches[0].clientX - gesture.x, dy = event.touches[0].clientY - gesture.y;
    if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) { gesture = null; return; }
    if (Math.abs(dx) > 18 && Math.abs(dx) > Math.abs(dy) * 1.6 && event.cancelable) event.preventDefault();
  }, { passive: false });
  document.addEventListener('touchend', event => { if (event.changedTouches[0]) end(event.changedTouches[0].clientX, event.changedTouches[0].clientY); });
  document.addEventListener('touchcancel', () => { gesture = null; });
  // On narrow desktop windows blank areas can also be dragged; text selection and control interaction are not hijacked.
  document.addEventListener('pointerdown', event => { if (event.pointerType === 'mouse' && event.button === 0) start(event, event.clientX, event.clientY); });
  document.addEventListener('pointerup', event => { if (event.pointerType === 'mouse') end(event.clientX, event.clientY); });
  document.addEventListener('pointercancel', () => { gesture = null; });
  media.addEventListener('change', resize);
  resize();
  return { set, isMobile: () => media.matches };
}
const drawers = createMobileDrawers();
const inspector=createWorkspaceInspector({api,getProject:getCurrentProject,getData:()=>app.data,openDevices:()=>openSettings('devices'),openProjectFolder});
initWorkspaceColumns();
const mobilePanel = drawers.set;
document.querySelector('#mobile-projects').innerHTML = UI_ICON.folder;
document.querySelector('#mobile-roles').innerHTML = UI_ICON.roles;
function viewportHeight() { document.documentElement.style.setProperty('--app-height', `${window.visualViewport?.height || window.innerHeight}px`); }
window.visualViewport?.addEventListener('resize', viewportHeight); window.addEventListener('resize', viewportHeight); viewportHeight();
document.querySelector('#pick-binding-folder').addEventListener('click', () => projectsUI.openBinding(app.bindingTarget?.nodeId));

function openSettings(value = 'devices') {
  let tab = normalizeSettingsTab(value);
  if (tab === 'project' && !projectsUI.prepareSettings()) tab = 'devices';
  if (tab === 'project') supervisorsUI.prepare();
  dom.projectFormPanel.hidden = true;
  app.view = 'settings';
  app.settingsTab = activateSettingsTab(dom.settingsPage, tab);
  if (dom.apiToken) dom.apiToken.value = app.token;
  renderSettingsDevices();
  platformUI.refresh(); spacesUI.refresh(); tokenUI.refresh();
  if (tab === 'usage') tokenUI.show();
  if (tab === 'timers') schedulesUI.show();
  if (tab === 'prompts') renderPlatformPrompts();
  mobilePanel('chat');
  renderWorkspace();
}

function closeSettings() {
  app.view = 'workspace';
  renderWorkspace();
}

/** Chat cards and the history list share the detail dialog and do not require the user to create a separate task. */
function openTask(taskId,runId=null) {
  const task = app.data.tasks.find(t => t.id === taskId && t.projectId === app.selectedProjectId);
  if (!task) return;
  app.selectedTaskId = taskId; app.events = []; app.files = []; app.detailTab = 'output'; app.detailRunId = null; app.loadedRunId = null; app.requestVersion++;
  app.pinnedDetailRunId=app.data.runs.some(r=>r.id===runId&&r.taskId===taskId)?runId:null;
  document.querySelector('#history-dialog').close();
  if (!dom.runDialog.open) dom.runDialog.showModal();
  renderTaskDetail(); void refreshRunDetails();
}

/** Read recoverable UI state from sessionStorage; corrupted data falls back to defaults. */
function readSessionJson(key, fallback) {
  try {
    return JSON.parse(sessionStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}

function saveDrafts() {
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(app.drafts));
}

function saveCommands() {
  sessionStorage.setItem(COMMAND_KEY, JSON.stringify(app.commands));
}

function setError(message = '') {
  dom.globalError.hidden = !message;
  dom.globalError.textContent = message;
}

function setConnection(message) {
  if (dom.connectionNote) {dom.connectionNote.textContent = message;dom.connectionNote.title=message;dom.connectionNote.dataset.state=/failed|interrupted/i.test(message)?'error':/^Connected/.test(message)?'connected':'waiting';}
  const settingsNote = document.querySelector('#settings-connection-note');
  if (settingsNote) settingsNote.textContent = message;
}

/**
 * Call the Home JSON API. Authentication goes in request headers only, so the Token never appears in URLs or logs.
 * @param {string} path
 * @param {RequestInit & {json?: unknown}} options
 */
async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  if (app.token) headers.set('Authorization', `Bearer ${app.token}`);
  if (options.json !== undefined) headers.set('Content-Type', 'application/json');

  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers,
      body: options.json === undefined ? options.body : JSON.stringify(options.json)
    });
  } catch (error) {
    const networkError = new Error(t('Unable to connect to Home: {message}', { message: error.message }));
    networkError.isNetworkError = true;
    throw networkError;
  }

  const contentType = response.headers.get('content-type') || '';
  if (options.blob && response.ok) return response.blob();
  const body = contentType.includes('application/json')
    ? await response.json().catch(() => ({}))
    : await response.text();

  if (!response.ok) {
    if(response.status===401 && !app.authPromptShown) {
      app.authPromptShown=true;
      const dialog=document.querySelector('#api-token-dialog');
      if(dialog && !dialog.open)dialog.showModal();
      const feedback=document.querySelector('#api-token-error');
      if(feedback){feedback.textContent='Home requires an access token; enter it and verify. This is not a GitHub/Gitee repository token.';feedback.hidden=false;}
    }
    const message = typeof body === 'object' && body?.error ? body.error : String(body || `HTTP ${response.status}`);
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return body;
}

/** Fetch the raw file; the same auth headers are used, but the response need not be JSON. */
async function fetchFile(path) {
  const headers = new Headers();
  if (app.token) headers.set('Authorization', `Bearer ${app.token}`);
  let response;
  try {
    response = await fetch(path, { headers });
  } catch (error) {
    throw new Error(t('Unable to read file: {message}', { message: error.message }));
  }
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json')
    ? await response.json().catch(() => ({}))
    : await response.text();
  if (!response.ok) {
    throw new Error(body?.error || t('Failed to read file (HTTP {status})', { status: response.status }));
  }
  return typeof body === 'object' && 'content' in body ? body.content : String(body);
}

function create(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function formatTime(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat(dateLocale(), {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(date);
}

function statusChip(status) {
  return create('span', `status-chip ${status || ''}`, statusLabels[status] || status || 'Unknown');
}

function getCurrentProject() {
  return app.data.projects.find((project) => project.id === app.selectedProjectId) || null;
}

function getCurrentTask() {
  const task=app.data.tasks.find(task=>task.id===app.selectedTaskId);
  return task?{...(app.fullTask?.id===task.id?app.fullTask:{}),...task}:null;
}

function getTaskRuns(taskId) {
  return app.data.runs
    .filter((run) => run.taskId === taskId)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

function getLatestRun(taskId) {
  return getTaskRuns(taskId).find(r=>!r.discussionDeliveryId) || null;
}
function getDetailRun(taskId) {
  const run=app.data.runs.find(r=>r.id===app.pinnedDetailRunId&&r.taskId===taskId)||getLatestRun(taskId);
  if(!run||app.fullRun?.id!==run.id)return run;
  return {...app.fullRun,...run,error:app.fullRun.error,report:app.fullRun.report};
}

/** Switching projects immediately isolates old data and in-flight details so late responses are not shown in another project. */
function selectProject(projectId) {
  app.selectedProjectId=projectId;app.selectedTaskId=null;app.stateGeneration++;
  app.stateCache=null;app.fullRun=null;app.fullTask=null;app.requestVersion++;
  for(const key of ['tasks','runs','requests','executionPlans','runReports','runAlerts','discussionThreads','discussionDeliveries','roleSessions','roleSwitches'])app.data[key]=[];
  if(dom.runDialog.open)dom.runDialog.close();
}

/** Manual acceptance status belongs to the Task and must override a Run status that only reflects the process outcome. */
function taskDisplayStatus(task, latestRun) {
  return taskRunDisplayStatus(task,latestRun);
}

function reconcileSelection() {
  if (!app.data.projects.some((project) => project.id === app.selectedProjectId)) {
    app.selectedProjectId = app.data.projects[0]?.id || null;
  }
  const projectTasks = app.data.tasks.filter((task) => task.projectId === app.selectedProjectId);
  if (!projectTasks.some((task) => task.id === app.selectedTaskId)) {
    app.selectedTaskId = projectTasks[0]?.id || null;
  }
}

/** Refresh authoritative state while keeping the user's current selection and unsubmitted forms. */
async function refreshState({ quiet = false } = {}) {
  if (app.loadingState) {
    app.pendingStateRefresh = true;
    return new Promise(resolve => app.refreshWaiters.push(resolve));
  }
  app.loadingState = true;
  const requestedProject=app.selectedProjectId,generation=app.stateGeneration;
  if (!quiet) setConnection('Syncing Home…');
  try {
    const params=new URLSearchParams({view:'workspace'});
    if(requestedProject)params.set('projectId',requestedProject);
    if(app.stateCache?.projectId===requestedProject)params.set('cursor',app.stateCache.cursor);
    let update=await api(`/api/state?${params}`);
    if(generation!==app.stateGeneration||requestedProject!==app.selectedProjectId){app.pendingStateRefresh=true;return;}
    try {app.stateCache=update.schema===1?applyStateUpdate(app.stateCache,update):{projectId:requestedProject||update.projects?.[0]?.id||null,cursor:null,state:update};}
    catch {
      params.delete('cursor');update=await api(`/api/state?${params}`);
      if(generation!==app.stateGeneration||requestedProject!==app.selectedProjectId){app.pendingStateRefresh=true;return;}
      app.stateCache=applyStateUpdate(null,update);
    }
    const data=app.stateCache.state;
    app.selectedProjectId=app.stateCache.projectId;
    app.data = {
      capabilities: data.capabilities || {},
      projects: Array.isArray(data.projects) ? data.projects : [],
      roles: Array.isArray(data.roles) ? data.roles : [],
      supervisorRoles: Array.isArray(data.supervisorRoles) ? data.supervisorRoles : [],
      roleSessions:Array.isArray(data.roleSessions)?data.roleSessions:[],
      roleSwitches:Array.isArray(data.roleSwitches)?data.roleSwitches:[],
      roleTemplates: Array.isArray(data.roleTemplates) ? data.roleTemplates : [],
      rooms: Array.isArray(data.rooms) ? data.rooms : [],
      gitChecks: Array.isArray(data.gitChecks) ? data.gitChecks : [],
      workspaces: Array.isArray(data.workspaces) ? data.workspaces : [],
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      runs: Array.isArray(data.runs) ? data.runs : [],
      workers: Array.isArray(data.workers) ? data.workers : [],
      approvals: Array.isArray(data.approvals) ? data.approvals : [],
      settings: data.settings || { paused: false },
      wechat: data.wechat || { enabled: false, configured: false, links: [] },
      promptDefaults: data.promptDefaults || {},
      supervisors: data.supervisors || [], requests: data.requests || [], deliveries: data.deliveries || [],
      executionPlans:data.executionPlans||[],scheduledJobs:data.scheduledJobs||[],scheduledOccurrences:data.scheduledOccurrences||[],runReports:data.runReports||[],runAlerts:data.runAlerts||[],
      terminalSessions:data.terminalSessions||[],
      discussionThreads:data.discussionThreads||[],discussionDeliveries:data.discussionDeliveries||[],
      attachmentTransfers:data.attachmentTransfers||[],
      repositories: data.repositories || [], repositoryWorkspaces: data.repositoryWorkspaces || [], setupProposals: data.setupProposals || [], projectGitVersions:data.projectGitVersions||[],
      hostingAccounts:data.hostingAccounts||[],devices:data.devices||[],repositoryOperations:data.repositoryOperations||[],
      version: data.version || '', homePlatform: data.homePlatform || ''
    };
    reconcileSelection();
    setError('');
    render();
    // File queries may wait on a remote Worker and must not block authoritative state refresh or later SSE merging.
    void refreshRunDetails();
    setConnection(app.token ? 'Connected · Token auth · 10 s polling' : 'Connected · live updates');
  } catch (error) {
    setError(error.message);
    setConnection('Home connection failed');
  } finally {
    app.loadingState = false;
    if (app.pendingStateRefresh) {
      app.pendingStateRefresh = false;
      void refreshState({ quiet: true });
    } else for (const resolve of app.refreshWaiters.splice(0)) resolve();
  }
}

function render() {
  if (app.selectedProjectId) sessionStorage.setItem('agent-workbench.project', app.selectedProjectId);
  if (app.selectedTaskId) sessionStorage.setItem('agent-workbench.task', app.selectedTaskId);
  renderProjects();
  renderRoles();
  renderProjectGitVersion();
  renderExecutionPlans();
  schedulesUI.refresh();
  renderSettingsDevices();
  renderOnlineDevices();
  inspector.render();
  renderDesktopShortcut();
  renderWorkspace();
  renderTasks();
  renderTaskDetail();
  projectsUI.refreshNodes();
  setupUI.refresh();
  platformUI.refresh(); spacesUI.refresh();
  void room.refresh(app.data, app.selectedProjectId);
}

const DISMISSED_PLANS_KEY = 'agent-workbench.dismissed-plans';
let dismissedPlanKeys;
try {
  const stored = JSON.parse(localStorage.getItem(DISMISSED_PLANS_KEY) || '[]');
  dismissedPlanKeys = Array.isArray(stored) ? stored.filter(key => typeof key === 'string') : [];
} catch { dismissedPlanKeys = []; }
function saveDismissedPlans() {
  try { localStorage.setItem(DISMISSED_PLANS_KEY, JSON.stringify(dismissedPlanKeys)); } catch { /* Even when storage is unavailable, this page can still be closed. */ }
}
document.querySelector('#show-plan-history').innerHTML = UI_ICON.log;
document.querySelector('#show-plan-history').addEventListener('click', () => {
  const projectPlans = new Set(planDockState(app.data.executionPlans, app.data.requests, app.selectedProjectId).plans.map(planDismissKey));
  dismissedPlanKeys = dismissedPlanKeys.filter(key => !projectPlans.has(key));
  saveDismissedPlans();
  mobilePanel('chat');
  renderExecutionPlans();
  const details = document.querySelector('#execution-plans details');
  if (details) { details.open = true; details.querySelector('summary')?.focus(); }
});

/** Show only the supervisor's latest project plan; closing is a display preference of this browser only and does not change scheduling. */
function renderExecutionPlans() {
  const panel=document.querySelector('#execution-plans');
  const state=planDockState(app.data.executionPlans,app.data.requests,app.selectedProjectId,dismissedPlanKeys);
  document.querySelector('#show-plan-history').hidden=!state.plans.some(plan=>dismissedPlanKeys.includes(planDismissKey(plan)));
  const previous=panel.querySelector('details');
  const open=panel.dataset.projectId===app.selectedProjectId && Boolean(previous?.open);
  panel.replaceChildren();panel.hidden=!state.current;if(!state.current)return;
  panel.dataset.projectId=app.selectedProjectId;
  const details=document.createElement('details');details.open=open;
  const summary=document.createElement('summary');
  const status={running:'Running',succeeded:'Completed',blocked:'Blocked',cancelled:'Cancelled',pending:'Not started',failed:'Failed',completed_with_issues:'Ended · with issues'};
  const title=document.createElement('strong');title.textContent=t('Supervisor plan · {currentStage}', { currentStage: t(state.currentStage) });
  const progress=document.createElement('span');progress.className='execution-progress';progress.textContent=`${state.completed}/${state.total}`;
  const badge=document.createElement('span');badge.className='execution-status';badge.textContent=status[state.current.status]||state.current.status;
  summary.append(title,progress,badge);details.append(summary);panel.append(details);
  if(state.dismissible.some(plan=>plan.id===state.current.id)) {
    const close=create('button','execution-plan-close');close.type='button';close.title='Close finished plan';close.setAttribute('aria-label','Close finished plan');
    close.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    close.onclick=()=>{
      // Closes this round only; old plans do not take its place and their execution status is unchanged.
      dismissedPlanKeys=[...new Set([...dismissedPlanKeys,...state.dismissible.map(planDismissKey)])];
      saveDismissedPlans();renderExecutionPlans();document.querySelector('#chat-text')?.focus({preventScroll:true});
    };
    panel.classList.add('is-dismissible');panel.append(close);
  } else panel.classList.remove('is-dismissible');
  const list=document.createElement('div');list.className='execution-plan-list';details.append(list);
  const count=document.createElement('p');count.className='execution-plan-count';count.textContent='This round\'s plan · view only; runs automatically once submitted';
  list.append(count);
  for(const plan of state.plans) {
    const item=document.createElement('section');item.className='execution-plan-item';
    const heading=document.createElement('h3');heading.textContent=`${plan.reason} · ${t(status[plan.status]||plan.status)}`;
    item.append(heading);
    const note=plan.error||plan.waitingReason||plan.fallbackReason;
    if(note){const p=document.createElement('p');p.textContent=note;item.append(p);}
    if((plan.deliveryIds||[]).some(id=>{
      const delivery=(app.data.deliveries||[]).find(d=>d.id===id);
      return delivery&&!delivery.approvedAt&&['waiting_source','awaiting_approval'].includes(delivery.status);
    })) {
      const p=document.createElement('p');p.textContent='Git delivery awaits confirmation; review and act in the run details';item.append(p);
    }
    for(const stage of plan.stages||[]) {
      const row=document.createElement('div');row.className='execution-stage';
      const label=document.createElement('span');
      const mode=stage.exclusive?'Exclusive serial':stage.mode==='parallel' && plan.isolated!==false?'Parallel':'Sequential';
      label.textContent=`${stage.index+1}. ${stage.title} · ${t(mode)} · ${plan.failurePolicy==='collect_reviews'&&stage.status==='failed'?t('Some failed or missing'):t(status[stage.status]||stage.status)}`;
      const members=document.createElement('small');
      members.textContent=(stage.members||[]).map(m=>{
        let request=(app.data.requests||[]).find(r=>r.id===m.requestId);
        for(let i=0;request?.continuationRequestId&&i<20;i++)request=(app.data.requests||[]).find(r=>r.id===request.continuationRequestId);
        const task=app.data.tasks.find(t=>t.id===request?.taskId);
        const run=(app.data.runs||[]).find(r=>r.id===request?.currentRunId);
        return `@${m.role} ${t(planMemberLabel(request,run,task))}`;
      }).join(' · ');
      row.append(label,members);item.append(row);
    }
    list.append(item);
  }
}

function renderProjects() {
  dom.projectList.replaceChildren();
  const icons = projectIconAssignments(app.data.projects);
  for (const project of app.data.projects) {
    const button = create('button', `project-item${project.id === app.selectedProjectId ? ' active' : ''}`);
    button.type = 'button';
    // Names, titles and accessible labels are user data; the count below is translated explicitly.
    button.translate = false;
    const count = project.supervisorRoleId ? (app.data.repositories || []).filter(r => r.projectId === project.id).length : (app.data.workspaces || []).filter(w => w.projectId === project.id).length;
    const icon = projectIconEl(icons[project.id]);
    const copy = create('span', 'project-item-copy');
    copy.append(create('strong', '', project.name), create('small', '', project.supervisorRoleId ? t(count===1?'{count} code repository':'{count} code repositories', { count }) : t(count===1?'{count} node workspace':'{count} node workspaces', { count })));
    button.title = project.name;
    button.setAttribute('aria-label', project.name);
    if (project.id === app.selectedProjectId) button.setAttribute('aria-current', 'page');
    button.append(icon, copy);
    button.addEventListener('click', async () => {
      selectProject(project.id);
      app.view = 'workspace';
      setError('');
      mobilePanel('chat');
      render();
      await refreshState({quiet:true});
    });
    dom.projectList.append(button);
  }
}


/** Open the selected project's binding on its own local Worker, never a path inferred by the browser. */
async function openProjectFolder(worker, button) {
  const project=getCurrentProject();
  if(!project){setError(t('Select a project before opening its folder.'));return;}
  if(button)button.disabled=true;
  try { await api(`/api/projects/${encodeURIComponent(project.id)}/workspaces/${encodeURIComponent(worker.id)}/open`,{method:'POST',json:{}}); }
  catch(error){setError(error.message);}
  finally{if(button)button.disabled=false;}
}

function renderOnlineDevices() {
  const list = document.querySelector('#sidebar-online-devices');
  if (!list) return;
  list.replaceChildren();
  const online = (app.data.workers || []).filter(w => w.online)
    .sort((a, b) => Number(workerKind(a) !== 'local') - Number(workerKind(b) !== 'local'));
  document.querySelector('#mobile-device-count').textContent = t(online.length===1?'{count} device online':'{count} devices online', { count: online.length });
  if (!online.length) {
    const empty = create('span', 'sidebar-device is-empty');
    empty.title = 'No devices online';
    empty.setAttribute('aria-label', 'No devices online');
    empty.append(deviceIconEl({ id: 'empty' }));
    list.append(empty);
    return;
  }
  for (const worker of online) {
    const row = create('button', 'sidebar-device');
    row.type = 'button';
    const name = workerDisplayName(worker);
    const desktopDevice = app.data.homePlatform === 'darwin' && workerKind(worker) === 'cloud' ? (app.data.devices || []).find(device => device.nodeId === worker.id) : null;
    const local=workerKind(worker)==='local';
    row.title = local ? t('Open project folder on {name}',{name}) : desktopDevice ? t('Open remote desktop for {name}', { name }) : name;
    row.setAttribute('aria-label',row.title);
    row.append(deviceIconEl(worker), create('span', 'sidebar-device-label', local?'Local':'Cloud'), create('span', 'device-online-dot'));
    row.addEventListener('click', () => {
      if(local){void openProjectFolder(worker,row);return;}
      if (desktopDevice) { void openRemoteDesktop(desktopDevice, row); return; }
      const project = getCurrentProject();
      if (!project) {
        document.querySelector('#show-app-settings')?.click();
        return;
      }
      openSettings('devices');
    });
    list.append(row);
  }
}

/** Only a Home on macOS can launch the local Windows App; a cloud Home does not show an unusable shortcut. */
function renderDesktopShortcut() {
  document.querySelector('#show-remote-desktop').hidden = app.data.homePlatform !== 'darwin';
}

function setDesktopStep(name, state, note) {
  const row = document.querySelector(`#desktop-step-${name}`);
  row.dataset.state = state;
  row.querySelector('small').textContent = note;
}

function resetDesktopSteps() {
  for (const name of ['check', 'tunnel', 'app']) setDesktopStep(name, 'waiting', 'Waiting');
  setDesktopStep('connect', 'waiting', 'Your action');
}

function invalidateDesktopChain() {
  app.desktopChainVersion++;
}

/** The device card, online icon and the shortcut beside settings share the same connection instructions. */
function openRemoteDesktop(device = null) {
  if (!device?.desktopUser) {
    openSettings('devices');
    setError('First click "Edit" next to the cloud device name, enter the remote desktop username and save the connection info.');
    return;
  }
  openDesktopDialog(device);
}

function openDesktopDialog(device = null) {
  invalidateDesktopChain();
  const devices = (app.data.devices || []).filter(item => item.desktopUser);
  const select = dom.desktopDevice;
  select.replaceChildren(...devices.map(item => {
    const option = document.createElement('option'); option.value = item.id; option.textContent = item.name || item.host;
    return option;
  }));
  if (device && devices.some(item => item.id === device.id)) select.value = device.id;
  resetDesktopSteps();
  const start = document.querySelector('#start-remote-desktop');
  start.disabled = !devices.length;
  start.textContent = 'Open desktop';
  dom.desktopFeedback.textContent = devices.length ? 'After the connection check, the Windows App opens; use the saved server connection there.' : 'Remote desktop is not configured; edit the cloud device in Basic Settings.';
  if (!dom.desktopDialog.open) dom.desktopDialog.showModal();
  if (devices.length === 1 || device) void startDesktopChain();
}

/** A step is marked done only after the backend completes it; launching the Windows App does not imply the user has signed in. */
async function startDesktopChain() {
  const id = dom.desktopDevice.value;
  if (!id) return;
  const version = ++app.desktopChainVersion;
  const current = () => version === app.desktopChainVersion && dom.desktopDialog.open && dom.desktopDevice.value === id;
  const start = document.querySelector('#start-remote-desktop');
  start.disabled = true;
  dom.desktopDevice.disabled = true;
  resetDesktopSteps();
  setDesktopStep('check', 'active', 'Checking');
  dom.desktopFeedback.textContent = 'Checking the server xrdp and preparing the SSH tunnel…';
  try {
    const prepared = await api(`/api/devices/${encodeURIComponent(id)}/desktop/prepare`, { method: 'POST', json: {} });
    if (!current()) return;
    setDesktopStep('check', 'done', 'Passed');
    setDesktopStep('tunnel', 'done', `127.0.0.1:${prepared.localPort}`);
    setDesktopStep('app', 'active', 'Starting');
    dom.desktopFeedback.textContent = 'Tunnel ready; launching the Windows App…';
    await api(`/api/devices/${encodeURIComponent(id)}/desktop/launch`, { method: 'POST', json: {} });
    if (!current()) return;
    setDesktopStep('app', 'done', 'Started');
    setDesktopStep('connect', 'active', 'Waiting for you');
    dom.desktopFeedback.textContent = 'In the Windows App, click the saved server connection; this page cannot read the RDP sign-in result.';
    start.textContent = 'Reopen';
  } catch (error) {
    if (!current()) return;
    const stage = document.querySelector('#desktop-step-app').dataset.state === 'active' ? 'app' : /tunnel|\bport\b|隧道|端口/i.test(error.message) ? 'tunnel' : 'check';
    setDesktopStep(stage, 'error', 'Failed');
    dom.desktopFeedback.textContent = error.message;
  } finally {
    if (current()) {
      start.disabled = false;
      dom.desktopDevice.disabled = false;
    }
  }
}


function renderRoles() {
  if (!dom.roleList) return;
  roleRefresh.update();
  dom.roleList.replaceChildren();
  const project = getCurrentProject();
  const supervisor = project && app.data.supervisorRoles?.find(r => r.id === project.supervisorRoleId && r.projectId === project.id);
  // Home preserves device registration order; include offline devices so reconnects do not renumber clouds.
  const cloudNumbers = new Map(app.data.workers.filter(w => workerKind(w) === 'cloud').map((w, index) => [w.id, index + 1]));
  const roles = project ? [...(supervisor ? [supervisor] : []), ...(app.data.roles || []).filter(r => r.projectId === project.id && !r.archivedAt && r.id !== supervisor?.id)] : [];
  const note = document.querySelector('#role-sidebar-note');
  if (!project) {
    if (note) {
      note.hidden = false;
      note.textContent = 'Select a project before managing roles. Project folders are bound in Project Settings.';
    }
    dom.roleList.append(create('div', 'worker-empty', 'No project selected'));
    return;
  }
  if (note) {
    note.hidden = roles.length > 0;
    note.textContent = 'Click a card to edit the role. Project folders are bound in Project Settings.';
  }
  if (!roles.length) {
    dom.roleList.append(create('div', 'worker-empty', 'This project has no roles yet. Click "+" in the title row to add one.'));
    return;
  }
  for (const role of roles) {
    const worker = app.data.workers.find(w => w.id === role.nodeId);
    const runtime = worker?.runtimes?.find(r => r.type === role.runtime);
    const warm=worker?.online && worker.warmSessions?.some(s=>s.roleId===role.id && Date.parse(s.idleUntil)>Date.now());
    const activity = roleActivity(role, app.data.tasks || [], app.data.runs || [],{requests:app.data.requests||[],warm,worker:worker||null,check:roleRefresh.getCheck(role)});
    const configured = activity.tone !== 'setup';
    const isSupervisor=role.id===project.supervisorRoleId;
    const displayName=isSupervisor?t('Supervisor@@roleCard'):role.name;
    const card = create('article', `worker-card role-card is-${activity.tone}${role.enabled ? '' : ' disabled'}${isSupervisor?' is-supervisor':''}`);
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', isSupervisor?t('Edit supervisor settings'):t('Edit role {name}', { name: role.name }));
    const head = create('div', 'role-card-head');
    const title = create('div', 'role-card-title');
    title.append(create('strong', 'role-card-name', displayName));
    if (configured) {
      const device = machineIconEl(worker || { id: role.nodeId }, cloudNumbers.get(role.nodeId));
      device.classList.add('role-name-device');
      if(worker && workerKind(worker)==='local'){
        device.setAttribute('role','button');device.tabIndex=0;
        device.title=t('Open project folder on {name}',{name:workerDisplayName(worker)});
        device.setAttribute('aria-label',device.title);
        device.addEventListener('click',event=>{event.stopPropagation();void openProjectFolder(worker);});
        device.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();event.stopPropagation();void openProjectFolder(worker);}});
      }
      title.append(device);
    }
    head.append(title);
    const terminalButton=create('button','chat-icon-btn role-terminal');
    terminalButton.type='button';terminalButton.innerHTML=UI_ICON.terminal;
    terminalButton.title='Continue the original session in iTerm';terminalButton.setAttribute('aria-label',t('Terminal session {name}', { name: displayName }));
    terminalButton.addEventListener('click',e=>{e.stopPropagation();openRoleTerminal(role);});
    head.append(terminalButton);
    if (activity.label !== 'Idle') head.append(create('span', `role-badge is-${activity.tone}`, activity.label));
    const ids = create('div', 'role-id-row');
    if (configured) {
      ids.append(
        agentIconEl(role.runtime, runtime?.label || role.runtime),
        create('span', 'role-model', role.model || '—')
      );
    } else {
      ids.append(create('span', 'role-setup-hint', role.modelHint || 'No run device bound yet'));
    }
    const activityRow = create('div', 'role-activity-row');
    activityRow.append(create('p', 'role-activity', activity.detail));
    if((app.data.terminalSessions||[]).some(s=>s.projectId===role.projectId&&s.nodeId===role.nodeId))activityRow.firstChild.textContent='Terminal takeover · to be returned to the platform';
    if (configured) {
      const quota = roleNameQuota(quotaForRole(runtime, worker, role.model));
      if (quota.childElementCount) activityRow.append(quota);
    }
    card.append(head, ids, activityRow);
    const open = () => {
      if(!isSupervisor){room.openRoleEditor(role.id);return;}
      openSettings('project');
      document.querySelector('#supervisor-settings').scrollIntoView({block:'start'});
      document.querySelector('#supervisor-form [name=nodeId]').focus({preventScroll:true});
    };
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => { if (e.target===card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); } });
    dom.roleList.append(card);
  }
}

const gitVersionRequests=new Set();
const gitVersionAttemptedAt=new Map();
let gitVersionDialog;

function currentGitVersion(projectId) {
  return (app.data.projectGitVersions||[]).find(item=>item.projectId===projectId) || null;
}

async function refreshProjectGitVersion(projectId,{force=false}={}) {
  const current=currentGitVersion(projectId);
  if(!force && current?.updatedAt && Date.now()-Date.parse(current.updatedAt)<5*60*1000)return;
  if(!force && !current && Date.now()-(gitVersionAttemptedAt.get(projectId)||0)<5*60*1000)return;
  if(gitVersionRequests.has(projectId))return;
  const repositories=(app.data.repositories||[]).filter(repo=>repo.projectId===projectId);
  if(!repositories.length)return;
  gitVersionRequests.add(projectId);gitVersionAttemptedAt.set(projectId,Date.now());renderProjectGitVersion();
  try {await api(`/api/projects/${encodeURIComponent(projectId)}/git-versions`,{method:'POST',json:{}});await refreshState({quiet:true});}
  catch(error){setError(t('Git version check failed: {message}', { message: error.message }));}
  finally{gitVersionRequests.delete(projectId);renderProjectGitVersion();}
}

function openGitVersionDetails(project,status) {
  if(!gitVersionDialog){gitVersionDialog=create('dialog','git-version-dialog');gitVersionDialog.setAttribute('aria-label','Git Version Details');document.body.append(gitVersionDialog);}
  gitVersionDialog.replaceChildren();
  const heading=create('div','dialog-heading');
  const title=create('div');title.append(create('p','eyebrow',project.name),create('h2','','Git Version Details'));
  const close=create('button','icon-button','×');close.type='button';close.setAttribute('aria-label','Close Git version details');close.onclick=()=>gitVersionDialog.close();
  heading.append(title,close);gitVersionDialog.append(heading);
  const tabs=create('div','git-version-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Select device');
  const list=create('div','git-version-list');
  const groups=new Map();
  for(const item of status?.items||[]) {
    const group=groups.get(item.nodeId||'unbound')||[];group.push(item);groups.set(item.nodeId||'unbound',group);
  }
  const ordered=[...groups].sort(([a],[b])=>{
    const rank=id=>{const worker=app.data.workers.find(entry=>entry.id===id);return worker?.nodeKind==='local'?0:worker?.nodeKind==='cloud'?1:2;};
    return rank(a)-rank(b) || String(a).localeCompare(String(b));
  });
  const tabButtons=[],panels=[];
  const selectTab=index=>{
    for(let i=0;i<tabButtons.length;i++) {
      tabButtons[i].setAttribute('aria-selected',String(i===index));tabButtons[i].tabIndex=i===index?0:-1;
      panels[i].hidden=i!==index;
    }
  };
  for(const [index,[nodeId,items]] of ordered.entries()) {
    const worker=app.data.workers.find(entry=>entry.id===nodeId);
    const button=create('button','git-version-tab',worker?workerDisplayName(worker):'Unbound device');
    button.type='button';button.id=`git-version-tab-${index}`;button.setAttribute('role','tab');
    button.setAttribute('aria-controls',`git-version-panel-${index}`);button.onclick=()=>selectTab(index);
    button.onkeydown=event=>{
      const next=event.key==='ArrowRight'?(index+1)%ordered.length:event.key==='ArrowLeft'?(index+ordered.length-1)%ordered.length
        :event.key==='Home'?0:event.key==='End'?ordered.length-1:null;
      if(next!==null){event.preventDefault();selectTab(next);tabButtons[next].focus();}
    };
    tabs.append(button);tabButtons.push(button);
    const section=create('section','git-version-device');section.id=`git-version-panel-${index}`;
    section.setAttribute('role','tabpanel');section.setAttribute('aria-labelledby',button.id);panels.push(section);
    for(const [number,item] of items.entries()) {
      const row=create('article',`git-version-row is-${item.status||'unknown'}`);
      const top=create('div','git-version-row-head');
      const name=create('div','git-version-row-name');
      name.append(create('span','git-version-index',`${number+1}.`),create('strong','',item.key||item.repositoryId));
      top.append(name,create('span','git-version-state',formatGitVersionStatus(item)));
      const syncLabel=item.checkedAt?`${item.stale?t('Cached sync at'):t('Synced at')} ${formatTime(item.checkedAt)}`:(item.stale?'Cached sync time unknown':'Sync time unknown');
      row.append(top,create('code','git-version-commit',String(item.localCommit||'Version not obtained').slice(0,10)),
        create('p','workspace-note',`${item.branch||t('Unknown branch')} · ${syncLabel}`));
      if(item.error)row.append(create('p','inline-error',item.error));
      section.append(row);
    }
    list.append(section);
  }
  if(!list.childElementCount)list.append(create('p','worker-empty','No repository version records yet'));
  if(tabButtons.length){selectTab(0);gitVersionDialog.append(tabs);}
  gitVersionDialog.append(list);gitVersionDialog.showModal();
}

/** The right column holds project-level totals only; per-repository versions, devices and sync times are viewed on click. */
function renderProjectGitVersion() {
  const panel=dom.projectGitSummary;if(!panel)return;
  const project=getCurrentProject();
  panel.hidden=!project || app.view==='settings';
  if(panel.hidden)return;
  const repositories=(app.data.repositories||[]).filter(repo=>repo.projectId===project.id);
  const status=currentGitVersion(project.id),busy=gitVersionRequests.has(project.id);
  panel.replaceChildren();
  const head=create('div','git-summary-head');
  const gitIcon=create('span','git-summary-icon');gitIcon.innerHTML=UI_ICON.git;gitIcon.setAttribute('aria-hidden','true');
  const heading=create('span','git-summary-title');heading.append(gitIcon,create('strong','','Repository Sync'));head.append(heading);
  const refresh=create('button','chat-icon-btn');refresh.type='button';refresh.innerHTML=UI_ICON.refresh;refresh.title='Refresh Git version';refresh.setAttribute('aria-label','Refresh Git version');refresh.disabled=busy||!repositories.length;
  refresh.onclick=event=>{event.stopPropagation();void refreshProjectGitVersion(project.id,{force:true});};head.append(refresh);
  const summary=create('p','git-summary-value',busy&&!status?'Syncing remote versions…':formatProjectGitSummary(status?.summary||{repositoryCount:repositories.length,unknown:repositories.length}));
  const cached=status?.items?.some(item=>item.stale);
  const timeText=status?.summary?.checkedAt ? `${cached?t('Cached sync at'):t('Synced at')} ${formatTime(status.summary.checkedAt)}`
    : cached ? t('Cached sync time unknown · checked {time}', { time: formatTime(status.updatedAt) }) : repositories.length?'Not synced yet':'No repository configured';
  const synced=create('small','git-summary-time',timeText);
  panel.append(head,summary,synced);
  panel.tabIndex=status?0:-1;panel.setAttribute('role',status?'button':'group');
  panel.onclick=()=>{if(status)openGitVersionDetails(project,status);};
  panel.onkeydown=event=>{if(event.target===panel&&status&&(event.key==='Enter'||event.key===' ')){event.preventDefault();openGitVersionDetails(project,status);}};
  if(repositories.length)void refreshProjectGitVersion(project.id);
}

let terminalDialog;
/** A manual terminal can start fresh or resume an exact native session; neither path is posted back to project chat. */
function openRoleTerminal(role) {
  if(!terminalDialog){terminalDialog=create('dialog','terminal-dialog');terminalDialog.setAttribute('aria-label','Terminal session');document.body.append(terminalDialog);}
  let operationId=crypto.randomUUID();const useLocalSshKey=['localhost','127.0.0.1','[::1]'].includes(location.hostname);
  const activeStatuses=new Set(['queued','starting','running','waiting_user','stopping','reconciling']);
  const render=(selectedMode='')=>{
    terminalDialog.replaceChildren();
    const claim=(app.data.terminalSessions||[]).find(s=>s.projectId===role.projectId&&s.nodeId===role.nodeId);
    const runs=app.data.runs.filter(r=>r.projectId===role.projectId&&r.roleId===role.id&&!r.historyClearedAt).slice().reverse();
    const mode=claim?(claim.kind==='new'?'':claim.runId||''):selectedMode;
    const heading=create('div','dialog-heading');
    const close=create('button','secondary compact','Close');close.type='button';close.onclick=()=>terminalDialog.close();
    heading.append(create('h2','',t('{name} · Terminal Session', { name: role.name })),close);terminalDialog.append(heading);
    terminalDialog.append(create('p','workspace-note','Choose New session to start a fresh native CLI session, or select a past run to resume its exact native session. While the terminal is open, project dispatch on this device is paused; return it to the platform after closing the CLI. Terminal conversation is not posted back to the chat automatically, and managed wb tools are unavailable.'));
    const select=create('select');select.setAttribute('aria-label','Select terminal session');
    const freshOption=create('option','','New session');freshOption.value='';select.append(freshOption);
    for(const run of runs){const option=create('option','',`${formatTime(run.createdAt)} · ${run.status} · ${(run.nativeSession?.id||run.threadId||t('no native ID')).slice(0,16)}`);option.value=run.id;select.append(option);}
    select.value=mode;select.disabled=!!claim;
    terminalDialog.append(select);
    const run=claim&&claim.kind!=='new'?app.data.runs.find(r=>r.id===claim.runId):runs.find(r=>r.id===select.value);
    select.onchange=()=>render(select.value);
    const info=create('p','workspace-note');
    const ownerRole=claim?.kind==='new'?[...(app.data.roles||[]),...(app.data.supervisorRoles||[])].find(item=>item.id===claim.roleId):role;
    const nodeId=claim?.nodeId||run?.nodeId||role.nodeId,worker=app.data.workers.find(item=>item.id===nodeId);
    const remote=workerKind(worker)==='cloud',sshDevice=(app.data.devices||[]).find(item=>item.nodeId===nodeId);
    const workspace=(app.data.workspaces||[]).find(item=>item.id===`${role.projectId}:${nodeId}`||item.projectId===role.projectId&&item.nodeId===nodeId);
    if(run)info.textContent=t('Device: {v}\nFolder: {v2}\nRun user: {v3}\nSession ID: {v4}', { v: worker?.name||nodeId, v2: claim?.workspace||run.workspace||t('not recorded'), v3: claim?.user||run.nativeSession?.user||t('verified by Worker'), v4: claim?.sessionId||run.nativeSession?.id||run.threadId||t('not recorded; resume cannot be guaranteed') });
    else {
      const contextRole=ownerRole||role;
      info.textContent=[t('Role: {v}',{v:contextRole.name}),t('Device: {v}',{v:worker?.name||nodeId||t('not recorded')}),t('Project workspace: {v}',{v:claim?.workspace||workspace?.localRoot||t('not recorded')}),t('CLI: {v}',{v:claim?.runtime||contextRole.runtime||t('not recorded')}),t('Model: {v}',{v:claim?.model||contextRole.model||t('not recorded')})].join('\n');
      if(claim?.user)info.textContent+=`\n${t('Run user: {v}',{v:claim.user})}`;
    }
    if(remote&&sshDevice)info.textContent+=`\n${t('SSH: {user}@{host}:{port}',{user:sshDevice.user,host:sshDevice.host,port:sshDevice.port})}`;
    info.style.whiteSpace='pre-wrap';terminalDialog.append(info);
    if(claim?.kind==='new'&&claim.roleId!==role.id)terminalDialog.append(create('p','workspace-note',t('This project device is under terminal control for {name}.',{name:ownerRole?.name||claim.roleId})));
    const currentSwitches=app.stateCache?.state?.roleSwitches||[],switching=currentSwitches.some(item=>item.projectId===role.projectId&&item.roleId===role.id&&!['committed','cancelled'].includes(item.status));
    const missingFreshConfig=!run&&(!role.nodeId||!role.runtime||!role.model||!workspace?.localRoot);
    const busy=app.data.runs.some(item=>item.projectId===role.projectId&&item.nodeId===nodeId&&activeStatuses.has(item.status));
    const occupied=app.data.runs.filter(item=>item.nodeId===nodeId&&activeStatuses.has(item.status)).length+(app.data.terminalSessions||[]).filter(item=>item.nodeId===nodeId&&['preparing','prepared','active'].includes(item.status)).length+(worker?.organizerBusy||0);
    const gate=claim?'':app.data.settings?.paused?'Remote dispatch is paused':switching?'This role is switching CLI; wait for the handoff to finish.':missingFreshConfig?'Configure the role device, CLI, model and project workspace before opening a terminal session.':!worker?.online?'Device offline or not connected':busy?'This project is still running on that device; view live replies in the web page first and resume after it finishes.':occupied>=(worker?.capacity||1)?'Device CLI limit reached; return an unused terminal to the platform or wait for running work.':'';
    const feedback=create('p','inline-error',claim?.error||gate);feedback.hidden=!(claim?.error||gate);feedback.setAttribute('role','status');terminalDialog.append(feedback);
    const actions=create('div','form-actions');terminalDialog.append(actions);
    if(claim) {
      if(claim.url) {
        const open=create('a','secondary',remote?(claim.kind==='new'?'Open new session via SSH':'Resume via SSH'):(claim.kind==='new'?'Open in iTerm':'Continue in iTerm'));open.href=claim.url;
        open.title='iTerm will ask you to confirm the command; it opens only once and does not repeat automatically';actions.append(open);
        const copy=create('button','secondary',remote?'Copy SSH command':claim.kind==='new'?'Copy command':'Copy resume command');copy.type='button';
        copy.onclick=async()=>{try{await navigator.clipboard.writeText(claim.command);copy.textContent='Copied';}catch{feedback.hidden=false;feedback.textContent='Clipboard unavailable; use the iTerm entry.';}};actions.append(copy);
      }
      const release=create('button','secondary','Return to platform');release.type='button';
      release.onclick=async()=>{release.disabled=true;try{
        const path=claim.kind==='new'?`/api/projects/${encodeURIComponent(claim.projectId)}/roles/${encodeURIComponent(claim.roleId)}/terminal`:`/api/runs/${encodeURIComponent(claim.runId)}/terminal`;
        await api(path,{method:'POST',json:claim.kind==='new'?{action:'release',id:claim.id}:{action:'release'}});if(claim.kind==='new')operationId=crypto.randomUUID();await refreshState({quiet:true});render(mode);
      }catch(e){feedback.hidden=false;feedback.textContent=e.message;release.disabled=false;}};
      actions.append(release);
    } else {
      const prepare=create('button','primary',run?'Verify and prepare resume':'Open new session');prepare.type='button';prepare.disabled=!!gate;
      prepare.onclick=async()=>{prepare.disabled=true;try{
        const path=run?`/api/runs/${encodeURIComponent(run.id)}/terminal`:`/api/projects/${encodeURIComponent(role.projectId)}/roles/${encodeURIComponent(role.id)}/terminal`;
        const json=run?{action:'prepare',useLocalSshKey}:{action:'prepare',operationId,useLocalSshKey};
        await api(path,{method:'POST',json});await refreshState({quiet:true});render(mode);
      }catch(e){let refreshed=false;try{await refreshState({quiet:true});refreshed=true;}catch{}render(mode);const active=(app.data.terminalSessions||[]).find(item=>item.projectId===role.projectId&&item.nodeId===nodeId);if(!active){if(refreshed&&!run)operationId=crypto.randomUUID();const status=terminalDialog.querySelector('[role="status"]');status.hidden=false;status.textContent=e.message;}}};
      actions.append(prepare);
    }
  };
  terminalDialog.languageCleanup?.();
  const languageCleanup=onLanguageChange(()=>{if(terminalDialog.open)render(terminalDialog.querySelector('select')?.value||'');});
  terminalDialog.languageCleanup=languageCleanup;terminalDialog.addEventListener('close',languageCleanup,{once:true});
  render();if(!terminalDialog.open)terminalDialog.showModal();
}

function renderSettingsDevices() {
  const list = dom.settingsDeviceList;
  if (!list) return;
  list.replaceChildren();
  const workers = [...app.data.workers].sort((a, b) => {
    const kind = Number(workerKind(a) !== 'local') - Number(workerKind(b) !== 'local');
    return kind || Number(b.online) - Number(a.online);
  });
  const entries = deviceEntries(workers, app.data.devices || []);
  if (!entries.length) {
    list.append(create('div', 'worker-empty', 'No execution devices registered'));
    return;
  }
  for (const entry of entries) {
    const { device } = entry;
    const worker = entry.worker || { id: device.nodeId, name: device.name, nodeKind: 'cloud', platform: 'linux', online: false };
    const card = create('article', 'worker-card device-card');
    const head = create('div', 'worker-card-head');
    head.append(deviceIconEl(worker), create('i', `status-dot ${worker.online ? 'online' : 'offline'}`), create('strong', '', workerDisplayName(worker)));
    const edit = create('button', 'secondary compact device-edit-button', 'Edit');
    edit.type = 'button';
    edit.setAttribute('aria-haspopup', 'dialog');
    edit.setAttribute('aria-label', t('Edit {v}', { v: workerDisplayName(worker) }));
    setActionIcon(edit,'edit');
    head.append(edit);
    if (app.data.homePlatform === 'darwin' && workerKind(worker) === 'cloud' && device) {
      const desktop = create('button', 'secondary compact device-open-desktop', 'Open remote desktop');
      desktop.type = 'button';
      setActionIcon(desktop,'desktop',t('Open remote desktop for {v}', { v: workerDisplayName(worker) }));
      desktop.addEventListener('click', () => void openRemoteDesktop(device, desktop));
      head.append(desktop);
    }
    const meta = create('div', 'worker-meta');
    meta.append(
      create('span', '', `${worker.platform || t('Unknown platform')} · ${worker.online ? t('Online') : entry.worker ? t('Offline') : t('Awaiting connection')}`),
      create('span', '', t('Last seen: {time}', { time: formatTime(worker.lastSeen) }))
    );
    card.append(head, meta);
    const detail = platformUI.deviceDetails(entry);
    const actions = create('div', 'device-actions');
    const remoteDesktopUrl = typeof worker.remoteDesktopUrl === 'string' ? worker.remoteDesktopUrl.trim() : '';
    if (remoteDesktopUrl) {
      const remoteDesktop = create('a', 'secondary compact device-remote-desktop', 'Open remote desktop');
      remoteDesktop.href = remoteDesktopUrl;
      remoteDesktop.target = '_blank';
      remoteDesktop.rel = 'noopener noreferrer';
      remoteDesktop.title = remoteDesktopUrl.startsWith('rdp://')
        ? 'Start the SSH tunnel first, then call the local RDP client'
        : 'Open the remote desktop in a new window';
      actions.append(remoteDesktop);
      if (remoteDesktopUrl.startsWith('rdp://')) detail.append(create('p', 'workspace-note', 'Native RDP · start the SSH tunnel to 127.0.0.1:3390 first'));
    }
    if (entry.worker) {
      const refresh = create('button', 'secondary compact', 'Refresh CLI');
      refresh.type = 'button';
      refresh.disabled = !worker.online || !worker.capabilities?.runtimeDiscovery;
      refresh.addEventListener('click', async () => {
        refresh.disabled = true;
        refresh.textContent = 'Refreshing…';
        try {
          await api(`/api/workers/${encodeURIComponent(worker.id)}/runtimes`, { method: 'POST', json: {} });
          await refreshState({ quiet: true });
        } catch (e) {
          setError(e.message);
        } finally {
          refresh.disabled = !worker.online || !worker.capabilities?.runtimeDiscovery;
          refresh.textContent = 'Refresh CLI';
        }
      });
      actions.append(refresh);
    }
    detail.append(actions);
    edit.addEventListener('click', () => {
      const dialog = document.querySelector('#device-edit-dialog');
      document.querySelector('#device-edit-title').textContent = t('Edit {v}', { v: workerDisplayName(worker) });
      document.querySelector('#device-edit-content').replaceChildren(detail);
      dialog.showModal();
    });
    const runtimes = Array.isArray(worker.runtimes) ? worker.runtimes : [];
    if (runtimes.length) {
      const runtimeList = create('div', 'device-runtime-list');
      for (const runtime of runtimes) {
        if (!runtime || typeof runtime !== 'object') continue;
        appendRuntimeModels(runtimeList, worker, runtime);
      }
      card.append(runtimeList);
    }
    list.append(card);
  }
}

function renderPlatformPromptPreview() {
  if (!dom.promptsForm || !dom.promptsPreview) return;
  const platform = dom.promptsForm.elements.platformPrompt.value.trim();
  dom.promptsPreview.textContent = [
    t('[Platform hard rules (built in, not editable)]'),
    t('Permissions, workspace, approvals and cross-role call boundaries'),
    '',
    t('[Platform prompt]'),
    platform || t('(not configured)'),
    '',
    t('[Current role prompt]'),
    t('(added at run time from the role configuration)')
  ].join('\n');
}

function setSupervisorDefaultOptions(name, values, selected, blank) {
  const select = dom.promptsForm?.elements[name];
  if (!select) return '';
  const unique = [...new Map(values.filter(value => value?.id).map(value => [value.id, value])).values()];
  if (selected && !unique.some(value => value.id === selected)) unique.push({ id: selected, name: t('{selected} (currently unavailable)', { selected }) });
  select.replaceChildren();
  for (const value of [{ id: '', name: blank }, ...unique]) {
    const option = create('option', '', value.name || value.id);
    option.value = value.id;
    select.append(option);
  }
  select.value = selected || '';
  return select.value;
}

/** Defaults are generated only from signed-in Runtimes on online local machines; stale saved values stay displayed but are not replaced. */
function renderSupervisorDefaultChoices(values = {}) {
  if (!dom.promptsForm) return;
  const runtimes = (app.data.workers || [])
    .filter(worker => worker.online)
    .flatMap(worker => worker.runtimes || [])
    .filter(runtime => runtime.supported && runtime.available && runtime.authReady === true);
  const runtime = setSupervisorDefaultOptions(
    'defaultSupervisorRuntime',
    runtimes.map(item => ({ id: item.type, name: item.label || item.type })),
    values.defaultSupervisorRuntime || '',
    'Choose manually when creating a project'
  );
  const selectedRuntimes = runtimes.filter(item => item.type === runtime);
  const model = setSupervisorDefaultOptions(
    'defaultSupervisorModel',
    selectedRuntimes.flatMap(item => item.models || []),
    values.defaultSupervisorModel || '',
    'Choose manually when creating a project'
  );
  const selectedModels = selectedRuntimes.flatMap(item => item.models || []).filter(item => item.id === model);
  setSupervisorDefaultOptions(
    'defaultSupervisorEffort',
    [...new Set(selectedModels.flatMap(item => item.efforts || []).concat(selectedRuntimes.flatMap(item => item.efforts || [])))].map(id => ({ id })),
    values.defaultSupervisorEffort || '',
    'Use CLI default'
  );
}

function renderPlatformPrompts() {
  if (!dom.promptsForm) return;
  const settings = app.data.settings || {};
  dom.promptsForm.elements.platformPrompt.value = settings.platformPrompt ?? app.data.promptDefaults?.platformPrompt ?? '';
  dom.promptsForm.elements.supervisorPrompt.value = settings.supervisorPrompt ?? app.data.promptDefaults?.supervisorPrompt ?? '';
  renderSupervisorDefaultChoices(settings);
  dom.promptsUpdated.textContent = settings.promptsUpdatedAt ? t('Last saved: {time}', { time: formatTime(settings.promptsUpdatedAt) }) : 'Not saved separately; using the default';
  document.querySelector('#platform-prompt-summary').textContent = dom.promptsForm.elements.platformPrompt.value.trim() || 'Not set; using the platform default rules.';
  document.querySelector('#supervisor-prompt-summary').textContent = dom.promptsForm.elements.supervisorPrompt.value.trim() || 'Not set; using the default supervisor instructions.';
  document.querySelector('#supervisor-defaults-summary').textContent = [
    dom.promptsForm.elements.defaultSupervisorRuntime.selectedOptions[0]?.textContent || t('Choose CLI manually'),
    dom.promptsForm.elements.defaultSupervisorModel.selectedOptions[0]?.textContent || t('Choose model manually'),
    dom.promptsForm.elements.defaultSupervisorEffort.selectedOptions[0]?.textContent || t('CLI default reasoning effort')
  ].join(' · ');
  dom.promptsFeedback.hidden = true;
  renderPlatformPromptPreview();
  const organizer=settings.conversationOrganizer||{};
  const worker=app.data.workers?.find(item=>item.id===organizer.nodeId);
  document.querySelector('#conversation-organizer-summary').textContent=organizer.nodeId
    ? t('{v} · {runtime} · {model}{v2}\nLast updated: {v3}', { v: worker?.name||organizer.nodeId, runtime: organizer.runtime, model: organizer.model, v2: organizer.effort?` · ${organizer.effort}`:'', v3: organizer.updatedAt?formatTime(organizer.updatedAt):t('not recorded') })
    : 'Not configured; dispatch uses original excerpts.';
}

const organizerDialog=document.querySelector('#conversation-organizer-dialog');
const organizerForm=document.querySelector('#conversation-organizer-form');
function organizerOptions(select,items,value,blank) {
  select.replaceChildren();
  const empty=create('option','',blank);empty.value='';select.append(empty);
  for(const item of items){const option=create('option','',item.name||item.label||item.id);option.value=item.id;select.append(option);}
  select.value=items.some(item=>item.id===value)?value:'';
}
function refreshOrganizerChoices(saved={}) {
  const workers=(app.data.workers||[]).filter(worker=>worker.online&&worker.capabilities?.managedResume===1);
  organizerOptions(organizerForm.elements.nodeId,workers.map(worker=>({id:worker.id,name:worker.name})),saved.nodeId||organizerForm.elements.nodeId.value,'Not enabled for now');
  const worker=workers.find(item=>item.id===organizerForm.elements.nodeId.value);
  const runtimes=(worker?.runtimes||[]).filter(runtime=>['codex','claude','grok','agy'].includes(runtime.type)&&runtime.available&&runtime.authReady===true);
  organizerOptions(organizerForm.elements.runtime,runtimes.map(runtime=>({id:runtime.type,name:runtime.label||runtime.type})),saved.runtime||organizerForm.elements.runtime.value,'Select CLI');
  const runtime=runtimes.find(item=>item.type===organizerForm.elements.runtime.value);
  organizerOptions(organizerForm.elements.model,(runtime?.models||[]).map(model=>({id:model.id,name:model.name||model.id})),saved.model||organizerForm.elements.model.value,'Select model');
  const model=runtime?.models?.find(item=>item.id===organizerForm.elements.model.value);
  organizerOptions(organizerForm.elements.effort,[...new Set(model?.efforts||runtime?.efforts||[])].map(id=>({id})),saved.effort||organizerForm.elements.effort.value,'CLI default');
}

/** Reuse one editor; the project entry edits only the shared supervisor prompt, not model defaults. */
function openPromptEditor(mode) {
  if (!['platform', 'supervisor', 'supervisor-prompt'].includes(mode)) return;
  // Reuse the existing global editor; its containing panel must be visible before showModal.
  if(mode==='supervisor-prompt')openSettings('prompts');
  renderPlatformPrompts();
  dom.promptsDialog.dataset.editMode = mode;
  for (const section of dom.promptsForm.querySelectorAll('[data-prompt-field]')) section.hidden = mode === 'supervisor-prompt' ? section.dataset.promptField !== 'supervisor' : mode === 'platform' ? section.dataset.promptField !== 'platform' : section.dataset.promptField === 'platform';
  document.querySelector('#prompt-merge-preview').hidden = mode !== 'platform';
  document.querySelector('#restore-platform-prompts').textContent = mode !== 'platform' ? 'Restore default prompts' : 'Restore defaults';
  document.querySelector('#platform-prompts-dialog-title').textContent = {
    platform: 'Edit platform prompt', supervisor: 'Edit supervisor settings', 'supervisor-prompt': 'Edit default supervisor prompt'
  }[mode];
  dom.promptsDialog.showModal();
  (mode === 'platform' ? dom.promptsForm.elements.platformPrompt : dom.promptsForm.elements.supervisorPrompt).focus();
}

function appendRuntimeModels(parent, worker, runtime) {
  const details = create('details', `runtime-settings${runtime.available ? ' is-available' : ''}`);
  const summary = create('summary', 'runtime-settings-summary');
  const label = runtime.label || runtime.type || 'Runtime';
  summary.append(
    agentIconEl(runtime.type, label),
    create('strong', '', label),
    create('span', `runtime-state ${runtime.available ? 'is-ready' : 'is-unavailable'}`, runtime.available ? 'Available' : 'Unavailable')
  );
  details.append(summary);
  const auth = runtime.authReady === true ? 'Signed in' : runtime.authReady === false ? 'Not signed in' : 'Sign-in status unknown';
  details.append(create('p', 'workspace-note runtime-meta', `${auth}${runtime.version ? ` · ${runtime.version}` : ''}${runtime.checkedAt ? t(' · Checked {time}', { time: formatTime(runtime.checkedAt) }) : ''}`));
  const models = Array.isArray(runtime.models) ? runtime.models : [];
  const modelList = create('div', 'inline-model-list');
  if (!models.length) {
    modelList.append(create('div', 'worker-empty', runtime.reason || 'This CLI has not returned a model list yet'));
  } else {
    for (const model of models) {
      const row = create('article', 'model-mgmt-row');
      const head = create('div', 'model-mgmt-row-head');
      head.append(create('strong', '', model.name || model.id), create('code', 'model-id', model.id));
      const quota = create('div', 'model-mgmt-quota');
      quota.append(create('span', 'model-mgmt-quota-label', 'Quota remaining'), create('strong', 'model-mgmt-quota-value', modelQuotaLabel(runtime, model)));
      row.append(head, quota);
      const last = lastRunUsageForModel(worker.id, runtime.type, model.id);
      if (last) row.append(create('p', 'workspace-note model-mgmt-last-usage', t('Last run usage: {text} · {time}', { text: last.text, time: formatTime(last.at) })));
      modelList.append(row);
    }
  }
  details.append(modelList);
  parent.append(details);
}

/** The dialog stores the target project and node, so SSE refreshes do not overwrite the path being edited. */
function openWorkspaceBinding(project, worker, binding) {
  if (project.supervisorRoleId) { openSettings('project'); return; }
  app.bindingTarget = { projectId: project.id, nodeId: worker.id };
  document.querySelector('#binding-title').textContent = `${project.name} · ${workerDisplayName(worker)}`;
  dom.bindingForm.elements.localRoot.value = binding?.localRoot || project.root || '';
  dom.bindingError.hidden = true;
  dom.workspaceDialog.showModal();
  dom.bindingForm.elements.localRoot.focus();
}

/** Account quota: when the probe returns no balance field, label it "Not available" rather than inventing a number. Optionally shows the last run's usage. */
function lastRunUsageForModel(nodeId, runtimeType, modelId) {
  const runs = (app.data.runs || [])
    .filter(r => r.nodeId === nodeId && r.model === modelId && (!r.roleSnapshot?.runtime || r.roleSnapshot.runtime === runtimeType) && r.usage)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
  if (!runs.length) return null;
  const text = formatUsage(runs[0].usage);
  return text ? { text, at: runs[0].updatedAt || runs[0].createdAt } : null;
}

function modelQuotaLabel(runtime, model) {
  const quota = model?.quota ?? quotaForRole(runtime, null, model?.id);
  const status = model?.quotaStatus ?? runtime?.quotaStatus;
  if (quota && typeof quota === 'object') {
    const parts = [];
    if (quota.fiveHour?.remainingPercent != null) parts.push(`5h ${Math.round(quota.fiveHour.remainingPercent)}%`);
    if (quota.weekly?.remainingPercent != null) parts.push(t('Week {v}%', { v: Math.round(quota.weekly.remainingPercent) }));
    if (quota.credits?.balance != null) parts.push(`Credits ${quota.credits.balance}`);
    if (parts.length) return parts.join(' · ');
  }
  if (quota != null && typeof quota === 'object' && (quota.remaining != null || quota.remainingTokens != null)) {
    return String(quota.remaining ?? quota.remainingTokens);
  }
  if (typeof quota === 'number' || (typeof quota === 'string' && quota.trim())) return String(quota);
  if (status === 'unavailable' || quota == null) return 'Not available';
  return 'Unknown';
}

/** Show only redacted status; WeChat credentials are managed in Home's private folder and never configured through the frontend. */
function renderWechat() {
  const state = app.data.wechat || { links: [] };
  const summary = document.querySelector('#wechat-summary');
  summary.textContent = !state.client ? 'WeChat service needs an update; currently not enabled' : !state.configured ? 'Home-specific client configuration not installed' : `${state.enabled ? t('Enabled') : t('Disabled')} · ${state.health || t('Connection not checked yet')}`;
  const dialog = document.querySelector('#wechat-dialog'); if (!dialog.open) return;
  document.querySelector('#wechat-health').textContent = t('{textContent}. Client: {v}; a connection check does not guarantee actual delivery.', { textContent: summary.textContent, v: state.client || t('not configured') });
  const toggle = document.querySelector('#toggle-wechat'); toggle.textContent = state.enabled ? 'Pause WeChat messaging' : 'Enable WeChat'; toggle.disabled = !state.configured;
  document.querySelector('#check-wechat').disabled = !state.configured;
  const select = document.querySelector('#wechat-project'), selected = select.value || app.selectedProjectId;
  const projects = app.data.projects.filter(project => project.supervisorRoleId);
  select.replaceChildren(...projects.map(project => { const option = create('option', '', project.name); option.value = project.id; return option; }));
  if (projects.some(project => project.id === selected)) select.value = selected;
  document.querySelector('#send-wechat-entry').disabled = !state.enabled || !projects.length;
  const list = document.querySelector('#wechat-records'); list.replaceChildren();
  for (const link of state.links || []) {
    const card = create('section', 'settings-overview-card');
    const project = app.data.projects.find(p => p.id === link.projectId);
    const kind = { question: 'Pending question', approval: 'CLI approval', project: 'Project entry' }[link.kind] || 'Message';
    card.append(create('strong', '', `${link.code ? t('[{code}]', { code: link.code }) : t('Pending send')} ${project?.name || t('Project removed')} · ${kind}`));
    if (link.preview) card.append(create('p', 'settings-overview-preview', link.preview));
    const status = link.state === 'closed' ? link.closedReason : link.error || (link.deliveryStatus === 'sent' ? t('Sent · {v}', { v: link.lastSeq ? t('reply received; you can keep giving numbered instructions') : t('awaiting reply') }) : 'Sending');
    card.append(create('p', 'workspace-note', `${status} · ${formatTime(new Date(link.createdAt).toISOString())}`));
    if (link.followupUntil && link.state !== 'closed') card.append(create('p', 'workspace-note', t('This answered number accepts follow-up instructions until {time}; after that, get the entry again. Unanswered questions have no local wait timeout.', { time: formatTime(new Date(link.followupUntil).toISOString()) })));
    if (link.error === 'weixin_context_expired') card.append(create('p', 'workspace-note', 'Send ClawBot a new message first, then retry the original request.'));
    if (link.state !== 'closed') {
      const actions = create('div', 'form-actions');
      if (link.error) {
        const retry = create('button', 'secondary compact', 'Retry original request'); retry.type = 'button';
        retry.onclick = () => void wechatAction(retry, `/api/wechat/${link.id}/retry`); actions.append(retry);
      }
      const close = create('button', 'secondary compact', link.kind === 'question' ? 'Handled locally' : 'Close WeChat follow-up'); close.type = 'button';
      close.title = 'Stop receiving further WeChat replies for this number; the business task is not cancelled'; close.onclick = () => void wechatAction(close, `/api/wechat/${link.id}/cancel`); actions.append(close);
      card.append(actions);
    }
    list.append(card);
  }
  if (!(state.links || []).length) list.append(create('p', 'workspace-note', 'No WeChat messages yet; once enabled, only newly pending questions are notified.'));
}
async function wechatAction(button, path, json = {}) {
  button.disabled = true; const feedback = document.querySelector('#wechat-feedback'); feedback.textContent = '';
  try { await api(path, { method: 'POST', json }); await refreshState(); }
  catch (error) { feedback.textContent = error.message; }
  finally { button.disabled = false; renderWechat(); }
}
document.querySelector('#manage-wechat').onclick = () => { document.querySelector('#wechat-dialog').showModal(); renderWechat(); };
document.querySelector('#close-wechat-dialog').onclick = () => document.querySelector('#wechat-dialog').close();
document.querySelector('#toggle-wechat').onclick = event => void wechatAction(event.currentTarget, '/api/wechat', { enabled: !app.data.wechat?.enabled });
document.querySelector('#check-wechat').onclick = event => void wechatAction(event.currentTarget, '/api/wechat/health');
document.querySelector('#send-wechat-entry').onclick = event => void wechatAction(event.currentTarget, `/api/projects/${document.querySelector('#wechat-project').value}/wechat`);

function renderWorkspace() {
  renderWechat();
  const project = getCurrentProject();
  const hasProjects = app.data.projects.length > 0;
  const settingsOpen = app.view === 'settings';
  document.body.dataset.workspaceView = settingsOpen ? 'settings' : 'workspace';
  dom.settingsPage.hidden = !settingsOpen;
  dom.emptyState.hidden = settingsOpen || hasProjects || !dom.projectFormPanel.hidden;
  dom.contentGrid.hidden = settingsOpen || !project || !dom.projectFormPanel.hidden;
  dom.workspaceTitle.translate = settingsOpen || !project;
  dom.workspaceTitle.textContent = settingsOpen ? settingsView(app.settingsTab).title : (project?.name || 'Select a project');
  document.querySelector('#show-project-settings').disabled = !project;
  const repoBar = document.querySelector('#project-repository'); repoBar.replaceChildren(); repoBar.hidden = settingsOpen || !project?.repository;
  if (!settingsOpen && project?.repository) { const link = create('a', '', `Gitee · ${project.repository.owner}/${project.repository.repo}`); link.href = project.repository.webUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; repoBar.append(link); }
  dom.versionLabel.textContent = app.data.version ? `Home ${app.data.version}` : '';
  if (dom.settingsHomeVersion) dom.settingsHomeVersion.textContent = app.data.version ? `Home ${app.data.version}` : 'Home status unknown';
  const tokenSummary = document.querySelector('#api-token-summary');
  if (tokenSummary) tokenSummary.textContent = app.token ? 'Set; saved in this browser for future visits. You can change it here.' : 'Not set; enter the Home access token if authentication is enabled.';
  const paused = Boolean(app.data.settings?.paused);
  for (const button of [dom.pauseRemote, dom.settingsPauseRemote].filter(Boolean)) {
    const label = paused ? 'Resume remote' : 'Pause remote';
    button.disabled = !hasProjects;
    button.classList.toggle('active', paused);
    button.title = label;
    button.setAttribute('aria-label', label);
    if (button === dom.pauseRemote) button.innerHTML = UI_ICON[paused ? 'play' : 'pause'];
    else setActionIcon(button,paused?'play':'pause',label);
  }
}

function renderTasks() {
  dom.taskList.replaceChildren();
  const tasks = app.data.tasks
    .filter((task) => task.projectId === app.selectedProjectId)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  if (!tasks.length) {
    dom.taskList.append(create('div', 'task-empty', 'This project has no run records yet; @role in the chat to start'));
    return;
  }
  for (const task of tasks) {
    const latestRun = getLatestRun(task.id);
    const button = create('button', `task-card${task.id === app.selectedTaskId ? ' active' : ''}`);
    button.type = 'button';
    const top = create('div', 'task-card-top');
    top.append(create('h3', '', task.title), statusChip(taskDisplayStatus(task, latestRun)));
    const meta = create('div', 'task-meta');
    meta.append(
      create('span', '', task.model || 'gpt-5.6-sol'),
      create('span', '', task.mode === 'workspace-write' ? 'Workspace write' : 'Read-only'),
      create('span', '', formatTime(task.createdAt))
    );
    button.append(top, meta);
    button.addEventListener('click', async () => {
      openTask(task.id);
    });
    dom.taskList.append(button);
  }
}

function renderTaskDetail() {
  const oldPanel = dom.taskDetail.querySelector('.run-tab-panel');
  const oldTab = oldPanel?.getAttribute('aria-labelledby');
  const oldFilesOpen = dom.taskDetail.querySelector('.run-workspace-files')?.open;
  const openToolIds = [...dom.taskDetail.querySelectorAll('.run-tool-card[open]')].map(card => card.dataset.toolId);
  const oldScroll = dom.taskDetail.scrollTop;
  const followTail = oldPanel && dom.taskDetail.scrollHeight - oldScroll - dom.taskDetail.clientHeight < 72;
  const oldRunId = app.detailRunId;
  dom.taskDetail.replaceChildren();
  const task = getCurrentTask();
  if (!task) {
    dom.runTitle.textContent = 'Conversation Log';
    dom.runCreated.textContent = '';
    dom.runStatus.replaceChildren();
    const placeholder = create('div', 'detail-placeholder');
    placeholder.append(create('span', '', '↗'), create('p', '', 'Select a run record in the conversation to view details'));
    dom.taskDetail.append(placeholder);
    return;
  }

  const latestRun = getDetailRun(task.id);
  dom.runTitle.textContent = latestRun?.inputTask?.title||task.title;
  dom.runTitle.title = dom.runTitle.textContent;
  dom.runCreated.textContent = t('Created {time}', { time: formatTime(task.createdAt) });
  dom.runStatus.replaceChildren(statusChip(taskDisplayStatus(task, latestRun)));

  renderRunToolbar(task, latestRun);
  const body = create('div', 'detail-body');
  if (latestRun) body.append(renderRunSummary(latestRun));
  if (app.detailError) body.append(create('div', 'inline-error', app.detailError));
  if (latestRun) body.append(renderApprovals(latestRun));
  body.append(renderRunTabs(task, latestRun));
  dom.taskDetail.append(body);
  app.detailRunId = latestRun?.id || null;
  const panel = dom.taskDetail.querySelector('.run-tab-panel');
  if (oldFilesOpen && oldRunId === app.detailRunId && oldTab === 'run-tab-artifacts') panel?.querySelector('.run-workspace-files')?.setAttribute('open', '');
  if (oldRunId === app.detailRunId && oldTab === 'run-tab-tools') for (const card of panel?.querySelectorAll('.run-tool-card') || []) if (openToolIds.includes(card.dataset.toolId)) card.open = true;
  const activeRun = latestRun && !['succeeded', 'failed', 'interrupted'].includes(latestRun.status);
  if (panel && app.detailTab === 'output' && activeRun && (!oldPanel || oldTab !== 'run-tab-output')) dom.taskDetail.scrollTop = dom.taskDetail.scrollHeight;
  else if (panel && oldPanel && oldRunId === app.detailRunId && oldTab !== `run-tab-${app.detailTab}`) dom.taskDetail.scrollTop = 0;
  else if (panel && oldPanel && oldRunId === app.detailRunId) dom.taskDetail.scrollTop = app.detailTab === 'output' && activeRun && followTail ? dom.taskDetail.scrollHeight : oldScroll;
  else dom.taskDetail.scrollTop = 0;
}

function renderRunToolbar(task, run) {
  const toolbar = create('div', 'run-toolbar');
  if (task.origin === 'chat') {
    if (run && ['queued', 'starting', 'running', 'waiting_user'].includes(run.status)) {
      const stop = create('button', 'secondary', 'Stop'); stop.type = 'button';
      stop.addEventListener('click', () => stopRun(run, stop)); toolbar.append(stop);
      dom.taskDetail.append(toolbar);
    }
    return;
  }
  const onlineWorkers = app.data.workers.filter(worker => worker.online
    && worker.runtimes?.some(r => r.supported && r.available)
    && (app.data.workspaces || []).some(w => w.projectId === task.projectId && w.nodeId === worker.id));
  const workerLabel = create('label', '', 'Execution node');
  const select = create('select');
  select.setAttribute('aria-label', 'Execution node');
  if (!onlineWorkers.length) {
    const option = create('option', '', 'Must be online, bound, and have a usable CLI');
    option.value = '';
    select.append(option);
    select.disabled = true;
  } else {
    for (const worker of onlineWorkers) {
      const option = create('option', '', worker.name || worker.id);
      option.value = worker.id;
      if ((app.nodeSelections[task.id] || run?.nodeId) === worker.id) option.selected = true;
      select.append(option);
    }
  }
  select.addEventListener('change', () => { app.nodeSelections[task.id] = select.value; });
  workerLabel.append(select);
  toolbar.append(workerLabel);

  const activeStatuses = ['queued', 'starting', 'running', 'waiting_user', 'stopping', 'reconciling'];
  if (run?.status === 'succeeded' && task.status === 'awaiting_acceptance') {
    const accept = create('button', 'primary', 'Confirm acceptance');
    accept.type = 'button';
    accept.addEventListener('click', () => acceptTask(task, run, accept));
    toolbar.append(accept);
  } else if (!run || !activeStatuses.includes(run.status)) {
    const start = create('button', 'primary', run ? 'Run again' : 'Start run');
    start.type = 'button';
    start.disabled = !onlineWorkers.length || Boolean(app.data.settings?.paused);
    start.title = app.data.settings?.paused ? 'Remote dispatch is paused' : '';
    start.addEventListener('click', () => startTask(task, select.value, start));
    toolbar.append(start);
  } else if (['stopping', 'reconciling'].includes(run.status)) {
    const waiting = create('button', 'secondary', run.status === 'stopping' ? 'Stopping' : 'Awaiting node confirmation');
    waiting.type = 'button';
    waiting.disabled = true;
    toolbar.append(waiting);
  } else {
    const stop = create('button', 'secondary', 'Stop');
    stop.type = 'button';
    stop.addEventListener('click', () => stopRun(run, stop));
    toolbar.append(stop);
  }
  dom.taskDetail.append(toolbar);
}

function renderRunResult(result) {
  const section = create('section', 'subsection run-result');
  const heading = create('div', 'subsection-heading');
  heading.append(create('h3', '', 'Execution Result'), create('span', 'subsection-note', 'Runtime output'));
  section.append(heading, create('div', 'result-content', typeof result === 'string' ? result : safeJson(result)));
  return section;
}

function renderRunSummary(run) {
  const summary = create('div', 'run-summary');
  const usage = formatUsage(run.usage);
  const items = [
    ['Git baseline', run.baseCommit || 'Plain folder / not registered yet'],
    ['Workspace', run.workspace || 'Not registered'],
    ['Session', run.threadId || 'Not registered'],
    ['Token', usage || 'Not available']
  ];
  for (const [label, value] of items) {
    const item = create('div', 'summary-item');
    item.append(create('span', '', label), create('strong', '', value));
    item.title = value;
    summary.append(item);
  }
  if (run.error) summary.append(create('div', 'inline-error full-width', run.error));
  return summary;
}

/** The conversation log groups input, output, tools and artifacts of the same Run, and keeps the current tab on refresh. */
function renderRunTabs(task, run) {
  const logs = partitionRunLog(app.events);
  const tabs = [
    ['input', 'Prompt input'],
    ['output', t('CLI output{v}', { v: logs.output.length ? ` ${logs.output.length}` : '' })],
    ['tools', t('Tool calls{v}', { v: logs.tools.length ? ` ${logs.tools.length}` : '' })],
    ['artifacts', 'Artifacts']
  ];
  const wrapper = create('div', 'run-log-tabs');
  const navigation = create('div', 'run-tab-list');
  navigation.setAttribute('role', 'tablist');
  navigation.setAttribute('aria-label', 'Conversation log categories');
  for (const [key, label] of tabs) {
    const button = create('button', `run-tab${app.detailTab === key ? ' active' : ''}`, label);
    button.type = 'button';
    button.id = `run-tab-${key}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(app.detailTab === key));
    button.setAttribute('aria-controls', 'run-tab-panel');
    button.addEventListener('click', () => {
      app.detailTab = key;
      renderTaskDetail();
      dom.taskDetail.querySelector(`#run-tab-${key}`)?.focus();
    });
    navigation.append(button);
  }
  const panel = create('div', 'run-tab-panel');
  panel.id = 'run-tab-panel';
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', `run-tab-${app.detailTab}`);
  if (app.detailTab === 'input') panel.append(renderRunInput(task, logs.input,run));
  if (app.detailTab === 'output') panel.append(renderRunOutput(run, logs.output));
  if (app.detailTab === 'tools') panel.append(renderRunTools(run, logs.tools));
  if (app.detailTab === 'artifacts') panel.append(renderRunArtifacts(run));
  wrapper.append(navigation, panel);
  return wrapper;
}

function renderRunInput(task, snapshot,run) {
  const section = create('section', 'run-log-content');
  const input = displayRunInput(task, snapshot);
  const contextNote=contextUsageLabel(run?.contextPacket?.context);
  if(contextNote)section.append(create('p','run-log-note',contextNote));
  if (!input.complete) section.append(create('p', 'run-log-note', 'The full CLI input was not saved for this past run; below is only the recorded task request.'));
  else section.append(create('p', 'run-log-note', 'This is the input the platform sent to the CLI this round; it excludes history kept by the CLI itself and vendor built-in prompts.'));
  if(input.instructionsInheritedFrom)section.append(create('p','run-log-note',t('Fixed rules are inherited from the original session run {instructionsInheritedFrom} and are not appended again this round; execution boundaries and tool entries are still shown in full below.', { instructionsInheritedFrom: input.instructionsInheritedFrom })));
  if (input.instructions) {
    section.append(create('h3', '', 'Platform and Role Work Instructions'), create('pre', 'run-log-pre', input.instructions));
  }
  if(input.configurationUpdate)section.append(create('h3','','Native configuration update event'),create('pre','run-log-pre',input.configurationUpdate));
  section.append(create('h3', '', input.complete ? 'Actual input this round' : 'Task request'), create('pre', 'run-log-pre', input.prompt || 'No execution request provided'));
  return section;
}

function renderRunOutput(run, events) {
  const section = create('section', 'run-log-content run-output');
  if (!events.length && !run?.result) section.append(create('div', 'event-empty', run ? 'Waiting for CLI output…' : 'Task has not started yet'));
  let text = '';
  const flushText = () => { if (text) { section.append(create('pre', 'run-log-pre run-output-text', text)); text = ''; } };
  for (const event of events) {
    if (event.type === 'text') { text += stripAnsi(eventPayloadText(event)); continue; }
    flushText();
    const block = create('div', `run-output-entry${event.type === 'error' ? ' error' : ''}`);
    block.append(create('small', '', `${event.type === 'error' ? t('Error') : event.type === 'log' ? t('CLI log') : t('Reply')} · ${formatTime(event.createdAt)}`),
      create('pre', 'run-log-pre', stripAnsi(eventPayloadText(event))));
    section.append(block);
  }
  flushText();
  if (shouldShowFinalResult(run?.result, events)) section.append(renderRunResult(run.result));
  return section;
}

function renderRunTools(run, tools) {
  const section = create('section', 'run-log-content run-tools');
  if (!tools.length) { section.append(create('div', 'event-empty', 'No tool calls this round')); return section; }
  for (const tool of tools) {
    const item = tool.item;
    const card = create('details', 'run-tool-card');
    card.dataset.toolId = String(item.id || `seq:${tool.seq}`);
    const title = item.name || item.command || item.query || item.type || 'Tool';
    const summary = create('summary');
    summary.append(create('strong', '', title), create('span', '', toolStatusLabel(item, run?.status)), create('time', '', formatTime(tool.updatedAt || tool.createdAt)));
    card.append(summary);
    const fields = [
      ['Command', item.command], ['Arguments', item.input], ['Changes', item.changes],
      ['Query', item.query], ['Output', item.aggregatedOutput], ['Result', item.results]
    ];
    for (const [label, value] of fields) {
      if (value == null || value === '') continue;
      const detail = create('div', 'run-tool-field');
      detail.append(create('h4', '', label), create('pre', 'run-log-pre', stripAnsi(typeof value === 'string' ? value : safeJson(value))));
      card.append(detail);
    }
    if (item.exitCode != null) card.append(create('p', 'run-log-note', t('Exit code {exitCode}', { exitCode: item.exitCode })));
    section.append(card);
  }
  return section;
}

function renderRunArtifacts(run) {
  const section = create('section', 'run-log-content');
  if (run?.report) {
    const report = create('div', 'run-artifact-report');
    report.append(create('h3', '', 'Delivery Report'), create('p', '', run.report.summary || ''));
    if (run.report.evidence?.length) report.append(create('pre', 'run-log-pre', run.report.evidence.join('\n')));
    section.append(report);
  }
  if (run) section.append(renderDeliveries(run));
  const files = create('details', 'run-workspace-files');
  files.append(create('summary', '', t('Browse workspace files{v}', { v: app.files.length ? t(' ({v})', { v: app.files.length }) : '' })), renderFiles());
  section.append(files);
  return section;
}

/** Push confirmation is bound to this delivery's SHA and does not grant the Agent arbitrary Git write ability. */
function renderDeliveries(run) {
  const section = create('section', 'subsection');
  const records = (app.data.deliveries || []).filter(d => d.projectId === run.projectId && d.sourceRunId === run.id);
  if (!records.length) return section;
  section.append(create('h3', '', 'Cross-device Git Delivery'));
  const labels = { waiting_source: 'Waiting for the source run to finish', awaiting_approval: 'Awaiting push confirmation', publishing: 'Publishing delivery', ready: 'Available to other devices', blocked: 'Delivery blocked' };
  for (const d of records) {
    const card = create('div', 'approval-card');
    card.append(create('strong', '', labels[d.status] || d.status), create('p', '', d.summary),
      create('p', '', `${d.repoUrl}\n${d.commit}\n${d.ref}`));
    if (d.error) card.append(create('p', 'inline-error', d.error));
    if (!d.approvedAt && ['waiting_source', 'awaiting_approval'].includes(d.status)) {
      const approve = create('button', 'secondary', 'Confirm push of this commit'); approve.type = 'button';
      approve.addEventListener('click', async () => {
        approve.disabled = true;
        try { await api(`/api/projects/${encodeURIComponent(d.projectId)}/deliveries/${encodeURIComponent(d.id)}/approve`, { method: 'POST', json: {} }); await refreshState({ quiet: true }); }
        catch (error) { setError(error.message); approve.disabled = false; }
      });
      card.append(approve);
    }
    section.append(card);
  }
  return section;
}

function renderApprovals(run) {
  const section = create('section', 'subsection');
  const approvals = app.data.approvals.filter((approval) => approval.runId === run.id && ['pending', 'waiting'].includes(approval.status));
  if (!approvals.length) return section;
  const heading = create('div', 'subsection-heading');
  heading.append(create('h3', '', 'Pending Approvals'), create('span', 'subsection-note', t('{v}@@approvals', { v: approvals.length })));
  section.append(heading);
  for (const approval of approvals) {
    const card = create('div', 'approval-card');
    const detail = [approval.method, approval.params ? safeJson(approval.params) : '', approval.expiresAt ? t('Valid until {time}', { time: formatTime(approval.expiresAt) }) : '']
      .filter(Boolean).join('\n');
    card.append(create('p', '', detail || 'Runtime requests manual confirmation'));
    const actions = create('div', 'approval-actions');
    const accept = create('button', 'primary compact', 'Approve');
    const decline = create('button', 'secondary compact', 'Reject');
    accept.type = decline.type = 'button';
    accept.addEventListener('click', () => decideApproval(approval, 'accept', accept, decline));
    decline.addEventListener('click', () => decideApproval(approval, 'decline', decline, accept));
    actions.append(accept, decline);
    card.append(actions);
    section.append(card);
  }
  return section;
}

function renderFiles() {
  const section = create('section', 'subsection');
  const heading = create('div', 'subsection-heading');
  heading.append(create('h3', '', 'Workspace Files'), create('span', 'subsection-note', t('{v}@@files', { v: app.files.length })));
  const list = create('div', 'file-list');
  if (!app.files.length) {
    list.append(create('div', 'event-empty', 'No workspace files to browse'));
  } else {
    for (const file of app.files) {
      const button = create('button', 'file-button');
      button.type = 'button';
      button.append(create('span', '', file.path), create('small', '', formatBytes(file.size)));
      button.addEventListener('click', () => openFile(file.path));
      list.append(button);
    }
  }
  section.append(heading, create('p', 'run-log-note', 'These are the files browsable in the current workspace; not all were produced this round. This round\'s deliverables are defined by the report and Git delivery records.'), list);
  return section;
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function eventPayloadText(event) {
  const payload = event.payload ?? {};
  if (event.type === 'status') return statusLabels[payload.status] || payload.status || safeJson(payload);
  if (event.type === 'text' || event.type === 'message') return payload.text || payload.message || safeJson(payload);
  if (event.type === 'tool') return payload.text || payload.name || safeJson(payload);
  if (event.type === 'usage') return formatUsage(payload) || safeJson(payload);
  if (event.type === 'error') return payload.error || payload.message || payload.text || safeJson(payload);
  return payload.text || payload.message || safeJson(payload);
}

function formatUsage(usage) {
  if (!usage) return '';
  if (typeof usage === 'number' || typeof usage === 'string') return String(usage);
  const input = usage.inputTokens ?? usage.input_tokens;
  const cachedInput = usage.cachedInputTokens ?? usage.cached_input_tokens;
  const output = usage.outputTokens ?? usage.output_tokens;
  const total = usage.totalTokens ?? usage.total_tokens;
  const parts = [];
  if (input !== undefined) parts.push(t('Input {input}', { input }));
  if (cachedInput !== undefined) parts.push(t('Cached input {cachedInput}', { cachedInput }));
  if (output !== undefined) parts.push(t('Output {output}', { output }));
  if (total !== undefined) parts.push(t('Total {total}', { total }));
  return parts.join(' / ') || safeJson(usage);
}

function formatBytes(size) {
  if (!Number.isFinite(Number(size))) return 'Size unknown';
  const bytes = Number(size);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/** Event deltas are shown first; a slow remote file query does not block the CLI's streamed output. */
async function refreshRunDetails() {
  if (!dom.runDialog.open) return;
  const task = getCurrentTask();
  const run = task ? getDetailRun(task.id) : null;
  if (run?.id !== app.loadedRunId) {
    app.events = [];
    app.files = [];
    app.detailError = '';
    app.loadedRunId = run?.id || null;
  }
  if (!run) {
    if(task?.summaryOnly&&app.fullTask?.id!==task.id) {
      const version=app.requestVersion;
      const key=`task:${task.id}`;
      if(app.detailFetch?.id!==key)app.detailFetch={id:key,promise:api(`/api/tasks/${encodeURIComponent(task.id)}/detail`)};
      const pending=app.detailFetch;
      try {
        const detail=await pending.promise;
        if(version!==app.requestVersion||app.selectedTaskId!==task.id||!dom.runDialog.open)return;
        app.fullTask=detail.task;
      }catch(error){if(version===app.requestVersion&&app.selectedTaskId===task.id)app.detailError=t('Details: {message}', { message: error.message });}
      finally{if(app.detailFetch===pending)app.detailFetch=null;}
    }
    renderTaskDetail();
    return;
  }
  const version = app.requestVersion;
  const stillCurrent = () => dom.runDialog.open && version === app.requestVersion && app.selectedTaskId === task.id && getDetailRun(task.id)?.id === run.id;
  if(run.summaryOnly && (app.fullRun?.id!==run.id || app.fullRun?.lastSeq!==run.lastSeq)) {
    if(app.detailFetch?.id!==run.id)app.detailFetch={id:run.id,promise:api(`/api/runs/${encodeURIComponent(run.id)}/detail`)};
    const pending=app.detailFetch;
    try {
      const detail=await pending.promise;
      if(!stillCurrent())return;
      app.fullRun=detail.run;app.fullTask=detail.task;renderTaskDetail();
    }catch(error){if(stillCurrent())app.detailError=t('Details: {message}', { message: error.message });}
    finally{if(app.detailFetch===pending)app.detailFetch=null;}
  }
  if(!stillCurrent())return;
  const after = app.events.at(-1)?.seq || 0;
  const events = api(`/api/runs/${encodeURIComponent(run.id)}/events?after=${after}`).then(result => {
    if (!stillCurrent()) return;
    app.events = mergeRunEvents(app.events, Array.isArray(result.events) ? result.events : []);
    if ((app.detailError.startsWith('Events: ') || app.detailError.startsWith(t('Events: ')))) app.detailError = '';
    renderTaskDetail();
  }).catch(error => {
    if (!stillCurrent()) return;
    app.detailError = t('Events: {message}', { message: error.message });
    renderTaskDetail();
  });
  const files = api(`/api/runs/${encodeURIComponent(run.id)}/files`).then(result => {
    if (!stillCurrent()) return;
    app.files = Array.isArray(result.files) ? result.files : [];
    if ((app.detailError.startsWith('Files: ') || app.detailError.startsWith(t('Files: ')))) app.detailError = '';
    renderTaskDetail();
  }).catch(error => {
    if (!stillCurrent()) return;
    app.detailError = t('Files: {message}', { message: error.message });
    renderTaskDetail();
  });
  await Promise.allSettled([events, files]);
}

/**
 * A write operation's commandId is kept while the network state is uncertain; it is released only after a definite HTTP result.
 */
async function commandRequest(key, path, json, button) {
  const commandId = app.commands[key] || crypto.randomUUID();
  app.commands[key] = commandId;
  saveCommands();
  button.disabled = true;
  const original = button.textContent;
  button.textContent = 'Submitting…';
  try {
    const result = await api(path, { method: 'POST', json: { ...json, commandId } });
    delete app.commands[key];
    saveCommands();
    setError('');
    return result;
  } catch (error) {
    if (!error.isNetworkError) {
      delete app.commands[key];
      saveCommands();
    }
    setError(error.isNetworkError ? t('{message}\nClick again; the system will reuse the same commandId to look up the original operation.', { message: error.message }) : error.message);
    return null;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function startTask(task, nodeId, button) {
  if (!nodeId) return setError('Please select an online execution node.');
  const result = await commandRequest(`start:${task.id}`, `/api/tasks/${encodeURIComponent(task.id)}/start`, { nodeId }, button);
  if (result) await refreshState({ quiet: true });
}

async function stopRun(run, button) {
  const result = await commandRequest(`stop:${run.id}`, `/api/runs/${encodeURIComponent(run.id)}/stop`, {}, button);
  if (result) await refreshState({ quiet: true });
}

async function acceptTask(task, run, button) {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = 'Accepting…';
  try {
    await api(`/api/tasks/${encodeURIComponent(task.id)}/accept`, { method: 'POST', json: { runId: run.id } });
    setError('');
    await refreshState({ quiet: true });
  } catch (error) {
    setError(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function decideApproval(approval, decision, button, sibling) {
  sibling.disabled = true;
  const result = await commandRequest(`approval:${approval.id}:${decision}`, `/api/approvals/${encodeURIComponent(approval.id)}`, { decision }, button);
  sibling.disabled = false;
  if (result) await refreshState({ quiet: true });
}

async function openFile(path) {
  const task = getCurrentTask();
  const run = task ? getLatestRun(task.id) : null;
  if (!run) return;
  const version = ++app.fileReadVersion;
  const current = () => version === app.fileReadVersion && dom.fileDialog.open;
  dom.fileDialogTitle.textContent = path;
  dom.fileContent.textContent = 'Reading…';
  dom.fileDialog.showModal();
  try {
    const content = await fetchFile(`/api/runs/${encodeURIComponent(run.id)}/file?path=${encodeURIComponent(path)}`);
    if (current()) dom.fileContent.textContent = content;
  } catch (error) {
    if (current()) dom.fileContent.textContent = t('Read failed: {message}', { message: error.message });
  }
}

function showProjectForm(show) {
  if (show) app.view = 'workspace';
  dom.projectFormPanel.hidden = !show;
  if (show) {
    mobilePanel('chat'); projectsUI.refreshNodes();
    hydrateForm(dom.projectForm, app.drafts.project);
    dom.projectForm.elements.name.focus();
  }
  renderWorkspace();
}

function hydrateForm(form, draft) {
  for (const [name, value] of Object.entries(draft || {})) {
    if (form.elements[name]) form.elements[name].value = value;
  }
}

function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

/** EventSource cannot set auth headers; when a Token exists, switch explicitly to a single polling channel. */
function connectUpdates() {
  disconnectUpdates();
  if (app.token) {
    startPolling();
    setConnection('Token auth · 10 s polling');
    return;
  }
  startSse();
}

function disconnectUpdates() {
  app.eventSource?.close();
  app.eventSource = null;
  clearInterval(app.pollTimer);
  app.pollTimer = null;
  clearTimeout(app.sseRetryTimer);
  app.sseRetryTimer = null;
}

function startPolling() {
  if (app.pollTimer) return;
  app.pollTimer = setInterval(() => refreshState({ quiet: true }), POLL_INTERVAL);
}

function startSse() {
  if (app.token || app.eventSource) return;
  const source = new EventSource('/api/events');
  app.eventSource = source;
  source.addEventListener('open', () => {
    clearInterval(app.pollTimer);
    app.pollTimer = null;
    setConnection('Connected · live updates');
  });
  source.addEventListener('change', () => refreshState({ quiet: true }));
  source.onerror = () => {
    source.close();
    if (app.eventSource === source) app.eventSource = null;
    setConnection('Live connection interrupted · 10 s polling');
    startPolling();
    if (!app.sseRetryTimer) {
      app.sseRetryTimer = setTimeout(() => {
        app.sseRetryTimer = null;
        startSse();
      }, SSE_RETRY_INTERVAL);
    }
  };
}


const SIDEBAR_KEY = 'agent-workbench.project-sidebar';
function setProjectSidebarMode(mode) {
  const next = ['expanded', 'collapsed', 'hidden'].includes(mode) ? mode : 'expanded';
  document.body.dataset.projectSidebar = next;
  sessionStorage.setItem(SIDEBAR_KEY, next);
  const toggle = document.querySelector('#toggle-project-sidebar');
  const brandMark = document.querySelector('#toggle-project-sidebar-collapse');
  if (toggle) {
    toggle.setAttribute('aria-pressed', String(next !== 'expanded'));
    toggle.textContent = next === 'hidden' ? 'Show projects' : 'Hide projects';
  }
  if (brandMark) {
    const collapsed = next === 'collapsed';
    brandMark.setAttribute('aria-label', collapsed ? 'Expand project menu' : 'Collapse project menu');
    brandMark.title = collapsed ? 'Expand' : 'Collapse';
    brandMark.setAttribute('aria-pressed', String(collapsed));
  }
}
setProjectSidebarMode(sessionStorage.getItem(SIDEBAR_KEY) || 'expanded');
document.querySelector('#toggle-project-sidebar-collapse')?.addEventListener('click', () => {
  if (drawers.isMobile()) { mobilePanel('chat'); return; }
  const cur = document.body.dataset.projectSidebar || 'expanded';
  // Avatar only toggles expanded ↔ collapsed (not hidden).
  setProjectSidebarMode(cur === 'collapsed' ? 'expanded' : 'collapsed');
});
document.querySelector('#toggle-project-sidebar')?.addEventListener('click', () => {
  const cur = document.body.dataset.projectSidebar || 'expanded';
  setProjectSidebarMode(cur === 'hidden' ? 'expanded' : 'hidden');
});

document.querySelector('#show-project-form').addEventListener('click', () => showProjectForm(true));
document.querySelector('#empty-create-project').addEventListener('click', () => showProjectForm(true));
document.querySelector('#close-project-form').addEventListener('click', () => showProjectForm(false));
document.querySelector('#cancel-project').addEventListener('click', () => showProjectForm(false));
document.querySelector('#show-history').addEventListener('click', () => { renderTasks(); document.querySelector('#history-dialog').showModal(); });
document.querySelector('#close-history').addEventListener('click', () => document.querySelector('#history-dialog').close());
document.querySelector('#close-device-edit').addEventListener('click', () => document.querySelector('#device-edit-dialog').close());
document.querySelector('#device-edit-dialog').addEventListener('close', () => document.querySelector('#device-edit-content').replaceChildren());
document.querySelector('#close-run').addEventListener('click', () => { dom.runDialog.close(); app.requestVersion++; });
document.querySelector('#refresh-state').addEventListener('click', () => refreshState());
document.querySelector('#close-file-dialog').addEventListener('click', () => dom.fileDialog.close());
dom.fileDialog.addEventListener('close', () => { app.fileReadVersion++; });

dom.saveToken?.addEventListener('click', async () => {
  const candidate=dom.apiToken.value.trim(),feedback=document.querySelector('#api-token-error');
  dom.saveToken.disabled=true;feedback.hidden=true;
  try {
    const response=await fetch('/api/state',{headers:candidate?{Authorization:`Bearer ${candidate}`}:{}});
    if(!response.ok)throw new Error(response.status===401?'Incorrect Home access token; please enter it again.':t('Home verification failed (HTTP {status})', { status: response.status }));
    saveApiToken(candidate);
    app.token=candidate;app.authPromptShown=false;
    connectUpdates();await refreshState();document.querySelector('#api-token-dialog').close();void syncLanguage();
  } catch(error) {feedback.textContent=error.message;feedback.hidden=false;}
  finally {dom.saveToken.disabled=false;}
});
document.querySelector('#edit-api-token')?.addEventListener('click', () => {
  const feedback=document.querySelector('#api-token-error');if(feedback)feedback.hidden=true;
  dom.apiToken.value = app.token;
  document.querySelector('#api-token-dialog').showModal();
  dom.apiToken.focus();
});
for (const id of ['#close-api-token-dialog', '#cancel-api-token-dialog']) document.querySelector(id)?.addEventListener('click', () => document.querySelector('#api-token-dialog').close());
document.querySelector('#api-token-dialog')?.addEventListener('close', () => { dom.apiToken.value = app.token; });
window.addEventListener('storage', event => {
  if (event.storageArea !== localStorage || (event.key !== TOKEN_KEY && event.key !== null)) return;
  app.token=readApiToken();app.authPromptShown=false;
  dom.apiToken.value=app.token;
  connectUpdates();void refreshState();
});

document.querySelector('#show-app-settings')?.addEventListener('click', () => openSettings('devices'));
document.querySelector('#show-remote-desktop')?.addEventListener('click', () => openDesktopDialog());
document.querySelector('#start-remote-desktop')?.addEventListener('click', () => void startDesktopChain());
document.querySelector('#remote-desktop-device')?.addEventListener('change', () => { invalidateDesktopChain(); resetDesktopSteps(); dom.desktopFeedback.textContent = 'Click "Open desktop" to start checking the selected server.'; });
for (const id of ['#close-remote-desktop-dialog', '#dismiss-remote-desktop-dialog']) document.querySelector(id)?.addEventListener('click', () => dom.desktopDialog.close());
dom.desktopDialog.addEventListener('close', invalidateDesktopChain);
document.querySelector('#show-token-usage')?.addEventListener('click', () => openSettings('usage'));
document.querySelector('#show-scheduled-jobs')?.addEventListener('click', () => openSettings('timers'));
document.querySelector('#open-project-timers')?.addEventListener('click', () => { schedulesUI.select(getCurrentProject()?.id || ''); openSettings('timers'); });
document.querySelector('#close-settings-page')?.addEventListener('click', closeSettings);
dom.settingsPage?.querySelectorAll('[data-settings-tab]').forEach(button => {
  button.addEventListener('click', () => openSettings(button.dataset.settingsTab));
});

dom.promptsForm?.addEventListener('input', renderPlatformPromptPreview);
document.querySelectorAll('[data-prompt-edit]').forEach(button => button.addEventListener('click', () => openPromptEditor(button.dataset.promptEdit)));
document.querySelector('#edit-conversation-organizer')?.addEventListener('click',()=>{
  const saved=app.data.settings?.conversationOrganizer||{};
  for(const key of ['nodeId','runtime','model','effort'])organizerForm.elements[key].value='';
  refreshOrganizerChoices(saved);
  organizerForm.elements.prompt.value=saved.prompt||'';
  document.querySelector('#conversation-organizer-feedback').hidden=true;
  organizerDialog.showModal();
});
for(const id of ['#close-conversation-organizer','#cancel-conversation-organizer'])document.querySelector(id)?.addEventListener('click',()=>organizerDialog.close());
organizerForm?.elements.nodeId?.addEventListener('change',()=>refreshOrganizerChoices({nodeId:organizerForm.elements.nodeId.value}));
organizerForm?.elements.runtime?.addEventListener('change',()=>refreshOrganizerChoices({nodeId:organizerForm.elements.nodeId.value,runtime:organizerForm.elements.runtime.value}));
organizerForm?.elements.model?.addEventListener('change',()=>refreshOrganizerChoices({nodeId:organizerForm.elements.nodeId.value,runtime:organizerForm.elements.runtime.value,model:organizerForm.elements.model.value}));
organizerForm?.addEventListener('submit',async event=>{
  event.preventDefault();const button=organizerForm.querySelector('[type=submit]');button.disabled=true;
  const feedback=document.querySelector('#conversation-organizer-feedback');feedback.hidden=true;
  try {
    const values=Object.fromEntries(new FormData(organizerForm));
    app.data.settings.conversationOrganizer=await api('/api/settings/conversation-organizer',{method:'POST',json:values});
    renderPlatformPrompts();organizerDialog.close();
  } catch(error) {feedback.textContent=error.message;feedback.hidden=false;}
  finally {button.disabled=false;}
});
for (const id of ['#close-platform-prompts-dialog', '#cancel-platform-prompts-dialog']) document.querySelector(id)?.addEventListener('click', () => dom.promptsDialog.close());
dom.promptsDialog?.addEventListener('close', renderPlatformPrompts);
dom.promptsForm?.elements.defaultSupervisorRuntime?.addEventListener('change', event => {
  renderSupervisorDefaultChoices({ defaultSupervisorRuntime: event.target.value });
});
dom.promptsForm?.elements.defaultSupervisorModel?.addEventListener('change', event => {
  renderSupervisorDefaultChoices({
    defaultSupervisorRuntime: dom.promptsForm.elements.defaultSupervisorRuntime.value,
    defaultSupervisorModel: event.target.value
  });
});
document.querySelector('#restore-platform-prompts')?.addEventListener('click', () => {
  const mode = dom.promptsDialog.dataset.editMode;
  if (mode === 'platform') dom.promptsForm.elements.platformPrompt.value = app.data.promptDefaults?.platformPrompt || '';
  if (mode === 'supervisor' || mode === 'supervisor-prompt') dom.promptsForm.elements.supervisorPrompt.value = app.data.promptDefaults?.supervisorPrompt || '';
  dom.promptsFeedback.textContent = 'Prompts have been restored to their defaults; click "Save settings" to apply.';
  dom.promptsFeedback.hidden = false;
  renderPlatformPromptPreview();
});
dom.promptsForm?.addEventListener('submit', async event => {
  event.preventDefault();
  const button = dom.promptsForm.querySelector('[type="submit"]');
  const values = Object.fromEntries(new FormData(dom.promptsForm));
  button.disabled = true;
  dom.promptsFeedback.hidden = true;
  try {
    app.data.settings = await api('/api/settings/prompts', { method: 'POST', json: dom.promptsDialog.dataset.editMode==='supervisor-prompt'?{supervisorPrompt:values.supervisorPrompt}:values });
    renderSupervisorDefaultChoices(app.data.settings);
    dom.promptsUpdated.textContent = t('Last saved: {time}', { time: formatTime(app.data.settings.promptsUpdatedAt) });
    dom.promptsDialog.close();
  } catch (error) {
    dom.promptsFeedback.textContent = error.message;
    dom.promptsFeedback.hidden = false;
  } finally {
    button.disabled = false;
  }
});

dom.projectForm.addEventListener('input', () => {
  app.drafts.project = formValues(dom.projectForm);
  saveDrafts();
});

let pendingProjectRequest;
dom.projectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = dom.projectForm.querySelector('[type="submit"]');
  const values = formValues(dom.projectForm);
  pendingProjectRequest ||= crypto.randomUUID(); values.requestId=pendingProjectRequest;
  values.supervisor = setupUI.selection();
  for (const key of ['root', 'repoUrl', 'nodeId', 'supervisorNodeId', 'supervisorRuntime', 'supervisorModel', 'supervisorEffort']) delete values[key];
  button.disabled = true;
  try {
    const project = await api('/api/projects', { method: 'POST', json: values });
    pendingProjectRequest=null;
    let repositoryError='';
    if(values.repositoryMode!=='none'){
      try {
        const result=await api(`/api/projects/${project.id}/repositories`,{method:'POST',json:{key:'code',mode:values.repositoryMode,repoUrl:values.repositoryUrl,
          baseBranch:values.baseBranch,accountId:values.hostingAccountId,remoteName:values.folderName,nodeIds:[values.supervisor.nodeId]}});
        if(result.status==='blocked')repositoryError=result.results.filter(r=>r.error).map(r=>r.error).join(t('; '));
      }catch(e){repositoryError=e.message;}
    }
    app.drafts.project = {};
    saveDrafts();
    dom.projectForm.reset();
    selectProject(project.id);
    showProjectForm(false);
    await refreshState();
    if(repositoryError){openSettings('project');setError(t('Project created, but the repository is not finished: {repositoryError}', { repositoryError }));}
  } catch (error) {
    setError(error.message);
  } finally {
    button.disabled = false;
  }
});

async function toggleRemotePause() {
  const nextPaused = !app.data.settings?.paused;
  for (const button of [dom.pauseRemote, dom.settingsPauseRemote].filter(Boolean)) button.disabled = true;
  try {
    await api('/api/settings', { method: 'POST', json: { paused: nextPaused } });
    await refreshState({ quiet: true });
  } catch (error) {
    setError(error.message);
  } finally {
    for (const button of [dom.pauseRemote, dom.settingsPauseRemote].filter(Boolean)) button.disabled = false;
  }
}
dom.pauseRemote.addEventListener('click', toggleRemotePause);
dom.settingsPauseRemote?.addEventListener('click', toggleRemotePause);

window.addEventListener('beforeunload', disconnectUpdates);

document.querySelector('#close-workspace-dialog').addEventListener('click', () => dom.workspaceDialog.close());
dom.bindingForm.addEventListener('submit', async event => {
  event.preventDefault();
  const target = { ...app.bindingTarget };
  const button = dom.bindingForm.querySelector('[type="submit"]');
  const localRoot = dom.bindingForm.elements.localRoot.value.trim();
  button.disabled = true;
  button.textContent = 'Checking node…';
  dom.bindingError.hidden = true;
  try {
    await api(`/api/projects/${encodeURIComponent(target.projectId)}/workspaces/${encodeURIComponent(target.nodeId)}`, { method: 'POST', json: { localRoot } });
    dom.workspaceDialog.close();
    await refreshState({ quiet: true });
  } catch (error) {
    dom.bindingError.textContent = error.message;
    dom.bindingError.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'Check and save';
  }
});

/* Language setting: i18n.js owns the choice (localStorage 'wb.language'); Home keeps a copy via GET/PUT /api/language. */
const languageSelect = document.querySelector('#language-select');
function showLanguageChoice() { if (languageSelect) languageSelect.value = getLanguage(); }
languageSelect?.addEventListener('change', () => setLanguage(languageSelect.value));
onLanguageChange(() => {
  showLanguageChoice();
  // Text built in JavaScript is regenerated from the current state; static text is handled by the DOM translator.
  // Each step is independent so one failing renderer cannot leave the rest of the page in the old language.
  for (const step of [
    render,
    () => { if (dom.promptsDialog?.open) renderPlatformPromptPreview(); else renderPlatformPrompts(); },
    () => tokenUI.refresh(),
    () => { if (app.view === 'settings' && app.settingsTab === 'usage') tokenUI.show(); }
  ]) {
    try { step(); } catch (error) { console.warn('Re-render after language change failed', error); }
  }
});
showLanguageChoice();
function syncLanguage() {
  return syncLanguageWithBackend({
    get: () => api('/api/language'),
    put: language => api('/api/language', { method: 'PUT', json: { language } })
  }).then(showLanguageChoice);
}

connectUpdates();
refreshState().finally(() => void syncLanguage());
