import {t} from './i18n.js';
import {closeIcon} from './role-icons.js';
import {orderedItems,readListOrder} from './list-order.js';

/** Copy configuration only; persist the request before sending so reloads recover rather than duplicate it. */
export function createProjectTeamCopyUI({api,getData,onCreated}) {
  const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=t(text);return n;};
  const dialog=el('dialog');dialog.id='project-team-copy-dialog';dialog.className='group-conversation-dialog team-copy-dialog';
  const header=el('div');header.className='group-conversation-heading';const close=closeIcon(el('button',''),t('Close'));close.type='button';close.className='icon-button';close.onclick=()=>dialog.close();header.append(el('h3','Copy team into new project'),close);
  const form=el('form'),name=el('input'),folder=el('input'),preview=el('section'),status=el('div'),submit=el('button','Create project'),retry=el('button','Retry preparation');
  name.id='team-copy-name';name.required=true;name.maxLength=80;folder.id='team-copy-folder';folder.required=true;folder.pattern='[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}';folder.maxLength=64;
  for(const [label,input]of [['Project name',name],['Folder name',folder]]){const field=el('label',label);field.append(input);form.append(field);}
  submit.id='team-copy-submit';submit.type='submit';submit.className='primary';retry.id='team-copy-retry';retry.type='button';retry.hidden=true;status.setAttribute('role','status');
  form.append(preview,status,submit,retry);dialog.append(header,el('p','No code or history is copied'),el('p','New business directories contain only platform bootstrap files; dependencies and native sessions are not copied.'),form);document.body.append(dialog);
  let sourceId=null,snapshot=null,operation=null,payload=null,busy=false,generation=0,navigated=null;
  const key=()=>`agent-workbench.project-copy.${sourceId}`;
  function remember(){sessionStorage.setItem(key(),JSON.stringify({payload,operationId:operation?.id||payload?.requestId}));}
  function draw(){
    preview.replaceChildren();if(snapshot){
      for(const warning of snapshot.warnings||[])preview.append(el('p',warning));
      for(const role of snapshot.roles){const details=el('details'),summary=el('summary');summary.textContent=`${role.name} · ${role.runtime||'—'} · ${role.model||'—'} · ${role.nodeId||'—'}${role.enabled===false?` · ${t('Disabled')}`:''}`;
        const prompt=el('pre'),settings=el('pre');settings.textContent=JSON.stringify({responsibility:role.responsibility||'',effort:role.effort??null,mode:role.mode??null,autoApprove:role.autoApprove??null},null,2);prompt.textContent=role.instructions===''?t('Explicitly empty prompt'):role.instructions??t('No custom prompt');details.append(summary,settings,prompt);preview.append(details);}
      for(const nodeId of snapshot.requiredDeviceIds){const receipt=operation?.deviceReceipts?.[nodeId],worker=getData().workers?.find(w=>w.id===nodeId);const destination=el('p');destination.className='team-copy-destination';destination.textContent=`${worker?.name||nodeId}: ${receipt?.result?.localRoot||`${receipt?.workspaceRoot||worker?.workspaceRoot||worker?.allowedRoots?.[0]||'?'}/${folder.value||'…'}`}`;preview.append(destination);}
    }
    name.disabled=folder.disabled=Boolean(payload)||busy;submit.hidden=Boolean(payload);submit.disabled=busy||!snapshot;
    retry.hidden=!payload||operation?.status==='ready';retry.disabled=busy;
    if(operation){status.textContent=[operation.status,operation.error,...Object.values(operation.deviceReceipts||{}).map(r=>`${r.nodeId}: ${r.status}${r.error?` · ${r.error}`:''}`)].filter(Boolean).join('\n');}
    if(operation?.status==='ready'&&dialog.open&&navigated!==operation.id){navigated=operation.id;sessionStorage.removeItem(key());dialog.close();void onCreated(operation);}
  }
  async function submitCopy(){
    if(busy)return;busy=true;status.textContent='';
    try{
      if(!payload){payload={requestId:crypto.randomUUID(),name:name.value,folderName:folder.value,sourceRevision:snapshot.sourceRevision,roleOrder:snapshot.roleOrder};remember();}
      draw();operation=await api(`/api/projects/${encodeURIComponent(sourceId)}/team-copies`,{method:'POST',json:payload});snapshot=operation.snapshot||snapshot;remember();
    }catch(e){
      status.textContent=e.message;
      // Only a confirmed absent operation permits form correction; an unknown response keeps its ID.
      if(e.status===400&&payload)try{operation=await api(`/api/project-copies/${encodeURIComponent(payload.requestId)}`);snapshot=operation.snapshot||snapshot;}catch(check){if(check.status===404){payload=null;sessionStorage.removeItem(key());}}
    }finally{busy=false;draw();}
  }
  form.onsubmit=event=>{event.preventDefault();void submitCopy();};folder.oninput=()=>draw();
  retry.onclick=async()=>{if(!operation)return void submitCopy();if(busy)return;busy=true;draw();try{operation=await api(`/api/project-copies/${encodeURIComponent(operation.id)}/retry`,{method:'POST',json:{}});snapshot=operation.snapshot||snapshot;remember();}catch(e){status.textContent=e.message;}finally{busy=false;draw();}};
  return {async open(projectId){
    if(busy)return;const version=++generation;sourceId=projectId;snapshot=null;operation=null;payload=null;status.textContent=t('Loading…');name.value='';folder.value='';draw();if(!dialog.open)dialog.showModal();
    try{
      if(getData().capabilities?.projectTeamCopy!==1)throw new Error(t('Upgrade Home before copying a team.'));
      const saved=JSON.parse(sessionStorage.getItem(key())||'null');
      if(saved?.operationId){payload=saved.payload;name.value=payload?.name||'';folder.value=payload?.folderName||'';operation=await api(`/api/project-copies/${encodeURIComponent(saved.operationId)}`);if(version!==generation)return;snapshot=operation.snapshot;}
      else{const roles=(getData().roles||[]).filter(r=>r.projectId===projectId&&!r.archivedAt&&!r.systemSupervisor),roleOrder=orderedItems(roles,readListOrder(`roles:${projectId}`)).map(r=>r.id);snapshot=await api(`/api/projects/${encodeURIComponent(projectId)}/team-copy/preview?roleOrder=${encodeURIComponent(JSON.stringify(roleOrder))}`);if(version!==generation)return;}
      status.textContent='';draw();
    }catch(e){if(version===generation){status.textContent=e.message;draw();}}
  },sync(){if(!operation||!dialog.open)return;const current=getData().projectCopies?.find(op=>op.id===operation.id);if(current){operation={...operation,...current};draw();}}};
}
