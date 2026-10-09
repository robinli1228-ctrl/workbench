import {t,getLanguage} from './i18n.js';

/** Reuse the role editor as the history host; tab changes preserve unsaved configuration. */
export function createRoleHistoryTabs({host,settings,getData,getRole,api,refreshState,create,formatTime,openTask}) {
  const nav=create('div','role-history-tabs');nav.setAttribute('role','tablist');nav.setAttribute('aria-label','Role Details');
  const panel=create('section','role-history-panel');panel.id=`${settings.id}-history`;panel.setAttribute('role','tabpanel');
  const settingsTab=create('button','secondary compact','Role settings'),historyTab=create('button','secondary compact','History records');
  settingsTab.type=historyTab.type='button';settingsTab.setAttribute('role','tab');historyTab.setAttribute('role','tab');
  settingsTab.id=`${settings.id}-settings-tab`;historyTab.id=`${settings.id}-history-tab`;
  settingsTab.setAttribute('aria-controls',settings.id);historyTab.setAttribute('aria-controls',panel.id);panel.setAttribute('aria-labelledby',historyTab.id);
  nav.append(settingsTab,historyTab);host.insertBefore(nav,settings);host.append(panel);
  let active='settings',busy=false,signature='';
  function select(value) {
    active=value;settings.hidden=value!=='settings';panel.hidden=value!=='history';
    for(const [button,name] of [[settingsTab,'settings'],[historyTab,'history']]){button.setAttribute('aria-selected',String(value===name));button.tabIndex=value===name?0:-1;}
    if(value==='history')render();
  }
  settingsTab.onclick=()=>select('settings');historyTab.onclick=()=>select('history');
  nav.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();select(active==='settings'?'history':'settings');(active==='settings'?settingsTab:historyTab).focus();}});
  function render(force=false) {
    const role=getRole(),data=getData();nav.hidden=!role?.id;
    if(!role?.id){select('settings');return;}
    if(active!=='history')return;
    const sessions=(data.roleSessions||[]).filter(s=>s.projectId===role.projectId&&s.roleId===role.id&&!s.historyClearedAt).slice().reverse();
    const runs=(data.runs||[]).filter(r=>r.projectId===role.projectId&&r.roleId===role.id&&!r.historyClearedAt);
    const next=JSON.stringify([role.id,sessions,runs.map(r=>[r.id,r.status,r.nativeSession?.id]),busy,getLanguage()]);
    if(!force&&next===signature)return;signature=next;panel.replaceChildren();
    const actions=create('div','form-actions');
    const clear=create('button','secondary compact','Clear history');clear.type='button';clear.disabled=busy||!sessions.length&&!runs.length;actions.append(clear);panel.append(actions);
    const feedback=create('p','inline-error');feedback.hidden=true;feedback.setAttribute('role','status');panel.append(feedback);
    clear.onclick=async()=>{
      if(busy||!window.confirm(t('Clear this role’s session history and start a new session next time? Project chat and code files are kept.')))return;
      const current=sessions.find(s=>s.conversationId===role.projectId&&s.status!=='archived'&&!s.candidateFor);
      busy=true;clear.disabled=true;
      try{
        await api(`/api/projects/${encodeURIComponent(role.projectId)}/roles/${encodeURIComponent(role.id)}/history/clear`,{method:'POST',json:{sessionId:current?.id||null}});
        await refreshState({quiet:true});
        if(getRole()?.id===role.id){signature='';render(true);}
      }catch(error){if(feedback.isConnected){feedback.textContent=error.message;feedback.hidden=false;}}
      finally{busy=false;if(clear.isConnected)clear.disabled=false;if(getRole()?.id===role.id&&!feedback.textContent)render(true);}
    };
    if(!sessions.length&&!runs.length)panel.append(create('p','workspace-note','No session history. The next execution starts a new session.'));
    for(const session of sessions){
      const card=create('section','settings-block');
      const label=session.status==='archived'?t('Past'):session.candidateFor?t('Staged'):t('Current');
      card.append(create('strong','',t('{v} session #{generation} · {v2}',{v:label,generation:session.generation,v2:session.id.slice(0,8)})),
        create('p','workspace-note',`${session.runtime} · ${data.workers?.find(w=>w.id===session.nodeId)?.name||session.nodeId} · ${session.updatedAt?formatTime(session.updatedAt):t('unknown')}`));
      const summary=create('p','workspace-note','Summary not loaded yet');card.append(summary);
      void api(`/api/projects/${encodeURIComponent(role.projectId)}/sessions/${encodeURIComponent(session.id)}/summary`).then(result=>{if(summary.isConnected)summary.textContent=result.status==='ready'?t('Summary: {text}',{text:result.text}):t('Summary not generated yet');}).catch(error=>{if(summary.isConnected)summary.textContent=t('Summary unavailable: {message}',{message:error.message});});
      const details=create('details');details.append(create('summary','','View the original text visible to the platform'));
      const content=create('pre','prompt-preview'),more=create('button','secondary compact','Load more');more.type='button';
      let offset=0,version=null,loaded=false,loading=false;
      const load=async()=>{if(loading)return;loading=true;more.disabled=true;try{const params=new URLSearchParams({offset:String(offset),limit:'4000',...(version?{version}:{})});const page=await api(`/api/projects/${encodeURIComponent(role.projectId)}/sessions/${encodeURIComponent(session.id)}/read?${params}`);if(!content.isConnected)return;content.textContent+=page.content||'';offset=page.nextOffset??offset;version=page.version;more.hidden=page.complete;}catch(error){if(content.isConnected)content.textContent+=t('\nRead failed: {message}',{message:error.message});}finally{loading=false;more.disabled=false;}};
      details.addEventListener('toggle',()=>{if(details.open&&!loaded){loaded=true;void load();}});more.onclick=()=>void load();details.append(content,more);card.append(details);panel.append(card);
    }
    const known=new Set(sessions.map(s=>s.id));
    for(const run of runs.filter(r=>!known.has(r.roleSessionId)).reverse()){
      const card=create('section','settings-block');card.append(create('strong','',`${formatTime(run.createdAt)} · ${run.status}`));
      if(openTask){const view=create('button','secondary compact','View run');view.type='button';view.onclick=()=>openTask(run.taskId);card.append(view);}panel.append(card);
    }
  }
  select('settings');
  return {refresh:render,reset:()=>{signature='';select('settings');render();}};
}
