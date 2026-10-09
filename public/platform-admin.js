import { t, dateLocale, getLanguage } from './i18n.js';
import { setActionIcon } from './role-icons.js';

/** Connected Workers and server registrations share one card; registrations that are not connected keep their edit entry. */
export function deviceEntries(workers = [], devices = []) {
  const byNodeId = new Map(devices.map(device => [device.nodeId, device]));
  const entries = workers.map(worker => ({ worker, device: byNodeId.get(worker.id) || null }));
  const connected = new Set(workers.map(worker => worker.id));
  entries.push(...devices.filter(device => !connected.has(device.nodeId)).map(device => ({ worker: null, device })));
  return entries;
}

/** Basic settings manage only devices and accounts; conversations run existing platform tools through the fixed configuration assistant. */
export function platformAdminUI({api,getData,refreshState,create}) {
  const $=s=>document.querySelector(s), account=$('#hosting-account-form'), accountDialog=$('#hosting-account-dialog'), device=$('#device-enroll-form'), assistant=$('#configuration-assistant-form');
  let signature='',assistantState={},loading=false,assistantConfigLoaded=false,pendingMessage=null;
  const text=(target,value)=>{const el=typeof target==='string'?$(target):target;el.textContent=value;el.hidden=false;};
  const option=(id,label)=>{const el=create('option','',label);el.value=id;return el;};
  function choices(el,values,blank,preferred=''){
    const old=el.value;el.replaceChildren(option('',blank),...values.map(v=>option(v.id,v.name||v.id)));el.value=values.some(v=>v.id===old)?old:values.some(v=>v.id===preferred)?preferred:'';
  }
  async function action(button,feedback,fn){button.disabled=true;text(feedback,'Processing…');try{const result=await fn();text(feedback,result?.note||'Done; please check the status.');await refreshState({quiet:true});return result;}catch(e){text(feedback,e.message);}finally{button.disabled=false;}}
  /** Each hosting platform shows its own overview; tokens are entered only in the explicit edit dialog. */
  function openAccount(provider,saved=null){
    account.reset();account.dataset.accountId=saved?.id||'';
    account.elements.provider.value=provider;account.elements.provider.disabled=true;
    account.elements.owner.value=saved?.owner||'';account.elements.visibility.value=saved?.private===false?'public':'private';
    account.elements.token.value='';account.elements.token.required=!saved;account.elements.token.placeholder=saved?'Leave blank to keep the existing token':'Enter access token';
    account.elements.isDefault.checked=saved?getData().settings?.hostingAccountId===saved.id:!(getData().hostingAccounts||[]).length;
    $('#hosting-dialog-title').textContent=t('{v} {v2} account', { v: saved?t('Edit'):t('Connect'), v2: provider==='gitee'?'Gitee':'GitHub' });
    $('#hosting-feedback').hidden=true;accountDialog.showModal();
  }
  for(const id of ['#close-hosting-dialog','#cancel-hosting-dialog'])$(id).addEventListener('click',()=>accountDialog.close());
  accountDialog.addEventListener('close',()=>{account.reset();delete account.dataset.accountId;account.elements.token.value='';$('#hosting-feedback').hidden=true;});
  account.addEventListener('submit',e=>{e.preventDefault();const values=Object.fromEntries(new FormData(account));values.provider=account.elements.provider.value;values.private=values.visibility==='private';values.isDefault=account.elements.isDefault.checked;if(account.dataset.accountId)values.id=account.dataset.accountId;
    void (async()=>{const result=await action(account.querySelector('[type=submit]'),'#hosting-feedback',()=>api('/api/hosting/accounts',{method:'POST',json:values}));if(result){accountDialog.close();text('#hosting-list-feedback',t('{v} account verified and saved.', { v: values.provider==='gitee'?'Gitee':'GitHub' }));}})();});
  device.addEventListener('submit',e=>{e.preventDefault();const values=Object.fromEntries(new FormData(device));void action(device.querySelector('[type=submit]'),'#device-admin-feedback',async()=>{const result=await api('/api/devices',{method:'POST',json:values});device.elements.password.value='';$('#device-enroll-panel').hidden=true;return result;});});
  $('#show-device-enroll').addEventListener('click',()=>{const panel=$('#device-enroll-panel');panel.hidden=!panel.hidden;if(!panel.hidden){device.reset();device.elements.name.focus();}});
  $('#cancel-device-enroll').addEventListener('click',()=>{$('#device-enroll-panel').hidden=true;device.reset();});

  /** The edit form is hosted by the device dialog; list refreshes do not overwrite what is being typed. */
  function deviceDetails({worker,device:registered}) {
    const detail=create('div','device-detail');
    const feedback=create('p','form-feedback');feedback.hidden=true;feedback.setAttribute('role','status');
    if(worker){
      detail.append(create('h4','','Device Name and Workspace'));
      const form=create('form','form-grid device-config-form');
      const name=create('input'),root=create('input');name.value=worker.name;root.value=worker.workspaceRoot||worker.allowedRoots?.[0]||'';
      name.required=true;root.required=true;
      const nameLabel=create('label','','Device name'),rootLabel=create('label','full-width','Default workspace');nameLabel.append(name);rootLabel.append(root);
      const save=create('button','secondary','Check and save device folders');save.type='submit';
      form.append(nameLabel,rootLabel,save);
      form.addEventListener('submit',e=>{e.preventDefault();void action(save,feedback,()=>api(`/api/workers/${encodeURIComponent(worker.id)}/configuration`,{method:'POST',json:{name:name.value,workspaceRoot:root.value}}));});
      detail.append(form);
      const roots=Array.isArray(worker.allowedRoots)?worker.allowedRoots:[];
      if(roots.length)detail.append(create('p','workspace-note',t('Allowed folders: {v}', { v: roots.join(t(', ')) })));

      detail.append(create('h4','','CLI Capacity'));
      const capacityForm=create('form','form-grid device-capacity-form'),capacity=create('input'),capacityFeedback=create('p','form-feedback full-width');
      capacity.type='number';capacity.min='1';capacity.max='64';capacity.step='1';capacity.required=true;
      capacity.value=worker.desiredCapacity ?? worker.capacity ?? 2;
      capacityFeedback.hidden=true;capacityFeedback.setAttribute('role','status');
      const capacityLabel=create('label','','Maximum running CLIs'),capacityHint=create('p','workspace-note full-width','Running and retained CLI processes share this limit. Tasks queue when full; lowering does not stop accepted work.'),capacitySave=create('button','secondary','Save CLI limit');
      capacityLabel.append(capacity);capacitySave.type='submit';capacityForm.append(capacityLabel,capacityHint,capacitySave,capacityFeedback);
      capacityForm.addEventListener('submit',e=>{e.preventDefault();void (async()=>{
        capacitySave.disabled=true;text(capacityFeedback,'Processing…');
        try{
          const result=await api(`/api/workers/${encodeURIComponent(worker.id)}/capacity`,{method:'POST',json:{capacity:Number(capacity.value)}});
          capacity.value=result.capacity;
          text(capacityFeedback,result.applied?'Saved and applied to the connected Worker.':'Saved; waiting for the Worker to apply this limit. It will be applied on reconnection if the device is offline.');
          await refreshState({quiet:true});
        }catch(error){text(capacityFeedback,error.message);}finally{capacitySave.disabled=false;}
      })();});
      detail.append(capacityForm);
    }
    if(registered){
      detail.append(create('h4','','Server Connection'));
      const form=device.cloneNode(true);form.removeAttribute('id');form.querySelector('#cancel-device-enroll')?.remove();form.classList.add('device-connection-form');
      for(const key of ['name','host','port','user','workspaceRoot','homeUrl','desktopUser'])form.elements[key].value=registered[key]||'';
      form.elements.desktopPort.value=registered.desktopPort||3389;form.elements.desktopLocalPort.value=registered.desktopLocalPort||3390;
      if(worker)for(const key of ['name','workspaceRoot'])form.elements[key].closest('label').hidden=true;
      form.elements.password.value='';form.querySelector('[type=submit]').textContent='Save connection info';
      form.addEventListener('submit',e=>{e.preventDefault();const values=Object.fromEntries(new FormData(form));values.id=registered.id;void action(form.querySelector('[type=submit]'),feedback,async()=>{const result=await api('/api/devices',{method:'POST',json:values});form.elements.password.value='';return result;});});
      detail.append(form,create('p','workspace-note',`${registered.user}@${registered.host}:${registered.port} · ${registered.status}`));
      if(registered.error)detail.append(create('p','inline-error',registered.error));
      if(registered.check)detail.append(create('p','workspace-note',t('{platform} · Node {node} · Folder {directory}', { platform: registered.check.platform, node: registered.check.node, directory: registered.check.directory })));
      if(registered.result?.autostart===false)detail.append(create('p','workspace-note','Worker is running in the background; after the device restarts, click Connect to start it again.'));
      const actions=create('div','device-actions');
      for(const [method,label] of [['check','Check connection'],['connect','Install / connect Worker']]){const button=create('button','secondary',label);button.type='button';button.disabled=registered.status==='installing';button.addEventListener('click',()=>void action(button,feedback,()=>api(`/api/devices/${registered.id}/${method}`,{method:'POST',json:{}})));actions.append(button);}
      detail.append(actions);
    }
    detail.append(feedback);
    return detail;
  }
  function assistantChoices(){
    const data=getData(),saved=assistantState.config||{},defaults=data.settings||{};
    const workers=(data.workers||[]).filter(w=>w.online&&w.capabilities?.projectSpace===1);
    choices(assistant.elements.nodeId,workers,'Select execution device',saved.nodeId || (workers.length===1?workers[0].id:''));
    const worker=workers.find(w=>w.id===assistant.elements.nodeId.value),runtimes=(worker?.runtimes||[]).filter(r=>r.supported&&r.available&&r.authReady===true);
    choices(assistant.elements.runtime,runtimes.map(r=>({id:r.type,name:r.label})),'Select CLI',saved.runtime||defaults.defaultSupervisorRuntime);
    const runtime=runtimes.find(r=>r.type===assistant.elements.runtime.value);
    choices(assistant.elements.model,runtime?.models||[],'Select model',saved.model||defaults.defaultSupervisorModel);
    const model=runtime?.models?.find(m=>m.id===assistant.elements.model.value);
    choices(assistant.elements.effort,(model?.efforts||runtime?.efforts||[]).map(id=>({id})),'CLI default',saved.effort||defaults.defaultSupervisorEffort);
    assistantRuntimeSummary();
  }
  function assistantRuntimeSummary(){
    $('#assistant-runtime-summary').textContent=['nodeId','runtime','model','effort'].map(key=>assistant.elements[key].selectedOptions[0]?.textContent||t('Not selected')).join(' · ');
  }
  const runtimeComplete=()=>['nodeId','runtime','model'].every(key=>assistant.elements[key].value);
  const assistantRuntimeDialog=$('#assistant-runtime-dialog');
  let runtimeBeforeEdit=null;
  $('#edit-assistant-runtime').addEventListener('click',()=>{
    runtimeBeforeEdit={config:assistantState.config,values:Object.fromEntries(['nodeId','runtime','model','effort'].map(key=>[key,assistant.elements[key].value]))};
    $('#assistant-runtime-feedback').hidden=true;
    assistantRuntimeDialog.showModal();assistant.elements.nodeId.focus();
  });
  function cancelAssistantRuntime(){
    if(runtimeBeforeEdit){
      const original=assistantState.config;assistantState.config=runtimeBeforeEdit.values;
      for(const key of ['nodeId','runtime','model','effort'])assistant.elements[key].value='';
      assistantChoices();assistantState.config=runtimeBeforeEdit.config||original;
    }
    runtimeBeforeEdit=null;assistantRuntimeDialog.close();
  }
  for(const id of ['#close-assistant-runtime-dialog','#cancel-assistant-runtime-dialog'])$(id).addEventListener('click',cancelAssistantRuntime);
  $('#save-assistant-runtime-dialog').addEventListener('click',()=>{if(!runtimeComplete())return text('#assistant-runtime-feedback','Please select a run device, CLI and model first.');runtimeBeforeEdit=null;$('#assistant-runtime-feedback').hidden=true;assistantRuntimeSummary();assistantRuntimeDialog.close();});
  assistantRuntimeDialog.addEventListener('cancel',e=>{e.preventDefault();cancelAssistantRuntime();});
  assistantRuntimeDialog.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.tagName==='SELECT')e.preventDefault();});
  for(const name of ['nodeId','runtime','model'])assistant.elements[name].addEventListener('change',()=>{assistantState.config={};if(name!=='model')assistant.elements.model.value='';assistantChoices();});
  assistant.elements.effort.addEventListener('change',assistantRuntimeSummary);
  assistant.addEventListener('submit',e=>{e.preventDefault();if(!runtimeComplete()){text('#assistant-runtime-feedback','Please select a run device, CLI and model first.');assistantRuntimeDialog.showModal();return;}const fields=Object.fromEntries(new FormData(assistant));pendingMessage ||= crypto.randomUUID();fields.clientMessageId=pendingMessage;void action(assistant.querySelector('[type=submit]'),'#assistant-feedback',async()=>{await api('/api/platform/assistant',{method:'POST',json:fields});pendingMessage=null;assistant.elements.text.value='';await refreshAssistant();return {note:'Configuration assistant received it; results will appear below.'};});});
  $('#assistant-stop').addEventListener('click',e=>{const run=(assistantState.runs||[]).findLast(r=>!['succeeded','failed','interrupted'].includes(r.status));if(!run)return text('#assistant-feedback','No assistant session is running');void action(e.currentTarget,'#assistant-feedback',()=>api(`/api/runs/${encodeURIComponent(run.id)}/stop`,{method:'POST',json:{commandId:crypto.randomUUID()}}));});
  async function refreshAssistant(){
    if(loading)return;loading=true;
    try{
      assistantState=await api('/api/platform/assistant');
      if(!assistantConfigLoaded){assistantChoices();assistantConfigLoaded=true;}
      $('#configuration-assistant-prompt').textContent=assistantState.prompt;
      const conversation=$('#assistant-conversation');conversation.replaceChildren();
      for(const m of (assistantState.messages||[]).slice(-20)){const card=create('article','settings-block');card.append(create('strong','',m.sender==='human'?'Me':'Configuration assistant'),create('p','assistant-message',m.text));conversation.append(card);}
      const active=(assistantState.tasks||[]).filter(t=>['ready','in_progress'].includes(t.status));if(active.length)conversation.append(create('p','workspace-note',active.map(t=>t.waitingReason||'Configuration assistant is working…').join(t('; '))));
      const proposals=$('#assistant-proposals');proposals.replaceChildren();
      for(const p of (assistantState.proposals||[]).slice(-8)){
        const card=create('article','settings-block');card.append(create('strong','',`${p.summary} · ${p.status}`),create('pre','prompt-preview',JSON.stringify(p.actions,null,2)));
        if(p.error)card.append(create('p','inline-error',p.error));
        if(p.status==='pending')for(const [act,label] of [['approve','Apply configuration'],['reject','Dismiss suggestion']]){const button=create('button','secondary',label);button.type='button';setActionIcon(button,act==='approve'?'check':'stop');button.addEventListener('click',()=>void action(button,'#assistant-feedback',async()=>{await api(`/api/platform/proposals/${p.id}/${act}`,{method:'POST',json:{}});await refreshAssistant();}));card.append(button);}
        proposals.append(card);
      }
    }catch(e){text('#assistant-feedback',e.message);}finally{loading=false;}
  }
  function refresh(){
    const data=getData(),next=JSON.stringify([data.devices,data.hostingAccounts,data.settings?.hostingAccountId,(data.workers||[]).map(w=>[w.id,w.name,w.online,w.workspaceRoot,w.capacity,w.desiredCapacity]),getLanguage()]);
    if(next!==signature){signature=next;
      const accounts=$('#hosting-account-list');accounts.replaceChildren();
      for(const [provider,label] of [['gitee','Gitee'],['github','GitHub']]){
        const card=create('section',`hosting-provider-card hosting-provider-${provider}`),head=create('div','hosting-provider-head'),mark=create('span','hosting-provider-mark',provider==='gitee'?'G':'GH'),title=create('div','hosting-provider-title');
        title.append(create('span','settings-kicker','Code Hosting'),create('h4','',label));head.append(mark,title);card.append(head);
        const linked=(data.hostingAccounts||[]).filter(a=>a.provider===provider);
        if(!linked.length)card.append(create('p','hosting-provider-empty','No account connected. Once connected, repositories can be created for new projects.'));
        for(const a of linked){
          const row=create('div','hosting-account-row'),info=create('div','hosting-account-info'),name=create('strong','',a.owner||a.login||a.label),meta=create('p','workspace-note',`${a.owner&&a.owner!==a.login?t('Login {login} · Organization', { login: a.login }):t('Personal')} · ${a.private?t('Private by default'):t('Public by default')}`);
          info.append(name,meta);if(data.settings?.hostingAccountId===a.id)info.append(create('span','settings-badge','Default for new projects'));
          if(a.verifiedAt)info.append(create('small','hosting-verified',t('Verified {v}', { v: new Date(a.verifiedAt).toLocaleString(dateLocale()) })));
          const edit=create('button','secondary compact','Edit');edit.type='button';edit.setAttribute('aria-label',t('Edit {label} account {v}', { label, v: a.owner||a.login||'' }));edit.addEventListener('click',()=>openAccount(provider,a));
          setActionIcon(edit,'edit');
          row.append(info,edit);card.append(row);
        }
        const add=create('button','secondary compact hosting-add',linked.length?'Add another account':'Connect account');add.type='button';add.setAttribute('aria-label',t('{v} {label} account', { v: linked.length?t('Add another'):t('Connect'), label }));setActionIcon(add,linked.length?'plus':'link');add.addEventListener('click',()=>openAccount(provider));card.append(add);accounts.append(card);
      }
      assistantChoices();
    }
    if(document.querySelector('[data-settings-panel="assistant"]')?.hidden===false)void refreshAssistant();
  }
  document.querySelector('[data-settings-tab="assistant"]').addEventListener('click',()=>void refreshAssistant());
  return {refresh,deviceDetails};
}
