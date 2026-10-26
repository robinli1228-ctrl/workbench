import {t,dateLocale,onLanguageChange} from './i18n.js';
import {setActionIcon,UI_ICON} from './role-icons.js';
import {taskList,taskStatus,taskStep,taskPatch,taskCardVisible,stepDescription,stepPreview,MAX_STEP_DESCRIPTION} from './conversation-task-state.js';
const el=(tag,cls='',text)=>Object.assign(document.createElement(tag),{className:cls,...(text===undefined?{}:{textContent:text})});
const raw=node=>{node.setAttribute('translate','no');return node;};
const date=value=>value?new Date(value).toLocaleString(dateLocale()):'—';
const labels={title:'Title',description:'Task description',plan:'Plan',ownerRoleId:'Owner',status:'Status',resultSummary:'Result summary',messageIds:'Related messages'};

/** One bounded read per existing state refresh; scope and editor identity guard every async response. */
export function createConversationTaskUI({api,getScope,getRoles,openMessage}){
  const host=document.querySelector('#conversation-task-card'),heading=el('div','task-card-heading'),list=el('div','task-list'),notice=el('p','workspace-note');
  const title=el('h3','',t('Task list')),unfinished=el('input');unfinished.type='checkbox';unfinished.checked=true;
  const toggle=el('label','task-closed-toggle');toggle.append(unfinished,el('span','',t('Only unfinished')));
  heading.append(title,toggle);host.append(heading,notice,list);notice.setAttribute('role','status');
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
    for(const item of taskList(items,!unfinished.checked)){
      const row=el('button','artifact-row task-list-row');row.type='button';row.dataset.taskId=item.id;
      const body=el('span','artifact-row-body');body.append(raw(el('strong','',`T${item.number} · ${item.title}`)));
      if(taskStep(item))body.append(raw(el('small','',taskStep(item))));
      const meta=el('span','task-list-meta'),identity=el('span','task-list-identity');
      identity.append(raw(el('span','task-owner',roleName(item.ownerRoleId))),el('span',`task-state task-state-${item.status}`,t(taskStatus(item.status))));
      const time=el('time','',date(item.updatedAt));if(item.updatedAt)time.dateTime=item.updatedAt;meta.append(identity,time);body.append(meta);row.append(body);row.onclick=()=>open(item);list.append(row);
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
    input.setAttribute('aria-label',t(label));
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
    dialog.id='conversation-task-detail';
    const top=el('div','dialog-heading'),close=button('Close',()=>dialog.close(),'icon-button');setActionIcon(close,'close','Close');
    top.append(raw(el('h2','',record?`T${record.number} · ${record.title}`:t('Add task'))),close);
    const error=el('p','task-form-error'),stale=el('p','workspace-note');error.setAttribute('role','alert');stale.setAttribute('role','status');
    const state={dialog,record,stale,requestId:crypto.randomUUID(),saving:false};editor=state;
    // One form keeps drafts across tabs. Reveal hidden invalid fields before native validation focuses them.
    form.noValidate=true;
    const tabs=el('div','task-detail-tabs'),panels=el('div','task-tab-panels');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label',t('Task details'));
    const sections={},tabButtons={},tabLabels={basic:'Basic information@@task',steps:'Task steps',history:'Change history'};
    function showTab(key,{focus=false}={}){for(const name of Object.keys(sections)){const selected=name===key;sections[name].hidden=!selected;tabButtons[name].setAttribute('aria-selected',String(selected));tabButtons[name].tabIndex=selected?0:-1;}footer.hidden=key==='history';if(focus)tabButtons[key].focus();panels.scrollTop=0;}
    for(const [key,label]of Object.entries(tabLabels)){
      const tab=raw(button(label,()=>showTab(key),'task-detail-tab')),panel=el('section','task-tab-panel');
      tab.id=`task-tab-${state.requestId}-${key}`;panel.id=`task-panel-${state.requestId}-${key}`;tab.setAttribute('role','tab');tab.setAttribute('aria-controls',panel.id);panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',tab.id);
      tab.onkeydown=event=>{const names=['basic','steps','history'],index=names.indexOf(key),next=event.key==='ArrowRight'?(index+1)%3:event.key==='ArrowLeft'?(index+2)%3:event.key==='Home'?0:event.key==='End'?2:null;if(next!==null){event.preventDefault();showTab(names[next],{focus:true});}};
      tabButtons[key]=tab;sections[key]=panel;tabs.append(tab);panels.append(panel);
    }
    form.append(tabs,panels);const basic=sections.basic;
    const roles=[...new Map(getRoles().filter(r=>r.projectId===target.projectId&&!r.archivedAt).map(r=>[r.id,r])).values()];
    const roleOptions=[['',t('Unassigned')],...roles.map(r=>[r.id,r.name])];
    // Retain an archived current owner when editing unrelated fields.
    if(record?.ownerRoleId&&!roles.some(r=>r.id===record.ownerRoleId))roleOptions.push([record.ownerRoleId,roleName(record.ownerRoleId)]);
    const titleInput=field(basic,'Title',record?.title,{required:true,maxLength:200});
    const description=field(basic,'Task description',record?.description,{area:true,required:true,maxLength:12000});
    basic.append(el('p','workspace-note',t('Changing the owner also requires a new handover description.')));
    const grid=el('div','form-grid');basic.append(grid);
    const owner=select(grid,'Owner',roleOptions,record?.ownerRoleId),status=select(grid,'Status',statuses(),record?.status||'todo');
    const summary=field(basic,'Result summary',record?.resultSummary,{area:true,maxLength:8000});
    const updateSummary=()=>{summary.parentElement.hidden=status.value!=='done';};status.onchange=updateSummary;updateSummary();
    const planBox=sections.steps,toolbar=el('div','task-steps-toolbar'),stepsBox=el('div','task-steps'),emptySteps=el('p','workspace-note',t('No steps yet. Add a step to build the plan.'));planBox.append(toolbar,emptySteps,stepsBox);
    let stepEditors=[],currentIndex=record?.plan?.currentStep||0;
    const countLabel=el('span','task-step-count');toolbar.append(countLabel);
    const addStep=button('Add step',()=>{if(stepEditors.length<50){stepEditor();stepEditors.at(-1).description.focus();}});toolbar.append(addStep);
    function currentOptions(selected=currentIndex){
      currentIndex=Math.min(selected,Math.max(0,stepEditors.length-1));countLabel.textContent=t('{count} steps',{count:stepEditors.length});emptySteps.hidden=Boolean(stepEditors.length);addStep.disabled=stepEditors.length>=50;
      stepEditors.forEach((entry,index)=>{entry.number.textContent=String(index+1).padStart(2,'0');entry.box.classList.toggle('is-current',index===currentIndex);entry.setCurrent.disabled=index===currentIndex;});
    }
    function stepEditor(step={description:'',status:'todo'}){
      const box=el('details','task-plan-step');box.open=!stepDescription(step).trim();
      const heading=el('summary'),number=el('span','task-step-number'),name=raw(el('span','task-step-name',stepPreview(step,24)||t('Step description')));heading.append(number,name);box.append(heading);
      const status=select(heading,'Step status',statuses().slice(0,3),step.status||'todo');status.parentElement.className='task-step-status';status.parentElement.querySelector('span').remove();
      status.onclick=event=>event.stopPropagation();status.onkeydown=event=>event.stopPropagation();
      const body=el('div','task-step-fields');box.append(body);
      const description=field(body,'Step description',stepDescription(step),{area:true,required:true,maxLength:MAX_STEP_DESCRIPTION});description.parentElement.className='task-step-description';description.parentElement.querySelector('span').remove();description.placeholder=t('Step description');
      const bottom=el('div','task-step-bottom'),more=el('details','task-step-more'),settings=el('div','task-step-settings'),moreHeading=el('summary','task-step-assignments');moreHeading.title=t('Edit collaboration and review settings');
      const assignment=(icon,label)=>{const group=el('span','task-step-assignment'),glyph=el('span','task-step-glyph'),value=raw(el('span','task-step-assignment-value'));glyph.innerHTML=UI_ICON[icon];glyph.setAttribute('aria-hidden','true');group.append(glyph,el('span','task-step-meta-label',t(label)),value);moreHeading.append(group);return value;};
      const collaborationValue=assignment('roles','Collaboration'),reviewValue=assignment('check','Review');
      more.append(moreHeading,settings);bottom.append(more);body.append(bottom);
      const role=select(settings,'Owner',roleOptions,step.roleId),handoff=select(settings,'Hand over to',roleOptions,step.handoffRoleId);
      const collaborators=select(settings,'Collaborators',roleOptions.slice(1),step.collaborators||[],true);
      const reviewers=select(settings,'Reviewers',roleOptions.slice(1),step.review?.roleIds||[],true);
      const count=field(settings,'Review count',step.review?.count||0,{type:'number'});count.min='0';count.max='20';
      const sequential=field(settings,'Sequential review','',{type:'checkbox'});sequential.checked=step.review?.sequential===true;
      const values=()=>({description:description.value,roleId:role.value||null,status:status.value,
        collaborators:[...collaborators.selectedOptions].map(o=>o.value),review:{roleIds:[...reviewers.selectedOptions].map(o=>o.value),count:Number(count.value),sequential:sequential.checked},handoffRoleId:handoff.value||null});
      const initial=values();
      // Editing one step must not insert default collaboration/review fields into untouched historical steps.
      const setCurrent=button('Set as current step',()=>currentOptions(stepEditors.indexOf(entry)));settings.append(setCurrent);
      const entry={box,description,number,setCurrent,read:()=>{const {title,...rest}=step;return {...rest,description:description.value,...Object.fromEntries(Object.entries(values()).filter(([key,value])=>JSON.stringify(value)!==JSON.stringify(initial[key])))};}};
      const remove=button('Remove step',()=>{const old=stepEditors.indexOf(entry),selected=currentIndex;stepEditors=stepEditors.filter(s=>s!==entry);box.remove();currentOptions(old<selected?selected-1:selected);},'icon-button task-step-remove');setActionIcon(remove,'trash','Remove step');bottom.append(remove);
      description.oninput=()=>{name.textContent=stepPreview({description:description.value},24)||t('Step description');};
      const updateAssignments=()=>{collaborationValue.textContent=[...new Set([role.value,...[...collaborators.selectedOptions].map(o=>o.value)].filter(Boolean))].map(roleName).join(', ')||t('Unassigned');reviewValue.textContent=([...reviewers.selectedOptions].map(o=>roleName(o.value)).join(', ')||t('Unassigned'))+(reviewers.selectedOptions.length?` · ${t(sequential.checked?'Sequential review':'Parallel review')}`:'');};
      for(const control of [role,collaborators,reviewers,sequential])control.addEventListener('change',updateAssignments);updateAssignments();
      const updateStatus=()=>{status.className=`task-state task-state-${status.value}`;};status.onchange=()=>{updateStatus();if(status.value==='in_progress')currentOptions(stepEditors.indexOf(entry));};updateStatus();
      stepEditors.push(entry);stepsBox.append(box);currentOptions();
    }
    for(const step of record?.plan?.steps||[])stepEditor(step);currentOptions(record?.plan?.currentStep||0);
    // Store the normalized initial form once, so opening/saving does not rewrite untouched optional plan fields.
    const initialPlan=JSON.stringify(stepEditors.map(s=>s.read()));
    function readPlan(){const steps=stepEditors.map(s=>s.read()),index=currentIndex;if(JSON.stringify(steps)===initialPlan&&index===(record?.plan?.currentStep||0))return record?.plan??null;return steps.length?{steps,currentStep:index}:null;}
    const footer=el('div','task-edit-footer'),actions=el('div','task-edit-actions');
    const reason=field(footer,'Change reason','',{maxLength:1000});
    const save=el('button','primary',t('Save'));save.type='submit';actions.append(button('Cancel',()=>dialog.close()),save);footer.append(error,stale,actions);form.append(footer);
    const history=sections.history;history.classList.add('task-change-history');
    for(const change of [...(record?.history||[])].reverse()){
      const detail=el('details'),heading=raw(el('summary','',`${date(change.at)} · ${change.actor.type==='user'?t('User'):roleName(change.actor.roleId)} · v${change.revision}`));detail.open=true;detail.append(heading);
      if(change.reason)detail.append(raw(el('p','',change.reason)));
      for(const [key,value] of Object.entries(change.changes)){
        const part=el('div','task-change');part.append(el('strong','',t(labels[key]||key)));
        const display=v=>{
          if(v==null)return '—';
          if(key==='ownerRoleId')return roleName(v);
          if(key==='status')return t(taskStatus(v));
          if(key==='plan')return [`${t('Current step')}: ${v.currentStep+1}`, ...v.steps.map((step,index)=>[
            `${index+1}. ${stepDescription(step)} · ${t(taskStatus(step.status||'todo'))}`,
            `${t('Owner')}: ${roleName(step.roleId)}`,
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
    basic.append(messages,el('p','task-updated-at',`${t('Updated')}: ${date(record?.updatedAt)}`));
    const unsubscribe=onLanguageChange(()=>{for(const [key,label]of Object.entries(tabLabels))tabButtons[key].textContent=t(label);});
    showTab('steps');dialog.append(top,form);document.body.append(dialog);dialog.addEventListener('close',()=>{unsubscribe();if(editor===state)editor=null;dialog.remove();});dialog.showModal();
    form.onsubmit=async event=>{
      event.preventDefault();if(state.saving||editor!==state||version!==generation)return;
      const invalid=form.querySelector(':invalid');if(invalid){const key=Object.keys(sections).find(name=>sections[name].contains(invalid));if(key)showTab(key);for(let node=invalid.parentElement;node&&node!==form;node=node.parentElement)if(node.tagName==='DETAILS')node.open=true;invalid.reportValidity();return;}
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
  unfinished.onchange=render;onLanguageChange(()=>render());
  return {sync,refresh};
}
