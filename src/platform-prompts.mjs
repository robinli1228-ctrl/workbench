import { defaultOrganizerPrompt } from './conversation-organizer.mjs';
import {discussionInstructions} from './discussion-policy.mjs';
import { tr, isMessage, runWithLanguage } from './i18n.mjs';
import { createHash } from 'node:crypto';

export const defaultPlatformPrompt = () => tr('minimal.platformTemplate');

// The supervisor has its own editable coordination template; it is not a shared rule for other roles.
export const defaultSupervisorPrompt = () => tr('minimal.supervisorTemplate');

const PROMPT_LIMIT = 6000;
/** Runtime rules are always English; UI-localized defaults and user-saved prompts stay independent. */
export function englishExecutionRules(run,options) {
  return runWithLanguage('en',()=>executionRules(run,options));
}

/** All runtimes share this execution boundary so adapters and the approved stage cannot contradict each other. */
export function executionRules(run,{minimal=false}={}) {
  const discussion=discussionInstructions(run);
  if(discussion&&run.turnPurpose&&run.turnPurpose!=='task')return discussion;
  const purpose=run.execution?.purpose;
  // wb pass guidance only for collaboration batch runs, which exist only when the project flag is on.
  const passRule=run.collaborationBatchId||run.continuationBatchId?tr('sessionQueue.passRule'):'';
  if(minimal)return [passRule,purpose==='merge'?tr('platformPrompts.scheduledMergeStageYouMay'):'',
    ['deploy','migration','production'].includes(purpose)?tr('platformPrompts.exclusiveStageOnlyTargetsOperations'):'',
    ['audit','review'].includes(purpose)?tr('platformPrompts.independentReviewBoundary'):'',
    run.reportRequired?tr('platformPrompts.beforeBusinessDeliveryRunWb',{p1:''}):''].filter(Boolean).join('\n');
  return tr('platformPrompts.handleOnlyAssignmentDoNot', { discussion, p2: run.discussionProtocol===2?tr('platformPrompts.useWbDiscussForShort'):tr('platformPrompts.useWbCallForRole'), p3: run.roleSnapshot?.systemSupervisor?tr('platformPrompts.workingRolesMayConsultDiscuss'):'', p4: purpose==='merge'?tr('platformPrompts.scheduledMergeStageYouMay'):tr('platformPrompts.unlessMergeStageScheduledDo'), p5: ['deploy','migration','production'].includes(purpose)?tr('platformPrompts.exclusiveStageOnlyTargetsOperations'):tr('platformPrompts.doNotReleaseOperateProduction'), p6: run.reportRequired?tr('platformPrompts.beforeBusinessDeliveryRunWb', { p1: run.discussionProtocol===2?tr('platformPrompts.wbDiscussAsk'):'' }):''  })+(passRule?`\n${passRule}`:'');
}
const DEFAULT_FIELD_LIMIT = 128;
// Match only exact previous EN/ZH defaults; custom edits must survive prompt upgrades.
const LEGACY_SUPERVISOR_DEFAULTS = new Set([
  'b70469e34eb2fc33bb75bad89ee5be8fdd4e1a79a9c76980d9e3c4f255fdf799',
  '8f2563680caa7f54a98bef237606618631e486a2e149e6b393a407b8c3fafba4',
  'd9aa330ed0fb40ce9ae07c94125427c03a92da70248d7c8e952f15d93ea754b1',
  '8698bb5f135b63bd01bc77efb6a6067903875831f20c76c1f8520cf30ecb896a',
  '68986281a3826c62394241e4e51068168a575bd615a65c415009538a625a93f7',
  'b9c53a1fc442a02fdf46bb50169105a1c8c012c3a5593d1270588e7ca1e40c1f',
  'bc1b43525dbdd2642f780776d9f7974f62eb41691d80fb3671a56fb6cecc6118',
  'febb81a33a504d8393ffe0a8d053ed953f9a9b8ae8879f782db09adcfd1d9b3e',
  'be0c5fc6adbdc4bd7ace76de8489a94d2b944ee6b577e346b18730c195c3eba1',
  'f4fdcbae86b204daad8506f4f8a431c48fa73052980abafdd6cd55434f2414fe',
  // Defaults before the goal-ownership line; saved copies of them follow the new built-in template.
  '2f93053a4afdc8f4f1e9c3a9a1134cf6915e3ad1481bb61a14cf53b1abccfa01',
  '5028d377bc872bb766d72588011c48dbaa4446350c5b3ca908d4517b02e3ad69'
]);
const LEGACY_PLATFORM_DEFAULTS = new Set([
  '4a7bd0d1a4bedbfd714d1493b7fd6c9a439bfec754a23f43d150a845ff249324',
  '1b15541e57fced0e26eaf3f6b601629e3099cd8a292d8196fcbfcfa38b88d2a9',
  '45204542deb0ef8dc50cf0793405c91417f586d7b8af901158c658667a2b82fe',
  '3be86c9e60917e7f697d6a17f50efd7a36793a69ee8551b49f7df5436aad7671'
]);

/** Text saved while a built-in default was shown in another language still counts as "the default" and follows the current language; customised text is kept verbatim. */
function promptOrDefault(value, key, fallback) {
  if (typeof value !== 'string') return fallback();
  const text = value.trim();
  const legacyDefault = (key === 'platformPrompts.youFixedProjectSupervisorYou' ? LEGACY_SUPERVISOR_DEFAULTS : LEGACY_PLATFORM_DEFAULTS)
    .has(createHash('sha256').update(text).digest('hex'));
  const currentKey = key === 'platformPrompts.youFixedProjectSupervisorYou' ? 'collaboration.supervisor' : 'collaboration.platform';
  const templateKey = key === 'platformPrompts.youFixedProjectSupervisorYou' ? 'minimal.supervisorTemplate' : 'minimal.platformTemplate';
  return isMessage(text, templateKey) || isMessage(text, key) || isMessage(text, currentKey) || isMessage(text,key==='platformPrompts.youFixedProjectSupervisorYou'?'minimal.supervisorDefault':'minimal.platformDefault') || (key!=='platformPrompts.youFixedProjectSupervisorYou'&&isMessage(text,'minimal.platformDefaultLegacy1')) || legacyDefault ? fallback() : value;
}

/** Suppress only legacy minimal boilerplate; current editable templates and custom text must reach execution. */
export function customExecutionPrompt(value,kind='platform') {
  const text=typeof value==='string'?value:'';
  return isMessage(text.trim(),kind==='supervisor'?'minimal.supervisorDefault':'minimal.platformDefault')
    ||kind!=='supervisor'&&isMessage(text.trim(),'minimal.platformDefaultLegacy1')
    ||isMessage(text.trim(),kind==='supervisor'?'collaboration.supervisor':'collaboration.platform')?'':text;
}

/** Rolling upgrades keep the old wrapping contract for Workers that have not negotiated minimal instructions. */
export function legacyExecutionPrompt(value,kind='platform') {
  if(typeof value==='string'&&!value.trim())return value;
  return customExecutionPrompt(value,kind)===''?runWithLanguage('en',()=>kind==='supervisor'?defaultSupervisorPrompt():tr('collaboration.platform')):value;
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
    platformPrompt: input.platformPrompt === undefined ? current.platformPrompt : promptValue(input.platformPrompt, tr('platformPrompts.platformPrompt')),
    supervisorPrompt: input.supervisorPrompt === undefined ? current.supervisorPrompt : promptValue(input.supervisorPrompt, tr('platformPrompts.supervisorPrompt')),
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
