import {t} from './i18n.js';
import {setActionIcon} from './role-icons.js';

/**
 * Remote access as one card: status, relay server, public address and password state, with an on/off switch. Server settings
 * and the password are changed in a dialog; a status refresh never overwrites a field being edited and never stores a password.
 */
export function createRemoteAccessSettingsUI({root,api}) {
  if(!root)return {refresh:async()=>{}};
  const prefix='/api/settings/remote-access', local=['127.0.0.1','localhost','[::1]'].includes(location.hostname);
  const $=selector=>root.querySelector(selector);
  const dialog=$('[data-relay-dialog]'),form=$('[data-relay-config]'),toggle=$('[data-relay-toggle]'),notice=$('[data-relay-notice]');
  const feedback=$('[data-relay-dialog-feedback]'),dirty=new Set();
  let state=null,busy=false,loading=null;
  setActionIcon($('[data-relay-test]'),'diagnose',t('Test connection'));
  setActionIcon($('[data-relay-refresh]'),'refresh',t('Refresh status'));
  setActionIcon($('[data-relay-edit]'),'edit',t('Edit remote access'));
  const message=value=>{notice.textContent=t(value||'');notice.hidden=!value;};
  const call=(route,json)=>api(prefix+route,json===undefined?{}:{method:'POST',json});
  const bootstrap=()=>call('/bootstrap',{});
  const available=()=>local&&state?.available===true;

  /** One status chip: green when connected, amber while connecting, grey when off or not set up. */
  function phase(){
    if(!local)return ['off','Manage on the Home computer'];
    if(!state)return ['off','Loading…'];
    if(!state.available)return ['off','Not configured'];
    const phases={connected:['ok','Connected'],connecting:['warn','Connecting…'],retrying:['warn','Waiting to reconnect'],stopped:['off','Disabled'],error:['bad','Needs attention']};
    return state.tunnel?.enabled?phases[state.tunnel.phase]||phases.error:phases.stopped;
  }
  const chip=(node,[tone,text])=>{node.className=`settings-chip ${tone}`;node.textContent=t(text);};
  function paint(){
    const ready=available();
    chip($('[data-relay-status]'),phase());
    toggle.checked=state?.tunnel?.enabled===true;toggle.disabled=busy||!ready;
    const label=t(toggle.checked?'Disable remote access':'Enable remote access');toggle.setAttribute('aria-label',label);toggle.closest('label').title=label;
    for(const name of ['data-relay-test','data-relay-edit'])$(`[${name}]`).disabled=busy||!ready;
    $('[data-relay-refresh]').disabled=busy||!local;
    $('[data-relay-host]').textContent=ready&&state.host?state.host:t('Not set');
    $('[data-relay-host]').classList.toggle('muted',!(ready&&state.host));
    const link=$('[data-relay-link]');$('[data-relay-link-row]').hidden=!(ready&&state.publicOrigin);
    link.href=ready&&state.publicOrigin?state.publicOrigin:'#';link.textContent=ready?state.publicOrigin||'':'';
    $('[data-relay-password-state]').textContent=ready?t(state.passwordConfigured?'Set · browser login lasts 15 days':'Not set · browser login lasts 15 days'):'—';
    // The dialog follows the same state, except for fields being edited.
    chip($('[data-relay-dialog-status]'),phase());
    $('[data-relay-dialog-hint]').textContent=ready&&!state.tunnel?.enabled?t('Save the server and set a password before enabling'):'';
    $('[data-relay-upgrade]').hidden=!ready||state.configurationEditable!==false;
    for(const field of form.querySelectorAll('input'))field.disabled=busy||!ready||(field.name!=='password'&&state.configurationEditable===false);
    for(const name of ['host','publicOrigin','user','port'])if(ready&&!dirty.has(name))form.elements[name].value=state[name]??'';
    $('[data-relay-save]').disabled=busy||!ready;
    const enableButton=$('[data-relay-enable]');enableButton.hidden=!ready||state.tunnel?.enabled===true;enableButton.disabled=busy||!ready;
    $('[data-relay-save]').className=enableButton.hidden?'primary':'secondary';
  }
  async function refresh(){
    if(!local){paint();return;}
    if(loading)return loading;
    loading=(async()=>{
      try{await bootstrap();state=await call('/status');}
      catch(error){state=null;message(error.message);}
      finally{paint();}
    })().finally(()=>{loading=null;});
    return loading;
  }
  async function action(operation,{report=message}={}){
    if(busy||!local)return false;
    busy=true;report('');paint();
    try{
      if(loading)await loading;
      await bootstrap();await operation();await refresh();return true;
    }catch(error){report(error.message);await refresh();return false;}
    finally{busy=false;paint();}
  }
  const dialogMessage=value=>{feedback.textContent=t(value||'');feedback.hidden=!value;};
  form.addEventListener('input',event=>{if(event.target.name&&event.target.name!=='password')dirty.add(event.target.name);});
  form.addEventListener('submit',event=>{
    event.preventDefault();
    const patch={},input=form.elements.password,password=input.value,wasOn=state?.tunnel?.enabled===true;
    // "Save and enable" turns a stopped relay on; plain "Save" leaves it as it was.
    const enable=event.submitter?.hasAttribute('data-relay-enable')===true;
    for(const name of dirty){const value=name==='port'?Number(form.elements[name].value):form.elements[name].value.trim();if(value!==state?.[name])patch[name]=value;}
    void action(async()=>{
      let patched=false;
      try{
        if(Object.keys(patch).length){await call('/config',patch);dirty.clear();patched=true;}
        if(password)await call('/password',{password});
      }finally{
        input.value='';
        // Saving server settings stops the relay: bring it back when it was on, even if a later step failed.
        if(patched&&wasOn&&!enable&&!(await call('/status')).tunnel?.enabled)await call('/start',{});
      }
      if(enable&&!(await call('/status')).tunnel?.enabled)await call('/start',{});
    },{report:dialogMessage}).then(done=>{if(done){dialog.close();message(enable?'Remote access status updated.':'Settings saved.');}});
  });
  toggle.addEventListener('change',()=>void action(async()=>{await call(state?.tunnel?.enabled?'/stop':'/start',{});message('Remote access status updated.');}));
  $('[data-relay-test]').addEventListener('click',()=>void action(async()=>{const result=await call('/test',{});message(result.ok?'Relay connection test passed.':'Relay connection test failed.');}));
  $('[data-relay-refresh]').addEventListener('click',()=>void refresh());
  $('[data-relay-edit]').addEventListener('click',()=>{dirty.clear();dialogMessage('');paint();dialog.showModal();form.elements.host.focus();});
  for(const button of [$('[data-relay-cancel]'),$('#close-remote-access-dialog')])button.addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{form.elements.password.value='';dirty.clear();paint();});
  paint();
  return {refresh};
}
