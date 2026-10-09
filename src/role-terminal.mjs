import {terminal} from './store.mjs';
import {roleWorkspace} from './project-repositories.mjs';
import {activeRoleSwitch} from './role-switch-policy.mjs';
import {projectTerminalLock} from './terminal-resume.mjs';
import {reservedTerminalSlots} from './device-capacity.mjs';
import {runtimeIssue} from './runtime-probe.mjs';
import {tr} from './i18n.mjs';

/** A fresh manual terminal uses the current role binding, never a fabricated historical Run. */
export function newTerminalBinding(db,projectId,roleId,online) {
  const role=db.get('roles',roleId),worker=db.get('workers',role?.nodeId);
  if(!db.get('projects',projectId)||role?.projectId!==projectId)throw new Error(tr('home.roleDoesNotBelongProject'));
  if(role.enabled!==true||role.archivedAt||role.platformAssistant||!role.runtime||!role.model)throw new Error(tr('roleTerminal.unconfigured'));
  if(db.get('settings','main')?.paused)throw new Error(tr('home.remoteExecutionPaused4'));
  if(activeRoleSwitch(db,role.id))throw new Error(tr('roleTerminal.switchBusy'));
  if(!online(role.nodeId))throw new Error(tr('home.selectOnlineWorker'));
  if(worker?.capabilities?.terminalFresh!==1)throw new Error(tr('roleTerminal.upgrade'));
  const issue=runtimeIssue(worker,role.runtime,role.model);if(issue)throw new Error(issue);
  if(projectTerminalLock(db,projectId,role.nodeId))throw new Error(tr('home.projectOnDeviceAlreadyUnder'));
  const active=db.list('runs').filter(r=>r.nodeId===role.nodeId&&!terminal.has(r.status));
  if(active.some(r=>r.status==='reconciling'))throw new Error(tr('rooms.nodeHasRunsAwaitingReconciliation'));
  if(active.some(r=>r.projectId===projectId))throw new Error(tr('home.projectStillExecutingOnDevice'));
  if(active.length+reservedTerminalSlots(db,role.nodeId)+(worker.organizerBusy||0)>=(worker.capacity||1))throw new Error(tr('capacity.full'));
  const workspace=roleWorkspace(db,projectId,role.nodeId)?.localRoot;
  if(!workspace)throw new Error(tr('roleTerminal.workspaceMissing'));
  return {role,worker,workspace};
}

/** A release during an awaited Worker/SSH check must never be overwritten by a late preparation result. */
export function publishNewTerminal(db,claim,value) {
  return db.transaction(()=>{
    const current=db.get('terminalSessions',claim.id);
    if(current?.status!=='preparing'||current.projectId!==claim.projectId||current.roleId!==claim.roleId||current.nodeId!==claim.nodeId)throw new Error(tr('roleTerminal.pending'));
    if(activeRoleSwitch(db,claim.roleId))throw new Error(tr('roleTerminal.switchBusy'));
    return db.put('terminalSessions',value);
  });
}
