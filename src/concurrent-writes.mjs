import {conversationIdOf} from './group-conversations.mjs';
import {tr} from './i18n.mjs';
/** A project's manual switch lets several roles on one device work in it at once; a Worker that cannot honour it keeps the lock. */
export const concurrentWritesAllowed=(project,worker)=>project?.allowConcurrentWrites===true&&worker?.capabilities?.concurrentWrites===1;

/**
 * Roles already admitted on this device in this project, named once so a starting run can say who else is working. The
 * starting role's own session in another group chat is named as such: it owns the same files, so the rule to change only
 * your own files does not keep the two apart.
 */
export const concurrentPeers=(db,projectId,nodeId,self={})=>{
  const names=new Set();
  for(const r of db.activeRuns(nodeId).filter(r=>r.projectId===projectId)){
    if(self.roleId&&r.roleId===self.roleId){if(conversationIdOf(r)!==self.conversationId)names.add(tr('concurrentWrites.ownOtherChat',{chat:db.get('groupConversations',conversationIdOf(r))?.title||db.get('projects',projectId)?.name||conversationIdOf(r)}));continue;}
    if(r.roleSnapshot?.name)names.add(r.roleSnapshot.name);
  }
  return [...names];
};
