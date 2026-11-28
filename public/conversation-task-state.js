/** Display helpers do not mutate Home records; task numbers are stable within a conversation. */
export const taskList=(items,includeClosed=false)=>items.filter(item=>includeClosed||!['done','cancelled'].includes(item.status)).slice().sort((a,b)=>a.number-b.number);
export const taskStatus=status=>({todo:'To do',in_progress:'In progress',done:'Done',cancelled:'Cancelled'}[status]||'Unknown status');
export const MAX_STEP_DESCRIPTION=4000;
const CALL_DONE=new Set(['succeeded','failed','cancelled']),RUN_LIVE=new Set(['queued','starting','running','waiting_user','stopping','reconciling']);
/**
 * Whether an unfinished task is being worked on right now: a call linked to it is still open, or its owner has a live turn
 * that is not for another task. Otherwise it only waits ("In progress" in its record, nobody on it), which the list shows
 * as waiting with how long it has been since it last changed.
 */
export function taskActivity(task,activity={}){
  if(task?.status!=='in_progress')return null;
  const index=activity.openTasks?activity:activityIndex(activity);
  if(index.openTasks.has(task.id))return 'active';
  const ownerOnIt=(index.liveByRole.get(task.ownerRoleId)||[]).some(r=>{const linked=index.taskOfRequest.get(r.requestId);return !linked||linked===task.id;});
  return ownerOnIt?'active':'waiting';
}
/**
 * What the task list needs from the chat's requests and runs, built once per render rather than once per task: tasks with an
 * open call, live turns by role, and the task each request is linked to. (Requests and runs keep the chat's whole history.)
 */
export function activityIndex({requests=[],runs=[]}={}){
  const openTasks=new Set(),taskOfRequest=new Map(),liveByRole=new Map();
  for(const r of requests){if(r.conversationTaskId){taskOfRequest.set(r.id,r.conversationTaskId);if(!CALL_DONE.has(r.status))openTasks.add(r.conversationTaskId);}}
  for(const r of runs)if(RUN_LIVE.has(r.status)){if(!liveByRole.has(r.roleId))liveByRole.set(r.roleId,[]);liveByRole.get(r.roleId).push(r);}
  return {openTasks,taskOfRequest,liveByRole};
}
/** Whole days since the task last changed, for "Waiting · 3 d"; under a day there is no count. */
export function idleDays(updatedAt,now=Date.now()){const at=Date.parse(updatedAt||'');return Number.isFinite(at)?Math.floor((now-at)/86400000):0;}
/** Legacy plans may have two fields. Read both without rewriting saved records or discarding their detail. */
export function stepDescription(step){
  const title=typeof step?.title==='string'?step.title:'',description=typeof step?.description==='string'?step.description:'';
  if(!title.trim()||title.trim()===description.trim())return description;
  return description.trim()?`${title}\n\n${description}`:title;
}
/** Summary text is presentation only; the full description remains in the editor, tool payload and history. */
export function stepPreview(step,limit=32){const chars=[...stepDescription(step).replace(/\s+/g,' ').trim()];return chars.slice(0,limit).join('')+(chars.length>limit?'…':'');}
export function taskStep(task){const plan=task.plan,step=plan?.steps?.[plan.currentStep];return step?`${plan.currentStep+1}/${plan.steps.length} · ${stepPreview(step)}`:'';}
export function taskPatch(current,draft){
  const patch={revision:current.revision};
  for(const key of ['title','description','plan','ownerRoleId','status','resultSummary']){
    if(key==='resultSummary'&&draft.status!=='done')continue;
    if(Object.hasOwn(draft,key)&&JSON.stringify(current[key])!==JSON.stringify(draft[key]))patch[key]=draft[key];
  }
  return patch;
}

/** Rectangles alone do not imply visibility: mobile drawers retain layout while off-screen. */
export function taskCardVisible({hasRects,mobile,mobilePanel,ancestors=[]}){
  return Boolean(hasRects)&&(!mobile||mobilePanel==='roles')
    &&!ancestors.some(node=>node.hidden||node.display==='none'||['hidden','collapse'].includes(node.visibility));
}
