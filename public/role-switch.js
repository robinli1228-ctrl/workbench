import {t} from './i18n.js';

const stages={draining:'Waiting for accepted work to finish',handoff:'Original CLI is preparing a handoff',verifying:'New CLI is checking the handoff',prepared:'Verifying process settlement',committed:'CLI switched',blocked:'Switch blocked; original configuration retained',cancelling:'Cancelling; waiting for confirmed shutdown',cancelled:'Cancelled; original configuration retained'};
const settled=op=>['committed','cancelled'].includes(op?.status);
const prefix='wb.cli-switch.';

/** Shared by work-role and supervisor forms; only Home decides whether a switch committed. */
export function createRoleSwitchUI({api,refreshState}) {
  let active=null,timer=null,heartbeat=null,sequence=0;
  const dialog=document.createElement('dialog');dialog.className='role-switch-dialog';
  dialog.style.cssText='max-width:640px;width:90%;padding:28px;border:1px solid #cddcef;border-radius:18px;';
  const title=document.createElement('h2'),status=document.createElement('p'),detail=document.createElement('p'),cancelButton=document.createElement('button');
  title.textContent=t('Handoff and switch');status.setAttribute('role','status');detail.style.whiteSpace='pre-wrap';cancelButton.type='button';cancelButton.textContent=t('Cancel switch');
  dialog.append(title,status,detail,cancelButton);document.body.append(dialog);
  const key=(projectId,roleId)=>`${prefix}${projectId}.${roleId}`;
  const path=a=>`/api/projects/${encodeURIComponent(a.projectId)}/roles/${encodeURIComponent(a.roleId)}/cli-switches`;
  const lock=(host)=>{const fields=[...(host?.querySelectorAll('input,select,textarea,button')||[])].map(el=>[el,el.disabled]);for(const[el]of fields)el.disabled=true;return()=>{for(const[el,disabled]of fields)el.disabled=disabled;};};

  function render(op) {
    status.textContent=t(stages[op.status]||'Checking switch status…');
    detail.textContent=op.error||t('The saved CLI stays unchanged until the handoff and verification finish. Business files and history are kept.');
    cancelButton.disabled=op.status==='cancelling';
  }
  function finish(a,op) {
    if(active!==a)return;
    clearInterval(timer);clearInterval(heartbeat);timer=heartbeat=null;
    sessionStorage.removeItem(key(a.projectId,a.roleId));a.unlock();active=null;
    dialog.close();a.resolve(op);void refreshState({quiet:true}).catch(()=>{});
  }
  async function poll() {
    const a=active;if(!a||a.polling)return;a.polling=true;
    try {
      const op=await api(`${path(a)}/${a.input.operationId}`);
      if(active!==a)return;render(op);if(settled(op))finish(a,op);
    } catch(error) {
      if(active!==a)return;
      detail.textContent=error.message;
      // A lost initial POST may not have reached Home. Reuse its ID and draft, never create another operation.
      if(error.status===400||error.status===404) {
        if(a.input.draft&&!a.creating)void createOperation(a);
      }
    }finally{a.polling=false;}
  }
  async function renew() {
    const a=active;if(!a||!a.input.leaseId)return;
    try{const op=await api(`${path(a)}/${a.input.operationId}/renew`,{method:'POST',json:{leaseId:a.input.leaseId}});if(active===a){render(op);if(settled(op))finish(a,op);}}catch(error){if(active===a)detail.textContent=error.message;}
  }
  async function cancel() {
    const a=active;if(!a)return;a.cancelRequested=true;cancelButton.disabled=true;
    try{const op=await api(`${path(a)}/${a.input.operationId}/cancel`,{method:'POST',json:{}});if(active===a){render(op);if(settled(op))finish(a,op);}}catch(error){if(active===a){detail.textContent=error.message;cancelButton.disabled=false;}}
  }
  async function createOperation(a) {
    if(a.creating)return;a.creating=true;
    try {
      const op=await api(path(a),{method:'POST',json:a.input});if(active!==a)return;
      render(op);if(settled(op))finish(a,op);else if(a.cancelRequested)await cancel();
    }catch(error){
      if(active!==a)return;
      if(error.isNetworkError||!error.status){detail.textContent=t('Connection lost; checking the same switch operation.');return;}
      clearInterval(timer);clearInterval(heartbeat);sessionStorage.removeItem(key(a.projectId,a.roleId));a.unlock();active=null;dialog.close();a.reject(error);
    }finally{a.creating=false;}
  }
  function watch({projectId,roleId,input,host,create=false}) {
    if(active)throw new Error(t('A CLI switch dialog is already open.'));
    const token=++sequence;
    return new Promise((resolve,reject)=>{
      const a={projectId,roleId,input,resolve,reject,token,unlock:lock(host)};active=a;
      sessionStorage.setItem(key(projectId,roleId),JSON.stringify({projectId,roleId,input}));
      cancelButton.disabled=false;title.textContent=t('Handoff and switch');render({status:'draining'});dialog.showModal();
      timer=setInterval(poll,1000);heartbeat=setInterval(renew,10000);
      if(create)void createOperation(a);else void poll();
    });
  }
  async function begin({projectId,role,draft,host,expectedSupervisorRevision}) {
    const saved=sessionStorage.getItem(key(projectId,role.id));
    if(saved)return watch({...JSON.parse(saved),host});
    return watch({projectId,roleId:role.id,host,create:true,input:{operationId:crypto.randomUUID(),leaseId:crypto.randomUUID(),expectedRoleRevision:role.revision||1,expectedSupervisorRevision,draft}});
  }
  function resume({projectId,role,host,operation}) {const saved=sessionStorage.getItem(key(projectId,role.id));return saved?watch({...JSON.parse(saved),host}):operation&&!settled(operation)?watch({projectId,roleId:role.id,host,input:{operationId:operation.id}}):null;}
  dialog.addEventListener('cancel',event=>{event.preventDefault();void cancel();});cancelButton.addEventListener('click',cancel);
  const leave=()=>{const a=active;if(a)void api(`${path(a)}/${a.input.operationId}/cancel`,{method:'POST',json:{},keepalive:true}).catch(()=>{});};
  window.addEventListener('pagehide',leave);
  return {begin,resume,cancel,dispose(){leave();clearInterval(timer);clearInterval(heartbeat);active?.unlock();active=null;window.removeEventListener('pagehide',leave);dialog.remove();}};
}
