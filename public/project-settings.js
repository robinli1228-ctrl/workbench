import { t } from './i18n.js';
import { workerDisplayName } from './role-icons.js';
import { createFolderControl } from './create-folder.js';
import { saveConcurrentWrites } from './concurrent-writes.js';

/** Node folder selection and repository settings share the existing authenticated API and never upload local browser files. */
export function projectSettings({ api, getData, getProject, getConversationId=()=>getProject()?.id, refreshState, create, setError, openSettings, closeSettings, openTask }) {
  const picker = document.querySelector('#folder-dialog');
  const crumbs = document.querySelector('#folder-crumbs');
  const list = document.querySelector('#folder-list');
  const filterInput = document.querySelector('#folder-filter');
  const pathLabel = document.querySelector('#folder-path');
  const choose = document.querySelector('#folder-use'), up = document.querySelector('#folder-up');
  const more = document.querySelector('#folder-more'), error = document.querySelector('#folder-error');
  const projectForm = document.querySelector('#project-form');
  const form = document.querySelector('#project-settings-form');
  const feedback = document.querySelector('#project-settings-feedback');
  const folderFeedback = document.querySelector('#project-folder-feedback'), deleteFeedback = document.querySelector('#project-delete-feedback');
  let workerId, current = null, callback, serial = 0, settingsId, busy = false, allowedRoots = [], filterText = '';
  const newFolder = createFolderControl({api,onCreated: result => load(result.path)});
  const directPath=create('input'),openPath=create('button','secondary','Open');directPath.placeholder=t('Absolute folder path');directPath.setAttribute('aria-label',t('Absolute folder path'));openPath.type='button';
  let pathInputVersion=0;directPath.addEventListener('input',()=>pathInputVersion++);
  const pathRow=create('div','native-workspace-row');pathRow.append(directPath,openPath);list.before(pathRow);
  openPath.addEventListener('click',()=>void load(directPath.value.trim()));directPath.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();void load(directPath.value.trim());}});
  document.querySelector('.folder-browser-actions').prepend(newFolder.button);
  list.before(newFolder.panel);
  const concurrentBox=document.querySelector('#concurrent-writes'),concurrentStatus=document.querySelector('#concurrent-status'),concurrentFeedback=document.querySelector('#concurrent-feedback');
  /** Devices whose Worker is too old to honour the switch keep the one-at-a-time lock; say so instead of promising more. */
  function showConcurrent(){
    const p=getProject();if(!p)return;concurrentBox.checked=p.allowConcurrentWrites===true;
    const data=getData(),nodeIds=new Set([...(data.roles||[]),...(data.supervisorRoles||[])].filter(r=>r.projectId===p.id&&!r.archivedAt&&r.enabled!==false).map(r=>r.nodeId));
    const old=(getData().workers||[]).filter(w=>nodeIds.has(w.id)&&w.capabilities?.concurrentWrites!==1).map(w=>workerDisplayName(w));
    concurrentStatus.textContent=p.allowConcurrentWrites===true&&old.length?t('These devices still queue one at a time until their Worker is upgraded: {names}',{names:old.join(t(', '))}):'';
  }
  concurrentBox.addEventListener('change',async()=>{
    const p=getProject();if(!p)return;const enabled=concurrentBox.checked,here=()=>getProject()?.id===p.id;
    concurrentBox.disabled=true;concurrentFeedback.hidden=true;
    try{if(await saveConcurrentWrites({api,getData,projectId:p.id,enabled})===null){concurrentBox.checked=false;concurrentBox.disabled=false;return;}}
    catch(error){if(here()){concurrentBox.checked=!enabled;concurrentFeedback.textContent=error.message;concurrentFeedback.hidden=false;}concurrentBox.disabled=false;return;}
    // The server has the new value; a failed refresh must not flip the box back.
    try{await refreshState({quiet:true});}catch{}
    if(here()){showConcurrent();concurrentFeedback.textContent=t('Saved');concurrentFeedback.hidden=false;}
    concurrentBox.disabled=false;
  });
  const followupForm=document.querySelector('#proactive-followup-form'),followupFeedback=document.querySelector('#followup-feedback'),followupStatus=document.querySelector('#followup-status'),viewFollowup=document.querySelector('#view-followup');
  let followupVersion=0,followupConfig=null,followupProject=null;
  function followupDisabled(value){for(const element of followupForm.elements)element.disabled=value;document.querySelector('#refresh-followup').disabled=value;viewFollowup.disabled=value||!followupConfig?.execution?.taskId;}
  function showFollowup(value){
    followupConfig=value;followupForm.elements.enabled.checked=value.enabled;followupForm.elements.silenceMinutes.value=value.silenceMinutes;
    const execution=value.execution;
    followupStatus.textContent=execution?[t(execution.progress?.label||execution.status),execution.waitingReason||execution.error||''].filter(Boolean).join(' · '):value.waitingReason||t(value.enabled?(value.anchorMessageId?'Waiting for chat silence':'Waiting for a new complete message'):'Stall reminders are off');
    viewFollowup.disabled=!execution?.taskId;
  }
  async function loadFollowup(){
    const id=getProject()?.id,conversationId=getConversationId()||id,version=++followupVersion;if(!id)return;
    followupProject=id;followupConfig=null;followupDisabled(true);followupFeedback.hidden=true;followupStatus.textContent=t('Loading…');
    try{const value=await api(`/api/projects/${encodeURIComponent(id)}/proactive-followup?conversationId=${encodeURIComponent(conversationId)}`);if(version===followupVersion&&getProject()?.id===id&&(getConversationId()||id)===conversationId)showFollowup(value);}
    catch(error){if(version===followupVersion&&getProject()?.id===id){followupStatus.textContent=error.message;}}
    finally{if(version===followupVersion&&getProject()?.id===id){followupDisabled(!followupConfig);document.querySelector('#refresh-followup').disabled=false;}}
  }
  followupForm.addEventListener('submit',async event=>{
    event.preventDefault();const id=followupProject,version=followupVersion;if(!followupConfig||id!==getProject()?.id)return;
    const input={conversationId:followupConfig.conversationId||id,enabled:followupForm.elements.enabled.checked,silenceMinutes:Number(followupForm.elements.silenceMinutes.value),revision:followupConfig.revision};followupDisabled(true);followupFeedback.hidden=true;
    try{const value=await api(`/api/projects/${encodeURIComponent(id)}/proactive-followup`,{method:'POST',json:input});if(version!==followupVersion||getProject()?.id!==id)return;showFollowup(value);followupFeedback.textContent=t('Saved');followupFeedback.hidden=false;}
    catch(error){if(version===followupVersion&&getProject()?.id===id){followupFeedback.textContent=error.message;followupFeedback.hidden=false;}}
    finally{if(version===followupVersion&&getProject()?.id===id)followupDisabled(false);}
  });
  document.querySelector('#refresh-followup').addEventListener('click',()=>void loadFollowup());
  viewFollowup.addEventListener('click',()=>{const execution=followupConfig?.execution;if(followupProject===getProject()?.id&&execution?.taskId)openTask?.(execution.taskId,execution.runId);});
  const option = (label, value) => { const o = create('option', '', label); o.value = value; return o; };
  function activeRoot(path) {
    if (!path) return null;
    return [...allowedRoots].filter(r => path === r || path.startsWith(r.endsWith('/') ? r : `${r}/`)).sort((a, b) => b.length - a.length)[0] || null;
  }

  function renderCrumbs() {
    crumbs.replaceChildren();
    const home = create('button', '', 'Allowed root folders');
    home.type = 'button';
    if (!current?.path) home.setAttribute('aria-current', 'page');
    else home.addEventListener('click', () => load(''));
    crumbs.append(home);
    const path = current?.path;
    if (!path) return;
    const root = activeRoot(path);
    const parts = [];
    if (root) {
      parts.push({ label: root, path: root });
      if (path !== root) {
        const rest = path.slice(root.length).split('/').filter(Boolean);
        let acc = root;
        for (const seg of rest) {
          acc = `${acc.replace(/\/$/,'')}/${seg}`;
          parts.push({ label: seg, path: acc });
        }
      }
    } else {
      parts.push({ label: path, path });
    }
    for (const part of parts) {
      crumbs.append(Object.assign(document.createElement('span'), { className: 'crumb-sep', textContent: '/' }));
      const btn = create('button', '', part.label);
      btn.type = 'button';
      if (part.path === path) btn.setAttribute('aria-current', 'page');
      else btn.addEventListener('click', () => load(part.path));
      crumbs.append(btn);
    }
  }

  function renderList() {
    list.replaceChildren();
    const folders = (current?.folders || []).filter(f => {
      if (!filterText) return true;
      return String(f.name || f.path || '').toLowerCase().includes(filterText);
    });
    if (!folders.length) {
      const empty = create('p', 'folder-empty', filterText ? 'No matching folders' : (current?.path ? 'No subfolders here; you can use the current path directly' : 'No allowed root folders'));
      list.append(empty);
      return;
    }
    for (const f of folders) {
      const row = create('button', 'folder-item');
      row.type = 'button';
      row.setAttribute('role', 'option');
      row.append(create('span', 'folder-icon', '📁'), create('span', 'folder-name', f.name || f.path), create('span', 'folder-hint', 'Open'));
      row.addEventListener('click', () => load(f.path));
      row.addEventListener('dblclick', e => { e.preventDefault(); load(f.path); });
      list.append(row);
    }
  }

  async function load(path = '', offset = 0) {
    const version = ++serial,inputVersion=pathInputVersion;
    newFolder.update();
    choose.disabled = true; up.disabled = true; more.disabled = true; error.hidden = true;
    if (!offset) {
      list.replaceChildren(create('p', 'folder-empty', 'Loading…'));
      filterInput.value = filterText;
    }
    try {
      const result = await api(`/api/workers/${encodeURIComponent(workerId)}/directories?path=${encodeURIComponent(path)}&offset=${offset}`);
      if (version !== serial || !picker.open) return;
      if (offset && current?.path === result.path) {
        current = { ...result, folders: [...(current.folders || []), ...(result.folders || [])] };
      } else {
        current = result;
        filterText = '';
        filterInput.value = '';
      }
      newFolder.update({nodeId:workerId,path:result.path,enabled:getData().workers.find(w=>w.id===workerId)?.capabilities?.directoryCreate===1});
      pathLabel.hidden = true;
      pathLabel.textContent = result.path || '';
      if(inputVersion===pathInputVersion)directPath.value=result.path||'';
      renderCrumbs();
      renderList();
      up.disabled = !result.path;
      choose.disabled = !result.path;
      more.hidden = !result.hasMore;
      more.disabled = false;
    } catch (e) {
      if (version === serial) {
        current = null;
        error.textContent = e.message;
        error.hidden = false;
        list.replaceChildren();
        renderCrumbs();
      }
    }
  }

  function openFolder(nodeId, selected, apply) {
    const worker = getData().workers.find(w => w.id === nodeId);
    if (!worker?.online || !worker.capabilities?.projectBrowser) return setError('Please select an online, upgraded node');
    workerId = nodeId; callback = apply; current = null;
    allowedRoots = worker.nodeKind==='local'&&worker.capabilities?.localFolderSelection===1?['/']:Array.isArray(worker.allowedRoots) ? worker.allowedRoots.slice() : [];
    document.querySelector('#folder-title').textContent = t('Select folder · {v}', { v: workerDisplayName(worker) });
    filterText = ''; filterInput.value = '';
    picker.showModal();
    const start = selected && allowedRoots.some(r => selected === r || selected.startsWith(r.endsWith('/') ? r : `${r}/`))
      ? selected
      : (allowedRoots.length === 1 ? allowedRoots[0] : '');
    void load(start);
  }

  filterInput.addEventListener('input', () => {
    filterText = filterInput.value.trim().toLowerCase();
    renderList();
  });
  up.addEventListener('click', () => load(current?.parent || ''));
  more.addEventListener('click', () => { if (current?.path) void load(current.path, current.nextOffset || 0); });
  choose.addEventListener('click', () => { if (!current?.path) return; callback(current.path); picker.close(); serial++; });
  document.querySelector('#folder-close').addEventListener('click', () => { picker.close(); serial++; });
  picker.addEventListener('cancel', () => { serial++; });
  picker.addEventListener('close', () => newFolder.update());

  function refreshNodes() {
    const select = projectForm.elements.nodeId, previous = select.value;
    select.replaceChildren(option('Bind node later', ''), ...getData().workers.map(w => option(`${workerDisplayName(w)} · ${w.online ? t('Online') : t('Offline')}`, w.id)));
    select.value = previous || '';
  }
  projectForm.elements.nodeId.addEventListener('change', () => {
    projectForm.elements.root.value = '';
    projectForm.dispatchEvent(new Event('input', { bubbles: true }));
  });
  document.querySelector('#pick-project-folder').addEventListener('click', () => openFolder(projectForm.elements.nodeId.value, projectForm.elements.root.value, path => {
    projectForm.elements.root.value = path; projectForm.dispatchEvent(new Event('input', { bubbles: true }));
  }));

  function prepareSettings() {
    const p = getProject(); if (!p) return;
    busy = false;
    settingsId = p.id;
    void loadFollowup();
    concurrentFeedback.hidden=true;showConcurrent();
    form.elements.name.value = p.name || '';
    form.elements.description.value = p.description || '';
    feedback.hidden = true;
    folderFeedback.hidden = true; deleteFeedback.hidden = true;
    const saveBtn = document.querySelector('#save-project-settings');
    const delBtn = document.querySelector('#delete-project');
    if (saveBtn) saveBtn.disabled = false;
    if (delBtn) delBtn.disabled = false;
    return true;
  }
  document.querySelector('#show-project-settings').addEventListener('click', () => {
    if (prepareSettings()) openSettings('project');
  });
  form.addEventListener('input', () => { feedback.hidden = true; });

  document.querySelector('#delete-project').addEventListener('click', async () => {
    if (busy) return;
    const p = getData().projects.find(x => x.id === settingsId) || getProject();
    const name = p?.name || form.elements.name.value || 'this project';
    if (!confirm(t('Delete project "{name}"? This cannot be undone.', { name }))) return;
    busy = true;
    const del = document.querySelector('#delete-project'), save = document.querySelector('#save-project-settings');
    del.disabled = true; if (save) save.disabled = true; deleteFeedback.hidden = true;
    try {
      await api(`/api/projects/${encodeURIComponent(settingsId)}`, { method: 'DELETE' });
      closeSettings();
      await refreshState({ quiet: true });
    } catch (e) { deleteFeedback.textContent = e.message; deleteFeedback.hidden = false; }
    finally { busy = false; del.disabled = false; if (save) save.disabled = false; }
  });
  async function saveProjectSettings() {
    if (busy) return;
    const name = String(form.elements.name.value || '').trim();
    if (!name) {
      feedback.textContent = 'Please enter a project name.';
      feedback.hidden = false;
      form.elements.name.focus();
      return;
    }
    busy = true;
    const save = document.querySelector('#save-project-settings');
    const del = document.querySelector('#delete-project');
    if (save) save.disabled = true;
    if (del) del.disabled = true;
    feedback.hidden = true;
    try {
      await api(`/api/projects/${encodeURIComponent(settingsId)}`, {
        method: 'POST',
        json: { name, description: form.elements.description.value }
      });
      feedback.textContent = t('Saved');
      feedback.hidden = false;
      await refreshState({ quiet: true });
    } catch (e) {
      feedback.textContent = e.message;
      feedback.hidden = false;
    } finally {
      busy = false;
      if (save) save.disabled = false;
      if (del) del.disabled = false;
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void saveProjectSettings(); });

  return {
    openFolder,
    refreshNodes,
    refreshConcurrent:()=>{if(!concurrentBox.disabled)showConcurrent();},
    prepareSettings
  };
}
