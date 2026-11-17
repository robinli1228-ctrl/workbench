import {tr} from './i18n.mjs';
import {terminal} from './store.mjs';
import {isRoleConfigured} from './default-roles.mjs';
import {conversationIdOf} from './group-conversations.mjs';

/**
 * When a role's turn has gone quiet for ten minutes (the run monitor's alert), the project supervisor gets one background
 * check for it: the facts, and the choice to leave it, end it with `wb run finish` when its reply is complete and only an
 * abandoned background command keeps it open, or ask the user. The check is internal (no chat message, no reply card);
 * the supervisor speaks in the chat once, with a one-line conclusion through `wb note`.
 * Checks keep ordinary workspace admission: adapters without enforced read-only access can queue behind the quiet turn.
 */
export function dispatchStallChecks(db,rooms){
  let changed=false;
  for(const alert of db.openRunAlerts()){
    if(alert.kind!=='silent'||alert.checkMessageId)continue;
    // One check per turn: a long, quiet build the supervisor chose to leave alone is not raised again every ten minutes.
    const run=db.get('runs',alert.id);if(!run||terminal.has(run.status)||!run.roleId||run.stallCheckId)continue;
    const project=db.get('projects',run.projectId),supervisor=project?.supervisorRoleId?db.get('roles',project.supervisorRoleId):null;
    // A quiet supervisor turn cannot check itself; nothing to hand a check to without a working supervisor.
    if(!supervisor?.enabled||supervisor.archivedAt||!isRoleConfigured(supervisor)||run.roleId===supervisor.id)continue;
    const id=`stall-check-${run.id}-${Date.parse(alert.createdAt)||0}`;
    try{
      rooms.postSystemTask(run.projectId,{id,conversationId:conversationIdOf(run),roleId:supervisor.id,text:stallCheckText(db,run),source:{kind:'stall_check',context:{id,roleId:supervisor.id,runId:run.id}}});
      db.put('runAlerts',{...alert,checkMessageId:id});db.put('runs',{...db.get('runs',run.id),stallCheckId:id});changed=true;
    }catch(error){console.error('Stall check:',error.message);}
  }
  return changed;
}

/** What the supervisor needs to judge the quiet turn, from the records Home already has. */
export function stallCheckText(db,run){
  const role=db.get('roles',run.roleId)?.name||run.roleSnapshot?.name||run.roleId,waiting=run.awaitingBackground;
  const tasks=(waiting?.tasks||[]).map(task=>`- ${task.description||task.id}${task.type?` (${task.type})`:''}`).join('\n');
  return tr(waiting?'stallCheck.taskAwaiting':'stallCheck.task',{role,runId:run.id,last:run.updatedAt||run.createdAt||'-',since:waiting?.since||'-',tasks:tasks||tr('stallCheck.noTaskDetails')});
}
