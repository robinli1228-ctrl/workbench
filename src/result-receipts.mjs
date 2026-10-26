import {createHash} from 'node:crypto';
import {conversationIdOf} from './group-conversations.mjs';
import {collaborationRoot,currentContinuation,waitDependencies} from './coordination-wait.mjs';
import {reviewView} from './collaboration-sessions.mjs';
import {tr} from './i18n.mjs';

/**
 * Result receipts record that a called role's result reached Home, separately from any business task. A receipt is
 * owned by the calling role: it is registered when a report is saved or the call settles ("received"), carried once
 * into that role's next accepted turn ("delivered"), and becomes an acceptance decision only when the owner records
 * it ("verified"). Registration never creates a task, run or room message and never calls a model.
 */
export const RECEIPT_STAGES=['implemented','reviewed','tested','merged','deployed'];
export const BLOCKED_NOTICE_MS=10*60000;
const KIND='resultReceipts',OUTCOMES=new Set(['not_executed','cancelled','blocked','resume_failed']),DECISIONS=new Set(['accepted','rejected','acknowledged']);
const runEnded=new Set(['succeeded','failed','interrupted']);
const WAKE_KIND='outcomeWakes',WAKE_ATTEMPTS=5,WAKE_OUTCOMES=new Set(['not_executed','blocked','resume_failed']),ACTIVE_REQUEST=new Set(['queued','waiting_delivery','running','waiting_call']);
const now=()=>new Date().toISOString();
const short=(text,limit)=>{const value=String(text||'').replace(/\s+/g,' ').trim();return value.length>limit?`${value.slice(0,limit-1)}…`:value;};
const receiptId=(requestId,runId,revision)=>`rr:${createHash('sha256').update(JSON.stringify([requestId,runId||null,revision||0])).digest('hex').slice(0,32)}`;

/** The owner is the role that issued the call; self-continuations and requests without a caller have no receipt.
 *  A transfer returns no result, but a transfer that never ran (not executed, blocked) is still told to the role that handed it over. */
function ownerOf(db,request,{outcome=false}={}) {
  const parent=request?.parentRequestId?db.get('coordinationRequests',request.parentRequestId):outcome&&request?.transferredFrom?db.get('coordinationRequests',request.transferredFrom):null;
  if(!parent?.targetRoleId||parent.projectId!==request.projectId||parent.targetRoleId===request.targetRoleId)return null;
  return parent.targetRoleId;
}

/** Idempotent per call, Run and report revision: replays and Home restarts refresh status facts but keep delivery and verification. */
export function registerResultReceipt(db,{run,request=null,report=null,refreshOnly=false}) {
  return db.transaction(()=>register(db,{run,request,report,refreshOnly}));
}
function register(db,{run,request,report,refreshOnly}) {
  if(!run?.id)return null;
  request=request||(run.requestId?db.get('coordinationRequests',run.requestId):null);
  if(!request||request.projectId!==run.projectId)return null;
  const ownerRoleId=ownerOf(db,request);
  if(!ownerRoleId)return null;
  report=report||db.get('runReports',run.id);
  const revision=report?.revision||0,id=receiptId(request.id,run.id,revision),previous=db.get(KIND,id);
  if(previous) {
    const refreshed={...previous,runStatus:run.status,requestStatus:request.status};
    return JSON.stringify(refreshed)===JSON.stringify(previous)?previous:db.put(KIND,{...refreshed,updatedAt:now()});
  }
  if(refreshOnly)return null;
  for(const older of db.listProject(KIND,run.projectId).filter(r=>r.runId===run.id&&r.requestId===request.id&&r.reportRevision<revision&&!r.supersededBy))
    db.put(KIND,{...older,supersededBy:id,updatedAt:now()});
  const time=now();
  return db.put(KIND,{id,projectId:run.projectId,conversationId:conversationIdOf(request),ownerRoleId,
    requestId:request.id,rootRequestId:request.rootRequestId||request.id,item:report?.item||collaborationRoot(db,request)?.id||request.id,
    taskId:run.taskId||request.taskId||null,runId:run.id,sourceRoleId:run.roleId||request.targetRoleId,
    sourceRoleName:(run.roleSnapshot||request.targetSnapshot)?.name||null,reportRevision:revision,
    // Only a saved report carries a verdict; a settled process without one stays unverified.
    verdict:report?.verdict||null,version:report?.version||null,stage:report?.stage||null,
    summary:short(report?.summary||request.error||request.result||'',300),next:short(report?.next||'',300),evidenceCount:report?.evidence?.length||0,
    files:(report?.files||[]).map(f=>({path:f.path,bytes:f.bytes,sha256:f.sha256})),runStatus:run.status,requestStatus:request.status,state:'received',receivedAt:time,updatedAt:time,
    pendingRunId:null,deliveredRunId:null,deliveredAt:null,verification:null,verifications:[]});
}

/**
 * A call that never produced a result still reaches its caller once: admission failure (not_executed), cancellation
 * while the caller's own chain stays active (cancelled), or a block that needs a person (blocked, one per episode).
 * It is registered only at that transition, so a replay refreshes nothing and history is never backfilled.
 */
export function registerCallOutcome(db,request,{outcome,reason='',episode=''}) {
  return db.transaction(()=>{
    if(!request?.id||!OUTCOMES.has(outcome))return null;
    const ownerRoleId=ownerOf(db,request,{outcome:true});
    if(!ownerRoleId)return null;
    const id=receiptId(request.id,null,`${outcome}:${episode}`),previous=db.get(KIND,id);
    if(previous)return previous;
    const time=now();
    // Every outcome except a cancellation wakes the role that sent the work (see wakeCallOutcomes); a small queue, so the
    // scheduler never scans receipts and history is not backfilled.
    if(WAKE_OUTCOMES.has(outcome))db.put(WAKE_KIND,{id,projectId:request.projectId,receiptId:id,createdAt:time});
    return db.put(KIND,{id,projectId:request.projectId,conversationId:conversationIdOf(request),ownerRoleId,requestId:request.id,
      rootRequestId:request.rootRequestId||request.id,item:collaborationRoot(db,request)?.id||request.id,taskId:request.taskId||null,runId:null,
      sourceRoleId:request.targetRoleId,sourceRoleName:request.targetSnapshot?.name||db.get('roles',request.targetRoleId)?.name||null,
      reportRevision:0,verdict:null,outcome,version:null,stage:null,summary:short(reason,300),next:'',evidenceCount:0,files:[],
      runStatus:null,requestStatus:request.status,state:'received',receivedAt:time,updatedAt:time,
      pendingRunId:null,deliveredRunId:null,deliveredAt:null,verification:null,verifications:[]});
  });
}

/** Independent-review guards and owner scoping apply to every read: other roles never see a receipt. */
function visibleTo(db,receipt,roleId) {
  if(receipt.ownerRoleId!==roleId)return false;
  const view=reviewView(db,{projectId:receipt.projectId,roleId});
  return view===db||!(receipt.runId&&view.get('runs',receipt.runId)?.reviewRedacted)&&!view.get('coordinationRequests',receipt.requestId)?.reviewRedacted;
}

/** A claim held by a Run that ended without accepting its input is released, so a failed launch cannot consume receipts. */
function deliverable(db,receipt) {
  if(receipt.deliveredRunId||receipt.supersededBy||receipt.archived)return false;
  if(!receipt.pendingRunId)return true;
  const holder=db.get('runs',receipt.pendingRunId);
  return !holder||runEnded.has(holder.status);
}

export function ownedReceipts(db,{projectId,roleId,conversationId}) {
  return db.listProject(KIND,projectId).filter(r=>(conversationId===undefined||r.conversationId===conversationId)&&visibleTo(db,r,roleId));
}

const digest=r=>({id:r.id,role:r.sourceRoleName||r.sourceRoleId,requestId:r.requestId,runId:r.runId,item:r.item,verdict:r.verdict||r.outcome||'unverified',
  outcome:r.outcome||null,reportRevision:r.reportRevision,version:r.version,stage:r.stage,runStatus:r.runStatus,summary:r.summary,
  files:(r.files||[]).length,readCommand:`wb history read ${r.requestId}`});

/** At a safe launch point, attach the owner's undelivered receipts (summaries and references only) to this Run's input. */
export function claimResultReceipts(db,run,{limit=20}={}) {
  if(!run?.roleId||run.switchOperationId||run.turnPurpose&&run.turnPurpose!=='task')return null;
  const available=ownedReceipts(db,{projectId:run.projectId,roleId:run.roleId,conversationId:conversationIdOf(run)}).filter(r=>deliverable(db,r));
  if(!available.length)return null;
  const selected=available.slice(-limit);
  for(const r of selected)db.put(KIND,{...r,pendingRunId:run.id,updatedAt:now()});
  return {ids:selected.map(r=>r.id),omitted:available.length-selected.length,items:selected.map(digest)};
}

/** Delivered means the owner's CLI accepted the input that carried it; an ended Run without acceptance releases its claim. */
export function settleResultReceipts(db,run,{accepted,ended}) {
  for(const id of run?.resultReceipts?.ids||[]) {
    const r=db.get(KIND,id);
    if(!r||r.pendingRunId!==run.id||r.deliveredRunId)continue;
    if(accepted)db.put(KIND,{...r,state:'delivered',deliveredRunId:run.id,deliveredAt:now(),updatedAt:now()});
    else if(ended)db.put(KIND,{...r,pendingRunId:null,updatedAt:now()});
  }
}

const publicReceipt=r=>({...digest(r),fileList:r.files||[],state:r.state,receivedAt:r.receivedAt,deliveredRunId:r.deliveredRunId,
  supersededBy:r.supersededBy||null,verification:r.verification,verifications:r.verifications||[]});

/**
 * Only the owning role decides; a newer report revision must be verified on its own receipt, and every decision is kept.
 * "acknowledged" records that the owner has seen a receipt and is never an acceptance. A list applies one decision to
 * each receipt separately and returns a result per receipt.
 */
export function verifyResultReceipt(db,run,input={}) {
  if(input.receiptIds===undefined)return verifyOne(db,run,input);
  if(!Array.isArray(input.receiptIds)||!input.receiptIds.length||input.receiptIds.length>50||new Set(input.receiptIds).size!==input.receiptIds.length)
    throw new Error(tr('resultReceipts.invalidReceipt'));
  return {results:input.receiptIds.map(receiptId=>{try{return verifyOne(db,run,{...input,receiptId,receiptIds:undefined});}catch(error){return {id:receiptId,error:error.message};}})};
}
function verifyOne(db,run,input) {
  return db.transaction(()=>{
    const id=input.receiptId;
    if(typeof id!=='string'||!/^rr:[0-9a-f]{32}$/.test(id))throw new Error(tr('resultReceipts.invalidReceipt'));
    const r=db.get(KIND,id);
    if(!r||r.projectId!==run.projectId||!visibleTo(db,r,run.roleId))throw new Error(tr('resultReceipts.notFound'));
    if(r.supersededBy)throw new Error(tr('resultReceipts.superseded',{id:r.supersededBy}));
    if(!DECISIONS.has(input.decision))throw new Error(tr('resultReceipts.invalidDecision'));
    const note=typeof input.note==='string'?input.note.trim():'';
    if(note.length>1000||input.decision==='rejected'&&!note)throw new Error(tr('resultReceipts.noteRequired'));
    const last=r.verifications?.at(-1);
    if(last&&last.decision===input.decision&&last.note===note&&last.runId===run.id)return {...publicReceipt(r),replayed:true};
    const entry={decision:input.decision,note,runId:run.id,at:now()};
    const next=db.put(KIND,{...r,state:input.decision==='acknowledged'?'acknowledged':'verified',verification:entry,verifications:[...(r.verifications||[]),entry],
      deliveredRunId:r.deliveredRunId||run.id,deliveredAt:r.deliveredAt||entry.at,updatedAt:entry.at});
    return {...publicReceipt(next),replayed:false};
  });
}

/** Progress per original item, derived only from receipts and owner decisions; a pass for an older SHA is kept but stale. */
export function progressItems(db,{projectId,roleId}) {
  const groups=new Map();
  for(const r of ownedReceipts(db,{projectId,roleId}).filter(r=>!r.supersededBy&&!r.archived))groups.set(r.item,[...(groups.get(r.item)||[]),r]);
  return [...groups].map(([item,receipts])=>{
    const latest=receipts.at(-1),version=receipts.findLast(r=>r.version)?.version||null;
    const stages=Object.fromEntries(RECEIPT_STAGES.map(stage=>{
      const r=receipts.findLast(x=>x.stage===stage);
      if(!r)return [stage,null];
      const decision=r.verification?.decision||null;
      const status=!decision?'awaiting_verification':decision==='rejected'?'rejected':decision==='acknowledged'?'acknowledged'
        :r.verdict!=='passed'?`verified_${r.verdict||'unverified'}`:r.version&&version&&r.version!==version?'stale':'verified_passed';
      return [stage,{status,version:r.version,verdict:r.verdict||'unverified',receiptId:r.id}];
    }));
    const blocked=['failed','blocked','needs_input'].includes(latest.verdict)||!latest.verdict&&(Boolean(latest.outcome)||['failed','interrupted'].includes(latest.runStatus));
    return {item,assignee:latest.sourceRoleName||latest.sourceRoleId,version,stages,
      unstaged:receipts.filter(r=>!r.stage).map(r=>({receiptId:r.id,verdict:r.verdict||r.outcome||'unverified',decision:r.verification?.decision||null})),
      // An acknowledged blocker stays listed with that decision: noting a result never turns it into a pass.
      blocker:blocked?{receiptId:latest.id,verdict:latest.verdict||latest.outcome||'unverified',runStatus:latest.runStatus,summary:latest.summary,decision:latest.verification?.decision||null}:null,
      next:latest.next||null,awaitingVerification:receipts.filter(r=>!r.verification).map(r=>r.id),
      evidence:receipts.map(r=>({receiptId:r.id,state:r.state,readCommand:`wb history read ${r.requestId}`}))};
  });
}

export function receiptList(db,{projectId,roleId}) {
  const owned=ownedReceipts(db,{projectId,roleId});
  return {items:progressItems(db,{projectId,roleId}),receipts:owned.filter(r=>!r.archived).map(publicReceipt),archived:owned.filter(r=>r.archived).length};
}

const HISTORY_GAP_MS=10*60000;
/**
 * Receipts created by replaying calls that had settled before receipts existed are history, not new results. A live
 * receipt is registered in the same transaction that settles its call or saves its report, so its time matches them;
 * a replayed one is much later. Archive those once at Home start: kept and listable as a count, never delivered.
 */
export function archiveHistoricalReceipts(db) {
  return db.transaction(()=>{
    let archived=0;
    for(const r of db.list(KIND)) {
      // Run-less outcome receipts only ever exist from a live transition; only replayed run receipts can be history.
      if(r.archived||r.verification||r.supersededBy||r.outcome)continue;
      const facts=[db.get('coordinationRequests',r.requestId)?.updatedAt,r.runId&&db.get('runReports',r.runId)?.updatedAt,r.runId&&db.get('runs',r.runId)?.finishedAt].map(v=>Date.parse(v||'')).filter(Number.isFinite);
      if(facts.length&&Date.parse(r.receivedAt)-Math.max(...facts)<=HISTORY_GAP_MS)continue;
      db.put(KIND,{...r,archived:true,archivedReason:'settled_before_receipts',state:'archived',pendingRunId:null,updatedAt:now()});archived++;
    }
    return archived;
  });
}

/** Patrol finding only while the owner is idle in that chat: a busy or waiting owner gets the receipts at its next safe turn. */
export function receiptFindings(db,projectId) {
  const groups=new Map();
  for(const r of db.listProject(KIND,projectId))if(deliverable(db,r)&&visibleTo(db,r,r.ownerRoleId))
    groups.set(`${r.ownerRoleId}\n${r.conversationId}`,[...(groups.get(`${r.ownerRoleId}\n${r.conversationId}`)||[]),r]);
  const findings=[];
  for(const [key,receipts] of groups) {
    const [roleId,conversationId]=key.split('\n'),inScope=record=>record.projectId===projectId&&conversationIdOf(record)===conversationId;
    const busy=db.activeRuns().some(run=>run.roleId===roleId&&inScope(run))
      ||db.schedulableRequests().some(request=>request.targetRoleId===roleId&&inScope(request))
      ||db.chatTasks(['ready','in_progress']).some(task=>task.roleId===roleId&&inScope(task));
    if(busy)continue;
    const name=db.get('roles',roleId)?.name||roleId;
    findings.push({key:`receipts:${roleId}:${conversationId}:${receipts.at(-1).id}`,text:tr('timerMonitor.resultReceipts',{role:name,count:receipts.length})});
  }
  return findings;
}

/**
 * A call that could not run tells the role that sent it at once, as a platform reminder, instead of waiting for that
 * role's next turn. The caller's chain is followed to its latest turn: a wait there that still lists the request wakes
 * it with the outcome, and any other active turn may yet wait, so it is checked again later. A failed post is retried a
 * few times; a disabled or archived caller, or a request hidden from it by review isolation, gets no reminder.
 * post(receipt,text) creates the reminder and returns its message.
 */
export function wakeCallOutcomes(db,post) {
  let changed=false;
  for(const pending of db.list(WAKE_KIND)) {
    const receipt=db.get(KIND,pending.receiptId),request=receipt&&db.get('coordinationRequests',receipt.requestId);
    const settle=(fields={})=>{db.transaction(()=>{if(receipt)db.put(KIND,{...db.get(KIND,receipt.id),...fields,updatedAt:now()});db.remove(WAKE_KIND,pending.id);});changed=true;};
    if(!receipt||!request||!visibleTo(db,receipt,receipt.ownerRoleId)){settle();continue;}
    let current=null;
    if(request.parentRequestId)try{current=currentContinuation(db,request.parentRequestId);}catch{current=db.get('coordinationRequests',request.parentRequestId);}
    let awaited=false;
    if(current?.status==='waiting_call')try{awaited=waitDependencies(db,current).some(r=>r.id===request.id);}catch{awaited=false;}
    if(awaited){settle({wake:'wait'});continue;}
    if(current&&ACTIVE_REQUEST.has(current.status))continue;
    const owner=db.get('roles',receipt.ownerRoleId);
    if(!owner?.enabled||owner.archivedAt){settle({wakeError:'owner_unavailable'});continue;}
    const text=tr('resultReceipts.outcomeWake',{action:tr(request.transferredFrom?'resultReceipts.wakeTransfer':'resultReceipts.wakeCall'),
      role:receipt.sourceRoleName||receipt.sourceRoleId||'',requestId:receipt.requestId,outcome:tr(`resultReceipts.wake.${receipt.outcome}`),reason:receipt.summary||''});
    try{const message=post(receipt,text);settle({wakeMessageId:message?.id||null});}
    catch(error){
      const attempts=(pending.attempts||0)+1,reason=String(error?.message||error).slice(0,300);
      if(attempts>=WAKE_ATTEMPTS)settle({wakeError:reason});
      else{db.put(WAKE_KIND,{...pending,attempts,lastError:reason});changed=true;}
    }
  }
  return changed;
}
