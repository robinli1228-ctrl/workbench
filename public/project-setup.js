import { t, getLanguage } from './i18n.js';
import {renderModelUsageNotice} from './model-usage.js';
import {renderPermissionScope,permissionScopeValue} from './permission-scope.js';
/** Keep the user's current selection; with no draft use platform defaults, and only then auto-select a sole option. */
export function preferredSelectValue(values, current, preferred) {
  if (values.some(value => value.id === current)) return current;
  if (values.some(value => value.id === preferred)) return preferred;
  if (current || preferred) return '';
  return values.length === 1 ? values[0].id : '';
}

const LAST_SUPERVISOR='wb.lastSupervisor';
/** The new project form starts from the supervisor chosen for the last project created in this browser. */
export function rememberSupervisorChoice(choice) {
  try { localStorage.setItem(LAST_SUPERVISOR, JSON.stringify({ nodeId: choice?.nodeId || '', runtime: choice?.runtime || '', model: choice?.model || '', effort: choice?.effort || '' })); } catch {}
}
function lastSupervisorChoice(settings) {
  let last = null;
  try { last = JSON.parse(localStorage.getItem(LAST_SUPERVISOR) || 'null'); } catch {}
  // Before any project was created here, earlier saved platform defaults still apply.
  return last || { nodeId: '', runtime: settings.defaultSupervisorRuntime || '', model: settings.defaultSupervisorModel || '', effort: settings.defaultSupervisorEffort || '' };
}

/** The create form accepts only Workers explicitly registered as local; the config card always shows the actual execution target. */
export function projectSetupUI({ api, getData, getProject, refreshState, create, setError,openFolder }) {
  const form = document.querySelector('#project-form');
  const folderLabel=create('label','full-width','Existing project folder (optional)'),folderRow=create('div','native-workspace-row'),localRoot=create('input'),pickFolder=create('button','secondary','Select folder');
  localRoot.name='localRoot';localRoot.placeholder='Leave blank to create the default project folder';pickFolder.type='button';folderRow.append(localRoot,pickFolder);folderLabel.append(folderRow);form.elements.folderName.closest('label').after(folderLabel);
  const folderNote=create('p','workspace-note full-width','Only the selected folder is bound; existing files are kept. Browsing does not grant CLI permissions.');folderLabel.after(folderNote);
  const permissionLabel=create('label','','Permission scope'),permissionSelect=create('select'),permissionNote=create('p','workspace-note full-width');permissionSelect.name='supervisorPermissionScope';permissionSelect.required=true;permissionLabel.append(permissionSelect);form.elements.supervisorEffort.closest('label').after(permissionLabel,permissionNote);
  let folderVersion=0;
  pickFolder.addEventListener('click',()=>{const nodeId=form.elements.supervisorNodeId.value,ticket=++folderVersion;openFolder?.(nodeId,localRoot.value,path=>{if(ticket!==folderVersion||form.elements.supervisorNodeId.value!==nodeId)return;localRoot.value=path;localRoot.dispatchEvent(new Event('input',{bubbles:true}));});});
  form.elements.supervisorNodeId.addEventListener('change',()=>{folderVersion++;localRoot.value='';permissionSelect.value='';delete permissionSelect.dataset.touched;});
  localRoot.addEventListener('input',()=>folderVersion++);
  permissionSelect.addEventListener('change',()=>{permissionSelect.dataset.touched='1';choices();});
  const cards = document.querySelector('#setup-proposals');
  const busy = new Set();
  let signature = '';
  const select = (name, values, blank, preferred = '') => {
    const el = form.elements[name], old = el.value;
    el.replaceChildren();
    for (const item of [{ id: '', name: blank }, ...values]) {
      const option = create('option', '', item.name || item.id); option.value = item.id; el.append(option);
    }
    el.value = preferredSelectValue(values, old, preferred);
  };
  function choices() {
    const data = getData(), settings = data.settings || {}, last = lastSupervisorChoice(settings);
    const workers = (data.workers || []).filter(w => w.online && w.capabilities?.projectSpace === 1);
    select('supervisorNodeId', workers, 'Select supervisor device', last.nodeId);
    select('hostingAccountId',(data.hostingAccounts || []).map(a=>({id:a.id,name:`${a.label} · ${a.private?t('Private'):t('Public')}`})),'Connect a hosting account in Settings first',settings.hostingAccountId);
    if (!form.elements.hostingAccountId.value && data.hostingAccounts?.length) form.elements.hostingAccountId.value = data.hostingAccounts[0].id;
    for (const node of form.querySelectorAll('[data-repository-mode]')) node.hidden = node.dataset.repositoryMode !== form.elements.repositoryMode.value;
    const worker = workers.find(w => w.id === form.elements.supervisorNodeId.value);
    const runtimes = (worker?.runtimes || []).filter(r => r.supported && r.available && r.authReady === true);
    select('supervisorRuntime', runtimes.map(r => ({ id: r.type, name: r.label || r.type })), 'Select a signed-in CLI', last.runtime);
    const runtime = runtimes.find(r => r.type === form.elements.supervisorRuntime.value);
    const local=worker?.nodeKind==='local'&&worker.capabilities?.localFolderSelection===1;
    localRoot.disabled=pickFolder.disabled=!local;
    folderNote.textContent=local?'Only the selected folder is bound; existing files are kept. Browsing does not grant CLI permissions.':'Upgrade the local Worker to select this folder';
    renderPermissionScope(permissionSelect,permissionNote,{worker,runtime:runtime?.type,isNew:true});
    select('supervisorModel', runtime?.models || [], 'Select supervisor model', last.runtime === form.elements.supervisorRuntime.value ? last.model : '');
    const model = runtime?.models?.find(m => m.id === form.elements.supervisorModel.value);
    renderModelUsageNotice(form.querySelector('[data-model-usage-note]'),runtime?.type,model||{id:form.elements.supervisorModel.value});
    select('supervisorEffort', (model?.efforts || runtime?.efforts || []).map(id => ({ id })), 'CLI default', last.effort);
    document.querySelector('#project-supervisor-note').textContent = workers.length
      ? 'The supervisor can run locally or on a server; other devices can join in project settings.'
      : 'No online device supporting project workspaces was found; connect or upgrade a Worker in Settings → Devices and CLIs.';
  }
  for (const name of ['supervisorNodeId', 'supervisorRuntime', 'supervisorModel', 'repositoryMode']) form.elements[name].addEventListener('change', choices);
  form.elements.name.addEventListener('change',()=>{if(!form.elements.folderName.value)form.elements.folderName.value=form.elements.name.value.toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,64)||`project-${Date.now().toString(36)}`;});
  function render() {
    const data = getData(), p = getProject();
    choices();
    const proposals = (data.setupProposals || []).filter(r => r.projectId === p?.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const pendingCount = proposals.filter(proposal => proposal.status === 'pending').length;
    const title = pendingCount
      ? `${t('Pending confirmation')} (${pendingCount}) · ${t('Supervisor setup suggestions')}`
      : t('Supervisor setup suggestions');
    const nextSignature = JSON.stringify([p?.id, proposals, [...busy], getLanguage()]);
    cards.hidden = !proposals.length;
    if (nextSignature === signature) return;
    signature = nextSignature; cards.replaceChildren();
    if (proposals.length) cards.append(create('h3', '', title));
    for (const proposal of proposals) {
      const card = create('details', 'setup-card');
      card.open = ['pending', 'running', 'blocked'].includes(proposal.status);
      const state = { pending: 'Pending confirmation', running: 'Running', succeeded: 'Configured', blocked: 'Needs attention', rejected: 'Rejected' }[proposal.status];
      card.append(create('summary', '', `${state} · ${proposal.summary}`));
      for (const action of proposal.actions) {
        const line = action.type === 'repository'
          ? t('Prepare repository {key}: {repoUrl}\nDevice: {v}\nFolder is computed by project settings', { key: action.key, repoUrl: action.repoUrl, v: workerName(action.nodeId) })
          : t('Configure role {name} · all project repositories\nDevice: {v} · {runtime} · {model}\nPrompt: {v2}', { name: action.name, v: workerName(action.nodeId), runtime: action.runtime, model: action.model, v2: action.instructions || t('Not specified') });
        card.append(create('pre', 'setup-action', line));
      }
      if (proposal.error) card.append(create('p', 'inline-error', t('{error}. Completed {v}/{v2}; nothing is rolled back or overwritten automatically. Ask the supervisor to review before proposing a new suggestion.', { error: proposal.error, v: proposal.completed?.length || 0, v2: proposal.actions.length })));
      if (proposal.status === 'pending') {
        const actions = create('div', 'form-actions');
        for (const [action, label] of [['approve', 'Confirm and run'], ['reject', 'Reject']]) {
          const b = create('button', action === 'approve' ? 'primary compact' : 'secondary compact', busy.has(proposal.id) ? 'Processing…' : label);
          b.type = 'button'; b.disabled = busy.has(proposal.id);
          b.addEventListener('click', async () => {
            busy.add(proposal.id); render();
            try { await api(`/api/projects/${encodeURIComponent(proposal.projectId)}/setup-proposals/${encodeURIComponent(proposal.id)}/${action}`, { method: 'POST', json: {} }); }
            catch (error) { setError(error.message); }
            finally { busy.delete(proposal.id); await refreshState({ quiet: true }); }
          });
          actions.append(b);
        }
        card.append(actions);
      }
      cards.append(card);
    }
  }
  return { refresh: render, selection: () => ({ nodeId: form.elements.supervisorNodeId.value, runtime: form.elements.supervisorRuntime.value, model: form.elements.supervisorModel.value, effort: form.elements.supervisorEffort.value || null,permissionScope:permissionScopeValue(permissionSelect) }) };
}
