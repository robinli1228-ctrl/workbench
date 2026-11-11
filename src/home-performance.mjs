import {performance} from 'node:perf_hooks';
import {setImmediate as immediate} from 'node:timers/promises';

const PHASES=new Set(['scheduler.pass','scheduler.recovery','scheduler.receipts','scheduler.jobs','scheduler.deliveries','scheduler.adopt','scheduler.waits','scheduler.requests','scheduler.wakes','scheduler.followup','scheduler.compaction','scheduler.context','scheduler.rooms','scheduler.dispatch','scheduler.organizers','source_sync.tick','source_sync.audit','source_sync.batches','source_sync.baselines','source_sync.conflict_cleanup','source_sync.watch','source_sync.conflicts','source_sync.schedule','source_sync.dispatch']);
const HTTP_GROUPS=new Set(['agent','data','devices','deliveries','events','files','history','native','platform','projects','roles','runs','sessions','settings','source-sync','state','tasks','workers']);
/** Keep only fixed route families: paths, identifiers, query strings and credentials never become diagnostics. */
export function httpOperation(pathname){
  pathname=pathname.split('?',1)[0];
  if(pathname==='/healthz')return 'http.health';
  if(pathname.startsWith('/media/'))return 'http.media';
  const raw=pathname.match(/^\/api\/([^/?]+)/)?.[1],group=['native-sessions','native-turns'].includes(raw)?'native':raw;
  return HTTP_GROUPS.has(group)?`http.api.${group}`:'http.other';
}
const OPERATIONS=new Set([...PHASES,'http.health','http.media','http.other',...[...HTTP_GROUPS].map(group=>`http.api.${group}`)]);
const allowed=name=>OPERATIONS.has(name);

/** Bounded, process-local observations. Repeat log lines are sampled per fixed operation, while recent rows remain visible. */
export class SlowOperations {
  constructor({thresholdMs=200,limit=100,log=line=>console.warn(line),now=Date.now}={}){
    Object.assign(this,{thresholdMs,limit,log,now});this.operations=[];this.lastLogs=new Map();this.startedAt=new Date(now()).toISOString();
  }
  /** Reject unknown labels and copy only the fixed diagnostic schema, even when callers supply extra fields. */
  record(operation,durationMs,details={}){
    if(!allowed(operation)||!Number.isFinite(durationMs)||durationMs<this.thresholdMs)return;
    const at=this.now(),row={at:new Date(at).toISOString(),operation,durationMs:Math.round(durationMs*10)/10};
    if(operation.startsWith('http.')){
      if(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(details.method))row.method=details.method;
      if(Number.isInteger(details.status)&&details.status>=100&&details.status<=599)row.status=details.status;
    }
    this.operations.push(row);if(this.operations.length>this.limit)this.operations.splice(0,this.operations.length-this.limit);
    if(!this.lastLogs.has(operation)||at-this.lastLogs.get(operation)>=30000){this.lastLogs.set(operation,at);this.log(`Slow operation: ${JSON.stringify(row)}`);}
  }
  /** Measure elapsed wall time on both success and failure, without retaining result/error contents. */
  async measureAsync(operation,fn){const start=performance.now();try{return await fn();}finally{this.record(operation,performance.now()-start);}}
  /** Return newest observations first without giving API callers ownership of the retained rows. */
  snapshot(){return {startedAt:this.startedAt,thresholdMs:this.thresholdMs,limit:this.limit,operations:this.operations.slice().reverse().map(row=>({...row}))};}
}

/** Return null for a cheap checkpoint, or a promise when the current slice has exhausted its budget. Cannot preempt one JS step. */
export function cooperativeSlice({budgetMs=200,now=()=>performance.now(),yieldNow=()=>immediate()}={}){
  let start=now();return ()=>{if(now()-start<budgetMs)return null;return Promise.resolve(yieldNow()).then(()=>{start=now();return true;});};
}

/** One pass at a time; any number of triggers during a pass request just one subsequent pass. */
export function coalescedScheduler({run,onError}){
  let running=false,queued=false,requested=false,closed=false;
  function request(){if(closed)return;requested=true;if(running||queued)return;queued=true;setImmediate(drain);}
  async function drain(){queued=false;if(closed||running)return;running=true;requested=false;
    try{await run();}catch(error){onError(error);}finally{running=false;if(requested&&!closed)request();}
  }
  return {request,close(){closed=true;requested=false;}};
}
