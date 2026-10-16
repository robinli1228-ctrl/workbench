import {t,dateLocale,getLanguage} from './i18n.js';

const labels={latest:'Up to date',update_available:'Update available',modified:'Local modifications',ahead:'Ahead of main',diverged:'Diverged from main',unknown:'Version not confirmed',check_failed:'Update check failed'};
const fingerprint=version=>JSON.stringify([version?.commit,version?.dirty,version?.repository,version?.observedAt]);

/** Show real process identities; checking GitHub never starts an assistant, deployment or restart. */
export function configurationInformationUI({api,getData,create}) {
  const $=selector=>document.querySelector(selector),panel=$('[data-settings-panel="information"]'),button=$('#check-software-updates'),feedback=$('#software-update-feedback');
  let state={instances:[]},busy=false,signature='',loaded=false;
  const raw=(tag,cls,value)=>{const element=create(tag,cls);element.textContent=String(value||'');element.setAttribute('translate','no');return element;};
  function link(label,url){
    const element=create('a','',label);
    if(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:commit|compare)\/[0-9a-f.]+$/.test(url||'')){element.href=url;element.target='_blank';element.rel='noopener noreferrer';}
    return element;
  }
  function render(){
    const latest=$('#software-latest');latest.replaceChildren();latest.hidden=!state.latest;
    if(state.latest){
      latest.append(create('h4','','Latest on GitHub main'),raw('code','software-commit',state.latest.commit),raw('p','',state.latest.summary),link('View update details',state.latest.url));
      latest.append(create('p','workspace-note',t('Checked at {time}',{time:new Date(state.checkedAt).toLocaleString(dateLocale())})));
    }
    const container=$('#software-versions');container.replaceChildren();
    for(const item of state.instances){
      const version=item.softwareVersion,comparison=item.comparison,card=create('section','settings-block software-version-card'),header=create('div','software-version-heading');
      header.append(raw('h4','',item.name),create('span','settings-badge',item.kind==='home'?'Home':item.kind==='local'?'Local Worker':'Server Worker'),create('span','workspace-note',item.online?'Online':'Offline'));
      const status=comparison?.status||(version?.dirty===true?'modified':version?.commit?'not_checked':'unknown');
      card.append(header,create('strong',`software-update-status software-update-${status}`,labels[status]||'Not checked yet'));
      card.append(create('p','',t('Package version: {version}',{version:version?.version||t('Unknown')})));
      if(version?.commit)card.append(raw('code','software-commit',version.commit));
      else card.append(create('p','workspace-note','No verified commit reported. Older Workers and unstamped releases cannot be compared.'));
      if(!item.online)card.append(create('p','workspace-note','Offline: showing the last reported version, not a confirmed current process.'));
      if(version?.observedAt)card.append(create('p','workspace-note',t('Version observed at {time}',{time:new Date(version.observedAt).toLocaleString(dateLocale())})));
      if(status==='modified')card.append(create('p','workspace-note','This process started with modified source files; the commit alone does not identify its code.'));
      if(comparison?.error)card.append(create('p','workspace-note',t('Check unavailable ({reason}). No update action was performed.',{reason:comparison.error})));
      if(comparison?.commits?.length){
        card.append(create('h4','','Update notes (commit summaries)'));
        const list=create('ul','software-update-notes');
        for(const commit of comparison.commits){const row=create('li'),anchor=link('',commit.url);anchor.append(raw('span','',commit.summary||commit.commit.slice(0,12)));row.append(anchor);list.append(row);}
        card.append(list,create('p','workspace-note','Showing up to 20 commit summaries. Open the comparison for the full changes.'));
      }
      if(comparison?.url)card.append(link('View version comparison',comparison.url));
      container.append(card);
    }
    if(!state.instances.length)container.append(create('p','workspace-note','No version information available.'));
  }
  async function load(check=false){
    if(busy)return;busy=true;button.disabled=true;
    feedback.hidden=false;feedback.textContent=t(check?'Checking versions…':'Loading versions…');
    try{
      const next=await api(check?'/api/platform/updates':'/api/platform/version');
      if(!check){
        next.latest=state.latest;next.checkedAt=state.checkedAt;
        for(const item of next.instances){const previous=state.instances.find(old=>old.id===item.id);if(fingerprint(previous?.softwareVersion)===fingerprint(item.softwareVersion))item.comparison=previous?.comparison;}
      }
      state=next;loaded=true;render();feedback.textContent=t(next.error?'Check unavailable ({reason}). No update action was performed.':check?'Update check complete. Nothing was installed or restarted.':'Versions reported by running services.',{reason:next.error});
    }catch(error){feedback.textContent=error.message;}finally{busy=false;button.disabled=false;}
  }
  button.addEventListener('click',()=>void load(true));
  $('[data-settings-tab="information"]').addEventListener('click',()=>void load());
  return {refresh(){
    if(panel.hidden||busy)return;
    const data=getData(),next=JSON.stringify([getLanguage(),(data.workers||[]).map(w=>[w.id,w.name,w.online,w.softwareVersion]),(data.devices||[]).map(d=>[d.id,d.name,d.status])]);
    // Existing state notifications update device status. No new timer or GitHub background polling.
    if(!loaded||next!==signature){signature=next;void load();}
  }};
}
