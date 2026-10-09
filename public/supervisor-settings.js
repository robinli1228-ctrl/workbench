import { t } from './i18n.js';
import {createRoleSwitchUI} from './role-switch.js';
import {createRoleHistoryTabs} from './role-history.js';
/** The supervisor device is the single routing setting; saving it also updates the fixed project supervisor. */
export function supervisorSettings({ api, getData, getProject, refreshState, create }) {
  const form = document.querySelector('#supervisor-form');
  const host=form.parentElement,settings=create('div','supervisor-configuration');settings.id='supervisor-settings-body';
  for(const child of [...host.children])if(child.tagName!=='H3')settings.append(child);
  host.append(settings);
  const history=createRoleHistoryTabs({host,settings,getData,getRole:()=>getData().supervisorRoles?.find(r=>r.id===getProject()?.supervisorRoleId),api,refreshState,create,formatTime:value=>new Date(value).toLocaleString()});
  const cliSwitch=createRoleSwitchUI({api,refreshState});
  const feedback = document.querySelector('#supervisor-feedback');
  let projectId, revision = 0, busy = false;
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
    efforts();
  }
  /** Only offer the selected model's advertised levels; keep unavailable saved values visible until explicitly changed. */
  function efforts(selected = '', preserveSaved = false) {
    const runtime = getData().workers.find(w => w.id === form.elements.nodeId.value)?.runtimes?.find(r => r.type === form.elements.runtime.value);
    const model = runtime?.models?.find(m => m.id === form.elements.model.value);
    const values = [...new Set(model ? (model.efforts || runtime.efforts || []) : [])].map(id => ({ id }));
    if (selected && !values.some(v => v.id === selected)) {
      if (preserveSaved) values.push({ id: selected, name: t('{value} (saved; unavailable)', { value: selected }) });
      else selected = '';
    }
    selectOptions(form.elements.effort, values, selected, 'Use CLI default');
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
    efforts(saved ? (saved.effort || '') : (defaults.defaultSupervisorEffort || ''), Boolean(saved));
  }
  function prepare() {
    if (busy) return;
    const p = getProject(), data = getData(); projectId = p?.id;
    document.querySelector('#supervisor-settings').hidden = !p;
    if (!p) return;
    document.querySelector('#supervisor-responsibility').textContent = t('Built-in responsibility: {responsibility}', {
      responsibility: data.supervisorRoles?.find(r => r.id === p.supervisorRoleId)?.responsibility || ''
    });
    document.querySelector('#project-supervisor-prompt-preview').textContent = data.settings?.supervisorPrompt ?? data.promptDefaults?.supervisorPrompt ?? '';
    selectOptions(form.elements.nodeId, data.workers.map(w => ({ id: w.id, name: `${w.name} · ${w.online ? t('Online') : t('Offline')}` })), p.supervisorNodeId, 'Select supervisor device');
    form.elements.nodeId.disabled = false;
    form.elements.enabled.disabled = !!p.supervisorRoleId;
    nodeChanged();
    feedback.hidden = true;
    history.refresh();
    const role=data.supervisorRoles?.find(r=>r.id===p.supervisorRoleId);
    if(role){const pending=cliSwitch.resume({projectId,role,host:form,operation:data.roleSwitches?.find(op=>op.roleId===role.id&&!['committed','cancelled'].includes(op.status))});if(pending){busy=true;void pending.catch(error=>{feedback.textContent=error.message;feedback.hidden=false;}).finally(()=>{busy=false;});}}
  }
  form.elements.nodeId.addEventListener('change', nodeChanged);
  form.elements.runtime.addEventListener('change', () => models());
  form.elements.model.addEventListener('change', () => efforts(form.elements.effort.value));
  form.addEventListener('submit', async e => {
    e.preventDefault(); if (busy || !projectId) return;
    const id = projectId, fields = Object.fromEntries(new FormData(form));
    fields.nodeId = form.elements.nodeId.value;
    busy = true; form.querySelector('button[type=submit]').disabled = true;
    try {
      const role=getData().supervisorRoles?.find(r=>r.id===getProject()?.supervisorRoleId);
      if(role?.runtime&&fields.runtime!==role.runtime){
        const result=await cliSwitch.begin({projectId:id,role,draft:{...fields,enabled:form.elements.enabled.checked,revision},expectedSupervisorRevision:revision,host:form});
        if(result.status==='committed'){await refreshState({quiet:true});busy=false;if(getProject()?.id===id)prepare();}
        return;
      }
      await api(`/api/projects/${encodeURIComponent(id)}/supervisors/${encodeURIComponent(fields.nodeId)}`, {
        method: 'PUT', json: { runtime: fields.runtime, model: fields.model, effort: fields.effort, enabled: form.elements.enabled.checked, revision }
      });
      await refreshState({ quiet: true }); busy = false;
      if (getProject()?.id !== id) return;
      prepare(); feedback.textContent = 'Local supervisor settings saved; they apply to later sessions.'; feedback.hidden = false;
    } catch (error) { feedback.textContent = error.message; feedback.hidden = false; }
    finally { busy = false; form.querySelector('button[type=submit]').disabled = false; }
  });
  return { prepare };
}
