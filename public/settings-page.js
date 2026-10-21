export const SETTINGS_TABS = Object.freeze(['general', 'devices', 'hosting', 'prompts', 'information', 'data']);

/** 只切换可见性，不重新加载配置或重建表单，保留各分类尚未保存的输入。 */
function selectProjectSettingsTab(root, value) {
  root.querySelectorAll('[data-project-settings-tab]').forEach(button => {
    const active = button.dataset.projectSettingsTab === value;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  root.querySelectorAll('[data-project-settings-panel]').forEach(panel => {
    panel.hidden = panel.dataset.projectSettingsPanel !== value;
  });
}

/** 项目内分类不走 openSettings，避免切换时触发 prepareSettings 覆盖草稿。 */
export function initProjectSettingsTabs(root) {
  const tabs = [...root.querySelectorAll('[data-project-settings-tab]')];
  tabs.forEach((button, index) => {
    button.addEventListener('click', () => {
      selectProjectSettingsTab(root, button.dataset.projectSettingsTab);
      root.scrollTop = 0;
    });
    button.addEventListener('keydown', event => {
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : event.key === 'ArrowRight' ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : null;
      if (next === null) return;
      event.preventDefault();
      tabs[next].focus();
      tabs[next].click();
    });
  });
}

export function normalizeSettingsTab(value) {
  if (value === 'assistant') return 'information';
  if (value === 'connection') return 'general';
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
  root.querySelector('#global-settings-tabs').hidden = view.scope !== 'global';
  root.querySelector('#project-settings-tabs').hidden = view.scope !== 'project';
  if (view.scope === 'project') {
    selectProjectSettingsTab(root, 'basic');
    root.scrollTop = 0;
  }
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
