const WINDOWS=['fiveHour','weekly'];
const PARTS=[...WINDOWS,'credits'];

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
  const same=previous?.type===report.type&&report.quotaIdentity&&previous.quotaIdentity===report.quotaIdentity;
  const quota={};let latest=0;
  for(const key of WINDOWS) {
    for(const source of [same?previous:null,report]) {
      const w=source?.quotaSource==='session'?source.quota?.[key]:null,time=Date.parse(w?.checkedAt);
      const reset=Date.parse(w?.resetsAt);
      if(!report.quotaIdentity||!w||!Number.isFinite(time)||time>now+60000||!Number.isFinite(reset)||typeof w.usedPercent!=='number'||!Number.isFinite(w.usedPercent)||w.usedPercent<0||typeof w.remainingPercent!=='number'||!Number.isFinite(w.remainingPercent))continue;
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
  if(quota.fiveHour||quota.weekly)quota.remainingPercent=quota.fiveHour?.remainingPercent??quota.weekly.remainingPercent;
  const incoming=report.quotaSource==='session'&&PARTS.some(key=>report.quota?.[key]&&Date.parse(report.quota[key].checkedAt)>=latest);
  const invalidated=report.authReady===false||Boolean(same&&previous.quotaInvalidated&&!incoming)||report.quotaInvalidated===true;
  const stale=!latest||invalidated||PARTS.some(key=>{const w=quota[key];return w&&(now-Date.parse(w.checkedAt)>600000||key!=='credits'&&Date.parse(w.resetsAt)<=now);});
  return {...report,quota:latest?quota:null,quotaSource:'session',quotaCheckedAt:latest?new Date(latest).toISOString():null,quotaStatus:latest?'ok':'unavailable',quotaStale:stale,quotaInvalidated:invalidated};
}

/** Only an adapter bound at startup to this device's current account can update quota, never auth state. */
export function applyRuntimeQuota(reports,type,sample,identity,now=Date.now()) {
  return reports.map(r=>{
    if(r.type!==type||!identity||r.quotaIdentity!==identity||r.authReady===false)return r;
    if(sample?.invalidated)return {...r,quotaIdentity:null,quotaInvalidated:true,quotaStale:true};
    return mergeRuntimeQuota(r,{...r,...sample,quotaInvalidated:false},now);
  });
}

/** Reuse Home's heartbeat timer to mark old snapshots, without changing sample timestamps or the browser UI. */
export function expireRuntimeQuota(runtime,now=Date.now()) {
  if(runtime?.quotaSource!=='session'||runtime.quotaStale)return runtime;
  const windows=PARTS.map(key=>runtime.quota?.[key]&&{...runtime.quota[key],kind:key}).filter(Boolean);
  return !windows.length||runtime.quotaInvalidated||runtime.authReady===false||windows.some(w=>!Number.isFinite(Date.parse(w.checkedAt))||now-Date.parse(w.checkedAt)>600000||w.kind!=='credits'&&(!Number.isFinite(Date.parse(w.resetsAt))||Date.parse(w.resetsAt)<=now))
    ? {...runtime,quotaStale:true}:runtime;
}
