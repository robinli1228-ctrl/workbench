const WINDOWS=['fiveHour','weekly'];
const PARTS=[...WINDOWS,'credits'];
// Claude reports only when a whole percent changes, so a quiet hour is normal; a sample older than this is shown as not latest.
const MAX_SAMPLE_AGE_MS=3*3600000;
const isAged=(part,now)=>!(now-Date.parse(part?.checkedAt)<=MAX_SAMPLE_AGE_MS);
// Each part carries its own age verdict (an event may omit a part, e.g. Codex credits or Claude's weekly window, so one old
// part must not grey the fresh ones); the runtime as a whole is stale only when every part it still has is old.
const allAged=quota=>{const parts=PARTS.filter(key=>quota?.[key]);return parts.length>0&&parts.every(key=>quota[key].stale===true);};

/** Keep the existing optional credit display when the account event supplies it; absence is not a zero balance. */
function creditSample(value,now) {
  if(!value||typeof value!=='object')return null;
  const balance=(typeof value.balance==='number'||typeof value.balance==='string'&&value.balance.trim())?Number(value.balance):null;
  if(!Number.isFinite(balance)&&typeof value.hasCredits!=='boolean'&&typeof value.unlimited!=='boolean')return null;
  return {balance:Number.isFinite(balance)?balance:null,hasCredits:value.hasCredits===true,unlimited:value.unlimited===true,checkedAt:new Date(now).toISOString()};
}

/** Quota comes from normal responses, never token counts; missing or ambiguous windows remain unknown. */
function windowSample(usedPercent,resetsAt,now) {
  if(typeof usedPercent!=='number'||!Number.isFinite(usedPercent)||usedPercent<0||!Number.isSafeInteger(resetsAt)||resetsAt<1e9||resetsAt>1e11)return null;
  usedPercent=Number(usedPercent.toFixed(6));
  return {usedPercent,remainingPercent:Math.max(0,Number((100-usedPercent).toFixed(6))),resetsAt:new Date(resetsAt*1000).toISOString(),checkedAt:new Date(now).toISOString()};
}

/** Accept only account quota events; never mix other Codex buckets into its default subscription. */
export function normalizeRuntimeQuota(runtime,raw,now=Date.now()) {
  const quota={};
  if(runtime==='claude'&&raw?.type==='rate_limit_event'&&!raw.parent_tool_use_id) {
    const windows=raw.rate_limit_info?.unifiedWindows;
    for(const [source,target] of [['five_hour','fiveHour'],['seven_day','weekly']]) {
      const w=windows?.[source],sample=w&&windowSample(typeof w.utilization==='number'?w.utilization*100:null,w.resetsAt,now);
      if(sample)quota[target]=sample;
    }
  } else if(runtime==='codex'&&raw?.method==='account/rateLimits/updated') {
    const p=raw.params,limits=p?.rateLimitsByLimitId? p.rateLimitsByLimitId.codex : p?.rateLimits;
    if(!limits||limits.limitId&&limits.limitId!=='codex')return null;
    for(const w of [limits.primary,limits.secondary]) {
      const key=w?.windowDurationMins===300?'fiveHour':w?.windowDurationMins===10080?'weekly':null;
      const sample=key&&windowSample(w.usedPercent,w.resetsAt,now);
      if(sample)quota[key]=sample;
    }
    const credits=creditSample(limits.credits,now);if(credits)quota.credits=credits;
  }
  if(!PARTS.some(key=>quota[key]))return null;
  return {quota,quotaCheckedAt:new Date(now).toISOString(),quotaSource:'session',quotaStatus:'ok',quotaStale:false};
}

/** Merge racing probes and session samples per window; unknown identities cannot borrow an old account's quota. */
export function mergeRuntimeQuota(previous,report,now=Date.now()) {
  if(!['claude','codex'].includes(report?.type))return report;
  // A check that could not read the account (timeout, exited CLI) keeps the last account's samples, marked unconfirmed;
  // only a definite sign-out or another account drops them, so one failed check no longer loses the quota for good.
  if(report.authUnknown&&!report.quotaIdentity&&previous?.type===report.type&&previous.quotaIdentity)report={...report,quotaIdentity:previous.quotaIdentity,quotaUnconfirmed:true};
  const same=previous?.type===report.type&&report.quotaIdentity&&previous.quotaIdentity===report.quotaIdentity;
  const quota={};let latest=0;
  for(const key of WINDOWS) {
    for(const source of [same?previous:null,report]) {
      const w=source?.quotaSource==='session'?source.quota?.[key]:null,time=Date.parse(w?.checkedAt);
      const reset=Date.parse(w?.resetsAt);
      // A window past its own reset is unknown until a new sample arrives.
      if(!report.quotaIdentity||!w||!Number.isFinite(time)||time>now+60000||!Number.isFinite(reset)||reset<=now||typeof w.usedPercent!=='number'||!Number.isFinite(w.usedPercent)||w.usedPercent<0||typeof w.remainingPercent!=='number'||!Number.isFinite(w.remainingPercent))continue;
      if(quota[key]&&Date.parse(quota[key].checkedAt)>=time)continue;
      quota[key]={usedPercent:w.usedPercent,remainingPercent:Math.max(0,100-w.usedPercent),resetsAt:new Date(reset).toISOString(),checkedAt:new Date(time).toISOString()};
    }
    if(quota[key])latest=Math.max(latest,Date.parse(quota[key].checkedAt));
  }
  for(const source of [same?previous:null,report]) {
    const c=source?.quotaSource==='session'?source.quota?.credits:null,time=Date.parse(c?.checkedAt);
    if(report.type!=='codex'||!report.quotaIdentity||!Number.isFinite(time)||time>now+60000||quota.credits&&Date.parse(quota.credits.checkedAt)>=time)continue;
    const value=creditSample(c,time);if(value)quota.credits=value;
  }
  if(quota.credits)latest=Math.max(latest,Date.parse(quota.credits.checkedAt));
  for(const key of PARTS)if(quota[key])quota[key].stale=isAged(quota[key],now);
  if(quota.fiveHour||quota.weekly)quota.remainingPercent=quota.fiveHour?.remainingPercent??quota.weekly.remainingPercent;
  const incoming=report.quotaSource==='session'&&PARTS.some(key=>report.quota?.[key]&&Date.parse(report.quota[key].checkedAt)>=latest);
  const invalidated=report.authReady===false&&!report.authUnknown||Boolean(same&&previous.quotaInvalidated&&!incoming)||report.quotaInvalidated===true;
  // A sample counts until its window resets or it grows older than MAX_SAMPLE_AGE_MS, whichever comes first.
  const stale=!latest||invalidated||report.quotaUnconfirmed===true||allAged(quota);
  return {...report,quota:latest?quota:null,quotaSource:'session',quotaCheckedAt:latest?new Date(latest).toISOString():null,quotaStatus:latest?'ok':'unavailable',quotaStale:stale,quotaInvalidated:invalidated};
}

/** Only an adapter bound at startup to this device's current account can update quota, never auth state. */
export function applyRuntimeQuota(reports,type,sample,identity,now=Date.now()) {
  return reports.map(r=>{
    // While a check could not read the account, the kept identity is only borrowed: no sample may refresh it.
    if(r.type!==type||!identity||r.quotaIdentity!==identity||r.authReady===false||r.authUnknown||r.quotaUnconfirmed)return r;
    if(sample?.invalidated)return {...r,quotaIdentity:null,quotaInvalidated:true,quotaStale:true};
    return mergeRuntimeQuota(r,{...r,...sample,quotaInvalidated:false},now);
  });
}

/** Reuse Home's heartbeat timer: a window past its own reset becomes unknown, the others keep their samples and times. */
export function expireRuntimeQuota(runtime,now=Date.now()) {
  if(runtime?.quotaSource!=='session')return runtime;
  const quota=runtime.quota&&typeof runtime.quota==='object'?runtime.quota:{};
  const expired=WINDOWS.filter(key=>quota[key]&&!(Date.parse(quota[key].resetsAt)>now));
  const unusable=Boolean(runtime.quotaInvalidated||runtime.authReady===false&&!runtime.authUnknown);
  const next={};for(const key of PARTS)if(quota[key]&&!expired.includes(key))next[key]={...quota[key],stale:isAged(quota[key],now)};
  if(next.fiveHour||next.weekly)next.remainingPercent=next.fiveHour?.remainingPercent??next.weekly.remainingPercent;
  const left=PARTS.some(key=>next[key]);
  const result={...runtime,quota:left?next:null,quotaStatus:left?'ok':'unavailable',quotaStale:Boolean(runtime.quotaStale||unusable||!left||allAged(next))};
  // Unchanged keeps the same object, so the heartbeat does not refresh pages for nothing.
  return JSON.stringify([result.quota,result.quotaStatus,result.quotaStale])===JSON.stringify([runtime.quota,runtime.quotaStatus,Boolean(runtime.quotaStale)])?runtime:result;
}

/** Every report Home receives (registration and runtime_report) merges the same way: a fresh probe after a Worker restart
 * keeps the saved samples of the same account, and windows past their reset are dropped at once. */
export function mergeReportedRuntimes(previous,incoming,now=Date.now()) {
  return (Array.isArray(incoming)?incoming:[]).map(rt=>{
    const old=(Array.isArray(previous)?previous:[]).find(p=>p?.type===rt?.type);
    if(rt?.quotaSource==='session')return expireRuntimeQuota(mergeRuntimeQuota(old,rt,now),now);
    const hasQuota=rt?.quota&&typeof rt.quota==='object'&&(rt.quota.fiveHour||rt.quota.weekly||rt.quota.groups||rt.quota.credits||rt.quota.remainingPercent!=null);
    // A signed-out CLI drops its saved quota, as before; otherwise a report without quota keeps the old one, greyed.
    if(hasQuota||rt?.authReady===false)return rt;
    if(old?.quota&&(old.quota.fiveHour||old.quota.weekly||old.quota.groups||old.quota.credits))return {...rt,quota:old.quota,quotaStatus:old.quotaStatus||'ok',quotaStale:true};
    return rt;
  });
}

/** A session binds to the device's current account; while the last check could not read it, a new session binds to none. */
export function sessionQuotaIdentity(runtime){return runtime&&!runtime.authUnknown&&!runtime.quotaUnconfirmed?runtime.quotaIdentity||null:null;}
/** A session started while the account could not be read binds none; its samples count once a check knows the account again. */
export function sampleQuotaIdentity(bound,runtime){return bound||sessionQuotaIdentity(runtime);}

/** The values a page shows; a resend that changes only sample times compares equal. */
export function quotaSignature(runtime) {
  const q=runtime?.quota||{},w=key=>q[key]?[q[key].usedPercent,q[key].resetsAt,q[key].stale===true]:null;
  return JSON.stringify([runtime?.quotaIdentity||null,runtime?.quotaStale||false,runtime?.quotaInvalidated||false,w('fiveHour'),w('weekly'),q.credits?[q.credits.balance,q.credits.hasCredits,q.credits.unlimited]:null]);
}
