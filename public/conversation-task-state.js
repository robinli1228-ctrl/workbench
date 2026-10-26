/** Display helpers do not mutate Home records; task numbers are stable within a conversation. */
export const taskList=(items,includeClosed=false)=>items.filter(item=>includeClosed||!['done','cancelled'].includes(item.status)).slice().sort((a,b)=>a.number-b.number);
export const taskStatus=status=>({todo:'To do',in_progress:'In progress',done:'Done',cancelled:'Cancelled'}[status]||'Unknown status');
export const MAX_STEP_DESCRIPTION=4000;
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
