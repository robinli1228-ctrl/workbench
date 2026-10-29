import {t} from './i18n.js';
import {UI_ICON,closeIcon} from './role-icons.js';

/** 弹窗只确认已登记任务的旧驱动退出，不接管会话、不修改任务正文或重新派工。 */
export function createCliRecoveryUI({api,refreshState,getData,create}) {
  const dialog=create('dialog','cli-recovery-dialog');dialog.setAttribute('aria-labelledby','cli-recovery-title');
  const heading=create('div','dialog-heading'),title=create('h2','','The original session still has a CLI process');title.id='cli-recovery-title';
  const close=closeIcon(create('button','icon-button'),t('Close'));close.type='button';
  heading.append(title,close);
  const description=create('p','workspace-note','The original session cannot continue directly. Stop the old CLI, restore the original session and execute the pending task? This may interrupt work in the old process, but keeps session history.');
  const info=create('p','workspace-note'),reason=create('p','inline-error');reason.setAttribute('role','status');
  const actions=create('div','form-actions'),later=create('button','secondary','Not now'),stop=create('button','primary','Stop old CLI and continue');
  later.type=stop.type='button';actions.append(later,stop);dialog.append(heading,description,info,reason,actions);document.body.append(dialog);
  let selected=null,busy=false;
  const current=()=>selected&&(getData().cliRecoveries||[]).find(r=>r.taskId===selected.taskId&&r.projectId===selected.projectId);
  function refresh(){
    if(!dialog.open)return;
    const record=current();if(!record){if(!busy)dialog.close();stop.disabled=true;return;}
    const data=getData(),role=[...(data.roles||[]),...(data.supervisorRoles||[])].find(r=>r.id===record.roleId),worker=data.workers?.find(w=>w.id===record.nodeId);
    const states={idle:'Idle CLI',unconfirmed:'CLI state unconfirmed',unknown:'Process identity unverified'};
    info.textContent=[t('Device: {name}',{name:worker?.name||record.nodeId}),t('Role: {name}',{name:role?.name||record.roleId}),...(record.processes||[]).map(p=>`PID ${p.pid} · ${t(states[p.state]||'Checking process')}`)].join('\n');
    const changed=record.requestId!==selected.requestId;
    reason.textContent=changed?t('Process state changed; reopen this check.'):record.reason||'';
    reason.hidden=!reason.textContent;
    stop.disabled=busy||changed||!record.canStop||!worker?.online;
    later.disabled=close.disabled=busy;
  }
  const dismiss=()=>{if(!busy)dialog.close();};later.onclick=close.onclick=dismiss;dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
  stop.onclick=async()=>{
    if(stop.disabled||busy)return;
    const record=current();if(!record||record.requestId!==selected.requestId)return refresh();
    selected.decisionId||=crypto.randomUUID();busy=true;refresh();
    try{await api(`/api/projects/${encodeURIComponent(selected.projectId)}/tasks/${encodeURIComponent(selected.taskId)}/cli-recovery`,{method:'POST',json:{requestId:selected.requestId,decisionId:selected.decisionId}});await refreshState({quiet:true});dialog.close();}
    catch(error){reason.textContent=error.message;reason.hidden=false;}
    finally{busy=false;stop.disabled=!current()?.canStop;later.disabled=close.disabled=false;}
  };
  return {refresh,button(task){
    const record=(getData().cliRecoveries||[]).find(r=>r.taskId===task.id&&r.projectId===task.projectId&&!['ready','resolved'].includes(r.state));
    if(!record)return null;
    // An icon like the other card actions; the dialog behind it is unchanged.
    const button=create('button','chat-icon-btn cli-recovery-open');button.type='button';button.innerHTML=UI_ICON.diagnose;
    button.dataset.recovery=`${record.requestId||''}:${record.state||''}`;button.title=t('Check CLI session occupancy');button.setAttribute('aria-label',button.title);button.onclick=()=>{selected={taskId:task.id,projectId:task.projectId,requestId:record.requestId};dialog.showModal();refresh();};return button;
  }};
}
