const TYPES=[
  {key:'inputTokens',label:'Input',color:'#0866ff'},
  {key:'outputTokens',label:'Output',color:'#00a8e8'},
  {key:'cacheCreationTokens',label:'Cache write',color:'#6645ed'},
  {key:'cacheReadTokens',label:'Cache read',color:'#29c9c0'}
];

export function usageChartModel(report){
  const devices=(report.devices||[]).map(device=>{
    const total=Number(device.total?.totalTokens||0);
    const unavailable=device.state?.status!=='ready'&&!device.daily?.some(row=>row.collectedAt);
    return {...device,unavailable,segments:TYPES.map(type=>({...type,value:Number(device.total?.[type.key]||0),percent:total?Math.round(Number(device.total?.[type.key]||0)/total*1000)/10:0}))};
  });
  const days=(devices[0]?.daily||[]).map((row,index)=>({date:row.date,values:devices.map(device=>Number(device.daily[index]?.totalTokens||0))}));
  return {devices,partial:devices.some(device=>device.unavailable),days,dailyMax:Math.max(1,...days.flatMap(day=>day.values)),totalTokens:Number(report.total?.totalTokens||0),total:report.total||{}};
}

export function refreshMessage(report){
  const failed=(report.devices||[]).filter(device=>device.state?.status!=='ready'&&device.state?.error);
  return failed.length?`Collection incomplete: ${failed.map(device=>`${device.name}: ${device.state.error}`).join('; ')}`:'Collection complete; offline devices keep their history and will backfill when back online.';
}

/** The platform token page reads aggregated data only; charts load no third-party scripts. */
export function tokenUsageUI({api,getData,create}){
  const form=document.querySelector('#token-usage-form'),feedback=document.querySelector('#token-usage-feedback');
  let loaded=false;
  const format=value=>Number(value||0).toLocaleString('en-US');
  const compact=value=>new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:1}).format(Number(value||0));
  const date=value=>{const d=new Date();d.setDate(d.getDate()+value);return new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit'}).format(d);};
  form.elements.from.value ||= date(-29);form.elements.to.value ||= date(0);
  function options(){
    const workers=getData().workers||[],selects=[form.elements.nodeA,form.elements.nodeB],old=selects.map(s=>s.value);
    for(let i=0;i<selects.length;i++){
      selects[i].replaceChildren(...workers.map(worker=>{const option=create('option','',`${worker.name}${worker.online?' · Online':' · Offline'}`);option.value=worker.id;return option;}));
      selects[i].value=workers.some(w=>w.id===old[i])?old[i]:(workers[i]?.id||workers[0]?.id||'');
    }
  }
  function render(report){
    const model=usageChartModel(report),summary=document.querySelector('#token-usage-total');
    summary.replaceChildren(create('span','usage-total-label',model.partial?'Total usage of collected devices (partial)':'Total usage of selected devices'),create('strong','',format(model.totalTokens)),create('span','usage-total-unit','tokens'),create('small','',`Input ${format(model.total.inputTokens)} · Output ${format(model.total.outputTokens)} · Cache ${format(Number(model.total.cacheCreationTokens||0)+Number(model.total.cacheReadTokens||0))}`));
    const pies=document.querySelector('#token-usage-pies');pies.replaceChildren();
    for(const device of model.devices){
      let cursor=0;const stops=device.segments.map(segment=>{const start=cursor;cursor+=segment.percent;return `${segment.color} ${start}% ${cursor}%`;});
      const card=create('article','usage-device-card'),pie=create('div','usage-pie');pie.style.background=device.total.totalTokens?`conic-gradient(${stops.join(',')})`:'#e7edf1';pie.setAttribute('role','img');pie.setAttribute('aria-label',device.unavailable?`${device.name} not collected yet`:`${device.name} token breakdown`);
      const center=create('span','usage-pie-center',device.unavailable?'—':compact(device.total.totalTokens));center.title=device.unavailable?'Not collected yet':`${format(device.total.totalTokens)} tokens`;pie.append(center);
      const info=create('div','usage-device-info');info.append(create('strong','',device.name),create('p','workspace-note',`${device.online?'Online':'Offline'} · ${device.state?.status==='ready'?`Collected through ${device.state.lastCollectedDate}`:device.state?.error||'Not collected yet'}`));
      const legend=create('div','usage-legend');if(!device.unavailable)for(const segment of device.segments){const item=create('span','');item.style.setProperty('--legend-color',segment.color);item.textContent=`${segment.label} ${format(segment.value)} (${segment.percent}%)`;legend.append(item);}info.append(legend);card.append(pie,info);pies.append(card);
    }
    const key=document.querySelector('#token-usage-device-key');key.replaceChildren(...model.devices.map(device=>create('span','',device.name)));
    const chart=document.querySelector('#token-usage-daily');chart.replaceChildren();
    for(const day of model.days){const group=create('div','usage-day'),bars=create('div','usage-bars');for(let i=0;i<day.values.length;i++){const bar=create('span',`usage-bar usage-bar-${i+1}`);const height=day.values[i]?Math.max(2,Math.round(day.values[i]/model.dailyMax*160)):0;bar.style.height=`${height}px`;bar.title=`${model.devices[i].name} · ${day.date} · ${format(day.values[i])} tokens`;bars.append(bar);}group.append(bars,create('time','',day.date.slice(5)));chart.append(group);}
  }
  async function load(refresh){
    const values=Object.fromEntries(new FormData(form)),nodeIds=[values.nodeA,values.nodeB].filter(Boolean);
    if(new Set(nodeIds).size!==nodeIds.length){feedback.hidden=false;feedback.textContent='Please select two different devices';return;}
    feedback.hidden=false;feedback.textContent=refresh?'Backfilling from online devices…':'Loading history…';form.querySelectorAll('button').forEach(button=>button.disabled=true);
    try{
      const report=refresh?await api('/api/token-usage/refresh',{method:'POST',json:{from:values.from,to:values.to,nodeIds}}):await api(`/api/token-usage?from=${encodeURIComponent(values.from)}&to=${encodeURIComponent(values.to)}&nodeIds=${encodeURIComponent(nodeIds.join(','))}`);
      render(report);feedback.textContent=refresh?refreshMessage(report):(usageChartModel(report).partial?`Loaded ${report.from} to ${report.to}; some devices not collected yet`:`Loaded ${report.from} to ${report.to}`);loaded=true;
    }catch(error){feedback.textContent=error.message;}finally{form.querySelectorAll('button').forEach(button=>button.disabled=false);}
  }
  form.addEventListener('submit',event=>{event.preventDefault();void load(false);});
  document.querySelector('#token-usage-refresh').addEventListener('click',()=>void load(true));
  return {refresh:options,show(){options();if(!loaded)void load(false);}};
}
