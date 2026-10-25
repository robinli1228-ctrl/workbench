import {t,dateLocale,onLanguageChange} from './i18n.js';
import {setActionIcon} from './role-icons.js';
import {taskList,taskStatus,taskStep,taskPatch,taskCardVisible} from './conversation-task-state.js';
const el=(tag,cls='',text)=>Object.assign(document.createElement(tag),{className:cls,...(text===undefined?{}:{textContent:text})});
const raw=node=>{node.setAttribute('translate','no');return node;};
const date=value=>value?new Date(value).toLocaleString(dateLocale()):'—';
const labels={title:'Title',description:'Task description',plan:'Plan',ownerRoleId:'Owner',status:'Status',resultSummary:'Result summary',messageIds:'Related messages'};

/** One bounded read per existing state refresh; scope and editor identity guard every async response. */
export function createConversationTaskUI({api,getScope,getRoles,openMessage}){
  const host=document.querySelector('#conversation-task-card'),heading=el('div','task-card-heading'),list=el('div','task-list'),notice=el('p','workspace-note');
  const title=el('h3','','Task list'),add=el('button','icon-button'),closed=el('input');add.type='button';setActionIcon(add,'plus','Add task');
  const toggle=el('label','task-closed-toggle');closed.type='checkbox';toggle.append(closed,el('span','','Include completed and cancelled'));
  heading.append(title,add);host.append(heading,toggle,notice,list);notice.setAttribute('role','status');
  let scopeKey='',scope=null,items=[],generation=0,pending=false,again=false,editor=null;
  const roleName=id=>getRoles().find(r=>r.id===id)?.name||id||t('Unassigned');
  const url=s=>`/api/projects/${encodeURIComponent(s.projectId)}/conversation-tasks`;
  function sync(){
    const next=getScope(),key=JSON.stringify(next);
    if(key!==scopeKey){scopeKey=key;scope=next;generation++;pending=false;again=false;items=[];notice.textContent='';if(editor)editor.dialog.close();render();}
    host.hidden=!scope?.projectId;
  }
  function render(){
    list.replaceChildren();
    for(const item of taskList(items,closed.checked)){
      const row=el('button','artifact-row task-list-row');row.type='button';row.dataset.taskId=item.id;
      const body=el('span','artifact-row-body');body.append(raw(el('strong','',`T${item.number} · ${item.title}`)),raw(el('small','',`${roleName(item.ownerRoleId)} · ${t(taskStatus(item.status))}`)));
      if(taskStep(item))body.append(raw(el('small','',taskStep(item))));
      body.append(el('small','',date(item.updatedAt)));row.append(body);row.onclick=()=>open(item);list.append(row);
    }
    if(!list.children.length)list.append(el('p','workspace-note',t('No tasks to show.')));
  }
  async function refresh(){
    sync();if(!scope?.projectId)return;
    const ancestors=[];for(let node=host;node;node=node.parentElement){const style=getComputedStyle(node);ancestors.push({hidden:node.hidden,display:style.display,visibility:style.visibility});}
    if(!taskCardVisible({hasRects:host.getClientRects().length>0,mobile:matchMedia('(max-width: 1000px)').matches,mobilePanel:document.body.dataset.mobilePanel,ancestors}))return;
    if(pending){again=true;return;}
    const version=generation,target={...scope};pending=true;
    try{const result=await api(`${url(target)}?${new URLSearchParams({conversationId:target.conversationId,status:'all'})}`);
      if(version!==generation)return;items=result;notice.textContent='';render();
      if(editor?.record){const latest=items.find(i=>i.id===editor.record.id);if(latest?.revision>editor.record.revision)editor.stale.textContent=t('This task changed. Reopen it before saving; your draft is kept here.');}
    }catch(error){if(version===generation)notice.textContent=error.message;}
    finally{if(version===generation){pending=false;if(again){again=false;void refresh();}}}
  }
  function button(text,action,cls='secondary'){const node=el('button',cls,t(text));node.type='button';node.onclick=action;return node;}
  function field(parent,label,value,{area=false,type='text',required=false,maxLength}={}){
    const wrap=el('label'),input=el(area?'textarea':'input');input.value=value??'';input.required=required;if(maxLength)input.maxLength=maxLength;
    if(!area)input.type=type;else input.rows=3;wrap.append(el('span','',t(label)),input);parent.append(wrap);return input;
  }
  function select(parent,label,options,value,multiple=false){
    const wrap=el('label'),input=el('select');input.multiple=multiple;input.setAttribute('aria-label',t(label));
    for(const [id,name] of options){const option=raw(el('option','',name));option.value=id;option.selected=multiple?(value||[]).includes(id):String(value??'')===id;input.append(option);}
    wrap.append(el('span','',t(label)),input);parent.append(wrap);return input;
  }
  const statuses=()=>['todo','in_progress','done','cancelled'].map(s=>[s,t(taskStatus(s))]);
  function open(record){
    if(editor)editor.dialog.close();
    const target={...scope},version=generation,dialog=el('dialog','task-detail-dialog'),form=el('form','task-edit-form');
    const top=el('div','dialog-heading'),close=button('Close',()=>dialog.close(),'icon-button');setActionIcon(close,'close','Close');
    top.append(raw(el('h2','',record?`T${record.number} · ${record.title}`:t('Add task'))),close);
    const error=el('p','task-form-error'),stale=el('p','workspace-note');error.setAttribute('role','alert');stale.setAttribute('role','status');
    const state={dialog,record,stale,requestId:crypto.randomUUID(),saving:false};editor=state;
    const roles=[...new Map(getRoles().filter(r=>r.projectId===target.projectId&&!r.archivedAt).map(r=>[r.id,r])).values()];
    const roleOptions=[['',t('Unassigned')],...roles.map(r=>[r.id,r.name])];
    // Retain an archived current owner when editing unrelated fields.
    if(record?.ownerRoleId&&!roles.some(r=>r.id===record.ownerRoleId))roleOptions.push([record.ownerRoleId,roleName(record.ownerRoleId)]);
    const titleInput=field(form,'Title',record?.title,{required:true,maxLength:200});
    const description=field(form,'Task description',record?.description,{area:true,required:true,maxLength:12000});
    form.append(el('p','workspace-note',t('Changing the owner also requires a new handover description.')));
    const grid=el('div','form-grid');form.append(grid);
    const owner=select(grid,'Owner',roleOptions,record?.ownerRoleId),status=select(grid,'Status',statuses(),record?.status||'todo');
    const summary=field(form,'Result summary',record?.resultSummary,{area:true,maxLength:8000});
    const updateSummary=()=>{summary.parentElement.hidden=status.value!=='done';};status.onchange=updateSummary;updateSummary();
    const planBox=el('fieldset','task-plan'),legend=el('legend','',t('Plan')),stepsBox=el('div','task-steps');planBox.append(legend);form.append(planBox);
    let stepEditors=[];
    const current=select(planBox,'Current step',[['0',t('No steps')]],'0');planBox.append(stepsBox);
    function currentOptions(selected=Number(current.value)){
      current.replaceChildren();const entries=stepEditors.length?stepEditors.map((s,i)=>[String(i),`${i+1} · ${s.title.value}`]):[['0',t('No steps')]];
      for(const [id,name] of entries){const option=raw(el('option','',name));option.value=id;current.append(option);}current.value=String(Math.min(selected,Math.max(0,stepEditors.length-1)));
    }
    function stepEditor(step={title:'',status:'todo'}){
      const box=el('details','task-plan-step');box.open=!step.title;const heading=el('summary','',t('Plan step'));box.append(heading);
      const body=el('div','task-step-fields');box.append(body);const title=field(body,'Step title',step.title,{required:true,maxLength:200});
      const description=field(body,'Step description',step.description,{area:true,maxLength:2000});
      const row=el('div','form-grid');body.append(row);
      const role=select(row,'Owner',roleOptions,step.roleId),status=select(row,'Status',statuses().slice(0,3),step.status||'todo');
      const collaborators=select(body,'Collaborators',roleOptions.slice(1),step.collaborators||[],true);
      const reviewers=select(body,'Reviewers',roleOptions.slice(1),step.review?.roleIds||[],true);
      const count=field(body,'Review count',step.review?.count||0,{type:'number'});count.min='0';count.max='20';
      const sequential=field(body,'Sequential review','',{type:'checkbox'});sequential.checked=step.review?.sequential===true;
      const handoff=select(body,'Hand over to',roleOptions,step.handoffRoleId);
      const entry={box,title,read:()=>({...step,title:title.value,description:description.value,roleId:role.value||null,status:status.value,
        collaborators:[...collaborators.selectedOptions].map(o=>o.value),review:{roleIds:[...reviewers.selectedOptions].map(o=>o.value),count:Number(count.value),sequential:sequential.checked},handoffRoleId:handoff.value||null})};
      body.append(button('Remove step',()=>{const old=stepEditors.indexOf(entry),selected=Number(current.value);stepEditors=stepEditors.filter(s=>s!==entry);box.remove();currentOptions(old<selected?selected-1:selected);}));
      title.oninput=()=>{heading.textContent=title.value||t('Plan step');currentOptions();};heading.textContent=title.value||t('Plan step');
      stepEditors.push(entry);stepsBox.append(box);currentOptions();
    }
    for(const step of record?.plan?.steps||[])stepEditor(step);currentOptions(record?.plan?.currentStep||0);
    planBox.append(button('Add step',()=>{if(stepEditors.length<50)stepEditor();}));
    // Store the normalized initial form once, so opening/saving does not rewrite untouched optional plan fields.
    const initialPlan=JSON.stringify(stepEditors.map(s=>s.read()));
    function readPlan(){const steps=stepEditors.map(s=>s.read()),index=Number(current.value);if(JSON.stringify(steps)===initialPlan&&index===(record?.plan?.currentStep||0))return record?.plan??null;return steps.length?{steps,currentStep:index}:null;}
    const reason=field(form,'Change reason','',{maxLength:1000});
    const save=el('button','primary',t('Save'));save.type='submit';form.append(error,stale,save);
    const history=el('section','task-change-history');history.append(el('h3','',t('Change history')));
    for(const change of [...(record?.history||[])].reverse()){
      const detail=el('details'),heading=raw(el('summary','',`${date(change.at)} · ${change.actor.type==='user'?t('User'):roleName(change.actor.roleId)} · v${change.revision}`));detail.append(heading);
      if(change.reason)detail.append(raw(el('p','',change.reason)));
      for(const [key,value] of Object.entries(change.changes)){
        const part=el('div','task-change');part.append(el('strong','',t(labels[key]||key)));
        const display=v=>{
          if(v==null)return '—';
          if(key==='ownerRoleId')return roleName(v);
          if(key==='status')return t(taskStatus(v));
          if(key==='plan')return [`${t('Current step')}: ${v.currentStep+1}`, ...v.steps.map((step,index)=>[
            `${index+1}. ${step.title} · ${t(taskStatus(step.status||'todo'))}`,
            step.description||'',`${t('Owner')}: ${roleName(step.roleId)}`,
            `${t('Collaborators')}: ${(step.collaborators||[]).map(roleName).join(', ')||'—'}`,
            `${t('Reviewers')}: ${(step.review?.roleIds||[]).map(roleName).join(', ')||'—'} · ${t('Review count')}: ${step.review?.count||0} · ${t('Sequential review')}: ${t(step.review?.sequential?'Yes':'No')}`,
            `${t('Hand over to')}: ${roleName(step.handoffRoleId)}`].filter(Boolean).join('\n'))].join('\n\n');
          return Array.isArray(v)?v.join('\n'):String(v);
        };
        part.append(el('small','',t('Before')),raw(el('pre','',display(value.from))),el('small','',t('After')),raw(el('pre','',display(value.to))));detail.append(part);
      }history.append(detail);
    }
    if(!record?.history?.length)history.append(el('p','workspace-note',t('No changes yet.')));
    const messages=el('section','task-related-messages');messages.append(el('h3','',t('Related messages')));
    for(const [index,id] of (record?.messageIds||[]).entries())messages.append(button(t('Message {number}',{number:index+1}),()=>{dialog.close();void openMessage(target,id).catch(e=>{notice.textContent=e.message;});}));
    if(!record?.messageIds?.length)messages.append(el('p','workspace-note',t('No linked messages.')));
    dialog.append(top,form,history,messages);document.body.append(dialog);dialog.addEventListener('close',()=>{if(editor===state)editor=null;dialog.remove();});dialog.showModal();
    form.onsubmit=async event=>{
      event.preventDefault();if(state.saving||editor!==state||version!==generation)return;
      const draft={title:titleInput.value,description:description.value,ownerRoleId:owner.value||null,status:status.value,plan:readPlan(),...(status.value==='done'?{resultSummary:summary.value}:{})};
      const patch=record?taskPatch(record,draft):draft;
      if(record&&Object.keys(patch).length===1){error.textContent=t('No changes to save.');return;}
      const body=record?{...patch,id:record.id,reason:reason.value,conversationId:target.conversationId}:{...patch,requestId:state.requestId,conversationId:target.conversationId,reason:reason.value};
      state.saving=true;save.disabled=true;error.textContent='';
      try{const saved=await api(url(target),{method:record?'PUT':'POST',json:body});if(editor!==state||version!==generation)return;dialog.close();await refresh();if(version===generation)open(saved);}
      catch(e){if(editor===state)error.textContent=e.message;}
      finally{state.saving=false;save.disabled=false;}
    };
  }
  // Hidden inspectors have no task traffic. Opening one reads once through the same refresh path.
  for(const control of document.querySelectorAll('#inspector-tab-artifacts, #toggle-inspector, [data-mode=groups]'))control.addEventListener('click',()=>queueMicrotask(refresh));
  for(const tab of document.querySelectorAll('.inspector-tabs [role=tab]'))tab.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key))queueMicrotask(refresh);});
  document.addEventListener('workbench:mobile-panel',()=>queueMicrotask(refresh));
  document.querySelector('.node-sidebar')?.addEventListener('transitionend',event=>{if(event.target===event.currentTarget&&event.propertyName==='transform')void refresh();});
  add.onclick=()=>open(null);closed.onchange=render;onLanguageChange(()=>render());
  return {sync,refresh};
}
