import { tr } from './i18n.mjs';
/** Templates are copied only when the user creates a new role; they never create project seats automatically. */
export function defaultRoleTemplates() {
  return Object.freeze([
    {
      key: 'reviewer',
      responsibility: tr('collaboration.reviewerResponsibility'),
      name: tr('defaultRoles.codeReviewer'),
      mode: 'workspace-write',
      modelHint: tr('defaultRoles.useTopTierModelFor'),
      instructions: tr('collaboration.reviewerInstructions')
    },
    {
      key: 'planner',
      responsibility: tr('collaboration.plannerResponsibility'),
      name: tr('defaultRoles.planner'),
      mode: 'workspace-write',
      modelHint: tr('defaultRoles.strongReasoningModelRecommendedFor'),
      instructions: tr('collaboration.plannerInstructions')
    },
    {
      key: 'developer',
      responsibility: tr('collaboration.developerResponsibility'),
      name: tr('defaultRoles.developer'),
      mode: 'workspace-write',
      modelHint: tr('defaultRoles.midTierModelRecommendedFor'),
      instructions: tr('collaboration.developerInstructions')
    },
    {
      key: 'tester',
      responsibility: tr('collaboration.testerResponsibility'),
      name: tr('defaultRoles.tester'),
      mode: 'workspace-write',
      modelHint: tr('defaultRoles.fastModelRecommendedForRoutine'),
      instructions: tr('collaboration.testerInstructions')
    }
  ]);
}

/** The fixed Supervisor role is recognised by either language's default display name (and by `systemSupervisor` / `supervisorRoleId`, never by name alone). */
export const SUPERVISOR_NAMES = Object.freeze(['Supervisor', '\u603b\u7ba1']);
export function isSupervisorName(name) {
  return typeof name === 'string' && SUPERVISOR_NAMES.some(n => n.toLowerCase() === name.trim().toLowerCase());
}

/** Broadcast labels cannot also identify a new working role, regardless of the selected language. */
export function isBroadcastName(name) {
  return typeof name === 'string' && /^(everyone|all|\u6240\u6709\u4eba|\u5168\u4f53)$/i.test(name);
}

export function isRoleConfigured(role) {
  return role?.configured !== false && Boolean(role?.nodeId && role?.runtime && role?.model);
}
