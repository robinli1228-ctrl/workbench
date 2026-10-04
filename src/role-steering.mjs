import {terminal} from './store.mjs';
import {RoleDiscussions} from './role-discussions.mjs';

/** A steer is a persisted stop barrier; the same native session cannot be resumed until the stop is confirmed. */
export function steeringWaitReason(db,task) {
  if(task.steering) {
    if(task.steering.waitForRunIds.some(id=>!terminal.has(db.get('runs',id)?.status))) return 'Interrupting; waiting for the old run to confirm it has stopped';
    return null;
  }
  if(db.list('tasks').some(t=>t.projectId===task.projectId && t.roleId===task.roleId && t.steering &&
    (t.status==='ready' || (t.currentRunId && !terminal.has(db.get('runs',t.currentRunId)?.status))))) return 'Waiting for the role to continue with the new instruction';
  return null;
}

/** Only promotes an already saved human message; it does not resend the message, change the text, or release the Worker session lock. */
export class RoleSteering {
  constructor(db,calls) {this.db=db;this.calls=calls;}

  request(projectId,taskId,commandId) {
    if(typeof commandId!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(commandId))throw new Error('Invalid steering ID');
    return this.db.transaction(()=>{
      let task=this.db.get('tasks',taskId);
      if(!task||task.projectId!==projectId)throw new Error('The message does not belong to the current project');
      if(task.steering) {
        if(task.steering.commandId!==commandId)throw new Error('This message has already started an immediate steer; wait for the status to update');
        return task.steering;
      }
      const message=this.db.get('roomMessages',task.sourceMessageId);
      if(task.origin!=='chat'||task.status!=='ready'||task.currentRunId||message?.sender!=='human'||!message.taskIds?.includes(task.id)||task.scheduledJobId||task.planId||task.continuationRunId)throw new Error('Only human messages that have not started can be steered');
      if(this.db.get('settings','main')?.paused)throw new Error('Remote execution is paused');
      const role=this.db.get('roles',task.roleId);
      if(!role?.enabled||role.archivedAt)throw new Error('The role is disabled or archived');
      if(this.db.list('tasks').some(t=>t.projectId===projectId&&t.roleId===task.roleId&&t.steering&&t.status==='ready'&&!t.currentRunId))throw new Error('This role already has a steering message waiting to run');
      const active=this.db.list('runs').filter(r=>r.projectId===projectId&&r.roleId===task.roleId&&!terminal.has(r.status));
      if(active.some(r=>r.nodeId!==task.roleSnapshot.nodeId||r.roleSnapshot?.runtime!==task.roleSnapshot.runtime))throw new Error('The role device or CLI has changed; end the original run and verify the session first');
      if(task.requestId && this.db.get('coordinationRequests',task.requestId)?.status!=='queued')throw new Error('The message state has changed; refresh');
      const stopped=new Set(active.map(r=>r.id)), blocked=new Set(), planIds=new Set();
      const discussions=new RoleDiscussions(this.db);
      const pendingDiscussionTasks=new Set(this.db.list('discussionIntents').filter(i=>i.projectId===projectId&&['queued','blocked'].includes(i.status)).map(i=>i.taskId));
      for(const prior of this.db.list('tasks').filter(t=>t.projectId===projectId&&t.roleId===task.roleId&&t.id!==taskId&&(t.discussionWait||pendingDiscussionTasks.has(t.id)))) {
        for(const id of discussions.invalidateTask(prior.id,{reason:'The user changed direction',directionRevision:(prior.directionRevision||1)+1}).stopRunIds)stopped.add(id);
      }
      // A role waiting for child results also needs its old continuation revoked, not just the current process stopped.
      for(const run of active) this.calls.forRun(run);
      const requests=this.db.list('coordinationRequests').filter(r=>r.projectId===projectId&&r.targetRoleId===task.roleId&&r.taskId!==taskId&&
        (active.some(run=>run.id===r.currentRunId)||r.status==='waiting_call'));
      for(const request of requests) {
        for(const id of this.calls.cancel(request.id))stopped.add(id);
        let current=request;
        while(current&&!blocked.has(current.id)) {
          blocked.add(current.id);if(current.planId)planIds.add(current.planId);
          for(const plan of this.db.list('executionPlans').filter(p=>p.parentRequestId===current.id))planIds.add(plan.id);
          const latest=this.db.get('coordinationRequests',current.id);
          this.db.put('coordinationRequests',{...latest,steeringTaskId:taskId});
          current=this.db.get('coordinationRequests',current.parentRequestId||current.continuationOf||'');
        }
      }
      // Sibling roles already running continue; members of the old plan that have not been dispatched yet cannot start in the old direction.
      for(const id of planIds) {
        const plan=this.db.get('executionPlans',id);
        if(!plan||['succeeded','cancelled'].includes(plan.status))continue;
        this.db.put('executionPlans',{...plan,status:'blocked',steeringTaskId:taskId,error:'The user has changed direction; the old plan no longer advances automatically',updatedAt:new Date().toISOString()});
        for(const r of this.db.list('coordinationRequests').filter(r=>r.planId===id&&!r.currentRunId&&!['succeeded','failed','cancelled'].includes(r.status)))this.calls.cancel(r.id);
      }
      for(const id of stopped)this.db.requestStop(id,`steer:${taskId}:${id}`);
      const steering={commandId,waitForRunIds:[...stopped],planIds:[...planIds],createdAt:new Date().toISOString()};
      task=this.db.get('tasks',taskId);
      this.db.put('tasks',{...task,steering,contextPrepared:true,contextState:'excerpt',waitingReason:stopped.size?'Interrupting; waiting for the old run to confirm it has stopped':'Continue with the new instruction first'});
      return steering;
    });
  }
}
