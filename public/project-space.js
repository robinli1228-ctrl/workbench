import { t, getLanguage } from './i18n.js';
/** The project page manages folders and repositories in one place; it shows only paths confirmed by the target Worker. */
export function projectSpaceUI({api,getData,getProject,refreshState,create}) {
  const prepare=document.querySelector('#project-prepare-form'), form=document.querySelector('#project-repository-form');
  const feedback=document.querySelector('#project-space-feedback'); let signature='',projectId='';
  const option=(id,label)=>{const o=create('option','',label);o.value=id;return o;};
  const select=(el,values,blank)=>{const old=el.value;el.replaceChildren(option('',blank),...values.map(v=>option(v.id,v.name)));el.value=values.some(v=>v.id===old)?old:'';};
  async function act(button,fn){button.disabled=true;feedback.hidden=false;feedback.textContent='Processing…';try{const result=await fn();feedback.textContent=result?.status==='blocked'?t('Some operations did not complete: {v}', { v: result.results.filter(r=>r.error).map(r=>r.error).join(t('; ')) }):'Configuration saved; folders checked.';await refreshState({quiet:true});}catch(e){feedback.textContent=e.message;}finally{button.disabled=false;}}
  prepare.addEventListener('submit',e=>{e.preventDefault();const id=projectId,node=prepare.elements.nodeId.value;void act(prepare.querySelector('button'),()=>api(`/api/projects/${encodeURIComponent(id)}/prepare/${encodeURIComponent(node)}`,{method:'POST',json:{}}));});
  form.addEventListener('submit',e=>{e.preventDefault();const id=projectId,fields=Object.fromEntries(new FormData(form));fields.nodeIds=[...form.querySelectorAll('[name=nodeIds]:checked')].map(el=>el.value);fields.publishBaseline=form.elements.publishBaseline.checked;void act(form.querySelector('button'),()=>api(`/api/projects/${encodeURIComponent(id)}/repositories`,{method:'POST',json:fields}));});
  function refresh(){
    const p=getProject(),data=getData();if(!p)return;
    if(projectId!==p.id){form.reset();feedback.hidden=true;document.querySelector('#repository-node-options').replaceChildren();}
    projectId=p.id;
    document.querySelector('#project-folder-name').value=p.folderName||'Keep existing folder';
    const bindings=(data.workspaces||[]).filter(w=>w.projectId===p.id);
    const next=JSON.stringify([p.id,bindings,(data.workers||[]).map(w=>[w.id,w.name,w.online,w.workspaceRoot]),data.hostingAccounts,data.repositoryOperations,getLanguage()]);
    if(next===signature)return;signature=next;
    const list=document.querySelector('#project-space-status');list.replaceChildren();
    for(const w of data.workers||[]){
      const binding=bindings.find(b=>b.nodeId===w.id);
      const row=create('p','workspace-note',`${w.name} · ${binding?t('Registered'):t('Pending')} · ${binding?.localRoot || `${w.workspaceRoot||w.allowedRoots?.[0]||t('Workspace not set')}/${p.folderName||''}`}`);list.append(row);
    }
    for(const op of (data.repositoryOperations||[]).filter(o=>o.projectId===p.id&&o.status!=='ready')) list.append(create('p','inline-error',t('{v}: {v2}', { v: op.id.split(':').at(-1), v2: op.error || op.results?.filter(r=>r.error).map(r=>r.error).join(t('; ')) || op.status })));
    select(prepare.elements.nodeId,(data.workers||[]).filter(w=>w.online).map(w=>({id:w.id,name:w.name})),'Select device');
    select(form.elements.accountId,(data.hostingAccounts||[]).map(a=>({id:a.id,name:a.label})),'Use device Git credentials');
    if(!form.elements.accountId.value)form.elements.accountId.value=data.settings?.hostingAccountId||'';
    const nodes=document.querySelector('#repository-node-options'),checked=[...nodes.querySelectorAll('input:checked')].map(el=>el.value);nodes.replaceChildren(create('p','workspace-note','Prepare on the following devices:'));
    for(const w of data.workers||[]){const label=create('label','checkbox-label',w.name),input=create('input');input.type='checkbox';input.name='nodeIds';input.value=w.id;input.checked=checked.includes(w.id)||(!checked.length&&bindings.some(b=>b.nodeId===w.id));label.prepend(input);nodes.append(label);}
  }
  return {refresh};
}
