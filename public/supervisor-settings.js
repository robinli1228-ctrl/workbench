import { t } from './i18n.js';
/** Configuration panel for the fixed supervisor; saves node settings and project intake settings separately and does not create work roles. */
export function supervisorSettings({ api, getData, getProject, refreshState, create }) {
  const form = document.querySelector('#supervisor-form');
  const routing = document.querySelector('#coordination-form');
  const feedback = document.querySelector('#supervisor-feedback');
  let projectId, revision = 0, projectRevision = 0, busy = false;
  const selectOptions = (select, values, selected, blank) => {
    select.replaceChildren();
    for (const value of [{ id: '', name: blank }, ...values]) {
      const option = create('option', '', value.name || value.id); option.value = value.id;
      select.append(option);
    }
    select.value = selected || '';
  };
  function models(selected = '') {
    const runtime = getData().workers.find(w => w.id === form.elements.nodeId.value)?.runtimes?.find(r => r.type === form.elements.runtime.value);
    selectOptions(form.elements.model, runtime?.models || [], selected, 'Select an available model');
  }
  function nodeChanged() {
    const data = getData(), nodeId = form.elements.nodeId.value;
    const saved = (data.supervisors || []).find(c => c.projectId === projectId && c.nodeId === nodeId);
    const defaults = data.settings || {};
    const runtime = saved ? saved.runtime : defaults.defaultSupervisorRuntime;
    const model = saved ? saved.model : (runtime === defaults.defaultSupervisorRuntime ? defaults.defaultSupervisorModel : '');
    revision = saved?.revision || 0;
    const worker = data.workers.find(w => w.id === nodeId);
    selectOptions(form.elements.runtime, (worker?.runtimes || []).filter(r => r.supported && r.available).map(r => ({ id: r.type, name: r.label || r.type })), runtime, 'Select CLI');
    models(model);
    form.elements.enabled.checked = saved?.enabled ?? true;
    form.elements.effort.value = saved ? (saved.effort || '') : (defaults.defaultSupervisorEffort || '');
  }
  function prepare() {
    if (busy) return;
    const p = getProject(), data = getData(); projectId = p?.id;
    document.querySelector('#supervisor-settings').hidden = !p;
    if (!p) return;
    projectRevision = p.coordinationRevision || 0;
    selectOptions(form.elements.nodeId, data.workers.map(w => ({ id: w.id, name: `${w.name} · ${w.online ? t('Online') : t('Offline')}` })), p.supervisorNodeId, 'Select supervisor device');
    form.elements.nodeId.disabled = false;
    form.elements.enabled.disabled = !!p.supervisorRoleId;
    nodeChanged();
    const configured = (data.supervisors || []).filter(c => c.projectId === projectId && c.enabled);
    selectOptions(routing.elements.supervisorNodeId, configured.map(c => ({ id: c.nodeId, name: data.workers.find(w => w.id === c.nodeId)?.name || c.nodeId })), p.supervisorNodeId, 'Do not handle messages without @ for now');
    routing.elements.supervisorNodeId.disabled = !!p.supervisorRoleId;
    selectOptions(routing.elements.plannerRoleId, (data.roles || []).filter(r => r.projectId === projectId && !r.archivedAt && r.enabled && r.configured !== false), p.plannerRoleId, 'No planner role selected');
    feedback.hidden = true;
  }
  form.elements.nodeId.addEventListener('change', nodeChanged);
  form.elements.runtime.addEventListener('change', () => models());
  form.addEventListener('submit', async e => {
    e.preventDefault(); if (busy || !projectId) return;
    const id = projectId, fields = Object.fromEntries(new FormData(form));
    fields.nodeId = form.elements.nodeId.value;
    busy = true; form.querySelector('button[type=submit]').disabled = true;
    try {
      await api(`/api/projects/${encodeURIComponent(id)}/supervisors/${encodeURIComponent(fields.nodeId)}`, {
        method: 'PUT', json: { runtime: fields.runtime, model: fields.model, effort: fields.effort, enabled: form.elements.enabled.checked, revision }
      });
      await refreshState({ quiet: true }); busy = false;
      if (getProject()?.id !== id) return;
      prepare(); feedback.textContent = 'Local supervisor settings saved; they apply to later sessions.'; feedback.hidden = false;
    } catch (error) { feedback.textContent = error.message; feedback.hidden = false; }
    finally { busy = false; form.querySelector('button[type=submit]').disabled = false; }
  });
  routing.addEventListener('submit', async e => {
    e.preventDefault(); if (busy || !projectId) return;
    const id = projectId; busy = true; routing.querySelector('button').disabled = true;
    try {
      await api(`/api/projects/${encodeURIComponent(id)}/coordination-settings`, { method: 'POST', json: { ...Object.fromEntries(new FormData(routing)), supervisorNodeId: routing.elements.supervisorNodeId.value, coordinationRevision: projectRevision } });
      await refreshState({ quiet: true }); busy = false;
      if (getProject()?.id !== id) return;
      prepare(); feedback.textContent = 'Project dispatch settings saved.'; feedback.hidden = false;
    } catch (error) { feedback.textContent = error.message; feedback.hidden = false; }
    finally { busy = false; routing.querySelector('button').disabled = false; }
  });
  return { prepare };
}
