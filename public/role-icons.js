/** Product marks and CLI icons are all SVG so they stay crisp at small sizes. */
/** Project marks differ in both shape and color, so they are recognizable in the collapsed sidebar without text or color alone. */
export const PROJECT_ICONS = [
  { name:'Cube', color:'#0866df', background:'#e7f0ff', path:'<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>' },
  { name:'Rocket', color:'#7147d8', background:'#eee8ff', path:'<path d="M14 4c2-1 4-1 6-1 0 2 0 4-1 6l-7 7-5-5 7-7Z"/><circle cx="16" cy="7" r="1.5"/><path d="m7 11-4 1 1-5 6-1m2 10-1 5 5-1 1-6M7 16l-3 4"/>' },
  { name:'Bolt', color:'#be7108', background:'#fff2d6', path:'<path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z"/>' },
  { name:'Star', color:'#d04576', background:'#ffe8f0', path:'<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>' },
  { name:'Compass', color:'#008b91', background:'#dcf5f4', path:'<circle cx="12" cy="12" r="9"/><path d="m16 8-2 6-6 2 2-6 6-2Z"/>' },
  { name:'Diamond', color:'#a148c0', background:'#f6e7fc', path:'<path d="M7 4h10l5 6-10 11L2 10l5-6Z"/><path d="M2 10h20M7 4l5 17 5-17"/>' },
  { name:'Peak', color:'#3962b9', background:'#e8edfc', path:'<path d="m2 20 8-15 6 10 3-5 4 10H2Z"/><path d="m7 11 3 2 3-2"/>' },
  { name:'Leaf', color:'#19844c', background:'#e2f4e8', path:'<path d="M20 3C8 2 3 7 5 15c8 5 16-2 15-12Z"/><path d="M3 21 15 9m-7 7v-5m0 5h5"/>' },
  { name:'Target', color:'#d05230', background:'#ffece4', path:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>' },
  { name:'Planet', color:'#4c59c7', background:'#e9ebff', path:'<circle cx="12" cy="12" r="7"/><ellipse cx="12" cy="12" rx="12" ry="3.5" transform="rotate(-30 12 12)"/>' }
];

/** Keep existing assignments; new projects prefer unused icons; beyond ten, icons are reused evenly. */
export function assignProjectIcons(projects, saved = {}) {
  const assignments = new Map();
  const counts = PROJECT_ICONS.map(() => 0);
  for (const project of projects) {
    const index = saved?.[project.id];
    if (Number.isInteger(index) && index >= 0 && index < counts.length) {
      assignments.set(project.id, index);
      counts[index]++;
    }
  }
  for (const project of [...projects].sort((a,b) => String(a.createdAt || a.id).localeCompare(String(b.createdAt || b.id)) || a.id.localeCompare(b.id))) {
    if (assignments.has(project.id)) continue;
    const index = counts.indexOf(Math.min(...counts));
    assignments.set(project.id, index);
    counts[index]++;
  }
  return Object.fromEntries(assignments);
}

/** The cache stores only project IDs and icon indexes; rendering still works when storage is unavailable. */
export function projectIconAssignments(projects) {
  const key = 'agent-workbench.project-icons';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(key) || '{}'); } catch {}
  const assignments = assignProjectIcons(projects, saved);
  try {
    const encoded = JSON.stringify(assignments);
    if (localStorage.getItem(key) !== encoded) localStorage.setItem(key, encoded);
  } catch {}
  return assignments;
}

/** Graphics come only from built-in constants; user content such as project names is never inserted. */
export function projectIconEl(index) {
  const icon = PROJECT_ICONS[index] || PROJECT_ICONS[0];
  const element = document.createElement('span');
  element.className = 'project-item-icon';
  element.setAttribute('aria-hidden', 'true');
  element.style.setProperty('--project-icon-color', icon.color);
  element.style.setProperty('--project-icon-background', icon.background);
  element.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icon.path}</svg>`;
  return element;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function iconEl(svg, className, title) {
  const node = el('span', className);
  node.innerHTML = svg;
  if (title) node.title = title;
  const drawn = node.querySelector('svg');
  if (drawn) {
    drawn.setAttribute('aria-hidden', 'true');
    drawn.removeAttribute('width');
    drawn.removeAttribute('height');
  }
  return node;
}

const MACHINE = {
  darwin: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="12" rx="2"/><path d="m4 16-2 4h20l-2-4M10 17h4"/></svg>',
  linux: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M8 6.5h.01M8 17.5h.01M12 6.5h4M12 17.5h4"/></svg>',
  win32: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="13" rx="2"/><path d="M12 16v5M8 21h8"/></svg>',
  cloud: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 19a5 5 0 0 1-1-9.9 6.5 6.5 0 0 1 12.5 1.4A4.3 4.3 0 0 1 18 19Z"/></svg>'
};

const AGENT = {
  opencode: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#182330"/><path d="m9 7-5 5 5 5m6-10 5 5-5 5" fill="none" stroke="#f5f8fc" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"/><path d="m13 6-2 12" stroke="#7fb4ed" stroke-width="1.8"/></svg>',
  claude: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#D97757"/><g transform="translate(2.15 2.15) scale(0.82)" fill="#fff" fill-rule="nonzero"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></g></svg>',
  codex: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#17213A"/><path d="m8.7 7.2-4 4.8 4 4.8M11.3 17.3l2.1-10.6M15.4 8.4h3.9M14.8 12h4.5M14.1 15.6h3.7" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="18.9" cy="5.4" r="1.7" fill="#7C8CFF"/></svg>',
  grok: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 509.641" fill-rule="evenodd" clip-rule="evenodd"><path fill="#111" d="M115.612 0h280.776C459.975 0 512 52.026 512 115.612v278.416c0 63.587-52.025 115.613-115.612 115.613H115.612C52.026 509.641 0 457.615 0 394.028V115.612C0 52.026 52.026 0 115.612 0z"/><path fill="#fff" d="M213.235 306.019l178.976-180.002v.169l51.695-51.763c-.924 1.32-1.86 2.605-2.785 3.89-39.281 54.164-58.46 80.649-43.07 146.922l-.09-.101c10.61 45.11-.744 95.137-37.398 131.836-46.216 46.306-120.167 56.611-181.063 14.928l42.462-19.675c38.863 15.278 81.392 8.57 111.947-22.03 30.566-30.6 37.432-75.159 22.065-112.252-2.92-7.025-11.67-8.795-17.792-4.263l-124.947 92.341zm-25.786 22.437l-.033.034L68.094 435.217c7.565-10.429 16.957-20.294 26.327-30.149 26.428-27.803 52.653-55.359 36.654-94.302-21.422-52.112-8.952-113.177 30.724-152.898 41.243-41.254 101.98-51.661 152.706-30.758 11.23 4.172 21.016 10.114 28.638 15.639l-42.359 19.584c-39.44-16.563-84.629-5.299-112.207 22.313-37.298 37.308-44.84 102.003-1.128 143.81z"/></svg>',
  agy: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#111827"/><path d="M4.2 18.5C7.5 15.3 7.7 5 12 5s4.5 10.3 7.8 13.5" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round"/><path d="M8.2 16.2c1-2 2.1-3 3.8-3s2.8 1 3.8 3" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round"/><circle cx="5.3" cy="6" r="1.3" fill="#EA4335"/><circle cx="8.7" cy="3.8" r="1.2" fill="#FBBC05"/><circle cx="15.3" cy="3.8" r="1.2" fill="#34A853"/><circle cx="18.7" cy="6" r="1.3" fill="#4285F4"/></svg>',
  fallback: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#e8f2ff"/><circle cx="12" cy="10" r="3.1" fill="#0866ff"/><path d="M6.8 18.2c.7-2.6 2.6-3.9 5.2-3.9s4.5 1.3 5.2 3.9" fill="#0866ff"/></svg>'
};

const AGENT_IMAGE = {
  codex: '/agent-codex.png?v=white-20260922',
  agy: '/agent-antigravity.png'
};

export function workerKind(worker) {
  if (worker?.nodeKind === 'local' || worker?.nodeKind === 'cloud') return worker.nodeKind;
  return worker?.platform === 'linux' ? 'cloud' : 'local';
}

export function workerDisplayName(worker) {
  const kind = workerKind(worker) === 'cloud' ? 'Cloud server' : 'This machine';
  return `${kind} · ${worker?.name || worker?.id || 'Unnamed device'}`;
}

/** The role bar shows only states that need user judgment; Runtime details and logs are not spread across the list. */
export function roleActivity(role, tasks = [], runs = [], {requests=[],warm=false,worker,check}={}) {
  const configured = role?.configured !== false && Boolean(role?.nodeId && role?.runtime && role?.model);
  if (!configured) return { tone: 'setup', label: 'Setup needed', detail: 'Select a device, CLI and model' };
  if (!role.enabled) return { tone: 'idle', label: 'Disabled', detail: 'Will not receive new assignments' };
  const ownTasks=tasks.filter(item=>item.roleId===role.id || item.roleSnapshot?.id===role.id);
  const queued=ownTasks.filter(t=>t.status==='ready');
  const discussionRun=runs.find(r=>r.roleId===role.id&&r.discussionDeliveryId&&['queued','starting','running','waiting_user','stopping','reconciling'].includes(r.status));
  if(discussionRun)return {tone:discussionRun.status==='reconciling'?'blocked':'working',label:discussionRun.status==='reconciling'?'To reconcile':discussionRun.turnPurpose==='clarification'?'Clarifying':'Handling reply',detail:ownTasks.some(t=>t.discussionWait)?'Business task still waiting · this round only handles discussion':'This round only handles peer discussion and does not change business task status'};
  const task = ownTasks.find(t=>runs.some(r=>r.id===t.currentRunId&&['queued','starting','running','waiting_user','stopping','reconciling'].includes(r.status))) || queued[0] || ownTasks.at(-1);
  const run = task?.currentRunId ? runs.find(item => item.id === task.currentRunId) : null;
  if (run?.status === 'waiting_user') return { tone: 'waiting', label: 'Awaiting approval', detail: task.title || 'Needs user action' };
  if (run?.status === 'reconciling') return { tone: 'blocked', label: 'To reconcile', detail: task.title || 'Execution state needs reconciling' };
  if (['queued', 'starting', 'running', 'stopping'].includes(run?.status)) {
    return { tone: 'working', label: run.status === 'stopping' ? 'Stopping' : 'Working', detail: `${task.title || 'Running'}${queued.length?` · ${queued.length} queued`:''}` };
  }
  if (task?.status === 'ready') return { tone: 'waiting', label: 'Waiting', detail: `${queued.length} queued · ${task.waitingReason || 'Waiting to be scheduled'}` };
  if(task?.status==='waiting_discussion')return {tone:'waiting',label:task.discussionWait?'Awaiting reply':'Awaiting continuation',detail:task.waitingReason||'Waiting for the current question to be handled'};
  // A Task's blocked status is a legacy summary state; it must not override the real Run final state or reuse a pre-start lock wait reason.
  if (run?.status === 'failed') return currentRuntimeActivity(role,worker,check,run.updatedAt||run.createdAt) || { tone: 'blocked', label: 'Execution failed', detail: run.error || 'This round failed; see the logs' };
  if (run?.status === 'interrupted') return currentRuntimeActivity(role,worker,check,run.updatedAt||run.createdAt) || { tone: 'idle', label: 'Stopped', detail: 'This round was stopped' };
  const request=task?requests.find(r=>r.targetRoleId===role.id&&(r.taskId===task.id||(run&&r.currentRunId===run.id))):null;
  if(request?.status==='waiting_call'&&!request.continuationRequestId)return {tone:'waiting',label:'Awaiting reply',detail:warm?'Awaiting reply · CLI ready':'Waiting for other roles to reply'};
  if(request?.status==='cancelled'||task?.status==='cancelled')return {tone:'idle',label:'Stopped',detail:'This round was cancelled'};
  if (run?.status === 'succeeded') {
    const outcome=request?.outcome||run.report?.verdict;
    if(['failed','blocked','needs_input'].includes(outcome))return {tone:'waiting',label:{failed:'Verdict: not passed',blocked:'Verdict: blocked',needs_input:'Awaiting answer'}[outcome],detail:(request?.reportSummary||'Execution finished; see this round\'s verdict').slice(0,160)};
  // A start-up block with no Run may come from the workspace/scheduler; a CLI probe does not prove it is resolved, and the creation time is not the failure time.
  } else if (task?.status === 'blocked') return { tone: 'blocked', label: 'Not started', detail: task.error || 'Task did not start; see the logs' };
  const detected=currentRuntimeActivity(role,worker,check);
  if(detected)return detected;
  if(warm)return {tone:'idle',label:'Idle',detail:'CLI ready · conversation can continue'};
  return { tone: 'idle', label: 'Idle', detail: 'Waiting to be mentioned' };
}

/** The current probe only updates availability of idle roles; it does not override running/waiting states or rewrite past results. */
function currentRuntimeActivity(role,worker,check,after) {
  if(worker===undefined)return null;
  if(!worker?.online)return {tone:'blocked',label:'Device offline',detail:'Refresh after the device reconnects'};
  const previous=Date.parse(after||'')||0,attempt=Date.parse(check?.checkedAt||'')||0;
  let report=worker.runtimes?.find(r=>r.type===role.runtime);
  if(check?.state==='checked'&&Date.parse(check.report?.checkedAt||'')>Date.parse(report?.checkedAt||'1970-01-01'))report=check.report;
  const checked=Date.parse(report?.checkedAt||'')||0;
  if(check?.state==='checking'&&attempt>previous)return {tone:'waiting',label:'Checking',detail:'Re-querying CLI status and quota…'};
  if(check?.state==='failed'&&attempt>=checked&&attempt>previous)return {tone:'blocked',label:'Check failed',detail:check.error||'This check did not complete; please retry'};
  // When a failure happens after the probe, an old "available" report must not erase the newer runtime error.
  if(after&&checked<=previous)return null;
  if(!checked||Date.now()-checked>600000||checked>Date.now()+60000)return {tone:'waiting',label:'To check',detail:'CLI check is stale or incomplete; please refresh'};
  if(!report.available)return {tone:'blocked',label:'CLI unavailable',detail:report.reason||'CLI failed the check; verify sign-in or configuration'};
  if(!report.models?.some(m=>m.id===role.model))return {tone:'blocked',label:'Model unavailable',detail:'The current model is not in this device\'s CLI model list; please reconfigure'};
  return {tone:'idle',label:'Available',detail:'CLI check passed · waiting for tasks (no model inference invoked)'};
}

export function machineIconEl(worker) {
  const kind = workerKind(worker);
  const key = kind === 'cloud' ? 'cloud' : (MACHINE[worker?.platform] ? worker.platform : 'darwin');
  return iconEl(MACHINE[key], `role-icon role-machine is-${kind}`, workerDisplayName(worker));
}

export function agentIconEl(runtime, label) {
  const title = label || runtime || 'Agent';
  const source = AGENT_IMAGE[runtime];
  const node = source ? el('span', 'role-icon role-agent') : iconEl(AGENT[runtime] || AGENT.fallback, 'role-icon role-agent', title);
  if (source) {
    const image = el('img');
    image.setAttribute('src', source);
    image.setAttribute('alt', '');
    image.setAttribute('aria-hidden', 'true');
    node.append(image);
    node.title = title;
  }
  node.dataset.runtime = runtime || '';
  return node;
}

const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
export const UI_ICON = {
  close: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}><path d="m6 6 12 12M18 6 6 18"/></svg>`,
  back: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}><path d="m10 5-7 7 7 7M3 12h18"/></svg>`,
  edit: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15zM13 20h7"/></svg>`,
  desktop: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}><rect x="3" y="3" width="18" height="13" rx="2"/><path d="M12 16v5M8 21h8M8 10h8m-3-3 3 3-3 3"/></svg>`,
  settings: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}><path d="M4 7h8m4 0h4M4 17h3m4 0h9"/><circle cx="14" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>`,
  link: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}><path d="m10 13 4-4m-7 2-3 3a4 4 0 0 0 6 6l3-3m-2-10 3-3a4 4 0 0 1 6 6l-3 3"/></svg>`,
  search: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></svg>`,
  save: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}><path d="M4 3h13l4 4v14H3V3h1ZM7 3v6h9V3M7 21v-8h10v8"/></svg>`,
  trash: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>`,
  send: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}><path d="m3 3 18 9-18 9 3-9-3-9ZM6 12h15"/></svg>`,
  folder: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z"/><path d="M3 9h18"/></svg>`,
  roles: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><path d="M3 21v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M21 21v-2a6 6 0 0 0-3-5.2"/></svg>`,
  git: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10M18 7v2a6 6 0 0 1-6 6H6"/></svg>`,
  refresh: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}><path d="M3 9a9 9 0 0 1 15-4l3 3M21 3v5h-5M21 15a9 9 0 0 1-15 4l-3-3M3 21v-5h5"/></svg>`,
  project: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}><path d="M4 7h16v12H4z"/><path d="M8 7V5h8v2"/><path d="M8 12h8M8 16h5"/></svg>`,
  history: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}><path d="M3 10a9 9 0 1 1 2.5 8M3 4v6h6M12 7v5l3 2"/></svg>`,
  plus: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}><path d="M12 5v14M5 12h14"/></svg>`,
  quote: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}><path d="M9 17 4 12l5-5"/><path d="M4 12h10a6 6 0 0 1 6 6"/></svg>`,
  copy: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg>`,
  check: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}><path d="m5 12 4 4L19 6"/></svg>`,
  fullscreen: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}><path d="M9 4H4v5M15 4h5v5M4 15v5h5M20 15v5h-5"/></svg>`,
  follow: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}><path d="M12 3v13m-5-5 5 5 5-5M5 21h14"/></svg>`,
  terminal: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/></svg>`,
  transfer: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M12 3v11m-4-4 4 4 4-4M16 17h1"/></svg>`,
  original: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}><path d="M13 3H5v18h14V9zM13 3v6h6M8 13h8M8 17h6"/></svg>`,
  log: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}><path d="M7 4h10v16H7z"/><path d="M10 8h4M10 12h4M10 16h2"/></svg>`,
  stop: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>`,
  pause: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}><path d="M8 5v14M16 5v14"/></svg>`,
  play: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}><path d="M8 5v14l12-7z"/></svg>`
};

/** Replaces only the button content, keeping submit type, disabled state and the original click handler; the name serves both hover and screen readers. */
export function setActionIcon(button,name,label) {
  if(!button || !UI_ICON[name])return button;
  const title=label||button.getAttribute('aria-label')||button.textContent.trim();
  button.classList.add('action-icon-button');button.innerHTML=UI_ICON[name];
  button.title=title;button.setAttribute('aria-label',title);
  button.querySelector('svg').setAttribute('aria-hidden','true');
  return button;
}


export function uiIconButton(create, name, title, className = 'icon-button') {
  const btn = create('button', className);
  btn.type = 'button';
  btn.innerHTML = UI_ICON[name] || '';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  return btn;
}

export function deviceIconEl(worker) {
  const kind = worker?.id === 'empty' ? 'empty' : workerKind(worker);
  const drawing = kind === 'cloud' ? MACHINE.cloud : kind === 'empty' ? MACHINE.linux : MACHINE[worker?.platform] || MACHINE.darwin;
  const node = el('span', 'device-glyph');
  node.classList.add(`is-${kind}`);
  node.innerHTML = drawing;
  node.querySelector('svg')?.setAttribute('aria-hidden', 'true');
  return node;
}

function usableBucket(bucket) {
  return bucket && (bucket.remainingPercent != null || bucket.usedPercent != null);
}

function remainingPercent(bucket) {
  if (bucket.remainingPercent != null) return Math.max(0, Math.min(100, Number(bucket.remainingPercent)));
  return Math.max(0, Math.min(100, 100 - Number(bucket.usedPercent)));
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function parseQuotaResetDate(raw) {
  const text = String(raw || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  const direct = new Date(text);
  if (text && Number.isFinite(direct.getTime()) && /\d{4}/.test(text)) return direct;
  const match = text.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!match) return null;
  let hour = Number(match[3]);
  const ap = match[5].toLowerCase();
  if (ap === 'pm' && hour !== 12) hour += 12;
  if (ap === 'am' && hour === 12) hour = 0;
  const now = new Date();
  const date = new Date(now.getFullYear(), MONTHS[match[1].toLowerCase()], Number(match[2]), hour, Number(match[4] || 0));
  if (date.getTime() + 14 * 86400000 < now.getTime()) date.setFullYear(now.getFullYear() + 1);
  return date;
}

/** Parses claude /usage output such as "Sep 17 at 5:40pm (America/Los_Angeles)" */
export function formatQuotaReset(raw) {
  const date = parseQuotaResetDate(raw);
  if (!date) return raw ? String(raw).replace(/\s*\([^)]*\)\s*$/, '').trim() : '';
  return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][date.getMonth()]} ${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Remaining >=50% green; 20-50% (50-80% used) orange; <20% (>80% used) red. On the last day of the weekly quota with >30% remaining, use a green smiley. */
function quotaTone(pct, { weekly = false, resetsAt } = {}) {
  if (weekly && pct > 30) {
    const reset = parseQuotaResetDate(resetsAt);
    if (reset && reset.getTime() - Date.now() <= 86400000 && reset.getTime() >= Date.now() - 3600000) return 'smile';
  }
  if (pct >= 50) return 'ok';
  if (pct >= 20) return 'mid';
  return 'low';
}

function quotaFromRuntime(runtime) {
  const quota = runtime?.quota;
  if (!quota || typeof quota !== 'object') return null;
  if (!usableBucket(quota.fiveHour) && !usableBucket(quota.weekly) && quota.remainingPercent == null) return null;
  return quota;
}

/** Quota strictly belongs to the role's own CLI; for Agy, it is further chosen by the shared quota group the model belongs to. */
export function quotaForRole(roleRuntime, _worker, modelId = '') {
  const quota = roleRuntime?.quota;
  if (roleRuntime?.type === 'agy' && quota?.groups) {
    const key = /claude|gpt|oss/i.test(modelId) ? 'claudeGpt' : 'gemini';
    const group = quota.groups[key];
    return group ? { ...group, credits: quota.credits || null } : null;
  }
  return quotaFromRuntime(roleRuntime);
}

/** Draw only quota windows actually returned by the vendor; unknown quota is not shown as green. */
export function roleNameQuota(quota) {
  const wrap = el('span', 'role-name-quota');
  const add = (kind, bucket, weekly = false) => {
    const known = usableBucket(bucket);
    if (!known) return;
    const pct = Math.round(remainingPercent(bucket));
    const tone = quotaTone(pct, { weekly, resetsAt: bucket?.resetsAt });
    const windowClass = weekly ? 'is-weekly' : 'is-five-hour';
    const mark = el('span', `role-quota-mark ${windowClass} is-${tone}`);
    const reset = known ? formatQuotaReset(bucket.resetsAt) : '';
    mark.title = reset ? `${kind} ${pct}% left · resets ${reset}` : `${kind} ${pct}% left`;
    mark.setAttribute('aria-label', mark.title);
    mark.textContent = String(pct);
    wrap.append(mark);
  };
  add('5h', quota?.fiveHour, false);
  add('Week', quota?.weekly, true);
  return wrap;
}
