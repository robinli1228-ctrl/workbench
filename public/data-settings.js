import {t,dateLocale} from './i18n.js';
import {formatBytes} from './media.js';

/**
 * Settings → Data: what Home and each device store, how much the retention policy would let go, and a cleanup on demand.
 * The numbers come from Home (/api/data/stats asks each online Worker); cleanup runs the same pass as the daily one.
 * Chat history, session turns, attachments and run logs are never part of what is reclaimed, so the page says so.
 */
const el=(tag,className='',text)=>{const n=document.createElement(tag);if(className)n.className=className;if(text!==undefined)n.textContent=text;return n;};
const KIND_LABELS={sourceSyncCommands:'Sync command records',sourceSyncTransport:'Sync transport receipts',sourceSyncVersions:'Manifest versions',sourceSyncManifests:'Current manifests',sourceSyncBatches:'Sync batches',sourceSyncJournals:'Sync journals',sourceSyncWatchStates:'Folder watch states',events:'Run logs',roomMessages:'Chat messages',nativeTurns:'Session turns',runs:'Runs',commands:'Commands'};
const stamp=value=>{const d=new Date(value||'');return Number.isNaN(d.getTime())?t('Never'):d.toLocaleString(dateLocale(),{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});};

export function createDataSettingsUI({api}){
  const panel=document.querySelector('#settings-data-panel');if(!panel)return {show(){}};
  const form=panel.querySelector('#data-retention-form'),feedback=panel.querySelector('#data-feedback'),table=panel.querySelector('#data-table'),cleanAll=panel.querySelector('#data-clean-all'),refresh=panel.querySelector('#data-refresh');
  let loading=false,busy=false,last=null;
  const note=(text,error=false)=>{feedback.hidden=!text;feedback.textContent=text;feedback.classList.toggle('is-error',error);};
  const mb=bytes=>formatBytes(bytes||0);
  function row(label,stats,{target,online=true,disabled=false,reason=''}){
    const tr=el('tr');
    tr.append(el('td','data-name',label));
    if(!stats){const td=el('td','data-note');td.colSpan=5;td.textContent=reason;tr.append(td);return tr;}
    const total=stats.dbBytes+(stats.blobs?.bytes||0),reclaim=stats.reclaimableBytes||0;
    tr.append(el('td','',mb(stats.dbBytes)+(stats.dbFreeBytes>1048576?` (${t('{size} free inside', {size:mb(stats.dbFreeBytes)})})`:'')));
    tr.append(el('td','',stats.blobs?`${mb(stats.blobs.bytes)} · ${stats.blobs.count}`:'—'));
    const r=el('td',reclaim?'data-reclaim':'');r.textContent=reclaim?mb(reclaim):t('Nothing');tr.append(r);
    tr.append(el('td','',stamp(stats.lastCleanupAt)));
    const actions=el('td','data-actions'),button=el('button','secondary compact',t('Clean up'));button.type='button';button.disabled=disabled||busy||!reclaim;button.addEventListener('click',()=>void cleanup(target));actions.append(button);tr.append(actions);
    // What makes up the store, largest kinds first, with what the policy would let go of each.
    const detail=el('tr','data-detail'),cell=el('td');cell.colSpan=6;const list=el('ul','data-kinds');
    for(const k of (stats.kinds||[]).filter(k=>k.bytes>=65536).slice(0,8))list.append(el('li','',`${t(KIND_LABELS[k.kind]||k.kind)}: ${k.count} · ${mb(k.bytes)}${k.reclaimableCount?` · ${t('{count} ({size}) reclaimable',{count:k.reclaimableCount,size:mb(k.reclaimableBytes)})}`:''}`));
    if(stats.blobs?.reclaimableCount)list.append(el('li','',`${t('Sync snapshots')}: ${t('{count} ({size}) reclaimable',{count:stats.blobs.reclaimableCount,size:mb(stats.blobs.reclaimableBytes)})}`));
    cell.append(list);detail.append(cell);
    const frag=document.createDocumentFragment();frag.append(tr,detail);void total;return frag;
  }
  function render(data){
    last=data;table.replaceChildren();
    const head=el('tr');for(const h of ['Device','Database','Sync snapshots','Reclaimable now','Last cleanup',''])head.append(el('th','',h?t(h):''));table.append(head);
    table.append(row(t('Home'),data.home,{target:'home'}));
    for(const d of data.devices||[])table.append(row(d.name||d.nodeId,d.stats||null,{target:d.nodeId,online:d.online,disabled:!d.online||d.upgrade,reason:!d.online?t('Offline'):d.upgrade?t('Upgrade this Worker to see its data'):d.error?t('Unavailable: {message}',{message:d.error}):''}));
    const reclaimable=(data.home?.reclaimableBytes||0)+(data.devices||[]).reduce((sum,d)=>sum+(d.stats?.reclaimableBytes||0),0);
    cleanAll.disabled=busy||!reclaimable;cleanAll.textContent=reclaimable?t('Clean up all ({size})',{size:mb(reclaimable)}):t('Nothing to clean up');
    const r=data.retention||{};form.elements.syncCommandDays.value=r.syncCommandDays??1;form.elements.blobDays.value=r.blobDays??7;form.elements.manifestVersions.value=r.manifestVersions??20;
  }
  async function load({keepNote=false}={}){if(loading)return;loading=true;refresh.disabled=true;if(!keepNote)note(t('Reading…'));
    try{render(await api('/api/data/stats'));if(!keepNote)note('');}catch(e){note(t('Unable to read data statistics: {message}',{message:e.message}),true);}
    finally{loading=false;refresh.disabled=false;}}
  async function cleanup(target){
    if(busy)return;
    if(!confirm(t('Delete the reclaimable data now? Chat history, session turns, attachments and run logs are never touched.')))return;
    busy=true;if(last)render(last);note(t('Cleaning up… this can take a moment on a large store.'));
    try{const result=await api('/api/data/cleanup',{method:'POST',json:{target}});
      const freed=Object.values(result).reduce((sum,r)=>sum+(r?.bytes||0)+(r?.blobBytes||0),0),deferred=Object.values(result).some(r=>r?.vacuum?.deferred);
      note(t('Removed {size}.',{size:mb(freed)})+(deferred?` ${t('The file itself shrinks at the next idle moment.')}`:''));}
    catch(e){note(t('Cleanup failed: {message}',{message:e.message}),true);}
    finally{busy=false;await load({keepNote:true});}
  }
  form.addEventListener('submit',async e=>{e.preventDefault();const f=form.elements;
    try{await api('/api/settings/retention',{method:'POST',json:{syncCommandDays:Number(f.syncCommandDays.value),blobDays:Number(f.blobDays.value),manifestVersions:Number(f.manifestVersions.value)}});note(t('Retention saved.'));await load();}
    catch(err){note(t('Unable to save: {message}',{message:err.message}),true);}});
  cleanAll.addEventListener('click',()=>void cleanup('all'));
  refresh.addEventListener('click',()=>void load());
  return {show(){void load();}};
}
