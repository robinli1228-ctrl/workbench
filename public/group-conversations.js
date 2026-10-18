import {t} from './i18n.js';
import {closeIcon} from './role-icons.js';

/** Creation changes navigation metadata only; the selected source is captured before any asynchronous work. */
export function createGroupConversationUI({api,getSelection,onCreated,onCopyTeam}) {
  const dialog=document.createElement('dialog');dialog.className='group-conversation-dialog';
  const heading=document.createElement('h3'),close=document.createElement('button');close.type='button';close.className='icon-button';closeIcon(close,t('Close'));
  const header=document.createElement('div');header.className='group-conversation-heading';header.append(heading,close);
  const branch=document.querySelector('#branch-group-chat'),copy=document.querySelector('#copy-project-team');
  const form=document.createElement('form'),label=document.createElement('label'),title=document.createElement('input'),note=document.createElement('p'),save=document.createElement('button'),error=document.createElement('p');
  title.id='group-conversation-title';title.required=true;title.maxLength=80;label.textContent=t('Chat title');label.append(title);
  note.textContent=t('Same project folders and roles; no messages or native context are copied. The original chat remains usable.');
  save.id='create-group-conversation';save.type='submit';save.className='primary';save.textContent=t('Create chat');error.setAttribute('role','status');
  form.append(label,note,error,save);dialog.append(header,form);document.body.append(dialog);
  let source=null,requestId=null,busy=false;
  close.onclick=()=>dialog.close();copy.onclick=()=>{const selection=getSelection();if(selection?.projectId)onCopyTeam?.({...selection});};
  branch.onclick=()=>open();
  form.onsubmit=async event=>{
    event.preventDefault();if(busy||!title.value.trim())return;
    busy=true;save.disabled=true;error.textContent='';requestId||=crypto.randomUUID();
    try{
      const created=await api(`/api/projects/${encodeURIComponent(source.projectId)}/conversations`,{method:'POST',json:{requestId,sourceConversationId:source.conversationId,title:title.value}});
      await onCreated(created);dialog.close();
    }catch(e){error.textContent=e.message;}finally{busy=false;save.disabled=false;}
  };
  function open(selection=getSelection()){
    if(!selection?.projectId||busy)return;
    source={...selection};requestId=null;heading.textContent=t('Branch into new chat');title.value='';error.textContent='';
    if(!dialog.open)dialog.showModal();
    title.focus();
  }
  return {open};
}
