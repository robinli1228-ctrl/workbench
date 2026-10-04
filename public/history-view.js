function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Show and copy the original body stored by Home in segments; all body text is written to the page via textContent only. */
export function createHistoryViewer({ api }) {
  if (typeof api !== 'function') throw new Error('api must be a function');
  let dialog, activeState;

  function ensureDialog() {
    if (dialog) return dialog;
    dialog = element('dialog', 'history-viewer');
    const title = element('h2', 'history-viewer-title', 'Original Text');
    const content = element('pre', 'history-viewer-content');
    const status = element('p', 'history-viewer-status');
    const actions = element('div', 'history-viewer-actions');
    const next = element('button', 'secondary', 'Load next segment');
    const copy = element('button', 'secondary', 'Copy full text');
    const close = element('button', 'secondary', 'Close');
    for (const button of [next, copy, close]) button.type = 'button';
    actions.append(next, copy, close);
    dialog.append(title, content, status, actions);
    document.body.append(dialog);
    dialog.parts = { title, content, status, next, copy, close };
    close.addEventListener('click', () => { activeState = null; dialog.close(); });
    dialog.addEventListener('cancel', () => { activeState = null; });
    dialog.addEventListener('close', () => { activeState = null; });
    return dialog;
  }

  async function requestPart(state) {
    if (state.request) return state.request;
    const request = (async () => {
      const query = new URLSearchParams({ kind: state.kind, id: state.id, offset: String(state.offset), limit: '4000' });
      if (state.version) query.set('version', state.version);
      const result = await api(`/api/projects/${encodeURIComponent(state.projectId)}/history/read?${query}`);
      if (activeState !== state) return null;
      if (state.version && result.version !== state.version) throw new Error('Source version has changed; please reopen');
      state.version = result.version;
      state.offset = result.nextOffset;
      state.complete = result.complete;
      state.text += result.content;
      return result;
    })();
    state.request = request;
    try { return await request; }
    finally { if (state.request === request) state.request = null; }
  }

  function showError(view, state, error) {
    if (activeState !== state) return;
    view.parts.status.textContent = `Load failed: ${error?.message || String(error)}`;
    view.parts.next.hidden = true;
  }

  function render(view, state) {
    view.parts.content.textContent = state.text;
    view.parts.status.textContent = state.complete ? `Full text, ${state.totalLength} characters` : `Loaded ${state.offset} / ${state.totalLength} characters`;
    view.parts.next.hidden = state.complete;
  }

  async function open(projectId, kind, id) {
    const view = ensureDialog();
    const state = { projectId, kind, id, offset: 0, version: null, complete: false, text: '', totalLength: 0 };
    activeState = state;
    view.parts.title.textContent = kind === 'message' ? 'Original message' : 'Original execution result';
    view.parts.content.textContent = '';
    view.parts.status.textContent = 'Loading…';
    view.parts.next.hidden = true;
    view.parts.next.disabled = false;
    view.parts.copy.disabled = false;
    view.parts.next.onclick = null;
    view.parts.copy.onclick = null;
    if (!view.open) view.showModal();
    let first;
    try {
      first = await requestPart(state);
      if (!first) return null;
      state.totalLength = first.totalLength;
      render(view, state);
    } catch (error) {
      showError(view, state, error);
      return null;
    }

    view.parts.next.onclick = async () => {
      if (activeState !== state || view.parts.copy.disabled) return;
      view.parts.next.disabled = true;
      try {
        if (await requestPart(state)) render(view, state);
      } catch (error) { showError(view, state, error); }
      finally { if (activeState === state) view.parts.next.disabled = false; }
    };
    view.parts.copy.onclick = async () => {
      if (activeState !== state) return;
      view.parts.copy.disabled = true;
      view.parts.next.disabled = true;
      try {
        while (!state.complete) if (!await requestPart(state)) return;
        render(view, state);
        await navigator.clipboard.writeText(state.text);
        if (activeState === state) view.parts.status.textContent = `Full text copied, ${state.totalLength} characters`;
      } catch (error) { showError(view, state, error); }
      finally {
        if (activeState === state) {
          view.parts.copy.disabled = false;
          view.parts.next.disabled = false;
        }
      }
    };
    return first;
  }

  return { open };
}
