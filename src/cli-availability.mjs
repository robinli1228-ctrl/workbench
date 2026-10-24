import { tr, getLanguage } from './i18n.mjs';

const shortTime=at=>{const d=new Date(at),now=new Date(),zh=getLanguage()==='zh';
  const time=d.toLocaleTimeString(zh?'zh-CN':'en-US',{hour:'2-digit',minute:'2-digit',hour12:false});
  return d.toDateString()===now.toDateString()?time:`${d.toLocaleDateString(zh?'zh-CN':'en-US',{month:'numeric',day:'numeric'})} ${time}`;};

/**
 * Why a role's CLI definitely cannot take work right now: the CLI is not on the device, the device's probe got a real
 * "not signed in" answer, its model is missing from a non-empty catalog, or a Codex quota window is used up with no
 * credits left (until it resets). Anything uncertain — a probe that timed out or failed, a Claude window at 100% (its
 * extra usage may still allow work), an old or silent Worker — returns null, so the work queues as before.
 */
export function cliUnavailable(worker,type,model,now=Date.now()) {
  if(!worker?.capabilities?.runtimeDiscovery||!Array.isArray(worker.runtimes)||!worker.runtimes.length)return null;
  const runtime=worker.runtimes.find(r=>r.type===type&&r.supported);
  if(!runtime)return tr('runtimeProbe.deviceHasNoAvailableConnected');
  if(runtime.authState==='signed_out'&&!runtime.available)return runtime.reason||tr('cliAvailability.failedAuth');
  if(runtime.available&&model&&Array.isArray(runtime.models)&&runtime.models.length&&!runtime.models.some(m=>m.id===model))return tr('runtimeProbe.modelNotInDeviceS');
  const spent=quotaSpent(runtime,now);
  return spent?tr('cliAvailability.quotaUsedUp',{window:tr(spent.key==='fiveHour'?'cliAvailability.fiveHour':'cliAvailability.weekly'),time:shortTime(spent.reset)}):null;
}
/** A confirmed account's used-up window stays used up until reset; borrowed quota during an unknown login cannot reject work. */
export function quotaSpent(runtime,now=Date.now()) {
  const credits=runtime?.quota?.credits;
  if(runtime?.type!=='codex'||runtime.authUnknown||runtime.quotaUnconfirmed||runtime.quotaInvalidated||!credits||credits.hasCredits||credits.unlimited)return null;
  for(const key of ['fiveHour','weekly']){const w=runtime.quota?.[key],reset=Date.parse(w?.resetsAt);
    if(w&&Number.isFinite(w.remainingPercent)&&w.remainingPercent<=0&&Number.isFinite(reset)&&reset>now)return {key,reset};}
  return null;
}

// Only the CLIs' own quota and sign-in wording; a git "Authentication failed" or a context-length error is left as it is.
const QUOTA=/usage limit|rate.?limit(ed| reached| exceeded)|exceeded your (current )?quota|insufficient_quota|credit balance is too low|too many requests|usageLimitExceeded|hit your (usage )?limit/i;
const AUTH=/not logged in|please (run )?\/login|log ?in again|invalid api key|oauth token (has )?expired|authentication_error|session (has )?expired.*log ?in/i;
/** A CLI failure in plain words first (quota used up, signed out), then what the CLI itself said. */
export function cliFailureText(error) {
  const raw=String(error||'').trim();if(!raw)return raw;
  const plain=QUOTA.test(raw)?tr('cliAvailability.failedQuota'):AUTH.test(raw)?tr('cliAvailability.failedAuth'):'';
  return plain?tr('cliAvailability.failedWith',{plain,raw:raw.slice(0,300)}):raw;
}
