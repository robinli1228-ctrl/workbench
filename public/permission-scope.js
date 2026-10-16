import { t } from './i18n.js';

const LABELS = {
  project: 'Project folder full access',
  device: 'Current device full access',
  'device-approval': 'Current device, ask for approval',
};
const NOTES = {
  project: 'Reads and writes stay inside this task\'s project folders; anything outside is refused, not silently allowed.',
  device: 'No sandbox or permission prompts; the device account\'s own permissions are the only limit.',
  'device-approval': 'Project work runs normally; an operation needing broader access waits for your one-time approval or rejection.',
};

/** The selector only offers what the bound Worker advertises for this CLI; Home validates again on save and at admission. */
export function renderPermissionScope(select, note, { worker, runtime, saved, isNew }) {
  const offered = worker?.capabilities?.permissionScopes?.[runtime];
  const previous = select.dataset.touched ? select.value : (saved ?? '');
  select.replaceChildren();
  if (!isNew || !Array.isArray(offered)) {
    // Not a fourth level: leaving it keeps exactly the permissions the role has today.
    const keep = document.createElement('option');
    keep.value = '';
    keep.textContent = saved ? t('Keep: {label}', { label: t(LABELS[saved] || saved) }) : isNew ? t('Existing CLI behavior (device not upgraded)') : t('Current permissions retained; select a scope to change');
    select.append(keep);
  }
  for (const scope of Object.keys(LABELS)) {
    const option = document.createElement('option');
    option.value = scope;
    const available = Array.isArray(offered) && offered.includes(scope);
    option.disabled = !available;
    option.textContent = available ? t(LABELS[scope]) : `${t(LABELS[scope])} · ${t(Array.isArray(offered) ? 'not available for this CLI on this device' : 'Worker upgrade required')}`;
    select.append(option);
  }
  const choice = [...select.options].find(o => o.value === previous && !o.disabled)
    || (isNew && Array.isArray(offered) && offered.includes('project') ? [...select.options].find(o => o.value === 'project') : null)
    || select.options[0];
  select.value = choice?.value ?? '';
  const scope = select.value || saved;
  note.textContent = scope ? t(NOTES[scope]) : (Array.isArray(offered) ? '' : t('This device has not reported per-role permission support yet.'));
}

/** Omit the field when "keep" is chosen so the server preserves the saved scope. */
export function permissionScopeValue(select) {
  return select.value ? select.value : undefined;
}
