import { tr, getLanguage } from './i18n.mjs';

const shortTime=at=>{const d=new Date(at),now=new Date(),zh=getLanguage()==='zh';
  const time=d.toLocaleTimeString(zh?'zh-CN':'en-US',{hour:'2-digit',minute:'2-digit',hour12:false});
  return d.toDateString()===now.toDateString()?time:`${d.toLocaleDateString(zh?'zh-CN':'en-US',{month:'numeric',day:'numeric'})} ${time}`;};

/**
 * Why a role's CLI cannot take work right now for a reason a person has to fix or wait out: not installed or connected,
 * signed out, its model gone from the device, or a quota window used up (until it resets). A Worker that has not reported
 * yet or is offline is not this; such work keeps queueing for the device as before.
 */
export function cliUnavailable(worker,type,model,now=Date.now()) {
  if(!worker?.capabilities?.runtimeDiscovery||!Array.isArray(worker.runtimes))return null;
  const runtime=worker.runtimes.find(r=>r.type===type&&r.supported);
  if(!runtime)return tr('runtimeProbe.deviceHasNoAvailableConnected');
  if(!runtime.available)return runtime.reason||tr('runtimeProbe.deviceHasNoAvailableConnected');
  if(model&&Array.isArray(runtime.models)&&runtime.models.length&&!runtime.models.some(m=>m.id===model))return tr('runtimeProbe.modelNotInDeviceS');
  // A used-up window stays used up until its reset, even when the sample is old; a changed account clears it.
  if(!runtime.quotaInvalidated)for(const key of ['fiveHour','weekly']){const w=runtime.quota?.[key],reset=Date.parse(w?.resetsAt);
    if(w&&Number.isFinite(w.remainingPercent)&&w.remainingPercent<=0&&Number.isFinite(reset)&&reset>now)return tr('cliAvailability.quotaUsedUp',{window:tr(key==='fiveHour'?'cliAvailability.fiveHour':'cliAvailability.weekly'),time:shortTime(reset)});}
  return null;
}

const QUOTA=/usage limit|rate.?limit|quota|exceeded your|insufficient_quota|credit balance|too many requests|\b429\b|usageLimitExceeded|limit reached/i;
const AUTH=/not logged in|log ?in again|please (run )?\/?login|authenticat|unauthori[sz]ed|\b401\b|invalid api key|oauth token|token (has )?expired|credentials/i;
/** A CLI failure in plain words first (quota used up, signed out), then what the CLI itself said. */
export function cliFailureText(error) {
  const raw=String(error||'').trim();if(!raw)return raw;
  const plain=QUOTA.test(raw)?tr('cliAvailability.failedQuota'):AUTH.test(raw)?tr('cliAvailability.failedAuth'):'';
  return plain?tr('cliAvailability.failedWith',{plain,raw:raw.slice(0,300)}):raw;
}
