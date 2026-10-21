import { t } from './i18n.js';
import { setActionIcon } from './role-icons.js';

/** Platform-wide role templates: list, edit, delete and restore. Roles already created keep their own copied text. */
export function roleTemplatesUI({ api, getData, refreshState, create }) {
  const dialog = document.querySelector('#role-templates-dialog');
  const browser = document.querySelector('#role-templates-browser');
  const list = document.querySelector('#role-templates-list');
  const hiddenSection = document.querySelector('#role-templates-hidden');
  const hiddenList = document.querySelector('#role-templates-hidden-list');
  const feedback = document.querySelector('#role-templates-feedback');
  const form = document.querySelector('#role-template-form');
  const error = document.querySelector('#role-template-error');
  const summary = document.querySelector('#role-templates-summary');
  if (!dialog || !form) return { render() {} };
  let editing = null, busy = false;

  const templates = () => getData().roleTemplates || [];
  const hidden = () => getData().hiddenRoleTemplates || [];
  const preview = text => { const value = String(text || '').trim(); return value.length > 140 ? `${value.slice(0, 140)}…` : value; };

  function say(message, isError = false) {
    feedback.textContent = message; feedback.hidden = !message;
    feedback.classList.toggle('is-error', isError);
  }

  function renderSummary() {
    if (!summary) return;
    const items = templates(), custom = items.filter(item => !item.builtin).length;
    summary.textContent = items.length
      ? t('{count} templates ({custom} added): {names}', { count: items.length, custom, names: items.map(item => item.name).join(', ') })
      : t('No templates; new roles start blank.');
  }

  function row(item, deleted) {
    const node = create('article', 'role-template-item');
    const head = create('div', 'role-template-head');
    const name = create('strong', 'role-template-name', item.name); name.setAttribute('translate', 'no');
    head.append(name);
    if (!deleted) head.append(create('span', `role-template-badge${item.builtin ? '' : ' is-custom'}`, item.builtin ? (item.customized ? 'Built-in · edited' : 'Built-in') : 'Added'));
    const text = create('p', 'role-template-text', preview(item.responsibility) || t('No responsibility set'));
    text.setAttribute('translate', 'no');
    const meta = create('p', 'role-template-meta', item.instructions?.trim() ? t('Prompt: {count} characters', { count: item.instructions.trim().length }) : 'No prompt');
    const actions = create('div', 'role-template-actions');
    // Same as the scheduled-job rows: short row actions are icons, the label stays as tooltip and accessible name.
    const button = (label, handler, className = 'secondary compact') => { const b = create('button', className, label); b.type = 'button'; const icon = { Edit: 'edit', Delete: 'trash', Restore: 'back', 'Restore default': 'back' }[label]; if (icon) setActionIcon(b, icon, t(label)); b.addEventListener('click', handler); actions.append(b); return b; };
    if (deleted) button('Restore', () => restore(item));
    else {
      button('Edit', () => openForm(item));
      if (item.builtin && item.customized) button('Restore default', () => restore(item));
      button('Delete', () => remove(item), 'danger compact');
    }
    node.append(head, text, meta, actions);
    return node;
  }

  function renderList() {
    list.replaceChildren(...templates().map(item => row(item, false)));
    const removed = hidden();
    hiddenSection.hidden = !removed.length;
    hiddenList.replaceChildren(...removed.map(item => row(item, true)));
  }

  function showBrowser() {
    editing = null; form.hidden = true; browser.hidden = false; error.hidden = true;
    document.querySelector('#role-templates-title').textContent = 'Role templates';
    renderList();
  }

  function openForm(item) {
    editing = item || null; form.reset(); error.hidden = true;
    form.elements.name.value = item?.name || '';
    form.elements.responsibility.value = item?.responsibility || '';
    form.elements.instructions.value = item?.instructions || '';
    browser.hidden = true; form.hidden = false;
    document.querySelector('#role-templates-title').textContent = item ? 'Edit role template' : 'New role template';
    form.elements.name.focus();
  }

  async function run(action, success) {
    if (busy) return;
    busy = true; say('');
    try { await action(); await refreshState({ quiet: true }); showBrowser(); say(success); }
    catch (e) { if (!form.hidden) { error.textContent = e.message; error.hidden = false; } else say(e.message, true); }
    finally { busy = false; }
  }

  async function remove(item) {
    if (!confirm(t('Delete template "{name}"? Roles already created from it are not changed.', { name: item.name }))) return;
    await run(() => api(`/api/settings/role-templates/${encodeURIComponent(item.key)}?revision=${item.revision}`, { method: 'DELETE' }), t('Template deleted.'));
  }

  async function restore(item) {
    await run(() => api(`/api/settings/role-templates/${encodeURIComponent(item.key)}/restore`, { method: 'POST', json: { revision: item.revision } }), t('Built-in template restored.'));
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    const json = { name: form.elements.name.value, responsibility: form.elements.responsibility.value, instructions: form.elements.instructions.value,
      ...(editing ? { key: editing.key, revision: editing.revision } : {}) };
    void run(() => api('/api/settings/role-templates', { method: 'POST', json }), t('Template saved.'));
  });
  document.querySelector('#cancel-role-template').addEventListener('click', showBrowser);
  document.querySelector('#new-role-template').addEventListener('click', () => openForm(null));
  document.querySelector('#close-role-templates').addEventListener('click', () => dialog.close());
  document.querySelector('#manage-role-templates')?.addEventListener('click', () => { say(''); showBrowser(); dialog.showModal(); });

  return {
    render() { renderSummary(); if (dialog.open && form.hidden) renderList(); }
  };
}
