export const SETTINGS_TABS = Object.freeze(['devices', 'hosting', 'assistant', 'prompts', 'connection']);

export function normalizeSettingsTab(value) {
  if (value === 'models') return 'devices';
  if (value === 'project') return 'project';
  if (value === 'usage') return 'usage';
  if (value === 'timers') return 'timers';
  return SETTINGS_TABS.includes(value) ? value : 'devices';
}

/** Settings, project, usage and scheduled jobs share a full-screen container; standalone pages do not take a basic settings tab. */
export function settingsView(value) {
  const tab = normalizeSettingsTab(value), scope = ['project', 'usage', 'timers'].includes(tab) ? tab : 'global';
  return { tab, scope, title: tab === 'project' ? 'Project Settings' : tab === 'usage' ? 'Token Usage' : tab === 'timers' ? 'Scheduled Jobs' : 'Basic Settings',
    tabs: scope === 'global' ? [...SETTINGS_TABS] : [] };
}

export function activateSettingsTab(root, value) {
  const view = settingsView(value), { tab } = view;
  root.dataset.settingsTab = tab;
  root.dataset.settingsScope = view.scope;
  root.querySelector('[role="tablist"]').hidden = view.scope !== 'global';
  root.querySelector('#settings-page-title').textContent = view.title;
  root.querySelectorAll('[data-settings-tab]').forEach(button => {
    const active = button.dataset.settingsTab === tab;
    button.hidden = !view.tabs.includes(button.dataset.settingsTab);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  root.querySelectorAll('[data-settings-panel]').forEach(panel => {
    panel.hidden = panel.dataset.settingsPanel !== tab;
  });
  return tab;
}
