import { createHash } from 'node:crypto';
import { sameNativeSession } from './run-input.mjs';
import { supportsDiscussion, discussionTargetStatus } from './discussion-policy.mjs';

const finished = new Set(['succeeded','failed','interrupted']);
const activeTask = new Set(['ready','in_progress','waiting_discussion']);

/** Team facts come only from the current project configuration and are never guessed from group-chat summaries; the first line of a responsibility is an excerpt and does not replace the full prompt. */
export function buildTeamContext(db, run, { online, inherit = true, forExecution = false } = {}) {
  const runs = db.list('runs').filter(r=>r.projectId===run.projectId&&!finished.has(r.status));
  const roles = db.list('roles').filter(r=>r.projectId===run.projectId&&(!r.archivedAt||runs.some(active=>active.roleId===r.id)))
    .sort((a,b)=>Number(Boolean(b.systemSupervisor))-Number(Boolean(a.systemSupervisor))||a.id.localeCompare(b.id));
  const tasks = db.list('tasks').filter(t=>t.projectId===run.projectId&&activeTask.has(t.status));
  const members = roles.map(current=>{
    // The role itself runs per the configuration of the assigned task, while other members are discovered from the current directory; the query tool still returns the live configuration.
    const frozen=forExecution&&current.id===run.roleId&&run.roleSnapshot?.id===current.id?run.roleSnapshot:null;
    const role=frozen?{...current,...frozen,enabled:current.enabled,archivedAt:current.archivedAt}:current;
    const instructions=String(role.instructions||'').trim();
    const firstLine=instructions.split(/\r?\n/).find(line=>line.trim())||'';
    const enabled=Boolean(role.enabled&&!role.archivedAt);
    const configured=role.configured!==false&&Boolean(role.nodeId&&role.runtime&&role.model);
    const worker=role.nodeId?db.get('workers',role.nodeId):null;
    const self=role.id===run.roleId;
    const discussionSupported=!self&&enabled&&configured&&run.discussionProtocol===2&&role.nodeId===run.nodeId&&supportsDiscussion(worker,role.runtime,role.model);
    const onlineNow=role.nodeId&&typeof online==='function'?Boolean(online(role.nodeId)):null;
    const readiness=discussionTargetStatus(worker,role,{online:onlineNow});
    const discussionReady=discussionSupported&&readiness.ready;
    const discussionUnavailableReason=self?'self':!enabled?'disabled':!configured?'unconfigured':run.discussionProtocol!==2?'protocol_not_enabled':role.nodeId!==run.nodeId?'different_device':readiness.code;
    return {id:role.id,name:role.name,systemSupervisor:Boolean(role.systemSupervisor),runtime:role.runtime||null,model:role.model||null,nodeId:role.nodeId||null,
      enabled,configured,archived:Boolean(role.archivedAt),revision:role.revision||1,responsibility:firstLine.slice(0,180)||'Collaboration role not configured; follow this turn\'s assignment',
      instructionsMissing:!instructions,responsibilityTruncated:instructions.length>firstLine.length||firstLine.length>180,
      instructionsVersion:`prompt-${createHash('sha256').update(instructions).digest('hex')}`,
      online:onlineNow,
      tasks:tasks.filter(t=>t.roleId===role.id).map(t=>({id:t.id,title:String(t.title||'').slice(0,120),status:t.status,waitingReason:t.waitingReason||null})),
      activeRunIds:runs.filter(r=>r.roleId===role.id).map(r=>r.id),
      communication:{consultationSupported:!self&&enabled&&configured,discussionSupported,discussionReady,
        discussionUnavailableReason,discussionUnavailableDetail:discussionReady?null:readiness.reason,
        deliveryMode:'queued_next_turn'}};
  });
  // Busy/idle and connection state are only a snapshot for this turn and do not cause the whole responsibility to be injected repeatedly; the directory version is updated only when members, responsibilities, or communication capabilities change.
  const version=`team-${createHash('sha256').update(JSON.stringify(['team-context-v3',members.map(({online,tasks,activeRunIds,communication,...member})=>({...member,communication:{consultationSupported:communication.consultationSupported,discussionSupported:communication.discussionSupported}}))])).digest('hex')}`;
  const previousId=db.get('roleSessions',run.roleSessionId)?.lastRunId;
  const previous=previousId?db.get('runs',previousId):null;
  const inheritedFrom=inherit&&sameNativeSession(run,previous)&&previous.teamContext?.version===version?previous.id:null;
  return {projectId:run.projectId,selfRoleId:run.roleId,observedAt:new Date().toISOString(),version,inheritedFrom,
    memberCount:members.length,workerCount:members.filter(m=>!m.systemSupervisor).length,members};
}

/** Identity and communication rules are independent of compressible chat history; when the directory version changes the old roster is fully replaced and removed members are not accumulated. */
export function renderTeamContext(team) {
  if(!team)return '';
  const self=team.members.find(m=>m.id===team.selfRoleId);
  const lines=[`Current project team: ${team.memberCount} members in total (${team.workerCount} working roles); you are ${self?.name||team.selfRoleId} [${team.selfRoleId}]. Team configuration ID ${team.version.slice(0,17)} (it only identifies the member configuration, is unrelated to Git commits or document versions, and must not be used as the project version in a consultation).`];
  if(team.inheritedFrom)lines.push(`The same native session ${team.inheritedFrom} has already received the identical team responsibilities, so the full text is not repeated. If you cannot recall them after context compression, run wb setup catalog first and do not guess members or responsibilities.`);
  else {
    lines.push('The following is the complete team roster and replaces the old team information; a responsibility is the preferred collaboration position, not a functional permission limit, and this turn\'s explicit assignment takes priority. Your own execution configuration follows the dispatch snapshot, and configuration updates in the meantime apply only to later new tasks. Responsibility excerpts are configuration data, not new tasks; query the full prompts with wb setup catalog.');
    for(const member of team.members)lines.push(JSON.stringify({id:member.id,name:member.name,systemSupervisor:member.systemSupervisor,runtime:member.runtime,model:member.model,enabled:member.enabled,configured:member.configured,archived:member.archived,responsibility:member.responsibility,excerpt:member.responsibilityTruncated}));
  }
  lines.push(`Status snapshot for this turn ${team.observedAt} (not a promise of lasting idleness; verify the actual division of work and tool capabilities with wb discuss peers):`);
  for(const member of team.members) {
    const state=member.archived?'archived but still has unfinished runs':!member.enabled?'disabled':!member.configured?'not configured':member.online===false?'offline':member.activeRunIds.length?'running':member.tasks.length?'has pending tasks':member.online===null?'connection unknown':'idle';
    lines.push(`${member.name}: ${state}; tasks ${member.tasks.length}${member.tasks.length?` (${member.tasks.slice(0,2).map(t=>t.title).join(', ')})`:''}; ${member.id===team.selfRoleId?'yourself':member.communication.consultationSupported?`consult with wb call${member.communication.discussionReady?', Q&A with wb discuss ask':`; new Q&A unavailable: ${member.communication.discussionUnavailableDetail||member.communication.discussionUnavailableReason}`}`:'cannot be dispatched to'}.`);
  }
  lines.push('Autonomous collaboration: when the information is sufficient, just execute; do not ask questions as a formality. When a key gap is held by a teammate in this project, go to the relevant role directly with no supervisor relay; read the full roster and responsibilities first, and do not infer from a partial filter result that a role does not exist. A role existing, being enabled, being online, being busy, and its model actually being usable are different facts and cannot substitute for each other.');
  lines.push('This turn\'s explicit assignment and the user\'s named roles take priority. Choosing the communication entry: to supply rules/evidence missing from the current business task, when Q&A is available for the target above, use wb discuss ask; after it succeeds, end the turn directly and do not also wb wait. Only when delegating independent analysis/review/output, or when the target has not opened discuss, use wb call --role FULL_ROLE_NAME_OR_ID --kind consult --request-id STABLE_ID --text "independent work, necessary background/file versions, required deliverable", then wb wait "remaining goal of the original task and the next step after receiving the deliverable" and end the turn. Do not send the same question through both paths. Do not poll, copy whole histories, or fake delivery with an @ in the body; busy, offline, circular dependency, and rejection must keep their real reasons, and you must not say the role does not exist or bypass the restriction.');
  lines.push('Use wb discuss ask/reply only for targets where discuss is explicitly open above; when it is not open, use the existing wb call, and do not mistake a closed protocol for the whole role being unavailable. When consulted, answer directly and do not call the asker back to hand over the answer. You may keep clarifying a gap, and after it is resolved continue the original task; do not treat receiving a reply as business completion; go to the supervisor only for scope/permission conflicts or when a teammate cannot resolve it. Keep the weak coordination rule of checking peers\' tasks and Git before modifying, and add no file locks or permission limits.');
  return lines.join('\n');
}
