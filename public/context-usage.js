import {t,dateLocale} from './i18n.js';
import {bindQuotaDetails} from './role-icons.js';

const valid=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;

/** Never borrow counters from an archived session, another device, or the role's old model. */
export function contextForRole(role,data) {
  const session=(data.roleSessions||[]).find(s=>s.roleId===role.id&&s.projectId===role.projectId&&s.conversationId===role.projectId&&s.nodeId===role.nodeId&&s.runtime===role.runtime&&s.status!=='archived'&&!s.candidateFor&&!s.historyClearedAt);
  const runs=session?(data.runs||[]).filter(r=>r.roleId===role.id&&r.projectId===role.projectId&&r.nodeId===role.nodeId&&r.roleSessionId===session.id&&!r.historyClearedAt&&!r.switchOperationId&&r.roleSnapshot?.runtime===role.runtime&&r.contextUsage&&(!r.contextUsage.sessionId||r.contextUsage.sessionId===session.nativeSessionId)):[];
  runs.sort((a,b)=>Date.parse(b.contextUsage.observedAt||b.createdAt)-Date.parse(a.contextUsage.observedAt||a.createdAt)||Date.parse(b.createdAt)-Date.parse(a.createdAt));
  const latest=runs[0],sample=(latest?.model||latest?.roleSnapshot?.model)===role.model?latest.contextUsage:{},used=valid(sample.usedTokens)?sample.usedTokens:null;
  // A turn still running on a fresh process has not reported its window yet: an earlier turn of this session on the same model has.
  const limitOf=s=>valid(s?.limitTokens)&&s.limitTokens>0?s.limitTokens:null;
  const limit=limitOf(sample)??(sample.model?limitOf(runs.find(r=>r.contextUsage.model===sample.model&&limitOf(r.contextUsage))?.contextUsage):null);
  // A compaction finished after the last request is the newer size of this context.
  const c=session?.compaction,newer=c?.finishedAt&&(!sample.observedAt||Date.parse(c.finishedAt)>Date.parse(sample.observedAt));
  const after=c?.status==='compacted'&&valid(c.usedTokensAfter)&&newer&&sample.observedAt?c.usedTokensAfter:null;
  // A finished compaction older than the latest measurement is history; the ring shows what that measurement says.
  const compaction=c&&(['pending','requested'].includes(c.status)||newer)?c:null;
  const current=after!==null?{...sample,usedTokens:after,state:'compacted',observedAt:c.finishedAt}:{...sample,usedTokens:used};
  return {...current,limitTokens:limit,percent:current.usedTokens!==null&&limit!==null?current.usedTokens/limit*100:null,compaction};
}

const BLOCKED={run:'another turn of this role is running',queued:'messages are queued for it',discussion:'a discussion is waiting for it',
  not_retained:'its process is no longer kept',offline:'its device is offline',unsupported:'its Worker needs an update',cleared:'its history was cleared'};
const blockedText=reason=>reason?.startsWith('call:')?t('an open call ({id})',{id:reason.slice(5,13)}):t(BLOCKED[reason]||'it can no longer be compacted');

/** After a finished task, a context over half the window is compacted; the line says where that stands, or why it did not happen. */
export function compactionLine(compaction,time,number=String){
  if(!compaction)return '';
  const {status,blockedBy,finishedAt,usedTokens,usedTokensAfter,error}=compaction;
  if(status==='pending')return blockedBy?t('Auto-compaction waiting: {reason}',{reason:blockedText(blockedBy)}):t('Auto-compaction will run once the role stays idle.');
  if(status==='requested')return t('Auto-compaction running.');
  if(status==='compacted')return Number.isFinite(usedTokensAfter)?t('Auto-compacted at {time}: {before} → {after} tokens',{time:time(finishedAt),before:number(usedTokens),after:number(usedTokensAfter)}):t('Auto-compacted at {time}',{time:time(finishedAt)});
  if(status==='skipped')return t('Auto-compaction failed: {error}',{error:error||'-'});
  if(status==='expired')return t('Auto-compaction dropped: {reason}',{reason:blockedText(blockedBy)});
  return '';
}

/** A hollow ring represents context used; the solid neighbouring badges remain account quota left. */
export function roleContextRing(role,data) {
  const sample=contextForRole(role,data),known=sample.percent!==null,pct=known?Math.round(sample.percent):null;
  const mark=document.createElement('button');mark.type='button';mark.className=`role-context-ring ${known?(pct>=90?'is-high':pct>=70?'is-mid':'is-normal'):'is-unknown'}`;
  mark.style.setProperty('--context-percent',`${known?Math.min(100,sample.percent):0}%`);
  mark.setAttribute('aria-haspopup','dialog');
  const details=()=>{
    const number=n=>new Intl.NumberFormat(dateLocale()).format(n);
    const remaining=known?t('Context used: {pct}%',{pct}):t('Context usage unknown');
    const values=sample.usedTokens===null?t(sample.state==='compacted'?'Compacted; awaiting the next context measurement.':'No current-session measurement. Updates after a supported CLI reports usage.'):
      sample.limitTokens===null?t('Last input: {used} tokens; context limit unavailable.',{used:number(sample.usedTokens)}):t('Last input: {used} / {limit} tokens',{used:number(sample.usedTokens),limit:number(sample.limitTokens)});
    const time=sample.observedAt&&Number.isFinite(Date.parse(sample.observedAt))?t('Measured at: {time}',{time:new Date(sample.observedAt).toLocaleString(dateLocale())}):'';
    const at=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString(dateLocale()):'-';
    return {remaining,reset:[values,time,compactionLine(sample.compaction,at,number),t('Latest native request snapshot, not cumulative usage or remaining account quota.')].filter(Boolean).join('\n')};
  };
  mark.setAttribute('aria-label',details().remaining);bindQuotaDetails(mark,details,'Context usage');return mark;
}
