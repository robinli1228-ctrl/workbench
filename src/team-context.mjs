import { createHash } from 'node:crypto';
import { sameNativeSession } from './run-input.mjs';
import { supportsDiscussion, discussionTargetStatus } from './discussion-policy.mjs';
import { tr } from './i18n.mjs';

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
      enabled,configured,archived:Boolean(role.archivedAt),revision:role.revision||1,responsibility:firstLine.slice(0,180)||tr('teamContext.collaborationRoleNotConfiguredFollow'),
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
  const lines=[tr('teamContext.currentProjectTeamMembersIn', { memberCount: team.memberCount, workerCount: team.workerCount, p3: self?.name||team.selfRoleId, selfRoleId: team.selfRoleId, p5: team.version.slice(0,17) })];
  if(team.inheritedFrom)lines.push(tr('teamContext.sameNativeSessionHasAlready', { inheritedFrom: team.inheritedFrom }));
  else {
    lines.push(tr('teamContext.followingCompleteTeamRosterReplaces'));
    for(const member of team.members)lines.push(JSON.stringify({id:member.id,name:member.name,systemSupervisor:member.systemSupervisor,runtime:member.runtime,model:member.model,enabled:member.enabled,configured:member.configured,archived:member.archived,responsibility:member.responsibility,excerpt:member.responsibilityTruncated}));
  }
  lines.push(tr('teamContext.statusSnapshotForTurnNot', { observedAt: team.observedAt }));
  for(const member of team.members) {
    const state=member.archived?tr('teamContext.archivedButStillHasUnfinished'):!member.enabled?tr('teamContext.disabled'):!member.configured?tr('teamContext.notConfigured'):member.online===false?tr('teamContext.offline'):member.activeRunIds.length?tr('teamContext.running'):member.tasks.length?tr('teamContext.hasPendingTasks'):member.online===null?tr('teamContext.connectionUnknown'):tr('teamContext.idle');
    lines.push(tr('teamContext.tasks', { name: member.name, state, length: member.tasks.length, p4: member.tasks.length?tr('teamContext.text2', { p1: member.tasks.slice(0,2).map(t=>t.title).join(tr('teamContext.text')) }):'', p5: member.id===team.selfRoleId?tr('teamContext.yourself'):member.communication.consultationSupported?tr('teamContext.consultWithWbCall', { p1: member.communication.discussionReady?tr('teamContext.qWithWbDiscussAsk'):tr('teamContext.newQUnavailable', { p1: member.communication.discussionUnavailableDetail||member.communication.discussionUnavailableReason }) }):tr('teamContext.cannotBeDispatched') }));
  }
  lines.push(tr('teamContext.autonomousCollaborationWhenInformationSuffic'));
  lines.push(tr('teamContext.turnSExplicitAssignmentUser'));
  lines.push(tr('teamContext.useWbDiscussAskReply'));
  return lines.join('\n');
}
