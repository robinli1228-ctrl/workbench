import {createHash} from 'node:crypto';
import {currentContinuation,waitDependencies} from './coordination-wait.mjs';
import {tr} from './i18n.mjs';

/**
 * A chat task goes back to its owner when the last turn on it ends without closing it or handing it on. The end of a
 * linked call is noted when it first settles; the scheduler then checks it again before waking the owner once, because
 * whoever called it may still wait for it or other work on the task may still be running. The turn that a return starts
 * is never returned again, so an owner that only answers in text is woken at most once.
 */
const KIND='taskReturns',ATTEMPTS=5,ACTIVE=new Set(['queued','waiting_delivery','running','waiting_call']);
const now=()=>new Date().toISOString();
const short=(text,limit)=>{const value=String(text||'').trim();return value.length>limit?`${value.slice(0,limit-1)}…`:value;};

/** Called when a linked call settles for the first time; a turn that handed work on or waits is not the end of the chain. */
export function noteTaskReturn(db,{run,request}) {
  if(run.status!=='succeeded'||request.status!=='succeeded'||!request.conversationTaskId||request.taskReturn)return;
  const task=db.get('conversationTasks',request.conversationTaskId);
  if(!task?.ownerRoleId||['done','cancelled'].includes(task.status))return;
  if(db.listProject('coordinationRequests',request.projectId).some(r=>r.sourceRunId===run.id))return;
  db.put(KIND,{id:`task-return:${run.id}`,projectId:request.projectId,runId:run.id,requestId:request.id,conversationTaskId:task.id,createdAt:now()});
}

/** post(item,text) creates the owner's turn linked to the task and returns its message. */
export function wakeTaskReturns(db,post) {
  let changed=false;
  for(const pending of db.list(KIND)) {
    const drop=()=>{db.remove(KIND,pending.id);changed=true;};
    const request=db.get('coordinationRequests',pending.requestId),task=db.get('conversationTasks',pending.conversationTaskId),run=db.get('runs',pending.runId);
    if(!request||!run||!task?.ownerRoleId||['done','cancelled'].includes(task.status)){drop();continue;}
    let caller=null;
    if(request.parentRequestId)try{caller=currentContinuation(db,request.parentRequestId);}catch{caller=db.get('coordinationRequests',request.parentRequestId);}
    // The caller waits for this result: its own next turn is the end of the chain and carries the task.
    if(caller?.status==='waiting_call'){let awaited=false;try{awaited=waitDependencies(db,caller).some(r=>r.id===request.id||r.resultRequestId===request.id);}catch{awaited=false;}if(awaited){drop();continue;}}
    // The caller's turn is still going and may yet wait for it: look again later.
    if(caller&&ACTIVE.has(caller.status))continue;
    // Other work on the task goes on; whichever of it ends last decides.
    if(db.listProject('coordinationRequests',task.projectId).some(r=>r.conversationTaskId===task.id&&r.id!==request.id&&ACTIVE.has(r.status))){drop();continue;}
    const owner=db.get('roles',task.ownerRoleId);
    if(!owner?.enabled||owner.archivedAt){drop();continue;}
    const text=tr('taskReturn.wake',{task:`T${task.number}`,title:task.title,role:run.roleSnapshot?.name||run.roleId||'',runId:run.id,
      result:run.reviewRedacted?tr('taskReturn.redacted'):short(run.result,2000)||tr('taskReturn.noReply')});
    const id=`task-return-${createHash('sha256').update(pending.id).digest('hex').slice(0,32)}`;
    try{db.transaction(()=>{post({...pending,id,ownerRoleId:task.ownerRoleId,conversationId:task.conversationId},text);db.remove(KIND,pending.id);});changed=true;}
    catch(error){
      const attempts=(pending.attempts||0)+1;
      if(attempts>=ATTEMPTS){console.error('Task return:',error.message);drop();}
      else{db.put(KIND,{...pending,attempts,lastError:String(error?.message||error).slice(0,300)});changed=true;}
    }
  }
  return changed;
}
