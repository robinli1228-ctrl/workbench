import { DEFAULT_ORGANIZER_PROMPT } from './conversation-organizer.mjs';
import {discussionInstructions} from './discussion-policy.mjs';

export const DEFAULT_PLATFORM_PROMPT = `You are running in a controlled collaboration environment provided by Agent Workbench.
- Handle only the current project, the current role, and the assignment given this turn; never mix in context from other projects.
- Before making changes, confirm the working directory and constraints; cross-device handoffs rely on a pinned Git commit or an explicit artifact.
- Give complex design, summarization, core development, and critical review to high-capability models; use lower-cost models for work that is well scoped, low risk, and easy to verify.
- Conclusions must rest on actual execution and verification; do not treat a successful build or a command attempt as business acceptance.
- You can consult roles in the same project directly with wb call; the platform forwards the call across devices. When consulted, give your conclusion first; to wait, use wb wait and end the turn instead of polling in a loop.
- Keep output concise: state what changed, the verification results, and any unresolved items.`;

export const DEFAULT_SUPERVISOR_PROMPT = `You are the fixed project supervisor. You are responsible only for intake, triage, dispatching, progress checks, replanning, and summarizing; you do not write plans or do development work yourself.
- When the user explicitly @-mentions a role, dispatch to that role; without an @-mention, decide whether intervention is needed.
- Hand simple, clear work directly to a suitable role; for complex, cross-module, or high-risk work, call the planner role first.
- After the plan is complete, dispatch to executor roles in dependency order; once development is done, automatically hand off to a tester or reviewer role.
- Use low-cost models for routine checks; escalate complex design, summarization, core development, hard analysis, and critical review to high-capability models.
- Working roles may consult and discuss with each other directly, with no need for you to relay or approve each message; step in when the plan needs adjusting, a conflict needs resolving, a blocker needs handling, or a final summary is due.
- Send a message only on a state change, failure, blocker, approval request, or completion; avoid repeated questions and group-chat noise.`;

const PROMPT_LIMIT = 6000;
/** All runtimes share this execution boundary so adapters and the approved stage cannot contradict each other. */
export function executionRules(run) {
  const discussion=discussionInstructions(run);
  if(discussion&&run.turnPurpose&&run.turnPurpose!=='task')return discussion;
  const purpose=run.execution?.purpose;
  return `${discussion}\n\nHandle only this assignment. Do not start other agents on your own; ${run.discussionProtocol===2?'use wb discuss for short peer Q&A and use wb call only for independent business dispatch':'use wb call for role calls'}, and use wb schedule for supervisor orchestration.
${run.roleSnapshot?.systemSupervisor?'Working roles may consult and discuss directly; the supervisor steps in only to adjust the plan, resolve conflicts, handle blockers, or give the final summary.':''}
Modify only the workspace designated by the Worker and the repositories listed for this run. ${purpose==='merge'?'This is a scheduled merge stage: you may merge the specified artifacts on an isolated branch, but must not merge into the main branch on your own.':'Unless a merge stage is scheduled, do not merge into the main branch on your own.'}
When you need the user to supply information or make a decision, submit wb report with verdict=needs_input, state the specific question and options in summary, and then end the turn. When WeChat is enabled, Home persists the notification, waits for the reply, and resumes the original role; ordinary questions do not expire after two hours of waiting. Do not poll WeChat, do not hold WeChat credentials, and do not treat a successful notification or a pending state as the user's reply. Once the web page has referenced a reply to the same question, an older WeChat reply is no longer executed. Native permission approvals still follow their own validity period.
${['deploy','migration','production'].includes(purpose)?'This is an exclusive stage; only targets and operations the user explicitly authorized may be executed, and a supervisor assignment does not constitute new production authorization.':'Do not release, operate production systems, or run database migrations on your own.'} Git pushes go only through wb deliver, which requests an existing approval.
${run.reportRequired?`Before business delivery, run wb report '{"verdict":"passed|failed|blocked|needs_input","summary":"short conclusion","evidence":["actual evidence"],"next":"next step"}'. Pick one real verdict value; passed requires evidence; a failure must not be reported as passed. A waiting turn where any role has run wb wait${run.discussionProtocol===2?' or wb discuss ask':''}, or where the supervisor has run wb schedule, needs no report; just end it, and report when the original task is actually delivered.`:''}`;
}
const DEFAULT_FIELD_LIMIT = 128;

export function normalizePlatformSettings(record = {}) {
  record = record && typeof record === 'object' ? record : {};
  return {
    ...record,
    id: 'main',
    paused: Boolean(record.paused),
    platformPrompt: typeof record.platformPrompt === 'string' ? record.platformPrompt : DEFAULT_PLATFORM_PROMPT,
    supervisorPrompt: typeof record.supervisorPrompt === 'string' ? record.supervisorPrompt : DEFAULT_SUPERVISOR_PROMPT,
    defaultSupervisorRuntime: typeof record.defaultSupervisorRuntime === 'string' ? record.defaultSupervisorRuntime : '',
    defaultSupervisorModel: typeof record.defaultSupervisorModel === 'string' ? record.defaultSupervisorModel : '',
    defaultSupervisorEffort: typeof record.defaultSupervisorEffort === 'string' ? record.defaultSupervisorEffort : '',
    conversationOrganizer: record.conversationOrganizer && typeof record.conversationOrganizer==='object' ? record.conversationOrganizer :
      {nodeId:'',runtime:'',model:'',effort:'',prompt:DEFAULT_ORGANIZER_PROMPT,revision:0},
    promptsUpdatedAt: record.promptsUpdatedAt || null
  };
}

/** Organizer settings only affect later input versions; they do not modify the saved prompts of working roles. */
export function updateConversationOrganizer(record,input) {
  const current=normalizePlatformSettings(record);
  const fields={};
  for(const key of ['nodeId','runtime','model','effort','prompt']) {
    if(typeof input?.[key]!=='string' || input[key].length>(key==='prompt'?6000:128))throw new Error(`Invalid conversation organizer setting: ${key}`);
    fields[key]=input[key].trim();
  }
  if(fields.nodeId && (!fields.runtime || !fields.model))throw new Error('Select the organizer device, CLI, and model together');
  if(!fields.nodeId && (fields.runtime || fields.model))throw new Error('Organizer device is not selected');
  return {...current,conversationOrganizer:{...fields,revision:(current.conversationOrganizer?.revision||0)+1,updatedAt:new Date().toISOString()}};
}

function promptValue(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  if (value.length > PROMPT_LIMIT) throw new Error(`${label} must not exceed ${PROMPT_LIMIT} characters`);
  return value.trim();
}

function defaultValue(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  if (value.length > DEFAULT_FIELD_LIMIT) throw new Error(`${label} must not exceed ${DEFAULT_FIELD_LIMIT} characters`);
  return value.trim();
}

export function updatePlatformPrompts(record, input, now = new Date().toISOString()) {
  const current = normalizePlatformSettings(record);
  return {
    ...current,
    platformPrompt: promptValue(input.platformPrompt, 'Platform prompt'),
    supervisorPrompt: promptValue(input.supervisorPrompt, 'Supervisor prompt'),
    defaultSupervisorRuntime: defaultValue(input.defaultSupervisorRuntime ?? current.defaultSupervisorRuntime, 'Default supervisor CLI'),
    defaultSupervisorModel: defaultValue(input.defaultSupervisorModel ?? current.defaultSupervisorModel, 'Default supervisor model'),
    defaultSupervisorEffort: defaultValue(input.defaultSupervisorEffort ?? current.defaultSupervisorEffort, 'Default supervisor reasoning effort'),
    promptsUpdatedAt: now
  };
}

export function updatePausedSetting(record, paused) {
  if (typeof paused !== 'boolean') throw new Error('paused must be a boolean');
  return { ...normalizePlatformSettings(record), paused };
}

/** Platform rules come before role configuration; neither can override the permission and collaboration boundaries hard-coded in the runtime. */
export function composeAgentInstructions(platformPrompt, roleInstructions) {
  const platform = typeof platformPrompt === 'string' ? platformPrompt.trim() : '';
  const role = typeof roleInstructions === 'string' ? roleInstructions.trim() : '';
  if (!platform) return role;
  if (!role) return platform;
  return `Platform prompt (does not override system execution boundaries):\n${platform}\n\nRole prompt:\n${role}`;
}
