import { defaultOrganizerPrompt } from './conversation-organizer.mjs';
import {discussionInstructions} from './discussion-policy.mjs';
import { tr, isMessage } from './i18n.mjs';

export const defaultPlatformPrompt = () => tr('platformPrompts.youRunningInControlledCollaboration');

export const defaultSupervisorPrompt = () => tr('platformPrompts.youFixedProjectSupervisorYou');

const PROMPT_LIMIT = 6000;
/** All runtimes share this execution boundary so adapters and the approved stage cannot contradict each other. */
export function executionRules(run) {
  const discussion=discussionInstructions(run);
  if(discussion&&run.turnPurpose&&run.turnPurpose!=='task')return discussion;
  const purpose=run.execution?.purpose;
  return tr('platformPrompts.handleOnlyAssignmentDoNot', { discussion, p2: run.discussionProtocol===2?tr('platformPrompts.useWbDiscussForShort'):tr('platformPrompts.useWbCallForRole'), p3: run.roleSnapshot?.systemSupervisor?tr('platformPrompts.workingRolesMayConsultDiscuss'):'', p4: purpose==='merge'?tr('platformPrompts.scheduledMergeStageYouMay'):tr('platformPrompts.unlessMergeStageScheduledDo'), p5: ['deploy','migration','production'].includes(purpose)?tr('platformPrompts.exclusiveStageOnlyTargetsOperations'):tr('platformPrompts.doNotReleaseOperateProduction'), p6: run.reportRequired?tr('platformPrompts.beforeBusinessDeliveryRunWb', { p1: run.discussionProtocol===2?tr('platformPrompts.wbDiscussAsk'):'' }):'' });
}
const DEFAULT_FIELD_LIMIT = 128;

/** Text saved while a built-in default was shown in another language still counts as "the default" and follows the current language; customised text is kept verbatim. */
function promptOrDefault(value, key, fallback) {
  if (typeof value !== 'string') return fallback();
  return isMessage(value.trim(), key) ? fallback() : value;
}

export function normalizePlatformSettings(record = {}) {
  record = record && typeof record === 'object' ? record : {};
  return {
    ...record,
    id: 'main',
    paused: Boolean(record.paused),
    platformPrompt: promptOrDefault(record.platformPrompt, 'platformPrompts.youRunningInControlledCollaboration', defaultPlatformPrompt),
    supervisorPrompt: promptOrDefault(record.supervisorPrompt, 'platformPrompts.youFixedProjectSupervisorYou', defaultSupervisorPrompt),
    defaultSupervisorRuntime: typeof record.defaultSupervisorRuntime === 'string' ? record.defaultSupervisorRuntime : '',
    defaultSupervisorModel: typeof record.defaultSupervisorModel === 'string' ? record.defaultSupervisorModel : '',
    defaultSupervisorEffort: typeof record.defaultSupervisorEffort === 'string' ? record.defaultSupervisorEffort : '',
    conversationOrganizer: record.conversationOrganizer && typeof record.conversationOrganizer==='object' ? {...record.conversationOrganizer,...(typeof record.conversationOrganizer.prompt==='string'&&isMessage(record.conversationOrganizer.prompt.trim(),'conversationOrganizer.youOnlyOrganizeConversationSpecified')?{prompt:defaultOrganizerPrompt()}:{})} :
      {nodeId:'',runtime:'',model:'',effort:'',prompt:defaultOrganizerPrompt(),revision:0},
    promptsUpdatedAt: record.promptsUpdatedAt || null
  };
}

/** Organizer settings only affect later input versions; they do not modify the saved prompts of working roles. */
export function updateConversationOrganizer(record,input) {
  const current=normalizePlatformSettings(record);
  const fields={};
  for(const key of ['nodeId','runtime','model','effort','prompt']) {
    if(typeof input?.[key]!=='string' || input[key].length>(key==='prompt'?6000:128))throw new Error(tr('platformPrompts.invalidConversationOrganizerSetting', { key }));
    fields[key]=input[key].trim();
  }
  if(fields.nodeId && (!fields.runtime || !fields.model))throw new Error(tr('platformPrompts.selectOrganizerDeviceCliModel'));
  if(!fields.nodeId && (fields.runtime || fields.model))throw new Error(tr('platformPrompts.organizerDeviceNotSelected'));
  return {...current,conversationOrganizer:{...fields,revision:(current.conversationOrganizer?.revision||0)+1,updatedAt:new Date().toISOString()}};
}

function promptValue(value, label) {
  if (typeof value !== 'string') throw new Error(tr('platformPrompts.mustBeText', { label }));
  if (value.length > PROMPT_LIMIT) throw new Error(tr('platformPrompts.mustNotExceedCharacters', { label, PROMPT_LIMIT }));
  return value.trim();
}

function defaultValue(value, label) {
  if (typeof value !== 'string') throw new Error(tr('platformPrompts.mustBeText2', { label }));
  if (value.length > DEFAULT_FIELD_LIMIT) throw new Error(tr('platformPrompts.mustNotExceedCharacters2', { label, DEFAULT_FIELD_LIMIT }));
  return value.trim();
}

export function updatePlatformPrompts(record, input, now = new Date().toISOString()) {
  const current = normalizePlatformSettings(record);
  return {
    ...current,
    platformPrompt: promptValue(input.platformPrompt, tr('platformPrompts.platformPrompt')),
    supervisorPrompt: promptValue(input.supervisorPrompt, tr('platformPrompts.supervisorPrompt')),
    defaultSupervisorRuntime: defaultValue(input.defaultSupervisorRuntime ?? current.defaultSupervisorRuntime, tr('platformPrompts.defaultSupervisorCli')),
    defaultSupervisorModel: defaultValue(input.defaultSupervisorModel ?? current.defaultSupervisorModel, tr('platformPrompts.defaultSupervisorModel')),
    defaultSupervisorEffort: defaultValue(input.defaultSupervisorEffort ?? current.defaultSupervisorEffort, tr('platformPrompts.defaultSupervisorReasoningEffort')),
    promptsUpdatedAt: now
  };
}

export function updatePausedSetting(record, paused) {
  if (typeof paused !== 'boolean') throw new Error(tr('platformPrompts.pausedMustBeBoolean'));
  return { ...normalizePlatformSettings(record), paused };
}

/** Platform rules come before role configuration; neither can override the permission and collaboration boundaries hard-coded in the runtime. */
export function composeAgentInstructions(platformPrompt, roleInstructions) {
  const platform = typeof platformPrompt === 'string' ? platformPrompt.trim() : '';
  const role = typeof roleInstructions === 'string' ? roleInstructions.trim() : '';
  if (!platform) return role;
  if (!role) return platform;
  return tr('platformPrompts.platformPromptDoesNotOverride', { platform, role });
}
