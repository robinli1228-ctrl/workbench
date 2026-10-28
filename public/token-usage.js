import { t, dateLocale } from './i18n.js';
const TYPES=[
  {key:'inputTokens',label:'Input',color:'#0866ff'},
  {key:'outputTokens',label:'Output',color:'#00a8e8'},
  {key:'cacheCreationTokens',label:'Cache write',color:'#6645ed'},
  {key:'cacheReadTokens',label:'Cache read',color:'#29c9c0'}
];
const MODEL_COLORS=['#0866ff','#00a8e8','#6645ed','#29a39a','#ed8b23','#d95082','#57872e','#8359aa','#b96a32','#c44242'];
const tokens=value=>Number.isFinite(Number(value))&&Number(value)>0?Number(value):0;

/** Combine selected devices by date and model; unknown historical shares keep an explicit remainder. */
function modelDays(devices){
  const days=new Map();
  for(const device of devices)for(const row of device.daily||[]){
    const day=days.get(row.date)||{date:row.date,totalTokens:0,values:new Map()},amount=tokens(row.totalTokens);day.totalTokens+=amount;
    const values=new Map();for(const item of row.modelBreakdowns||[]){if(item.modelName&&tokens(item.totalTokens))values.set(item.modelName,(values.get(item.modelName)||0)+tokens(item.totalTokens));}
    // A single recorded model is unambiguous; do not split a multi-model total without measured amounts.
    if(!values.size&&row.models?.length===1&&amount)values.set(row.models[0],amount);
    const measured=[...values.values()].reduce((sum,value)=>sum+value,0);
    if(measured>amount)values.clear();
    const remainder=amount-(measured>amount?0:measured);if(remainder)values.set('Unclassified',(values.get('Unclassified')||0)+remainder);
    for(const[name,value]of values)day.values.set(name,(day.values.get(name)||0)+value);
    days.set(row.date,day);
  }
  const totals=new Map();for(const day of days.values())for(const[name,value]of day.values)totals.set(name,(totals.get(name)||0)+value);
  const models=[...totals].sort(([a],[b])=>a==='Unclassified'?1:b==='Unclassified'?-1:a.localeCompare(b)).map(([modelName,totalTokens],index)=>({modelName,totalTokens,color:modelName==='Unclassified'?'#94a3b8':MODEL_COLORS[index]||`hsl(${index*137.508%360} 65% 45%)`}));
  return {models,days:[...days.values()].sort((a,b)=>a.date.localeCompare(b.date)).map(day=>({date:day.date,totalTokens:day.totalTokens,segments:models.filter(model=>day.values.has(model.modelName)).map(model=>({...model,value:day.values.get(model.modelName)}))}))};
}

export function usageChartModel(report){
  const devices=(report.devices||[]).map(device=>{
    const total=Number(device.total?.totalTokens||0);
    const unavailable=device.state?.status!=='ready'&&!device.daily?.some(row=>row.collectedAt);
    return {...device,unavailable,segments:TYPES.map(type=>({...type,value:Number(device.total?.[type.key]||0),percent:total?Math.round(Number(device.total?.[type.key]||0)/total*1000)/10:0}))};
  });
  const {days,models}=modelDays(devices);
  return {devices,models,partial:devices.some(device=>device.unavailable),days,dailyMax:Math.max(1,...days.map(day=>day.totalTokens)),totalTokens:Number(report.total?.totalTokens||0),total:report.total||{}};
}

export function refreshMessage(report){
  const failed=(report.devices||[]).filter(device=>device.state?.status!=='ready'&&device.state?.error);
  return failed.length?t('Collection incomplete: {v}', { v: failed.map(device=>t('{name}: {error}', { name: device.name, error: device.state.error })).join(t('; ')) }):'Collection complete; offline devices keep their history and will backfill when back online.';
}

/** The platform token page reads aggregated data only; charts load no third-party scripts. */
export function tokenUsageUI({api,getData,create}){
  const form=document.querySelector('#token-usage-form'),feedback=document.querySelector('#token-usage-feedback');
  let loaded=false;
  // 等可见布局完成后定位最新日期；用户随后仍可自由向左查看历史。
  const showLatest=()=>requestAnimationFrame(()=>{const chart=document.querySelector('#token-usage-daily');chart.scrollLeft=chart.scrollWidth;});
  const format=value=>Number(value||0).toLocaleString(dateLocale());
  const compact=value=>new Intl.NumberFormat(dateLocale(),{notation:'compact',maximumFractionDigits:1}).format(Number(value||0));
  const date=value=>{const d=new Date();d.setDate(d.getDate()+value);return new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit'}).format(d);};
  form.elements.from.value ||= date(-29);form.elements.to.value ||= date(0);
  function options(){
    const workers=getData().workers||[],selects=[form.elements.nodeA,form.elements.nodeB],old=selects.map(s=>s.value);
    for(let i=0;i<selects.length;i++){
      selects[i].replaceChildren(...workers.map(worker=>{const option=create('option','',`${worker.name}${worker.online?t(' · Online'):t(' · Offline')}`);option.value=worker.id;return option;}));
      selects[i].value=workers.some(w=>w.id===old[i])?old[i]:(workers[i]?.id||workers[0]?.id||'');
    }
  }
  function render(report){
    const model=usageChartModel(report),summary=document.querySelector('#token-usage-total');
    summary.replaceChildren(create('span','usage-total-label',model.partial?'Total usage of collected devices (partial)':'Total usage of selected devices'),create('strong','',format(model.totalTokens)),create('span','usage-total-unit','tokens'),create('small','',t('Input {v} · Output {v2} · Cache {v3}', { v: format(model.total.inputTokens), v2: format(model.total.outputTokens), v3: format(Number(model.total.cacheCreationTokens||0)+Number(model.total.cacheReadTokens||0)) })));
    const pies=document.querySelector('#token-usage-pies');pies.replaceChildren();
    for(const device of model.devices){
      let cursor=0;const stops=device.segments.map(segment=>{const start=cursor;cursor+=segment.percent;return `${segment.color} ${start}% ${cursor}%`;});
      const card=create('article','usage-device-card'),pie=create('div','usage-pie');pie.style.background=device.total.totalTokens?`conic-gradient(${stops.join(',')})`:'#e7edf1';pie.setAttribute('role','img');pie.setAttribute('aria-label',device.unavailable?t('{name} not collected yet', { name: device.name }):t('{name} token breakdown', { name: device.name }));
      const center=create('span','usage-pie-center',device.unavailable?'—':compact(device.total.totalTokens));center.title=device.unavailable?'Not collected yet':`${format(device.total.totalTokens)} tokens`;pie.append(center);
      const info=create('div','usage-device-info');info.append(create('strong','',device.name),create('p','workspace-note',`${device.online?t('Online'):t('Offline')} · ${device.state?.status==='ready'?t('Collected through {lastCollectedDate}', { lastCollectedDate: device.state.lastCollectedDate }):device.state?.error||t('Not collected yet')}`));
      const legend=create('div','usage-legend');if(!device.unavailable)for(const segment of device.segments){const item=create('span','');item.style.setProperty('--legend-color',segment.color);item.textContent=`${segment.label} ${format(segment.value)} (${segment.percent}%)`;legend.append(item);}info.append(legend);card.append(pie,info);pies.append(card);
    }
    const key=document.querySelector('#token-usage-device-key');key.replaceChildren(...model.models.map(item=>{const label=create('span','',t(item.modelName));label.style.setProperty('--legend-color',item.color);label.title=`${format(item.totalTokens)} tokens`;return label;}));
    const chart=document.querySelector('#token-usage-daily');chart.replaceChildren();
    document.querySelector('#token-usage-model-note')?.remove();
    document.querySelector('#token-usage-model-empty')?.remove();
    if(!model.models.length){const empty=create('p','workspace-note','No usage in this date range.');empty.id='token-usage-model-empty';chart.before(empty);}
    if(model.models.some(item=>item.modelName==='Unclassified')){const note=create('p','workspace-note','Some usage has no model breakdown; historical snapshots can be updated by collecting this range again.');note.id='token-usage-model-note';chart.before(note);}
    for(const day of model.days){
      const group=create('div','usage-day'),bars=create('div','usage-bars'),stack=create('div','usage-stack');
      stack.style.height=`${day.totalTokens?Math.max(2,day.totalTokens/model.dailyMax*160):0}px`;stack.title=`${day.date} · ${format(day.totalTokens)} tokens`;
      for(const segment of day.segments){const bar=create('span','usage-bar');bar.style.height=`${segment.value/day.totalTokens*100}%`;bar.style.background=segment.color;bar.title=`${t(segment.modelName)} · ${day.date} · ${format(segment.value)} tokens`;bar.setAttribute('role','img');bar.setAttribute('aria-label',bar.title);stack.append(bar);}
      bars.append(stack);group.append(bars,create('time','',day.date.slice(5)));chart.append(group);
    }
    showLatest();
  }
  async function load(refresh){
    const values=Object.fromEntries(new FormData(form)),nodeIds=[values.nodeA,values.nodeB].filter(Boolean);
    if(new Set(nodeIds).size!==nodeIds.length){feedback.hidden=false;feedback.textContent='Please select two different devices';return;}
    feedback.hidden=false;feedback.textContent=refresh?'Backfilling from online devices…':'Loading history…';form.querySelectorAll('button').forEach(button=>button.disabled=true);
    try{
      const report=refresh?await api('/api/token-usage/refresh',{method:'POST',json:{from:values.from,to:values.to,nodeIds}}):await api(`/api/token-usage?from=${encodeURIComponent(values.from)}&to=${encodeURIComponent(values.to)}&nodeIds=${encodeURIComponent(nodeIds.join(','))}`);
      render(report);feedback.textContent=refresh?refreshMessage(report):(usageChartModel(report).partial?t('Loaded {from} to {to}; some devices not collected yet', { from: report.from, to: report.to }):t('Loaded {from} to {to}', { from: report.from, to: report.to }));loaded=true;
    }catch(error){feedback.textContent=error.message;}finally{form.querySelectorAll('button').forEach(button=>button.disabled=false);}
  }
  form.addEventListener('submit',event=>{event.preventDefault();void load(false);});
  document.querySelector('#token-usage-refresh').addEventListener('click',()=>void load(true));
  return {refresh:options,show({resetScroll=false}={}){options();if(!loaded)void load(false);else if(resetScroll)showLatest();}};
}
