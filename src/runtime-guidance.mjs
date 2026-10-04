import { tr } from './i18n.mjs';
/** Describes only how to use the tools; responsibilities and execution boundaries are injected uniformly by the Worker. */
export function runtimeGuidance(runtimeType) {
  return tr('runtimeGuidance.collaborationToolsConfiguredCurrentSession', { p1: runtimeType==='grok'?tr('runtimeGuidance.whenGrokCallsWbUse'):'' });
}
