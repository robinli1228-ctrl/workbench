import {runtimeIssue} from './runtime-probe.mjs';
import {isAbsolute} from 'node:path';
import { tr } from './i18n.mjs';

/** A validation record authorizes only the specified binary/version/model; transient health is checked separately, and a single preview switch is not treated as acceptance of every adapter. */
export function validatedDiscussionConfigurations(raw,runtimes,bins) {
  let records;try{records=JSON.parse(raw||'[]');}catch{return [];}
  if(!Array.isArray(records))return [];
  const accepted=[];
  for(const record of records) {
    if(!record||!['codex','claude','grok','agy'].includes(record.runtime)||typeof record.bin!=='string'||!isAbsolute(record.bin)||record.bin!==bins?.[record.runtime])continue;
    const runtime=runtimes?.find(r=>r.type===record.runtime&&r.supported);
    if(!record.version||runtime?.version!==record.version||!record.model||!runtime.models?.some(m=>m.id===record.model))continue;
    if(!accepted.some(r=>r.runtime===record.runtime&&r.model===record.model))accepted.push({runtime:record.runtime,model:record.model,version:record.version,bin:record.bin});
  }
  return accepted;
}

/** Reachability and protocol capability for a new question are kept separate; an unknown connection cannot create a blocking wait, and busy targets are handled by the queue. */
export function discussionTargetStatus(worker,role,{online}={}) {
  const fail=(code,reason)=>({ready:false,code,reason});
  if(!role?.enabled||role.archivedAt)return fail('disabled',tr('discussionPolicy.targetRoleDisabledArchived'));
  if(role.configured===false||!role.nodeId||!role.runtime||!role.model)return fail('unconfigured',tr('discussionPolicy.targetRoleNotFullyConfigured'));
  if(online===false)return fail('offline',tr('discussionPolicy.waitingForTargetNodeCome'));
  if(online!==true)return fail('connection_unknown',tr('discussionPolicy.targetNodeConnectionUnknownRefresh'));
  if(!supportsDiscussion(worker,role.runtime))return fail('protocol_not_enabled',tr('discussionPolicy.targetRoleHasNotEnabled'));
  const runtime=worker?.runtimes?.find(r=>r.type===role.runtime&&r.supported);
  if(runtime?.authReady===false)return fail('auth_unavailable',runtime.reason||tr('discussionPolicy.targetCliLoginUnavailableSign'));
  const issue=runtimeIssue(worker,role.runtime,role.model);
  if(issue) {
    const code=!worker?.capabilities?.runtimeDiscovery||!runtime?.available?'runtime_unavailable'
      :!Number.isFinite(Date.parse(runtime.checkedAt))||Date.now()-Date.parse(runtime.checkedAt)>600000?'probe_stale':'model_unavailable';
    return fail(code,issue);
  }
  if(!supportsDiscussion(worker,role.runtime,role.model))return fail('configuration_unverified',tr('discussionPolicy.cliVersionModelHasNot'));
  return {ready:true,code:null,reason:null};
}

/** The turn purpose is used for routing and no longer changes the CLI's original permissions. */
export function discussionPolicy(run) {
  const turnPurpose = run?.turnPurpose || 'task';
  if (!['task', 'clarification', 'answer_resume'].includes(turnPurpose)) throw new Error(tr('discussionPolicy.invalidTurnPurpose'));
  return {
    turnPurpose,
    profileId: 'business'
  };
}

/** The protocol version isolates older Workers with the forced sandbox; declaring adapter capability does not mean the account is currently usable. */
export function supportsDiscussion(worker,runtime,model) {
  if(worker?.capabilities?.discussionProtocol!==2||worker.capabilities.discussionRuntimes?.includes(runtime)!==true)return false;
  if(!model)return true;
  const version=worker.runtimes?.find(r=>r.type===runtime)?.version;
  return worker.capabilities.discussionConfigurations?.some(c=>c.runtime===runtime&&c.model===model&&c.version===version)===true;
}

export const discussionHelp = () => tr('discussionPolicy.wbDiscussPeersCurrentTasks');

/** The fixed protocol is injected regardless of whether the user has updated the default prompts; the dynamic question is sent explicitly every turn. */
export function discussionInstructions(run) {
  const policy=discussionPolicy(run),purpose=policy.turnPurpose;
  if(!run.roleId||!run.roleSessionId)return tr('discussionPolicy.beforeChangingCodeCheckGit');
  if(run.peerStatus!==1&&run.discussionProtocol!==2)return tr('discussionPolicy.beforeChangingCodeCheckGit2');
  const coordination=tr('discussionPolicy.beforeChangingCodeRunWb');
  if(run.discussionProtocol!==2)return tr('discussionPolicy.whenCoordinationNeededContactRole', { coordination });
  return tr('discussionPolicy.peerDiscussionProtocolV2Turn', { coordination, purpose, p3: purpose==='task'?tr('discussionPolicy.businessTaskExecutesOnlyWithin'):purpose==='clarification'?tr('discussionPolicy.inTurnVerifyMaterialRun'):tr('discussionPolicy.inTurnUseWbDiscuss'), p4: run.roleSnapshot?.systemSupervisor?tr('discussionPolicy.supervisorDoesNotRelayEach'):'', DISCUSSION_HELP: discussionHelp(), p6: run.discussionContext?tr('discussionPolicy.discussionContextForTurnFrozen', { p1: JSON.stringify(run.discussionContext) }):'' });
}
