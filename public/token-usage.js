import { t, dateLocale } from './i18n.js';
const TYPES=[
  {key:'inputTokens',label:'Input',color:'#0866ff'},
  {key:'outputTokens',label:'Output',color:'#00a8e8'},
  {key:'cacheCreationTokens',label:'Cache write',color:'#6645ed'},
  {key:'cacheReadTokens',label:'Cache read',color:'#29c9c0'}
];
const MODEL_COLORS=['#0866ff','#00a8e8','#6645ed','#29a39a','#ed8b23','#d95082','#57872e','#8359aa','#b96a32','#c44242'];
// Agents are told apart by model name; ccusage records which agents ran on a day but not their amounts.
const AGENTS=[
  {name:'Claude',color:'#d97757',match:/claude|opus|sonnet|haiku|fable/},
  {name:'Codex',color:'#10a37f',match:/^(gpt|o\d|codex)|codex/},
  {name:'Agy',color:'#6645ed',match:/gemini/},
  {name:'Grok',color:'#b07f00',match:/grok/}
];
const OTHER_COLOR='#94a3b8',UNCLASSIFIED_COLOR='#cbd5e1',DEVICE_COLORS=['#475569','#a8b3c4','#7c8798','#d0d6df'],TOP_MODELS=5;
const tokens=value=>Number.isFinite(Number(value))&&Number(value)>0?Number(value):0;
const sum=items=>items.reduce((total,item)=>total+item.value,0);

/** The agent behind a model name; usage without a model breakdown stays unclassified. */
export function agentOf(modelName){
  if(modelName==='Unclassified')return 'Unclassified';
  const name=String(modelName||'').toLowerCase().split('/').at(-1);
  return AGENTS.find(agent=>agent.match.test(name))?.name||'Other';
}

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
  const models=[...totals].sort(([a],[b])=>a==='Unclassified'?1:b==='Unclassified'?-1:a.localeCompare(b)).map(([modelName,totalTokens],index)=>({modelName,totalTokens,color:modelName==='Unclassified'?UNCLASSIFIED_COLOR:MODEL_COLORS[index]||`hsl(${index*137.508%360} 65% 45%)`}));
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

/**
 * Shares for the two donuts: devices on the inner ring and agents summed across devices on the outer ring; the five largest
 * models keep their daily-chart colours and the rest fold into Other.
 */
export function usageShares(model){
  const devices=model.devices.map((device,index)=>({name:device.name,value:tokens(device.total?.totalTokens),color:DEVICE_COLORS[index%DEVICE_COLORS.length]}));
  const byAgent=new Map();for(const item of model.models){const name=agentOf(item.modelName);byAgent.set(name,(byAgent.get(name)||0)+item.totalTokens);}
  const agents=[...AGENTS.map(({name,color})=>({name,color})).filter(agent=>byAgent.get(agent.name)).map(agent=>({...agent,value:byAgent.get(agent.name)})).sort((a,b)=>b.value-a.value),
    ...[{name:'Other',color:OTHER_COLOR},{name:'Unclassified',color:UNCLASSIFIED_COLOR}].filter(agent=>byAgent.get(agent.name)).map(agent=>({...agent,value:byAgent.get(agent.name)}))];
  const named=model.models.filter(item=>item.modelName!=='Unclassified').map(item=>({name:item.modelName,value:item.totalTokens,color:item.color})).sort((a,b)=>b.value-a.value||a.name.localeCompare(b.name));
  const rest=named.slice(TOP_MODELS),unclassified=model.models.find(item=>item.modelName==='Unclassified');
  const models=[...named.slice(0,TOP_MODELS),...(rest.length?[{name:'Other',count:rest.length,value:sum(rest),color:OTHER_COLOR}]:[]),...(unclassified?[{name:'Unclassified',value:unclassified.totalTokens,color:UNCLASSIFIED_COLOR}]:[])];
  return {devices,agents,models,modelCount:named.length};
}

export function refreshMessage(report){
  const failed=(report.devices||[]).filter(device=>device.state?.status!=='ready'&&device.state?.error);
  return failed.length?t('Collection incomplete: {v}', { v: failed.map(device=>t('{name}: {error}', { name: device.name, error: device.state.error })).join(t('; ')) }):'Collection complete; offline devices keep their history and will backfill when back online.';
}

const SVG='http://www.w3.org/2000/svg';
const svg=(tag,attrs={})=>{const node=document.createElementNS(SVG,tag);for(const[key,value]of Object.entries(attrs))node.setAttribute(key,value);return node;};
// One annulus segment in a 200x200 box, clockwise from 12 o'clock.
const arc=(inner,outer,from,to)=>{const at=(r,a)=>`${(100+r*Math.sin(a)).toFixed(2)} ${(100-r*Math.cos(a)).toFixed(2)}`,large=to-from>Math.PI?1:0;
  return `M${at(outer,from)}A${outer} ${outer} 0 ${large} 1 ${at(outer,to)}L${at(inner,to)}A${inner} ${inner} 0 ${large} 0 ${at(inner,from)}Z`;};

/** The platform token page reads aggregated data only; charts load no third-party scripts. Every registered device is read. */
export function tokenUsageUI({api,getData,create}){
  const form=document.querySelector('#token-usage-form'),feedback=document.querySelector('#token-usage-feedback');
  let loaded=false,loadedFor='',report=null,statusDrawn='';
  // 等可见布局完成后定位最新日期；用户随后仍可自由向左查看历史。
  const showLatest=()=>requestAnimationFrame(()=>{const chart=document.querySelector('#token-usage-daily');chart.scrollLeft=chart.scrollWidth;});
  const format=value=>Number(value||0).toLocaleString(dateLocale());
  const compact=value=>new Intl.NumberFormat(dateLocale(),{notation:'compact',maximumFractionDigits:1}).format(Number(value||0));
  const percent=(value,total)=>`${total?(value/total*100).toFixed(1):'0.0'}%`;
  const date=value=>{const d=new Date();d.setDate(d.getDate()+value);return new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit'}).format(d);};
  form.elements.from.value ||= date(-29);form.elements.to.value ||= date(0);
  const workers=()=>{const all=getData().workers||[],usage=all.filter(worker=>worker.capabilities?.tokenUsage===1);return usage.length?usage:all;};
  const nodeIds=()=>workers().map(worker=>worker.id);
  // Online state follows the live device list; collection progress from the last report sits in the tooltip.
  function deviceStatus(){
    const host=document.querySelector('#token-usage-total .usage-total-devices');if(!host)return;
    const states=new Map((report?.devices||[]).map(device=>[device.id,device]));
    // State refreshes arrive often; redraw only when a device, its online state or its collection state changed.
    const drawn=JSON.stringify(workers().map(worker=>[worker.id,worker.name,worker.online,states.get(worker.id)?.state]));
    if(drawn===statusDrawn&&host.childElementCount)return;statusDrawn=drawn;
    host.replaceChildren(...workers().map(worker=>{
      const device=states.get(worker.id),item=create('span',`usage-device-status ${worker.online?'is-online':'is-offline'}`);
      item.append(create('i',''),create('span','',`${worker.name} ${worker.online?t('Online'):t('Offline')}`));
      item.title=device?.state?.status==='ready'?t('Collected through {lastCollectedDate}',{lastCollectedDate:device.state.lastCollectedDate}):device?.state?.error||t('Not collected yet');
      return item;
    }));
  }
  function donut(rings,center,sub,label){
    const chart=svg('svg',{viewBox:'0 0 200 200',class:'usage-donut',role:'img','aria-label':label});
    for(const{items,inner,outer}of rings){
      const total=sum(items),drawn=items.filter(item=>item.value>0);
      if(!total){chart.append(svg('circle',{cx:100,cy:100,r:(inner+outer)/2,class:'usage-donut-empty','stroke-width':outer-inner}));continue;}
      let from=0;
      for(const item of drawn){
        const to=from+item.value/total*Math.PI*2;
        // A ring with one segment is two halves without the white gap, since an arc cannot start and end at one point.
        const path=svg('path',drawn.length===1?{d:arc(inner,outer,0,Math.PI)+arc(inner,outer,Math.PI,Math.PI*2),fill:item.color}:{d:arc(inner,outer,from,to),fill:item.color,class:'usage-donut-gap'});
        const title=svg('title');title.textContent=`${item.label} · ${format(item.value)} tokens (${percent(item.value,total)})`;path.append(title);chart.append(path);from=to;
      }
    }
    const main=svg('text',{x:100,y:sub?98:106,class:'usage-donut-value'});main.textContent=center;
    const small=svg('text',{x:100,y:119,class:'usage-donut-unit'});small.textContent=sub;chart.append(main,small);
    return chart;
  }
  function legend(groups){
    const list=create('div','usage-chart-legend');
    for(const group of groups){
      if(group.title)list.append(create('span','usage-chart-legend-title',group.title));
      const total=sum(group.items);
      for(const item of group.items){const row=create('span','usage-chart-legend-row'),swatch=create('i','');swatch.style.background=item.color;const name=create('span','usage-chart-legend-name',item.label);name.translate=false;row.append(swatch,name,create('em','',`${compact(item.value)} · ${percent(item.value,total)}`));row.title=`${format(item.value)} tokens`;list.append(row);}
    }
    return list;
  }
  function chartCard(title,chart,list){const card=create('article','usage-chart-card'),body=create('div','usage-chart-body');body.append(chart,list);card.append(create('h4','',title),body);return card;}
  function render(data){
    report=data;
    const model=usageChartModel(data),shares=usageShares(model),summary=document.querySelector('#token-usage-total');
    const value=create('div','usage-total-value');value.append(create('strong','',format(model.totalTokens)),create('span','usage-total-unit','tokens'));
    summary.replaceChildren(create('span','usage-total-label',model.partial?'Total usage of collected devices (partial)':'Total usage of all devices'),create('small','',t('Input {v} · Output {v2} · Cache {v3}', { v: format(model.total.inputTokens), v2: format(model.total.outputTokens), v3: format(Number(model.total.cacheCreationTokens||0)+Number(model.total.cacheReadTokens||0)) })),value,create('div','usage-total-devices'));
    deviceStatus();
    const named=item=>({...item,label:item.name==='Other'&&item.count?t('Other ({n} models)',{n:item.count}):item.name==='Other'||item.name==='Unclassified'?t(item.name):item.name});
    const devices=shares.devices.map(named),agents=shares.agents.map(named),models=shares.models.map(named);
    document.querySelector('#token-usage-pies').replaceChildren(
      chartCard(t('Devices and agents'),donut([{items:devices,inner:56,outer:68},{items:agents,inner:76,outer:96}],compact(model.totalTokens),'tokens',t('Devices and agents')),legend([{title:t('Devices (inner ring)'),items:devices},{title:t('Agents (outer ring)'),items:agents}])),
      chartCard(t('Tokens by model'),donut([{items:models,inner:64,outer:96}],String(shares.modelCount),t('models in range'),t('Tokens by model')),legend([{items:models}])));
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
  let pending=0;
  async function load(refresh){
    const values=Object.fromEntries(new FormData(form)),ids=nodeIds(),ticket=++pending;
    if(!ids.length){feedback.hidden=false;feedback.textContent='No device to read';return;}
    feedback.hidden=false;feedback.textContent=refresh?'Backfilling from online devices…':'Loading history…';form.querySelectorAll('button').forEach(button=>button.disabled=true);
    try{
      const data=refresh?await api('/api/token-usage/refresh',{method:'POST',json:{from:values.from,to:values.to,nodeIds:ids}}):await api(`/api/token-usage?from=${encodeURIComponent(values.from)}&to=${encodeURIComponent(values.to)}&nodeIds=${encodeURIComponent(ids.join(','))}`);
      // A later query (a changed date while this one ran) wins.
      if(ticket!==pending)return;
      render(data);loadedFor=ids.join(',');feedback.textContent=refresh?refreshMessage(data):(usageChartModel(data).partial?t('Loaded {from} to {to}; some devices not collected yet', { from: data.from, to: data.to }):t('Loaded {from} to {to}', { from: data.from, to: data.to }));loaded=true;
    }catch(error){if(ticket===pending)feedback.textContent=error.message;}finally{if(ticket===pending)form.querySelectorAll('button').forEach(button=>button.disabled=false);}
  }
  // Dates query on change; Enter in a date field does the same instead of reloading the page.
  form.addEventListener('submit',event=>{event.preventDefault();void load(false);});
  form.addEventListener('change',event=>{if(event.target.matches('input[type=date]')&&form.checkValidity())void load(false);});
  document.querySelector('#token-usage-refresh').addEventListener('click',()=>void load(true));
  // A device added or removed reloads the shown range; a device going on or offline only repaints its status.
  const devicesChanged=()=>{if(loaded&&nodeIds().join(',')!==loadedFor)void load(false);else deviceStatus();};
  return {refresh:devicesChanged,show({resetScroll=false}={}){if(!loaded)void load(false);else{devicesChanged();if(resetScroll)showLatest();}}};
}
