import {agentIconEl,setActionIcon} from './role-icons.js';

const names={claude:'Claude Code',codex:'Codex',grok:'Grok',agy:'Agy'};
const identity=item=>`${item.nodeId}/${item.runtime}/${item.sessionId||item.id}`;
/** Small selector at the existing Agent label. Only an explicit choice begins an idempotent switch. */
export function createNativeAgentSwitchUI({api,getState,onCommitted,onError,t=text=>text,onChange=()=>{}}){
 const pending=new Map();let disposed=false;
 const dialog=document.createElement('dialog');dialog.className='settings-edit-dialog native-agent-dialog';dialog.setAttribute('aria-label',t('Switch Agent'));document.body.append(dialog);
 const busy=item=>pending.has(identity(item))||Boolean(item.conversationBinding?.pendingSwitchId);
 function remember(id,value){try{sessionStorage.setItem(`workbench.agent-switch.${id}`,JSON.stringify(value));}catch{}}
 async function apply(entry,result){
  if(result.conversation)entry.conversation=result.conversation;
  if(result.operation?.stage==='committed'){
   clearTimeout(entry.timer);pending.delete(identity(entry.source));remember(identity(entry.source),null);
   const c=result.conversation;await onCommitted({source:entry.source,conversation:c,current:c.segments.find(s=>s.id===c.currentSegmentId),segments:c.segments});
  }else if(result.operation?.stage==='failed'){
   clearTimeout(entry.timer);pending.delete(identity(entry.source));remember(identity(entry.source),null);onError(result.operation.error||'Agent switch failed');
  }else{entry.message=result.operation?.error||'Switching Agent…';schedule(entry);}
  onChange();
 }
 function schedule(entry){clearTimeout(entry.timer);if(disposed||entry.polls>=60)return;entry.timer=setTimeout(()=>void poll(entry),1000);}
 async function poll(entry){if(disposed||!pending.has(identity(entry.source)))return;entry.polls++;
  try{await apply(entry,await api(`/api/native-sessions/${encodeURIComponent(entry.source.nodeId)}/agent-switch/${encodeURIComponent(entry.id)}`));}
  catch(error){entry.message=error.message;schedule(entry);onChange();}}
 async function choose(item,targetRuntime){
  if(busy(item)||getState().busy)return;
  const entry={id:crypto.randomUUID(),source:{...item,sessionId:item.sessionId||item.id},polls:0,message:'Switching Agent…'};pending.set(identity(item),entry);remember(identity(item),{id:entry.id});onChange();
  try{await apply(entry,await api(`/api/native-sessions/${encodeURIComponent(item.nodeId)}/agent-switch`,{method:'POST',json:{operationId:entry.id,source:{runtime:item.runtime,sessionId:entry.source.sessionId,entryId:item.entryId||null},targetRuntime,expectedRevision:item.conversationBinding?.revision||0}}));}
  catch(error){
   // An HTTP validation error confirms rejection; a network failure may have lost a successful receipt.
   if(Number(error.status)>=400&&Number(error.status)<500){pending.delete(identity(item));remember(identity(item),null);onError(error.message);}
   else{entry.message=error.message;schedule(entry);}onChange();
  }
 }
 function openPicker(item,worker){
  dialog.replaceChildren();const heading=document.createElement('div');heading.className='dialog-heading';const title=document.createElement('h2');title.textContent=t('Switch Agent');
  const close=document.createElement('button');close.type='button';close.className='icon-button';setActionIcon(close,'close',t('Close'));close.onclick=()=>dialog.close();heading.append(title,close);dialog.append(heading);
  const list=document.createElement('div');list.className='native-agent-options';
  for(const [runtime,name] of Object.entries(names)){
   const available=worker.runtimes?.some(r=>r.type===runtime&&r.available&&r.supported!==false),current=runtime===item.runtime;
   const option=document.createElement('button');option.type='button';option.className='native-agent-option';option.disabled=!available||current;
   option.append(agentIconEl(runtime));const text=document.createElement('span');text.textContent=name+(current?` · ${t('Current Agent')}`:available?'':` · ${t('Unavailable')}`);option.append(text);
   option.onclick=()=>{dialog.close();void choose(item,runtime);};list.append(option);
  }
  dialog.append(list);dialog.showModal();
 }
 function render({item,worker,conversation=item.conversationBinding,busy:occupied=false}){
  const id=identity(item);let entry=pending.get(id),saved=null;
  if(!entry){try{saved=JSON.parse(sessionStorage.getItem(`workbench.agent-switch.${id}`));}catch{}
   const operationId=conversation?.pendingSwitchId||saved?.id;if(operationId){entry={id:operationId,source:item,polls:0,message:'Switching Agent…'};pending.set(id,entry);schedule(entry);}}
  const root=document.createElement('span');root.className='native-identity-item native-agent-selector';root.append(agentIconEl(item.runtime));
  const name=document.createElement('span');name.className='native-identity-name';name.textContent=names[item.runtime]||item.runtime;root.append(name);
  const select=document.createElement('button');select.type='button';select.className='icon-button native-agent-switch-button';setActionIcon(select,'refresh',t('Switch Agent'));select.setAttribute('aria-haspopup','dialog');
  select.disabled=occupied||busy(item)||!worker?.online||worker.capabilities?.nativeAgentSwitch!==1||Boolean(item.roleBinding)||!item.sessionId;
  root.title=t(entry?.message||(!worker?.capabilities?.nativeAgentSwitch?'Upgrade this Worker to switch Agent':item.roleBinding?'Use the group role controls to switch this Agent':occupied?'Finish replies, questions and queued messages before switching Agent':'Switch Agent'));
  select.onclick=()=>openPicker(item,worker);root.append(select);
  if(entry){const indicator=document.createElement('span');indicator.className='native-agent-switch-status';indicator.setAttribute('role','status');indicator.textContent=t('Switching Agent…');root.append(indicator);
   if(entry.polls>=60){const retry=document.createElement('button');retry.type='button';retry.textContent=t('Check status');retry.onclick=()=>{entry.polls=0;void poll(entry);};root.append(retry);}}
  return root;
 }
 return {render,busy,dispose(){disposed=true;for(const entry of pending.values())clearTimeout(entry.timer);dialog.close();dialog.remove();}};
}
