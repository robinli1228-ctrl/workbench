/** Display helpers do not mutate Home records; task numbers are stable within a conversation. */
export const taskList=(items,includeClosed=false)=>items.filter(item=>includeClosed||!['done','cancelled'].includes(item.status)).slice().sort((a,b)=>a.number-b.number);
export const taskStatus=status=>({todo:'To do',in_progress:'In progress',done:'Done',cancelled:'Cancelled'}[status]||'Unknown status');
export function taskStep(task){const plan=task.plan,step=plan?.steps?.[plan.currentStep];return step?`${plan.currentStep+1}/${plan.steps.length} · ${step.title}`:'';}
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
