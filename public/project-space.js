import { t, getLanguage } from './i18n.js';
import { deviceIconEl, setActionIcon, UI_ICON } from './role-icons.js';
import {deviceAccessRows} from './device-access.js';

/** The account a repository URL will use, the same order Home applies: the account owning it, the default, the only one. */
export function matchHostingAccount(url, accounts = [], preferred = '') {
  const remote = String(url || '').trim().match(/^(?:https:\/\/|git@)(gitee\.com|github\.com)[/:]([\w.-]+)\/[\w.-]+?(?:\.git)?\/?$/i);
  if (!remote) return null;
  const provider = remote[1].toLowerCase().split('.')[0], owner = remote[2].toLowerCase();
  const same = accounts.filter(account => account.provider === provider), owned = same.filter(account => String(account.owner || '').toLowerCase() === owner);
  return (owned.length === 1 ? owned[0] : null) || same.find(account => account.id === preferred) || (same.length === 1 ? same[0] : null);
}
/** Several accounts on the URL's platform and none chosen by the rule above: Home refuses to guess. */
export function hostingAccountAmbiguous(url, accounts = [], preferred = '') {
  const remote = String(url || '').trim().match(/^(?:https:\/\/|git@)(gitee\.com|github\.com)[/:]/i);
  return Boolean(remote) && !matchHostingAccount(url, accounts, preferred) && accounts.filter(account => account.provider === remote[1].toLowerCase().split('.')[0]).length > 1;
}

/**
 * Repositories and workspace: one row per device for the project folder (use the default folder, or pick an existing one) and
 * one row per repository; adding or editing a repository happens in a dialog. Only paths confirmed by the target Worker are shown.
 */
export function projectSpaceUI({ api, getData, getProject, refreshState, create, openFolder }) {
  const folderRows = document.querySelector('#project-folder-rows'), folderFeedback = document.querySelector('#project-folder-feedback');
  const accessRows = document.querySelector('#project-device-access-rows'), accessFeedback = document.querySelector('#project-device-access-feedback');
  const repoRows = document.querySelector('#project-repository-rows'), feedback = document.querySelector('#project-space-feedback');
  const dialog = document.querySelector('#project-repository-dialog'), form = document.querySelector('#project-repository-form');
  const dialogFeedback = document.querySelector('#project-repository-feedback'), nodes = document.querySelector('#repository-node-options');
  const submit = form.querySelector('[data-repository-submit]'), accountNote = form.querySelector('[data-repository-account]');
  const removeButton = document.querySelector('#remove-project-repository');
  let signature = '', projectId = '', editing = null, keyTouched = false, submitting = false;
  let accessSaving = Promise.resolve();
  const busy = new Set();
  setActionIcon(document.querySelector('#add-project-repository'), 'plus', t('Add repository'));
  const show = (node, text) => { node.textContent = t(text || ''); node.hidden = !text; };
  const icon = (name, label, onClick, { disabled = false, tint = false } = {}) => {
    const button = create('button', `icon-button${tint ? ' is-tint' : ''}`); button.type = 'button'; button.disabled = disabled;
    setActionIcon(button, name, t(label)); button.addEventListener('click', onClick); return button;
  };
  const chip = (tone, text) => create('span', `settings-chip ${tone}`, text);
  /** One request at a time per row; the result note sits under the card and the state refresh redraws the rows. */
  async function act(key, note, fn, done = 'Saved') {
    if (busy.has(key)) return; busy.add(key); signature = ''; render();
    show(note, 'Processing…');
    try {
      const result = await fn();
      show(note, result?.status === 'blocked' ? t('Some operations did not complete: {v}', { v: result.results.filter(r => r.error).map(r => r.error).join(t('; ')) }) : done);
      return result;
    } catch (error) { show(note, error.message); return null; }
    finally { busy.delete(key); signature = ''; try { await refreshState({ quiet: true }); } catch {} render(); }
  }
  const prepare = nodeId => act(`folder:${nodeId}`, folderFeedback, () => api(`/api/projects/${encodeURIComponent(projectId)}/prepare/${encodeURIComponent(nodeId)}`, { method: 'POST', json: {} }), 'Project folder checked.');
  const pick = (worker, current) => openFolder?.(worker.id, current || '', path => {
    const id = projectId;
    void act(`folder:${worker.id}`, folderFeedback, () => api(`/api/projects/${encodeURIComponent(id)}/workspaces/${encodeURIComponent(worker.id)}`, { method: 'POST', json: { localRoot: path } }), 'Project folder saved.');
  });

  function folderRow(project, worker, binding) {
    const row = create('div', 'settings-row'), main = create('span', 'settings-row-main'), pending = busy.has(`folder:${worker.id}`);
    const fallback = `${(worker.workspaceRoot || worker.allowedRoots?.[0] || '').replace(/\/$/, '')}/${project.folderName || ''}`;
    const path = create('small'), code = create('code', '', binding?.localRoot || (worker.workspaceRoot || worker.allowedRoots?.[0] ? t('Default: {path}', { path: fallback }) : t('Workspace not set')));
    path.append(code); main.append(create('strong', '', worker.name || worker.id), path);
    const health = (versionsOf(getData())?.folders || []).find(f => f.nodeId === worker.id);
    const state = pending ? chip('warn', t('Checking…')) : !worker.online ? chip('off', t('Offline')) : !binding ? chip('off', t('Not joined'))
      : health?.status === 'unavailable' ? chip('warn', t('Folder missing')) : chip('ok', t('Folder ready'));
    if (health?.error) state.title = health.error;
    const actions = create('span', 'settings-row-actions'), offline = !worker.online || pending;
    if (binding) actions.append(icon('folder', 'Choose another folder', () => pick(worker, binding.localRoot), { disabled: offline }), icon('refresh', 'Check project folder', () => void prepare(worker.id), { disabled: offline }));
    else actions.append(icon('folder', 'Use an existing folder', () => pick(worker, ''), { disabled: offline }), icon('plus', 'Join with the default folder', () => void prepare(worker.id), { disabled: offline, tint: true }));
    const glyph = create('span', 'settings-row-icon'); glyph.append(deviceIconEl(worker));
    row.append(glyph, main, state, actions); return row;
  }

  const expanded = new Set(), outcomes = new Map();
  const versionsOf = data => (data.projectGitVersions || []).find(v => v.projectId === projectId) || null;
  const repoUrl = (repo, path = '') => `/api/projects/${encodeURIComponent(projectId)}/repositories/${encodeURIComponent(repo.key)}${path}`;
  /** Problems a device's copy has against the unified version (or its own remote branch when none is set). */
  function deviceIssues(item, repo) {
    if (!item || ['missing', 'offline', 'unknown'].includes(item.status)) return null;
    const issues = [];
    if (repo.baseBranch && item.targetBranch === repo.baseBranch && item.onTarget === false) issues.push(t('On branch {branch}', { branch: item.branch }));
    if (item.ahead) issues.push(item.targetBranch ? t('{count} commits not in the unified version', { count: item.ahead }) : t('{count} unpushed commits', { count: item.ahead }));
    if (item.behind) issues.push(t('{count} commits behind', { count: item.behind }));
    if (item.dirty) issues.push(t('Uncommitted changes'));
    return issues;
  }
  function deviceState(item, worker, repo) {
    if (!worker?.online || item?.status === 'offline') return chip('off', t('Offline'));
    if (!item) return chip('off', t('To check'));
    if (item.status === 'missing') return chip('warn', t('Folder missing'));
    if (item.status === 'unknown') return chip('warn', t('Check failed'));
    const issues = deviceIssues(item, repo);
    return issues.length ? chip('warn', issues.join(t(', '))) : chip('ok', repo.baseBranch && item.targetBranch === repo.baseBranch ? t('Matches the unified version') : t('Matches its remote branch'));
  }
  function repositoryState(repo, bindings, workerName, items) {
    if (!bindings.length) return chip('off', t('No device yet'));
    const attention = bindings.filter(b => { const item = items.find(i => i.nodeId === b.nodeId); return item?.status === 'missing' || deviceIssues(item, repo)?.length; }).length;
    if (attention) return chip('warn', t('{count} devices need attention', { count: attention }));
    const head = b => items.find(i => i.nodeId === b.nodeId)?.localCommit || b.git?.head || '';
    const heads = new Set(bindings.map(head));
    if (heads.size === 1 && !heads.has('')) return chip('ok', bindings.length > 1 ? t('{count} devices match · {head}', { count: bindings.length, head: [...heads][0].slice(0, 8) }) : `${workerName(bindings[0].nodeId)} · ${[...heads][0].slice(0, 8)}`);
    if (heads.has('')) return chip('off', t('To check'));
    return chip('warn', t('Devices differ: {list}', { list: bindings.map(b => `${workerName(b.nodeId)} ${head(b).slice(0, 8)}`).join(t(', ')) }));
  }
  const outcomeText = (r, repo) => ({
    updated: () => t('updated to {commit}', { commit: String(r.localCommit || '').slice(0, 8) }), synced: () => t('already matches'),
    dirty: () => t('has uncommitted changes; left as it is'), ahead: () => t('has {count} commits not in the unified version; push or merge them first', { count: r.ahead }),
    remote_unavailable: () => t('could not reach the remote branch; left as it is'), detached_commits: () => t('has commits on a detached HEAD that no branch holds; left as it is'),
    baseline_copy: () => t('uses an old baseline copy; choose its source checkout folder first'),
    diverged: () => t('has {ahead} commits not in the unified version and is {behind} commits behind; merge first', { ahead: r.ahead, behind: r.behind }),
    needs_switch: () => t('is on branch {branch}; not switched', { branch: r.branch }), offline: () => t('offline'), worker_unsupported: () => t('needs a Worker update'),
  }[r.status]?.() || r.error || r.status) + (r.switchedFrom ? ' · ' + t('switched from {branch} to {target}', { branch: r.switchedFrom, target: repo.baseBranch }) : '');
  async function align(repo, workerName) {
    const key = `repo:${repo.key}`;
    await act(key, feedback, async () => {
      let result = await api(repoUrl(repo, '/align'), { method: 'POST', json: {} });
      const off = result.results.filter(r => r.status === 'needs_switch');
      if (off.length && window.confirm(t('{list} are on another branch. Switch them to {branch}? Only clean checkouts are switched; their current branches and commits are kept.', { list: off.map(r => `${workerName(r.nodeId)} (${r.branch})`).join(t(', ')), branch: result.branch })))
        result = await api(repoUrl(repo, '/align'), { method: 'POST', json: { allowSwitch: off.map(r => r.nodeId) } });
      outcomes.set(repo.id, result.results.map(r => `${workerName(r.nodeId)}: ${outcomeText(r, repo)}`).join('\n'));
      return result;
    }, 'Alignment finished.');
  }
  const recheck = repo => act(`repo:${repo.key}`, feedback, () => api(`/api/projects/${encodeURIComponent(projectId)}/git-versions`, { method: 'POST', json: {} }), 'Checked.');
  const pickRepositoryFolder = (repo, binding, worker) => openFolder?.(worker.id, binding.localRoot || '', path => {
    void act(`device:${repo.key}:${worker.id}`, feedback, async () => {
      let result = await api(repoUrl(repo, `/devices/${encodeURIComponent(worker.id)}`), { method: 'POST', json: { localRoot: path } });
      if (result.needsConfirm) {
        const details = [result.dirty ? t('uncommitted changes') : '', result.ahead ? t('{count} commits not in the unified version', { count: result.ahead }) : ''].filter(Boolean).join(t(', '));
        const question = result.error ? t('{error}. Use the new folder anyway? The current folder {path} is kept as it is.', { error: result.error, path: result.localRoot })
          : t('The current folder {path} has {details}. Use the new folder anyway? The current folder is kept as it is.', { path: result.localRoot, details });
        if (!window.confirm(question)) return { status: 'kept' };
        result = await api(repoUrl(repo, `/devices/${encodeURIComponent(worker.id)}`), { method: 'POST', json: { localRoot: path, confirm: true } });
      }
      return result;
    }, 'Folder changed.');
  });
  const removeDevice = (repo, binding, worker) => {
    if (!window.confirm(t('Stop using {repo} on {device}? Its folder stays on the device.', { repo: repo.name || repo.key, device: worker?.name || binding.nodeId }))) return;
    void act(`device:${repo.key}:${binding.nodeId}`, feedback, () => api(repoUrl(repo, `/devices/${encodeURIComponent(binding.nodeId)}`), { method: 'DELETE' }), 'Device removed from the repository.');
  };
  function deviceRow(repo, binding, item, worker) {
    const row = create('div', 'settings-row repository-device-row'), main = create('span', 'settings-row-main'), pending = busy.has(`device:${repo.key}:${binding.nodeId}`);
    const path = create('small'); path.append(create('code', '', item?.localRoot || binding.localRoot));
    const branch = item?.branch || binding.git?.branch, commit = item?.localCommit || binding.git?.head;
    main.append(create('strong', '', worker?.name || binding.nodeId), path);
    if (branch || commit) main.append(create('small', '', [branch, String(commit || '').slice(0, 8)].filter(Boolean).join(' · ')));
    const state = pending ? chip('warn', t('Processing…')) : deviceState(item, worker, repo);
    if (item?.error) state.title = item.error;
    const actions = create('span', 'settings-row-actions'), offline = !worker?.online || pending;
    actions.append(icon('folder', 'Choose another folder', () => pickRepositoryFolder(repo, binding, worker), { disabled: offline }),
      icon('trash', 'Stop using it on this device', () => removeDevice(repo, binding, worker), { disabled: pending }));
    const glyph = create('span', 'settings-row-icon'); glyph.append(deviceIconEl(worker || {}));
    row.append(glyph, main, state, actions); return row;
  }
  function repositoryRow(repo, data, workerName) {
    const bindings = (data.repositoryWorkspaces || []).filter(b => b.repositoryId === repo.id), items = (versionsOf(data)?.items || []).filter(i => i.repositoryId === repo.id);
    const group = create('div', 'repository-group'), row = create('div', 'settings-row repository-row'), main = create('span', 'settings-row-main'), title = create('strong', '', repo.name || repo.key);
    const branch = repo.baseBranch || bindings.find(b => b.baselineBranch)?.baselineBranch;
    if (branch) title.append(create('span', 'settings-row-aside', ` · ${branch}`));
    main.append(title, create('small', '', String(repo.repoUrl || '').replace(/^https:\/\//, '').replace(/\.git$/, '')));
    const glyph = create('span', 'settings-row-icon'); glyph.innerHTML = UI_ICON.git;
    const open = expanded.has(repo.id), toggle = create('button', 'repository-toggle'); toggle.type = 'button'; toggle.setAttribute('aria-expanded', String(open));
    toggle.append(glyph, main); toggle.addEventListener('click', () => { if (expanded.has(repo.id)) expanded.delete(repo.id); else expanded.add(repo.id); signature = ''; render(); });
    const actions = create('span', 'settings-row-actions');
    actions.append(icon('edit', 'Edit repository', () => openDialog(repo), { disabled: busy.has(`repo:${repo.key}`) }));
    const state = busy.has(`repo:${repo.key}`) ? chip('warn', t('Processing…')) : repositoryState(repo, bindings, workerName, items);
    state.title = bindings.map(b => `${workerName(b.nodeId)} · ${b.baselineBranch || t('Original folder')} · ${b.localRoot} · ${b.git?.head?.slice(0, 10) || t('To check')}`).join('\n');
    row.append(toggle, state, actions); group.append(row);
    if (!open) return group;
    const panel = create('div', 'repository-devices'), bar = create('div', 'repository-devices-bar'), workers = data.workers || [];
    bar.append(create('span', '', repo.baseBranch ? t('Unified version: origin/{branch}', { branch: repo.baseBranch }) : t('No unified branch yet; set one under Edit repository')));
    const alignButton = create('button', 'secondary', t('Align to the unified version')); alignButton.type = 'button'; alignButton.disabled = !repo.baseBranch || busy.has(`repo:${repo.key}`);
    alignButton.addEventListener('click', () => void align(repo, workerName));
    const checkButton = create('button', 'secondary', t('Check again')); checkButton.type = 'button'; checkButton.disabled = busy.has(`repo:${repo.key}`);
    checkButton.addEventListener('click', () => void recheck(repo));
    bar.append(alignButton, checkButton); panel.append(bar);
    for (const binding of bindings) panel.append(deviceRow(repo, binding, items.find(i => i.nodeId === binding.nodeId), workers.find(w => w.id === binding.nodeId)));
    if (!bindings.length) panel.append(create('p', 'settings-list-note', t('No device holds this repository yet; add one under Edit repository')));
    if (outcomes.get(repo.id)) panel.append(create('p', 'settings-list-note repository-outcome', outcomes.get(repo.id)));
    group.append(panel); return group;
  }

  function render() {
    const p = getProject(), data = getData(); if (!p) return;
    if (projectId !== p.id) { show(feedback, ''); show(folderFeedback, ''); show(accessFeedback, ''); if (dialog.open) dialog.close(); }
    projectId = p.id;
    document.querySelector('#project-folder-name').value = p.folderName || t('Keep existing folder');
    const bindings = (data.workspaces || []).filter(w => w.projectId === p.id), repos = (data.repositories || []).filter(r => r.projectId === p.id);
    const next = JSON.stringify([p.id, p.folderName, p.deviceAccess || null, bindings, repos, data.repositoryWorkspaces, (data.workers || []).map(w => [w.id, w.name, w.online, w.workspaceRoot, w.nodeKind, w.platform]), data.repositoryOperations, versionsOf(data), [...expanded], [...outcomes], [...busy], getLanguage()]);
    if (next === signature) return; signature = next;
    const workers = data.workers || [], workerName = id => workers.find(w => w.id === id)?.name || id;
    folderRows.replaceChildren(...workers.map(w => folderRow(p, w, bindings.find(b => b.nodeId === w.id))));
    if (!workers.length) folderRows.append(create('div', 'settings-list-empty', t('No devices registered yet')));
    // wb device for this project's roles: a read and a write level per device; saved as a whole on every change.
    const id = p.id;
    // The change shows at once and saves in order; a later change waits for the earlier save instead of being dropped.
    accessRows.replaceChildren(...deviceAccessRows({ workers, value: p.deviceAccess, create, save: value => {
      p.deviceAccess = value; show(accessFeedback, 'Saving…');
      accessSaving = accessSaving.then(() => api(`/api/projects/${encodeURIComponent(id)}/device-access`, { method: 'POST', json: { deviceAccess: value } }))
        .then(() => show(accessFeedback, 'Saved'), error => show(accessFeedback, error.message)).then(() => refreshState({ quiet: true }).catch(() => {}));
    } }));
    if (!workers.length) accessRows.append(create('div', 'settings-list-empty', t('No devices registered yet')));
    repoRows.replaceChildren(...repos.map(repo => repositoryRow(repo, data, workerName)));
    if (!repos.length) { const empty = create('div', 'settings-list-empty'); empty.innerHTML = UI_ICON.git; empty.append(create('span', '', t('No repository yet; plain-file projects use the project folder directly'))); repoRows.append(empty); }
    for (const op of (data.repositoryOperations || []).filter(o => o.projectId === p.id && o.status !== 'ready'))
      repoRows.append(create('p', 'settings-list-note inline-error', t('{v}: {v2}', { v: op.id.split(':').at(-1), v2: op.error || op.results?.filter(r => r.error).map(r => r.error).join(t('; ')) || op.status })));
    if (dialog.open) refreshDialog();
  }

  // The dialog: link an existing repository (the account follows the URL) or create one under a chosen account.
  const mode = () => form.elements.mode.value;
  function refreshDialog() {
    const data = getData(), accounts = data.hostingAccounts || [], preferred = data.settings?.hostingAccountId || '';
    for (const node of form.querySelectorAll('[data-mode]')) node.hidden = node.dataset.mode !== mode();
    form.querySelector('[data-repository-mode]').hidden = Boolean(editing);
    form.querySelector('[data-repository-edit]').hidden = !editing; removeButton.hidden = !editing;
    const matched = matchHostingAccount(form.elements.repoUrl.value, accounts, preferred);
    const url = form.elements.repoUrl.value;
    accountNote.textContent = !url.trim() ? '' : matched ? t('Will use account: {label} (matched by URL)', { label: matched.label })
      : hostingAccountAmbiguous(url, accounts, preferred) ? t('Several accounts on this platform could be used; mark one as the default in Settings → Code Hosting Accounts') : t("Uses the device's own Git credentials");
    const select = form.elements.accountId, old = select.value;
    select.replaceChildren(...accounts.map(account => { const option = create('option', '', `${account.label} · ${account.private ? t('Private') : t('Public')}`); option.value = account.id; return option; }));
    if (!accounts.length) { const option = create('option', '', t('Connect a hosting account in Settings first')); option.value = ''; select.append(option); }
    select.value = accounts.some(a => a.id === old) ? old : accounts.some(a => a.id === preferred) ? preferred : accounts[0]?.id || '';
    const bound = editing ? (data.repositoryWorkspaces || []).filter(b => b.repositoryId === editing.id).map(b => b.nodeId) : null;
    const checked = new Set([...nodes.querySelectorAll('input:checked')].map(el => el.value));
    const projectNodes = (data.workspaces || []).filter(w => w.projectId === projectId).map(w => w.nodeId);
    const fresh = !nodes.childElementCount;
    nodes.replaceChildren(...(data.workers || []).map(w => {
      const label = create('label', 'checkbox-label', w.name || w.id), input = create('input'); input.type = 'checkbox'; input.name = 'nodeIds'; input.value = w.id;
      input.checked = fresh ? (bound || projectNodes).includes(w.id) : checked.has(w.id) || Boolean(bound?.includes(w.id));
      // A device already holding the repository stays; editing can only add devices.
      if (bound?.includes(w.id)) { input.checked = true; input.disabled = true; }
      label.prepend(input); return label;
    }));
    submit.disabled = submitting || (mode() === 'create' && !select.value);
  }
  function openDialog(repo = null) {
    editing = repo; keyTouched = Boolean(repo); form.reset(); nodes.replaceChildren(); show(dialogFeedback, '');
    document.querySelector('#project-repository-title').textContent = t(repo ? 'Edit repository' : 'Add repository');
    submit.textContent = t(repo ? 'Save' : 'Add repository');
    form.elements.key.readOnly = Boolean(repo);
    if (repo) {
      form.elements.mode.value = 'existing'; form.elements.repoUrl.value = repo.repoUrl || ''; form.elements.key.value = repo.key || repo.name || '';
      // Suggest the branch the devices already have when none is set yet.
      form.elements.baseBranch.value = repo.baseBranch || (getData().repositoryWorkspaces || []).find(b => b.repositoryId === repo.id && b.git?.branch && b.git.branch !== 'detached')?.git.branch || '';
    }
    form.elements.repoUrl.readOnly = Boolean(repo);
    refreshDialog(); dialog.showModal(); (repo ? form.elements.key : form.elements.repoUrl).focus();
  }
  document.querySelector('#add-project-repository').addEventListener('click', () => openDialog());
  for (const id of ['#close-project-repository', '#cancel-project-repository']) document.querySelector(id).addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { editing = null; });
  form.addEventListener('input', event => {
    show(dialogFeedback, '');
    if (event.target.name === 'key') keyTouched = true;
    // The folder name follows the repository name until it is typed by hand.
    if (!keyTouched && ['repoUrl', 'remoteName'].includes(event.target.name)) {
      const source = event.target.name === 'repoUrl' ? form.elements.repoUrl.value.trim().replace(/\.git\/?$/, '').split(/[/:]/).at(-1) : form.elements.remoteName.value.trim();
      form.elements.key.value = String(source || '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^[-_]+/, '').slice(0, 40);
    }
    if (['mode', 'repoUrl', 'accountId'].includes(event.target.name)) refreshDialog();
  });
  removeButton.addEventListener('click', async () => {
    const repo = editing; if (!repo) return;
    if (!window.confirm(t('Remove {repo} from this project? The folders on every device stay as they are.', { repo: repo.name || repo.key }))) return;
    const result = await act(`repo:${repo.key}`, feedback, () => api(repoUrl(repo), { method: 'DELETE' }), 'Repository removed.');
    if (result) dialog.close(); else show(dialogFeedback, feedback.textContent);
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const id = projectId, key = form.elements.key.value.trim(), nodeIds = [...nodes.querySelectorAll('input:checked')].map(el => el.value);
    if (editing) {
      // Editing saves the unified branch and prepares only devices that were added; existing copies are not prepared again.
      const repo = editing, bound = (getData().repositoryWorkspaces || []).filter(b => b.repositoryId === repo.id).map(b => b.nodeId);
      const branch = form.elements.baseBranch.value.trim(), added = nodeIds.filter(n => !bound.includes(n));
      submitting = true; submit.disabled = true; show(dialogFeedback, 'Processing…');
      let ok = true;
      if (branch !== (repo.baseBranch || '')) ok = Boolean(await act(`repo:${key}`, feedback, () => api(repoUrl(repo, '/branch'), { method: 'POST', json: { branch } }), 'Saved'));
      // An old baseline copy still moves back to its source checkout through the full preparation, as before.
      const legacy = (getData().repositoryWorkspaces || []).some(b => b.repositoryId === repo.id && b.baselineBranch);
      if (ok && (added.length || legacy)) ok = Boolean(await act(`repo:${key}`, feedback, () => api(`/api/projects/${encodeURIComponent(id)}/repositories`, { method: 'POST', json: { key, mode: 'existing', nodeIds, repoUrl: repo.repoUrl } }), 'Repository prepared.'));
      submitting = false; submit.disabled = false;
      if (ok) { if (dialog.open) dialog.close(); } else show(dialogFeedback, feedback.textContent);
      return;
    }
    const fields = { key, mode: mode(), nodeIds, ...(mode() === 'create' ? { accountId: form.elements.accountId.value, remoteName: form.elements.remoteName.value.trim() } : { repoUrl: form.elements.repoUrl.value.trim() }) };
    if (!nodeIds.length) { show(dialogFeedback, 'Choose at least one device.'); return; }
    submitting = true; submit.disabled = true; show(dialogFeedback, 'Processing…');
    const result = await act(`repo:${key}`, feedback, () => api(`/api/projects/${encodeURIComponent(id)}/repositories`, { method: 'POST', json: fields }), 'Repository prepared.');
    submitting = false; submit.disabled = false;
    if (result) { if (dialog.open) dialog.close(); } else show(dialogFeedback, feedback.textContent);
  });
  return { refresh: render };
}
