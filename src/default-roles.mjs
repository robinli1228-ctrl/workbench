import { tr } from './i18n.mjs';
/** Five shipped presets (planning, execution, review, testing, cross-device); they can be edited and restored, not removed. Only the cross-device preset includes a prompt, and no seats are created automatically. */
export function defaultRoleTemplates() {
  return Object.freeze([
    {
      key: 'planner',
      responsibility: tr('roleTemplates.plannerResponsibility'),
      name: tr('roleTemplates.planner'),
      mode: 'workspace-write',
      modelHint: tr('defaultRoles.strongReasoningModelRecommendedFor'),
      instructions: ''
    },
    {
      key: 'developer',
      responsibility: tr('roleTemplates.developerResponsibility'),
      name: tr('roleTemplates.developer'),
      mode: 'workspace-write',
      modelHint: tr('defaultRoles.midTierModelRecommendedFor'),
      instructions: ''
    },
    {
      key: 'reviewer',
      responsibility: tr('roleTemplates.reviewerResponsibility'),
      name: tr('roleTemplates.reviewer'),
      mode: 'workspace-write',
      modelHint: tr('defaultRoles.useTopTierModelFor'),
      instructions: ''
    },
    {
      key: 'tester',
      responsibility: tr('roleTemplates.testerResponsibility'),
      name: tr('roleTemplates.tester'),
      mode: 'workspace-write',
      modelHint: tr('defaultRoles.fastModelRecommendedForRoutine'),
      instructions: ''
    },
    {
      key: 'crossDevice',
      responsibility: tr('roleTemplates.crossDeviceResponsibility'),
      name: tr('roleTemplates.crossDevice'),
      mode: 'workspace-write',
      modelHint: tr('defaultRoles.midTierModelRecommendedFor'),
      instructions: tr('roleTemplates.crossDeviceInstructions')
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
