import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const SYSTEM_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const exec=promisify(execFile);
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const fields=['inputTokens','outputTokens','cacheCreationTokens','cacheReadTokens','totalTokens','costUSD'];
const number=value=>Number.isFinite(Number(value))&&Number(value)>=0?Number(value):0;
const validDate=value=>DATE.test(value||'')&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
const dateKey=(value,timezone)=>new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit',timeZone:timezone}).format(value);

/** The Worker only runs the ccusage installed with the app or found on PATH; it never downloads the program over the network on demand. */
export async function collectCcusageReport({base,since=null,until=null,timezone=SYSTEM_TIME_ZONE,execute=exec,exists=async file=>{try{await access(file);return true;}catch{return false;}},now=()=>new Date()}){
  if(since&&!validDate(since)||until&&!validDate(until))throw new Error('Invalid ccusage date');
  try{new Intl.DateTimeFormat('en',{timeZone:timezone});}catch{throw new Error('Invalid ccusage time zone');}
  const bundled=join(base,'node_modules','.bin','ccusage'),command=await exists(bundled)?bundled:(process.env.CCUSAGE_BIN||'ccusage');
  const args=['daily','--offline','--json','--timezone',timezone];
  if(since)args.push('--since',since.replaceAll('-',''));if(until)args.push('--until',until.replaceAll('-',''));
  try{
    const {stdout}=await execute(command,args,{timeout:120000,maxBuffer:20*1024*1024,env:{...process.env,NO_COLOR:'1'}});
    const today=dateKey(now(),timezone);
    return {available:true,throughDate:until&&until<today?until:today,report:JSON.parse(stdout)};
  }catch(error){
    if(error.code==='ENOENT')return {available:false,error:'ccusage is not installed on this device; upgrade or reconnect the Worker'};
    if(error instanceof SyntaxError)throw new Error('Unable to parse the JSON returned by ccusage');
    if(error.killed)throw new Error('ccusage timed out (120 seconds)');
    if(error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')throw new Error('ccusage output is too large and exceeds the collection limit');
    if(typeof error.code==='number')throw new Error(`ccusage failed (exit code ${error.code})`);
    throw new Error(`ccusage failed to start (${error.code||error.signal||'unknown reason'})`);
  }
}

function total(rows){
  return rows.reduce((sum,row)=>{for(const key of fields)sum[key]+=number(row[key]);return sum;},Object.fromEntries(fields.map(key=>[key,0])));
}

/** Old and new ccusage JSON fields are normalized here, so Home only stores stable daily records. */
export function normalizeCcusageDaily(report,nodeId,collectedAt=new Date().toISOString()){
  const result=new Map();
  for(const row of report?.daily||report?.data||[]){
    const date=row.period||row.date;if(!DATE.test(date||''))continue;
    const current=result.get(date)||{id:`${nodeId}:${date}`,nodeId,date,inputTokens:0,outputTokens:0,cacheCreationTokens:0,cacheReadTokens:0,totalTokens:0,costUSD:0,agents:[],models:[],collectedAt};
    for(const key of ['inputTokens','outputTokens','cacheCreationTokens','cacheReadTokens'])current[key]+=number(row[key]);
    current.totalTokens+=number(row.totalTokens)||number(row.inputTokens)+number(row.outputTokens)+number(row.cacheCreationTokens)+number(row.cacheReadTokens);
    current.costUSD+=number(row.totalCost??row.costUSD);
    current.agents=[...new Set([...current.agents,...(row.metadata?.agents||[]),...(row.agent&&row.agent!=='all'?[row.agent]:[])])].sort();
    current.models=[...new Set([...current.models,...(row.modelsUsed||row.models||[])])].sort();
    result.set(date,current);
  }
  return [...result.values()].sort((a,b)=>a.date.localeCompare(b.date));
}

function dates(from,to){
  if(!validDate(from)||!validDate(to)||from>to)throw new Error('Invalid statistics date range');
  const out=[],cursor=new Date(`${from}T00:00:00Z`),end=new Date(`${to}T00:00:00Z`);
  while(cursor<=end){if(out.length>=366)throw new Error('At most 366 days can be viewed at a time');out.push(cursor.toISOString().slice(0,10));cursor.setUTCDate(cursor.getUTCDate()+1);}
  return out;
}

/** After collection from an online device, the snapshot for that day is overwritten per device and date; after a disconnect and reconnect, collection resumes from the last scanned day (inclusive). */
export class TokenUsage{
  constructor(db,query,online,change=()=>{},clock=()=>new Date(),timezone=process.env.TOKEN_USAGE_TIMEZONE||SYSTEM_TIME_ZONE){Object.assign(this,{db,query,online,change,clock,timezone});this.running=new Map();}
  async collect(nodeId,{from=null,to=null}={}){
    if(this.running.has(nodeId))return this.running.get(nodeId);
    const job=this.#collect(nodeId,{from,to}).finally(()=>this.running.delete(nodeId));this.running.set(nodeId,job);return job;
  }
  async #collect(nodeId,{from,to}){
    const worker=this.db.get('workers',nodeId);if(!worker)throw new Error('Device not found');
    const state=this.db.get('tokenUsageStates',nodeId)||{id:nodeId,nodeId};
    const until=to||dateKey(this.clock(),this.timezone),since=from||state.lastCollectedDate||null,attemptedAt=this.clock().toISOString();
    if(!this.online(nodeId)){const next=this.db.put('tokenUsageStates',{...state,lastAttemptAt:attemptedAt,status:'offline',error:'Device is offline; usage will be backfilled automatically once it is back online'});this.change();return next;}
    try{
      const result=await this.query({nodeId},'token_usage',{since,until,timezone:this.timezone},120000);
      if(result?.available!==true)throw new Error(result?.error||'Device does not provide ccusage');
      const rows=normalizeCcusageDaily(result.report,nodeId,attemptedAt);
      const lastCollectedDate=[state.lastCollectedDate,result.throughDate||until].filter(Boolean).sort().at(-1);
      this.db.transaction(()=>{for(const row of rows)this.db.put('tokenUsageDaily',row);this.db.put('tokenUsageStates',{...state,lastAttemptAt:attemptedAt,lastCollectedDate,status:'ready',error:null,version:result.version||null});});
      this.change();return {status:'ready',rows:rows.length};
    }catch(error){const next=this.db.put('tokenUsageStates',{...state,lastAttemptAt:attemptedAt,status:'blocked',error:error.message});this.change();throw error;}
  }
  report({from,to,nodeIds}){
    const range=dates(from,to),wanted=[...new Set(nodeIds||[])];
    if(wanted.length!==2)throw new Error('Select two different devices');
    const rows=this.db.list('tokenUsageDaily');
    const devices=wanted.map(id=>{
      const worker=this.db.get('workers',id);if(!worker)throw new Error('Statistics device not found');
      const daily=range.map(date=>rows.find(row=>row.nodeId===id&&row.date===date)||{id:`${id}:${date}`,nodeId:id,date,inputTokens:0,outputTokens:0,cacheCreationTokens:0,cacheReadTokens:0,totalTokens:0,costUSD:0,agents:[],models:[]});
      return {id,name:worker.name,nodeKind:worker.nodeKind,online:this.online(id),state:this.db.get('tokenUsageStates',id)||null,total:total(daily),daily};
    });
    return {from,to,devices,total:total(devices.map(device=>device.total)),generatedAt:this.clock().toISOString()};
  }
}

/** If collection fails right after a Worker connects, it is retried only once; scheduled collection remains Home's own responsibility. */
export function createTokenUsageBackgroundCollector({collect,online,getState,schedule=setTimeout,cancel=clearTimeout,delay=30000}){
  const pending=new Map();
  async function run(nodeId,retry=false){
    try{
      await collect(nodeId);
      if(pending.has(nodeId)){cancel(pending.get(nodeId));pending.delete(nodeId);}
    }catch{
      if(retry||!online(nodeId)||pending.has(nodeId))return;
      const timer=schedule(()=>{
        pending.delete(nodeId);
        if(online(nodeId)&&getState(nodeId)?.status==='blocked')return run(nodeId,true);
      },delay);
      timer?.unref?.();pending.set(nodeId,timer);
    }
  }
  return {run,stop(){for(const timer of pending.values())cancel(timer);pending.clear();}};
}
