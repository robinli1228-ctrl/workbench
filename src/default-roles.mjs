import { tr } from './i18n.mjs';
/** Templates are copied only when the user creates a new role; they never create project seats automatically. */
export function defaultRoleTemplates() {
  return Object.freeze([
    {
      key: 'reviewer',
      name: tr('defaultRoles.codeReviewer'),
      mode: 'workspace-write',
      modelHint: tr('defaultRoles.useTopTierModelFor'),
      instructions: tr('defaultRoles.youIndependentCodeReviewRole')
    },
    {
      key: 'planner',
      name: tr('defaultRoles.planner'),
      mode: 'workspace-write',
      modelHint: tr('defaultRoles.strongReasoningModelRecommendedFor'),
      instructions: tr('defaultRoles.youProjectPlanningRoleYou')
    },
    {
      key: 'developer',
      name: tr('defaultRoles.developer'),
      mode: 'workspace-write',
      modelHint: tr('defaultRoles.midTierModelRecommendedFor'),
      instructions: tr('defaultRoles.youProjectDevelopmentRoleYou')
    },
    {
      key: 'tester',
      name: tr('defaultRoles.tester'),
      mode: 'workspace-write',
      modelHint: tr('defaultRoles.fastModelRecommendedForRoutine'),
      instructions: tr('defaultRoles.youIndependentTestingReviewRole')
    }
  ]);
}

/** The fixed Supervisor role is recognised by either language's default display name (and by `systemSupervisor` / `supervisorRoleId`, never by name alone). */
export const SUPERVISOR_NAMES = Object.freeze(['Supervisor', '\u603b\u7ba1']);
export function isSupervisorName(name) {
  return typeof name === 'string' && SUPERVISOR_NAMES.some(n => n.toLowerCase() === name.trim().toLowerCase());
}

export function isRoleConfigured(role) {
  return role?.configured !== false && Boolean(role?.nodeId && role?.runtime && role?.model);
}
