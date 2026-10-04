import { setActionIcon } from './role-icons.js';

/** Converts a stored UTC value to the browser-local wall clock needed by datetime-local; the ISO string cannot be sliced directly. */
export function localDateTimeValue(value) {
  const date = new Date(value), pad = number => String(number).padStart(2, '0');
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The global snapshot stores only the state at trigger time; the list must combine current Task/call facts to show the latest status. */
export function recentTimerOccurrences(occurrences, data, jobId) {
  return occurrences.filter(item => item.jobId === jobId).map(item => {
    if (item.status === 'cancelled') return item;
    const tasks = (item.taskIds || []).map(id => (data.tasks || []).find(task => task.id === id)).filter(Boolean);
    const calls = (data.requests || []).filter(call => call.sourceMessageId === item.messageId);
    if (tasks.length && tasks.every(task => task.status === 'ready' && !task.currentRunId)
      && calls.every(call => ['queued', 'waiting_delivery'].includes(call.status))) return { ...item, status: 'queued' };
    if (tasks.some(task => ['ready', 'in_progress', 'awaiting_acceptance'].includes(task.status))
      || calls.some(call => !['succeeded', 'failed', 'cancelled'].includes(call.status))) return { ...item, status: 'running' };
    if (tasks.some(task => task.status === 'blocked') || calls.some(call => call.status === 'failed')) return { ...item, status: 'failed' };
    if (tasks.length && tasks.every(task => ['completed', 'done', 'succeeded', 'cancelled'].includes(task.status))) {
      if (tasks.every(task => task.status === 'cancelled')) return { ...item, status: 'cancelled' };
      return { ...item, status: calls.length && calls.every(call => call.status === 'succeeded' && call.outcome === 'passed') ? 'succeeded' : 'unverified' };
    }
    return item;
  }).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 5);
}

/** A single shared edit form is provided for project scheduled jobs; the authoritative schedule and trigger facts remain in Home. */
export function createScheduledJobsUI({ api, getData, getProject, refreshState, create, openTask }) {
  const container = document.querySelector('#global-scheduled-jobs');
  const dialog = document.querySelector('#scheduled-job-dialog');
  if (!container || !dialog) return { refresh() {}, show() {} };
  let selectedProjectId = '', detailProjectId = '', detail = null, editing = null, busy = false, requestSerial = 0;
  const option = (value, label) => { const el = create('option', '', label); el.value = value; return el; };
  const field = (label, control, className = '') => { const el = create('label', className, label); el.append(control); return el; };
  const input = (name, type = 'text') => { const el = create('input'); el.name = name; el.type = type; return el; };
  const button = (label, action, className = 'secondary') => {
    const el = create('button', className, label); el.type = 'button';
    const icon={'Add scheduled job':'plus','Edit':'edit','Pause':'pause','Resume':'play','Check now':'search','Run now':'play','Delete':'trash','View conversation':'log'}[label];
    if(icon)setActionIcon(el,icon,label);
    el.addEventListener('click', () => void action(el)); return el;
  };
  const format = value => {
    const date = value && new Date(value);
    return date && !Number.isNaN(date.getTime()) ? new Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'short' }).format(date) : '—';
  };
  const status = value => ({ queued: 'Queued', running: 'Running', succeeded: 'Passed', unverified: 'To verify', failed: 'Failed', cancelled: 'Cancelled', dispatching: 'Dispatching' }[value] || value || 'Unknown');
  const projectName = id => getData().projects?.find(project => project.id === id)?.name || id;

  const toolbar = create('div', 'timer-toolbar');
  const projectSelect = create('select'); projectSelect.id = 'timer-project-filter'; projectSelect.setAttribute('aria-label', 'Filter by project');
  const add = button('Add scheduled job', () => edit(), 'primary'); add.id = 'timer-add';
  toolbar.append(field('Project', projectSelect), add);
  const summary = create('div', 'timer-overview'); summary.id = 'timer-overview';
  const feedback = create('p', 'form-feedback'); feedback.hidden = true;
  const list = create('div', 'timer-job-list'); list.id = 'timer-job-list';
  container.replaceChildren(toolbar, summary, feedback, list);

  const heading = create('div', 'dialog-heading');
  const dialogTitle = create('h3', '', 'Add scheduled job');
  heading.append(dialogTitle, button('×', () => dialog.close(), 'icon-button'));
  const form = create('form', 'form-grid timer-edit-form');
  const formProject = create('select'); formProject.name = 'projectId';
  const jobType = create('select'); jobType.name = 'jobType'; jobType.append(option('dispatch', 'Scheduled dispatch'), option('monitor', 'Progress check'));
  const name = input('name'), description = create('textarea'), roleId = create('select'), type = create('select');
  description.name = 'description'; description.rows = 3;
  type.name = 'type'; type.append(option('once', 'Once'), option('interval', 'At intervals'), option('daily', 'Daily'), option('weekly', 'Weekly'));
  const onceAt = input('onceAt', 'datetime-local'), intervalMinutes = input('intervalMinutes', 'number');
  intervalMinutes.min = '15'; intervalMinutes.step = '1'; intervalMinutes.value = '60';
  const time = input('time', 'time'), timezone = input('timezone'); time.value = '09:00'; timezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const weekday = create('select'); weekday.name = 'weekday';
  ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].forEach((label, index) => weekday.append(option(String(index), label)));
  const enabled = input('enabled', 'checkbox'); enabled.checked = true;
  const projectField = field('Project', formProject), roleField = field('Role', roleId);
  const onceField = field('Run at', onceAt), intervalField = field('Interval (minutes)', intervalMinutes);
  const timeField = field('Local time', time), zoneField = field('IANA time zone', timezone), weekdayField = field('Day of week', weekday);
  const formActions = create('div', 'form-actions full-width');
  const save = create('button', 'primary', 'Save'); save.type = 'submit';
  formActions.append(button('Cancel', () => dialog.close()), save);
  const dialogFeedback = create('p', 'form-feedback full-width'); dialogFeedback.hidden = true;
  form.append(projectField, field('Job type', jobType), field('Name', name), roleField,
    field('Description', description, 'full-width'), field('Schedule', type), field('Enabled', enabled),
    onceField, intervalField, timeField, weekdayField, zoneField, dialogFeedback, formActions);
  dialog.replaceChildren(heading, form);

  function fillProjects() {
    const projects = getData().projects || [];
    const formProjectId = formProject.value;
    if (selectedProjectId && !projects.some(project => project.id === selectedProjectId)) selectedProjectId = '';
    projectSelect.replaceChildren(option('', 'All projects'));
    formProject.replaceChildren(option('', 'Select project'));
    for (const project of projects) {
      projectSelect.append(option(project.id, project.name));
      formProject.append(option(project.id, project.name));
    }
    projectSelect.value = selectedProjectId;
    formProject.value = projects.some(project => project.id === formProjectId) ? formProjectId : '';
  }

  function fillRoles(selected = '') {
    const project = getData().projects?.find(item => item.id === formProject.value);
    const roles = (getData().roles || []).filter(role => role.projectId === project?.id && !role.archivedAt && role.enabled && role.configured !== false);
    roleId.replaceChildren(option('', 'Select role'));
    for (const role of roles) roleId.append(option(role.id, role.systemSupervisor ? 'Supervisor' : role.name));
    if (project?.supervisorRoleId && !roles.some(role => role.id === project.supervisorRoleId)) roleId.append(option(project.supervisorRoleId, 'Supervisor'));
    roleId.value = selected || (jobType.value === 'monitor' ? project?.supervisorRoleId || '' : '');
  }

  function showFields() {
    const monitor = jobType.value === 'monitor';
    if (monitor) type.value = 'interval';
    for (const item of type.options) item.disabled = monitor && item.value !== 'interval';
    intervalMinutes.min = monitor ? '10' : '15';
    if (monitor && Number(intervalMinutes.value) < 10) intervalMinutes.value = '10';
    roleField.hidden = monitor;
    if (monitor) fillRoles(getData().projects?.find(item => item.id === formProject.value)?.supervisorRoleId || '');
    onceField.hidden = type.value !== 'once'; intervalField.hidden = type.value !== 'interval';
    timeField.hidden = !['daily', 'weekly'].includes(type.value); zoneField.hidden = timeField.hidden;
    weekdayField.hidden = type.value !== 'weekly';
  }

  function edit(job = null) {
    editing = job;
    form.reset();
    dialogFeedback.hidden = true;
    dialogTitle.textContent = job ? `Edit · ${job.name}` : 'Add scheduled job';
    formProject.value = job?.projectId || selectedProjectId || getProject()?.id || '';
    formProject.disabled = Boolean(job);
    jobType.value = job?.jobType || 'dispatch';
    name.value = job?.name || '';
    description.value = job?.description || '';
    type.value = job?.schedule?.type || 'interval';
    onceAt.value = localDateTimeValue(job?.schedule?.onceAt);
    intervalMinutes.value = String(job?.schedule?.intervalMinutes || 60);
    time.value = job?.schedule?.time || '09:00'; timezone.value = job?.schedule?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    weekday.value = String(job?.schedule?.weekday ?? 1); enabled.checked = job?.enabled ?? true;
    fillRoles(job?.roleId || ''); showFields(); dialog.showModal(); name.focus();
  }

  async function act(control, operation) {
    if (busy) return;
    busy = true; control.disabled = true; feedback.hidden = true; dialogFeedback.hidden = true;
    try { await operation(); await refreshState({ quiet: true }); await loadDetails(); }
    catch (error) {
      const target = dialog.open ? dialogFeedback : feedback;
      target.textContent = error.message; target.hidden = false;
    } finally { busy = false; control.disabled = false; }
  }

  function render() {
    fillProjects();
    const data = getData();
    const allJobs = data.scheduledJobs || [];
    const jobs = allJobs.filter(job => !selectedProjectId || job.projectId === selectedProjectId);
    const occurrences = selectedProjectId && detailProjectId === selectedProjectId && detail?.occurrences
      ? detail.occurrences : data.scheduledOccurrences || [];
    const count = allJobs.length, enabledCount = allJobs.filter(job => job.enabled).length;
    const monitorCount = allJobs.filter(job => job.jobType === 'monitor').length;
    summary.replaceChildren(create('div', 'timer-overview-number', `${count} ${count===1?'job':'jobs'}`),
      create('span', '', `${enabledCount} enabled · ${monitorCount} progress ${monitorCount===1?'check':'checks'} · ${data.projects?.length || 0} ${(data.projects?.length || 0)===1?'project':'projects'}`));
    list.replaceChildren();
    if (!jobs.length) { list.append(create('p', 'timer-empty', selectedProjectId ? 'This project has no scheduled jobs yet.' : 'No scheduled jobs yet.')); return; }
    for (const job of jobs) {
      const card = create('article', 'timer-job-card');
      const head = create('div', 'timer-job-head');
      head.append(create('div', '', `${job.name} · ${job.jobType === 'monitor' ? 'Progress check' : 'Scheduled dispatch'}`),
        create('span', job.enabled ? 'timer-status is-on' : 'timer-status', job.enabled ? 'Enabled' : 'Paused'));
      card.append(head, create('p', 'timer-job-description', job.description),
        create('p', 'timer-job-meta', `${projectName(job.projectId)} · Next ${format(job.nextRunAt)} · Last ${format(job.lastCheckAt || job.lastRunAt)}`));
      if (job.jobType === 'monitor') card.append(create('p', 'timer-job-meta', `Last check: ${job.lastCheckResult === 'deferred' ? 'new anomaly; supervisor will be notified when idle' : job.lastCheckResult === 'alerted' ? 'new anomaly found' : job.lastCheckAt ? 'no new anomalies' : 'not checked yet'}`));
      const controls = create('div', 'timer-actions');
      const immediate = button(job.jobType === 'monitor' ? 'Check now' : 'Run now', control => {
        if (!window.confirm(`Run "${job.name}" now? ${job.jobType === 'monitor' ? 'This only checks current progress; new anomalies will notify the supervisor.' : 'This dispatches to the role and consumes model quota.'}`)) return;
        return act(control, () => api(`/api/projects/${encodeURIComponent(job.projectId)}/scheduled-jobs/${encodeURIComponent(job.id)}/run`, { method: 'POST', json: {} }));
      });
      if (job.jobType === 'monitor' && !job.enabled) immediate.disabled = true;
      controls.append(button('Edit', () => edit(job)),
        button(job.enabled ? 'Pause' : 'Resume', control => act(control, () => api(`/api/projects/${encodeURIComponent(job.projectId)}/scheduled-jobs/${encodeURIComponent(job.id)}/toggle`, { method: 'POST', json: { enabled: !job.enabled, revision: job.revision } }))),
        immediate,
        button('Delete', control => {
          if (!window.confirm(`Delete scheduled job "${job.name}"? Existing run records are kept.`)) return;
          return act(control, () => api(`/api/projects/${encodeURIComponent(job.projectId)}/scheduled-jobs/${encodeURIComponent(job.id)}/delete`, { method: 'POST', json: { revision: job.revision } }));
        }, 'secondary danger-text'));
      card.append(controls);
      const history = recentTimerOccurrences(occurrences, data, job.id);
      if (history.length) {
        const details = create('details', 'timer-history'); details.append(create('summary', '', `Last ${history.length} ${history.length===1?'trigger':'triggers'}`));
        for (const item of history) {
          const row = create('div', 'timer-history-row');
          row.append(create('span', '', `${item.kind === 'manual' ? 'Manual' : item.kind === 'monitor' ? 'Check' : 'Scheduled'} · ${format(item.createdAt)} · ${status(item.status)}${item.error ? ` · ${item.error}` : ''}`));
          const taskId = item.taskIds?.[0];
          if (taskId) row.append(button('View conversation', () => openTask(job.projectId, taskId)));
          details.append(row);
        }
        card.append(details);
      }
      list.append(card);
    }
  }

  async function loadDetails() {
    const projectId = selectedProjectId;
    if (!projectId) { detailProjectId = ''; detail = null; render(); return; }
    const serial = ++requestSerial;
    try {
      const result = await api(`/api/projects/${encodeURIComponent(projectId)}/scheduled-jobs`);
      if (serial !== requestSerial || selectedProjectId !== projectId) return;
      detailProjectId = projectId; detail = result; render();
    } catch (error) { if (serial === requestSerial) { feedback.textContent = error.message; feedback.hidden = false; } }
  }

  projectSelect.addEventListener('change', () => {
    selectedProjectId = projectSelect.value; detail = null; detailProjectId = ''; render(); void loadDetails();
  });
  formProject.addEventListener('change', () => { fillRoles(); showFields(); });
  jobType.addEventListener('change', showFields);
  type.addEventListener('change', showFields);
  form.addEventListener('submit', event => {
    event.preventDefault();
    void act(save, async () => {
      const projectId = formProject.value;
      if (!projectId) throw new Error('Please select a project');
      const project = getData().projects.find(item => item.id === projectId);
      const payload = { id: editing?.id, revision: editing?.revision, name: name.value, description: description.value,
        roleId: jobType.value === 'monitor' ? project.supervisorRoleId : roleId.value, jobType: jobType.value,
        type: type.value, enabled: enabled.checked };
      if (type.value === 'once') {
        const date = new Date(onceAt.value);
        if (!onceAt.value || Number.isNaN(date.getTime())) throw new Error('Please select a valid one-time run time');
        payload.onceAt = date.toISOString();
      }
      if (type.value === 'interval') payload.intervalMinutes = Number(intervalMinutes.value);
      if (['daily', 'weekly'].includes(type.value)) Object.assign(payload, { time: time.value, timezone: timezone.value });
      if (type.value === 'weekly') payload.weekday = Number(weekday.value);
      await api(`/api/projects/${encodeURIComponent(projectId)}/scheduled-jobs`, { method: 'POST', json: payload });
      selectedProjectId = projectId;
      detail = null; detailProjectId = '';
      dialog.close();
    });
  });
  return {
    refresh() {
      render();
      if (selectedProjectId && !busy && document.querySelector('#settings-page')?.dataset.settingsScope === 'timers') void loadDetails();
    },
    show: () => { render(); void loadDetails(); },
    select(projectId) { selectedProjectId = projectId; render(); void loadDetails(); }
  };
}
