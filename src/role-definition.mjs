import { tr } from './i18n.mjs';

/** An omitted field belongs to an older client; only an explicit empty string clears a duty. */
export function normalizeResponsibility(value, previous = '') {
  if (value === undefined) return previous;
  if (typeof value !== 'string' || value.length > 1000) throw new Error(tr('roleDefinition.invalidResponsibility'));
  return value.trim();
}

/** The fixed supervisor has a built-in outward duty; custom roles are never inferred from names. */
export function roleResponsibility(role) {
  return role.systemSupervisor && !role.platformAssistant ? tr('collaboration.supervisorResponsibility') : (role.responsibility || '');
}

/** Discovery is caller-relative: self duties are not execution context; peer prompts are management-only. */
export function roleForAgent(role, caller) {
  const result = { ...role, responsibility: roleResponsibility(role) };
  if (role.id === caller.roleId) delete result.responsibility;
  else if (!caller.roleSnapshot?.systemSupervisor) delete result.instructions;
  return result;
}
