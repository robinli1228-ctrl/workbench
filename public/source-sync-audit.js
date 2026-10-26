/** Display only recorded facts; these helpers never read file contents. */
export function auditQuery(filters={},after=''){
  const q=new URLSearchParams();for(const k of ['path','device','status','from','to'])if(filters[k])q.set(k,filters[k]);if(after)q.set('after',after);return q.toString();
}
export function auditSummary(r){return {path:r.relativePath,action:({add:'Add',modify:'Modify',delete:'Delete',confirm_equal:'Confirm equal'})[r.action]||r.action,status:({syncing:'Syncing',succeeded:'Succeeded',failed:'Failed'})[r.status]||r.status};}
export function auditFields(r){return [
  ['Record ID',r.recordId],['Operation ID',r.operationId],['Attempt',r.attempt],['Scope',r.scope],['Relative path',r.relativePath],
  ['Started',r.startedAt],['Finished',r.finishedAt||'Unconfirmed'],['Phase',r.phase],['Reason',r.reason||'—'],
  ['Source before',r.sourceBefore||'Unconfirmed'],['Target before',r.targetBefore||'Unconfirmed'],['Target after',r.targetAfter||'Unconfirmed'],
  ['Source hash',r.sourceHash||'Not computed'],['Target hash',r.targetHash||'Not computed'],['Retry of',r.retryOf||'—'],
  ['Transferred payload bytes',r.transferredBytes],['Duration (ms)',r.duration]
];}
