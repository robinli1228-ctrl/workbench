import {t} from './i18n.js';

/** One local settings surface; status refresh never overwrites an unsaved field or stores a password. */
export function createRemoteAccessSettingsUI({root,api}) {
  if(!root)return {refresh:async()=>{}};
  const prefix='/api/settings/remote-access', local=['127.0.0.1','localhost','[::1]'].includes(location.hostname);
  const config=root.querySelector('[data-relay-config]'),password=root.querySelector('[data-relay-password]');
  const status=root.querySelector('[data-relay-status]'),notice=root.querySelector('[data-relay-notice]'),link=root.querySelector('[data-relay-link]');
  const toggle=root.querySelector('[data-relay-toggle]'),dirty=new Set();
  let state=null,busy=false,loading=null;
  const message=value=>{notice.textContent=t(value||'');};
  const call=(route,json)=>api(prefix+route,json===undefined?{}:{method:'POST',json});
  const bootstrap=()=>call('/bootstrap',{});

  function paint(){
    const available=local&&state?.available;
    for(const field of root.querySelectorAll('input,button'))field.disabled=busy||!available;
    for(const field of config.querySelectorAll('input,button'))field.disabled=busy||!available||state.configurationEditable===false;
    root.querySelector('[data-relay-upgrade]').hidden=!available||state.configurationEditable!==false;
    root.querySelector('[data-relay-refresh]').disabled=busy||!local;
    toggle.textContent=t(state?.tunnel?.enabled?'Disable remote access':'Enable remote access');
    toggle.setAttribute('aria-pressed',String(state?.tunnel?.enabled===true));
    const phases={connected:'Relay connected',connecting:'Connecting relay…',retrying:'Waiting to reconnect',stopped:'Remote access disabled',error:'Relay needs attention'};
    status.textContent=t(!local?'Manage remote access on the Home computer.':!available?'Remote access service is not configured or is unavailable.':phases[state.tunnel?.phase]||'Relay needs attention');
    link.hidden=!available;link.href=available?state.publicOrigin:'#';link.textContent=available?state.publicOrigin:'';
    for(const name of ['host','publicOrigin','user','port'])if(available&&!dirty.has(name))config.elements[name].value=state[name]??'';
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
  async function action(operation){
    if(busy||!local)return;
    busy=true;message('');paint();
    try{
      if(loading)await loading;
      await bootstrap();await operation();await refresh();
    }catch(error){message(error.message);await refresh();}
    finally{busy=false;paint();}
  }
  config.addEventListener('input',event=>{if(event.target.name)dirty.add(event.target.name);});
  config.addEventListener('submit',event=>{
    event.preventDefault();
    const patch={};
    for(const name of dirty){const value=name==='port'?Number(config.elements[name].value):config.elements[name].value.trim();if(value!==state?.[name])patch[name]=value;}
    void action(async()=>{
      const result=await call('/config',patch);dirty.clear();message(result.message);
    });
  });
  password.addEventListener('submit',event=>{
    event.preventDefault();const input=password.elements.password,value=input.value;
    void action(async()=>{
      try{const result=await call('/password',{password:value});message(result.message);}
      finally{input.value='';}
    });
  });
  toggle.addEventListener('click',()=>void action(async()=>{await call(state?.tunnel?.enabled?'/stop':'/start',{});message('Remote access status updated.');}));
  root.querySelector('[data-relay-test]').addEventListener('click',()=>void action(async()=>{const result=await call('/test',{});message(result.ok?'Relay connection test passed.':'Relay connection test failed.');}));
  root.querySelector('[data-relay-refresh]').addEventListener('click',()=>void refresh());
  paint();
  return {refresh};
}
