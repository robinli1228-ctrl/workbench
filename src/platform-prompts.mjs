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
  if(minimal)return [purpose==='merge'?tr('platformPrompts.scheduledMergeStageYouMay'):'',
    ['deploy','migration','production'].includes(purpose)?tr('platformPrompts.exclusiveStageOnlyTargetsOperations'):'',
    ['audit','review'].includes(purpose)?tr('platformPrompts.independentReviewBoundary'):''].filter(Boolean).join('\n');
  return tr('platformPrompts.handleOnlyAssignmentDoNot', { discussion, p2: tr('platformPrompts.useWbCallForRole'), p3: run.roleSnapshot?.systemSupervisor?tr('platformPrompts.workingRolesMayConsultDiscuss'):'', p4: purpose==='merge'?tr('platformPrompts.scheduledMergeStageYouMay'):tr('platformPrompts.unlessMergeStageScheduledDo'), p5: ['deploy','migration','production'].includes(purpose)?tr('platformPrompts.exclusiveStageOnlyTargetsOperations'):tr('platformPrompts.doNotReleaseOperateProduction'), p6: ''  });
}
const DEFAULT_FIELD_LIMIT = 128;
// Match only exact previous EN/ZH defaults; custom edits must survive prompt upgrades.
const LEGACY_SUPERVISOR_DEFAULTS = new Set([
  // Exact defaults before task-driven collaboration.
  '9fd60d14949af20883ae03e75daf592f86e323b4be329bfb4f0d166d56f438ba',
  '542d638a7020bbad92a8a4ed48f0f78e3b3f0de565a656b7df6a024300e13be5',

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
  '5028d377bc872bb766d72588011c48dbaa4446350c5b3ca908d4517b02e3ad69',
  // Defaults before the receipt/four-item close-out template.
  'd190ea330847f51e444ed00ff69ca8dce4581ab6e6ff7269c046dbfdf56e2284',
  'ba52194b15a44c3e211e6b9d11ff63600ad4f53b831e55685b5deb3625b1206b',
  // Defaults before not-executed receipts, acknowledged/batch verification and the single-patrol rule.
  '97cb5f80cacbe949d4174487ee050d686f803b87210fef6a679244e893926917',
  '2e1f318253219def1ff5dd028af03961a368639bd4fc9bde5b8f518be081c46a',
  // Exact defaults before the operator-aligned templates; never include customized prompt text.
  '05423256820bf20af920b4876484122f324ba86b7738d4f57d5ce6152bf6d57e',
  '3d93b7e8d344da4e1fc565d50cfe541c7073e50238c07d809f705a8014dfb034',
  // Defaults before the supervisor stopped coding and started routing unaddressed messages by peers' state and balance.
  '55ab7467b3ebfd0d14e8e142155ae64b3798b61daad78d5cec5fa34a17e15c1e',
  '8ab1ec3517d5e91083434ca363fb4a59a25153b2422af339a84d142674d9a137',
  // Defaults before the supervisor took on the simplest tasks itself.
  'fb1b0d4f6d221456decc6772b6a971ca37fb97981836b6967587bf706367b2d9',
  '5c5a736260792f1eea3239614c4cdb1528aa3bd714bacabd15840495261fe156',
  // Defaults before whole-task transfer, stall handling and the end of wb schedule / wb progress / wb setup propose.
  '658468f3a543b60041dc94da72c10d877e07e8f85687c8cde715377ca9b87725',
  '891c4412e1ff62d8ca3264e1627dc12b10678a2025b0cafaa907384b48751bb0'
]);
const LEGACY_PLATFORM_DEFAULTS = new Set([
  // Exact defaults before task-driven collaboration.
  '13d2e34a3a5a8fd0cbe946442693a46e8601a49be87751623acad8dfe7ec3d4b',
  '5470aa8edaecde124ea8c024d4929a92ff091fe5939353b57559ac645e719cc9',

  '4a7bd0d1a4bedbfd714d1493b7fd6c9a439bfec754a23f43d150a845ff249324',
  '1b15541e57fced0e26eaf3f6b601629e3099cd8a292d8196fcbfcfa38b88d2a9',
  '45204542deb0ef8dc50cf0793405c91417f586d7b8af901158c658667a2b82fe',
  '3be86c9e60917e7f697d6a17f50efd7a36793a69ee8551b49f7df5436aad7671',
  // Long defaults before the concise template with receipts, structured calls, per-file sync status and error codes.
  '46251e959abf53517d8f8f4a8f20e036b4a9f251fbe9f590779bcfe5159b6b33',
  '59bd2efea7e7abfdbf2080ba5c50d0114800e9d4694f273bfbd141fe8baec0a1',
  // Exact defaults before the operator-aligned templates; custom and explicitly empty prompts remain unchanged.
  'b69fedfb2ef0c528a66f62b624095c0353d62948bb86879b1b98cd21c034bc69',
  '1f60ca54f13ca8da234dd30bef95ba7b19f38d8e4f4b4dd0ab38e07bf9c44f3f',
  // Defaults before the four ask-the-user cases, roles choosing whom to @, and review/sync/error text moving to wb help.
  '4b0fb508e9184a7acb0f42f8a1ad72d48c2728c54335df5895fb46a4163782bf',
  '1a1c7c92c460eb03cf2cd50d2e28f3f5d70f4bf57b6d5d4156089f1a71e70801',
  // Defaults before every @ had to be handled, reviews in turn, evidence-backed challenge and report only for assigned work.
  'ab94b6b0f24365f002461752c06a195e7f65602e7c42ba2fb5fa17901f6f5185',
  '425555463ecd6044365b7ecfec4f40ec07ad996d5587dba08191b2f2be4a5db4',
  // Defaults before the short template: no wb report, owners of transferred tasks, device > quota > idle.
  '9d72984584070cec25b18a4d085c55b2e1fba00a362c4cf4366af7a38d811a38',
  'f2a7f7f83e8454bcc2d7c1b20115c39f29448d8e7844513f397d307ffc276c27'
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
