import { workerDisplayName } from './role-icons.js';

/** Node folder selection and repository settings share the existing authenticated API and never upload local browser files. */
export function projectSettings({ api, getData, getProject, refreshState, create, setError, openSettings, closeSettings }) {
  const picker = document.querySelector('#folder-dialog');
  const crumbs = document.querySelector('#folder-crumbs');
  const list = document.querySelector('#folder-list');
  const filterInput = document.querySelector('#folder-filter');
  const pathLabel = document.querySelector('#folder-path');
  const choose = document.querySelector('#folder-use'), up = document.querySelector('#folder-up');
  const more = document.querySelector('#folder-more'), error = document.querySelector('#folder-error');
  const projectForm = document.querySelector('#project-form'), bindingForm = document.querySelector('#binding-form');
  const form = document.querySelector('#project-settings-form');
  const checkButton = document.querySelector('#repository-check'), feedback = document.querySelector('#project-settings-feedback');
  const workspaceNode = document.querySelector('#settings-workspace-node');
  const localRoot = document.querySelector('#settings-local-root');
  const pickSettingsFolder = document.querySelector('#pick-settings-folder');
  const saveSettingsFolder = document.querySelector('#save-settings-folder');
  let workerId, current = null, callback, serial = 0, settingsId, savedUrl = '', busy = false, allowedRoots = [], filterText = '';
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
          acc = `${acc}/${seg}`;
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
    const version = ++serial;
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
      pathLabel.hidden = true;
      pathLabel.textContent = result.path || '';
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
    allowedRoots = Array.isArray(worker.allowedRoots) ? worker.allowedRoots.slice() : [];
    document.querySelector('#folder-title').textContent = `Select folder · ${workerDisplayName(worker)}`;
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

  function refreshNodes() {
    const select = projectForm.elements.nodeId, previous = select.value;
    select.replaceChildren(option('Bind node later', ''), ...getData().workers.map(w => option(`${workerDisplayName(w)} · ${w.online ? 'Online' : 'Offline'}`, w.id)));
    select.value = previous || '';
  }
  projectForm.elements.nodeId.addEventListener('change', () => {
    projectForm.elements.root.value = '';
    projectForm.dispatchEvent(new Event('input', { bubbles: true }));
  });
  document.querySelector('#pick-project-folder').addEventListener('click', () => openFolder(projectForm.elements.nodeId.value, projectForm.elements.root.value, path => {
    projectForm.elements.root.value = path; projectForm.dispatchEvent(new Event('input', { bubbles: true }));
  }));

  function fillWorkspaceFields(projectId, preferredNodeId = '') {
    const workers = getData().workers.filter(w => w.capabilities?.workspaceBindings);
    const previous = preferredNodeId || workspaceNode.value;
    workspaceNode.replaceChildren(
      option(workers.length ? 'Select device…' : 'No devices support binding', ''),
      ...workers.map(w => option(`${workerDisplayName(w)} · ${w.online ? 'Online' : 'Offline'}`, w.id))
    );
    const bound = getData().workspaces.filter(b => b.projectId === projectId);
    const pick = workers.find(w => w.id === previous)
      || workers.find(w => w.online && bound.some(b => b.nodeId === w.id))
      || workers.find(w => w.online)
      || workers[0];
    workspaceNode.value = pick?.id || '';
    const binding = getData().workspaces.find(b => b.projectId === projectId && b.nodeId === workspaceNode.value);
    localRoot.value = binding?.localRoot || '';
  }

  function fillGitCheckNodes(projectId) {
    const nodes = getData().workers.filter(w => getData().workspaces.some(b => b.nodeId === w.id && b.projectId === projectId));
    const previous = form.elements.nodeId.value;
    form.elements.nodeId.replaceChildren(option('Select node to check…', ''), ...nodes.map(w => option(`${workerDisplayName(w)} · ${w.online ? 'Online' : 'Offline'}`, w.id)));
    form.elements.nodeId.value = nodes.some(w => w.id === previous) ? previous : (nodes[0]?.id || '');
  }

  function prepareSettings() {
    const p = getProject(); if (!p) return;
    busy = false;
    settingsId = p.id; savedUrl = p.repoUrl || '';
    form.elements.name.value = p.name || '';
    form.elements.description.value = p.description || '';
    form.elements.repoUrl.value = savedUrl;
    feedback.hidden = true;
    const saveBtn = document.querySelector('#save-project-settings');
    const delBtn = document.querySelector('#delete-project');
    if (saveBtn) saveBtn.disabled = false;
    if (delBtn) delBtn.disabled = false;
    try { fillWorkspaceFields(p.id); } catch (e) { feedback.textContent = e.message; feedback.hidden = false; }
    try { fillGitCheckNodes(p.id); } catch (e) { feedback.textContent = e.message; feedback.hidden = false; }
    return true;
  }
  document.querySelector('#show-project-settings').addEventListener('click', () => {
    if (prepareSettings()) openSettings('project');
  });

  workspaceNode.addEventListener('change', () => {
    const binding = getData().workspaces.find(b => b.projectId === settingsId && b.nodeId === workspaceNode.value);
    localRoot.value = binding?.localRoot || '';
    feedback.hidden = true;
  });
  pickSettingsFolder.addEventListener('click', () => {
    if (!workspaceNode.value) return setError('Please select the device to bind a folder to first');
    openFolder(workspaceNode.value, localRoot.value, path => { localRoot.value = path; });
  });
  saveSettingsFolder.addEventListener('click', async () => {
    if (busy) return;
    if (!workspaceNode.value) { feedback.textContent = 'Please select a device first.'; feedback.hidden = false; return; }
    if (!localRoot.value) { feedback.textContent = 'Please select a local project folder first.'; feedback.hidden = false; return; }
    busy = true; saveSettingsFolder.disabled = true; pickSettingsFolder.disabled = true; feedback.hidden = true;
    try {
      const binding = await api(
        `/api/projects/${encodeURIComponent(settingsId)}/workspaces/${encodeURIComponent(workspaceNode.value)}`,
        { method: 'POST', json: { localRoot: localRoot.value } }
      );
      localRoot.value = binding.localRoot;
      const git = binding.git ? ` · Git ${binding.git.branch} @ ${String(binding.git.head || '').slice(0, 8)}` : '';
      feedback.textContent = `Local folder saved: ${binding.localRoot}${git}`;
      feedback.hidden = false;
      await refreshState({ quiet: true });
      fillWorkspaceFields(settingsId, workspaceNode.value);
      fillGitCheckNodes(settingsId);
    } catch (e) { feedback.textContent = e.message; feedback.hidden = false; }
    finally { busy = false; saveSettingsFolder.disabled = false; pickSettingsFolder.disabled = false; }
  });

  document.querySelector('#delete-project').addEventListener('click', async () => {
    if (busy) return;
    const p = getData().projects.find(x => x.id === settingsId) || getProject();
    const name = p?.name || form.elements.name.value || 'this project';
    if (!confirm(`Delete project "${name}"? This cannot be undone.`)) return;
    busy = true;
    const del = document.querySelector('#delete-project'), save = document.querySelector('#save-project-settings');
    del.disabled = true; if (save) save.disabled = true; feedback.hidden = true;
    try {
      await api(`/api/projects/${encodeURIComponent(settingsId)}`, { method: 'DELETE' });
      closeSettings();
      await refreshState({ quiet: true });
    } catch (e) { feedback.textContent = e.message; feedback.hidden = false; }
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
      const p = await api(`/api/projects/${encodeURIComponent(settingsId)}`, {
        method: 'POST',
        json: {
          name,
          description: form.elements.description.value,
          repoUrl: form.elements.repoUrl.value
        }
      });
      savedUrl = p.repoUrl; form.elements.repoUrl.value = savedUrl;
      feedback.textContent = 'Project settings saved. The repository connection check does not modify origin or push code.';
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
  document.querySelector('#save-project-settings').addEventListener('click', () => { void saveProjectSettings(); });
  function showCheck(check) {
    feedback.textContent = `${check.message}\n${check.origin ? `Node origin: ${check.origin}\n${check.remoteMatches ? 'Matches the project link' : 'Differs from the project link; not modified automatically'}` : 'No Gitee origin detected; only the link entered for the project was checked'}\nChecked at: ${new Date(check.checkedAt).toLocaleString()}`;
    feedback.hidden = false;
  }
  form.elements.nodeId.addEventListener('change', () => {
    const binding = getData().workspaces.find(b => b.projectId === settingsId && b.nodeId === form.elements.nodeId.value);
    const check = (getData().gitChecks || []).find(c => c.projectId === settingsId && c.nodeId === form.elements.nodeId.value && c.repoUrl === savedUrl && c.localRoot === binding?.localRoot);
    feedback.hidden = true; if (check) showCheck(check);
  });
  checkButton.addEventListener('click', async () => {
    if (busy) return;
    if (!savedUrl || form.elements.repoUrl.value.trim() !== savedUrl || !form.elements.nodeId.value) {
      feedback.textContent = 'Please save the repository link first, then select a bound node.'; feedback.hidden = false; return;
    }
    busy = true; checkButton.disabled = true; checkButton.textContent = 'Checking node…';
    try {
      showCheck(await api(`/api/projects/${encodeURIComponent(settingsId)}/git-check`, { method: 'POST', json: { nodeId: form.elements.nodeId.value } }));
      await refreshState({ quiet: true });
    } catch (e) { feedback.textContent = e.message; feedback.hidden = false; }
    finally { busy = false; checkButton.disabled = false; checkButton.textContent = 'Check saved repository'; }
  });

  return {
    refreshNodes,
    prepareSettings,
    openBinding(nodeId) { openFolder(nodeId, bindingForm.elements.localRoot.value, path => { bindingForm.elements.localRoot.value = path; }); }
  };
}
