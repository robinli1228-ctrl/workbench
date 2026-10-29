import { t } from './i18n.js';
import { setActionIcon, UI_ICON } from './role-icons.js';

export const MEMORY_TYPES = ['decision', 'environment', 'credential', 'lesson', 'procedure', 'personal', 'other'];
const TYPE_LABELS = { decision: 'Decision', environment: 'Environment', credential: 'Account or secret', lesson: 'Lesson', procedure: 'Procedure', personal: 'Personal details', other: 'Other' };
export const memoryTypeLabel = type => t(TYPE_LABELS[type] || type);

/** One line under the card: how far organizing has reached, what waits and the last error. */
export function memoryStatusText(progress, organizer, formatTime = value => new Date(value).toLocaleString()) {
  if (!organizer?.nodeId) return t('Memory organizing is not set up; choose its model above.');
  if (progress === undefined) return t('Loading…');
  if (!progress) return '';
  const parts = [];
  if (progress.running) parts.push(t(!progress.pending && progress.checking ? 'Checking for duplicates…' : 'Organizing…'));
  else if (progress.requestedAt) parts.push(t('Waiting to organize'));
  parts.push(progress.pending ? t('Messages not organized yet: {count}', { count: progress.pending }) : t('All messages organized'));
  if (progress.lastRunAt) parts.push(t('Last run {time}', { time: formatTime(progress.lastRunAt) }));
  if (!progress.requestedAt && progress.pending) parts.push(t('Next run daily at {time}', { time: organizer.time || '03:00' }));
  if (progress.lastError) parts.push(t('Last attempt failed: {error}; retrying {time}', { error: progress.lastError, time: (progress.errorRetryAt || progress.retryAt) ? formatTime(progress.errorRetryAt || progress.retryAt) : '' }));
  return parts.join(' · ');
}

/**
 * Settings → Memory: the platform's shared memory, one page at a time. Home filters and pages (words and type), so a
 * large memory never loads at once. Add/edit in a dialog, delete, and a run-now button; entries saved here are marked as
 * people's, so organizing keeps them.
 */
const PAGE = 50;
export function platformMemoryUI({ api, getData, create, formatTime, visible = () => true }) {
  const rows = document.querySelector('#platform-memory-rows'), status = document.querySelector('#platform-memory-status');
  const feedback = document.querySelector('#platform-memory-feedback'), filter = document.querySelector('#platform-memory-search'), typeFilter = document.querySelector('#platform-memory-type');
  const pager = document.querySelector('#platform-memory-pager'), pageLabel = document.querySelector('#platform-memory-page');
  const previous = document.querySelector('#platform-memory-previous'), next = document.querySelector('#platform-memory-next');
  const dialog = document.querySelector('#platform-memory-dialog'), form = document.querySelector('#platform-memory-form'), dialogFeedback = document.querySelector('#platform-memory-dialog-feedback');
  const organize = document.querySelector('#organize-platform-memory'), add = document.querySelector('#add-platform-memory');
  if (!rows) return { load: async () => {}, refresh: () => {} };
  setActionIcon(organize, 'refresh', t('Organize now'));
  setActionIcon(add, 'plus', t('Add memory'));
  setActionIcon(previous, 'previous', t('Previous page'));
  setActionIcon(next, 'next', t('Next page'));
  let offset = 0, filterTimer = null;
  let state = null, version = 0, editing = null, busy = false, loading = false, loadedAt = 0, failed = false;
  const show = (node, text) => { node.textContent = text || ''; node.hidden = !text; };
  // Entry text, device and chat names are people's or the organizer's words: the page translator must leave them alone.
  const raw = node => { node.setAttribute('translate', 'no'); return node; };
  const option = (value, label) => { const node = create('option', '', label); node.value = value; return node; };
  typeFilter.replaceChildren(option('', t('All types')), ...MEMORY_TYPES.map(type => option(type, memoryTypeLabel(type))));
  form.elements.type.replaceChildren(...MEMORY_TYPES.map(type => option(type, memoryTypeLabel(type))));
  const icon = (name, label, onClick) => { const button = create('button', 'icon-button'); button.type = 'button'; setActionIcon(button, name, t(label)); button.addEventListener('click', onClick); return button; };

  function row(entry) {
    const node = create('div', 'settings-row platform-memory-row'), main = create('span', 'settings-row-main');
    const meta = [memoryTypeLabel(entry.type), entry.runtime, entry.device, entry.sourceProject ? t('From {project}', { project: entry.sourceProject }) : '', entry.edited ? t('Edited by people') : '', formatTime(entry.updatedAt)].filter(Boolean).join(' · ');
    main.append(raw(create('strong', 'platform-memory-content', entry.content)), raw(create('small', '', meta)));
    const glyph = create('span', 'settings-row-icon'); glyph.innerHTML = UI_ICON.memory;
    const actions = create('span', 'settings-row-actions');
    actions.append(icon('edit', 'Edit memory', () => openDialog(entry)), icon('trash', 'Delete memory', () => void remove(entry)));
    node.append(glyph, main, create('span'), actions);
    return node;
  }

  /** The status line and the run button only; state pushes refresh these without redrawing the rows. */
  function renderStatus() {
    const organizer = getData().settings?.memoryOrganizer;
    status.textContent = memoryStatusText(failed && !state ? null : state?.progress, organizer, formatTime);
    // A run waiting out a failure back-off can be forced again; only a queued or running one is left alone.
    const progress = state?.progress;
    organize.disabled = busy || !organizer?.nodeId || (!!progress?.requestedAt && !progress?.retryAt && !progress?.unrequested);
  }
  function render() {
    renderStatus();
    if (!state) { rows.replaceChildren(); pager.hidden = true; return; }
    rows.replaceChildren(...state.items.map(row));
    if (!state.items.length) {
      const empty = create('div', 'settings-list-empty'); empty.innerHTML = UI_ICON.memory;
      empty.append(create('span', '', t(state.all ? 'No memory matches the filter' : 'No memory yet; it is organized from the group chats')));
      rows.append(empty);
    }
    pager.hidden = state.total <= PAGE;
    pageLabel.textContent = t('{from}–{to} of {total}', { from: state.offset + 1, to: state.offset + state.items.length, total: state.total });
    previous.disabled = loading || state.offset === 0;
    next.disabled = loading || state.offset + state.items.length >= state.total;
  }

  const base = () => '/api/memories';
  async function load() {
    const mine = ++version;
    loading = true; loadedAt = Date.now(); render();
    const params = new URLSearchParams({ offset: String(offset), limit: String(PAGE), ...(filter.value.trim() ? { query: filter.value.trim() } : {}), ...(typeFilter.value ? { type: typeFilter.value } : {}) });
    try {
      const value = await api(`${base()}?${params}`);
      if (mine !== version) return;
      // A page emptied by deletions steps back to the last page that still has entries.
      if (!value.items.length && value.offset > 0 && value.total) { offset = Math.max(0, Math.floor((value.total - 1) / PAGE) * PAGE); loading = false; return load(); }
      state = value; failed = false; render();
    }
    catch (error) { if (mine === version) { failed = true; show(feedback, error.message); render(); } }
    finally { if (mine === version) { loading = false; render(); } }
  }
  /** Changes reload the list; a progress-only answer just updates the status. */
  async function call(path, options, progressOnly = false) {
    busy = true; render(); show(feedback, '');
    try {
      const value = await api(base() + path, options);
      if (progressOnly && state) state = { ...state, progress: value };
      await load();
      return value;
    } catch (error) { show(feedback, error.message); return null; }
    finally { busy = false; render(); }
  }
  async function remove(entry) {
    if (!confirm(t('Delete this memory? Organizing will not bring it back unless the chat says it again.'))) return;
    await call(`/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
  }

  function openDialog(entry = null) {
    editing = entry; form.reset(); show(dialogFeedback, '');
    const data = getData();
    document.querySelector('#platform-memory-title').textContent = t(entry ? 'Edit memory' : 'Add memory');
    form.elements.runtime.replaceChildren(option('', t('Any CLI')), ...['claude', 'codex', 'grok', 'agy'].map(id => option(id, id)));
    // A device removed since keeps its option, so saving the entry does not silently drop it.
    const workers = [...(data.workers || []).map(worker => [worker.id, worker.name || worker.id]), ...(entry?.nodeId && !(data.workers || []).some(worker => worker.id === entry.nodeId) ? [[entry.nodeId, entry.device || entry.nodeId]] : [])];
    form.elements.nodeId.replaceChildren(option('', t('Any device')), ...workers.map(([id, name]) => raw(option(id, name))));
    form.elements.type.value = entry?.type || 'other';
    form.elements.content.value = entry?.content || '';
    form.elements.runtime.value = entry?.runtime || '';
    form.elements.nodeId.value = entry?.nodeId || '';
    dialog.showModal();
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = form.querySelector('[type=submit]'); submit.disabled = true; show(dialogFeedback, '');
    const values = Object.fromEntries(new FormData(form));
    try {
      await api(editing ? `${base()}/${encodeURIComponent(editing.id)}` : base(), { method: editing ? 'PUT' : 'POST', json: values });
      dialog.close(); await load();
    } catch (error) { show(dialogFeedback, error.message); }
    finally { submit.disabled = false; }
  });
  for (const id of ['#close-platform-memory', '#cancel-platform-memory']) document.querySelector(id)?.addEventListener('click', () => dialog.close());
  add.addEventListener('click', () => openDialog());
  organize.addEventListener('click', () => void call('/organize', { method: 'POST', json: {} }, true));
  // Filtering asks Home again from the first page; typing waits a moment so each keystroke is not a request.
  filter.addEventListener('input', () => { clearTimeout(filterTimer); filterTimer = setTimeout(() => { offset = 0; void load(); }, 300); });
  typeFilter.addEventListener('change', () => { offset = 0; void load(); });
  previous.addEventListener('click', () => { offset = Math.max(0, offset - PAGE); void load(); });
  next.addEventListener('click', () => { offset += PAGE; void load(); });

  return {
    load,
    /**
     * State pushes while the Memory tab is on screen: reload at most every 5 s while organizing is queued or running and
     * every 30 s otherwise (a daily run may start meanwhile); one read at a time, nothing when the tab is not shown.
     */
    refresh() {
      // Off screen nothing is drawn or read; the tab loads afresh when it opens.
      if (!visible()) return;
      if (busy || loading) return;
      const active = state?.progress?.running || (state?.progress?.requestedAt && !state?.progress?.retryAt);
      if (Date.now() - loadedAt >= (active ? 5000 : 30000)) void load(); else renderStatus();
    }
  };
}
