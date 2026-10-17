import {createHash} from 'node:crypto';
import {conversationIdOf} from './group-conversations.mjs';
import {collaborationRoot} from './coordination-wait.mjs';
import {reviewView} from './collaboration-sessions.mjs';
import {tr} from './i18n.mjs';

/**
 * Result receipts record that a called role's result reached Home, separately from any business task. A receipt is
 * owned by the calling role: it is registered when a report is saved or the call settles ("received"), carried once
 * into that role's next accepted turn ("delivered"), and becomes an acceptance decision only when the owner records
 * it ("verified"). Registration never creates a task, run or room message and never calls a model.
 */
export const RECEIPT_STAGES=['implemented','reviewed','tested','merged','deployed'];
const KIND='resultReceipts';
const runEnded=new Set(['succeeded','failed','interrupted']);
const now=()=>new Date().toISOString();
const short=(text,limit)=>{const value=String(text||'').replace(/\s+/g,' ').trim();return value.length>limit?`${value.slice(0,limit-1)}…`:value;};
const receiptId=(requestId,runId,revision)=>`rr:${createHash('sha256').update(JSON.stringify([requestId,runId||null,revision||0])).digest('hex').slice(0,32)}`;

/** The owner is the role that issued the call; self-continuations and requests without a caller have no receipt. */
function ownerOf(db,request) {
  const parent=request?.parentRequestId?db.get('coordinationRequests',request.parentRequestId):null;
  if(!parent?.targetRoleId||parent.projectId!==request.projectId||parent.targetRoleId===request.targetRoleId)return null;
  return parent.targetRoleId;
}

/** Idempotent per call, Run and report revision: replays and Home restarts refresh status facts but keep delivery and verification. */
export function registerResultReceipt(db,{run,request=null,report=null}) {
  return db.transaction(()=>register(db,{run,request,report}));
}
function register(db,{run,request,report}) {
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
    runStatus:run.status,requestStatus:request.status,state:'received',receivedAt:time,updatedAt:time,
    pendingRunId:null,deliveredRunId:null,deliveredAt:null,verification:null,verifications:[]});
}

/** Independent-review guards and owner scoping apply to every read: other roles never see a receipt. */
function visibleTo(db,receipt,roleId) {
  if(receipt.ownerRoleId!==roleId)return false;
  const view=reviewView(db,{projectId:receipt.projectId,roleId});
  return view===db||!view.get('runs',receipt.runId)?.reviewRedacted&&!view.get('coordinationRequests',receipt.requestId)?.reviewRedacted;
}

/** A claim held by a Run that ended without accepting its input is released, so a failed launch cannot consume receipts. */
function deliverable(db,receipt) {
  if(receipt.deliveredRunId||receipt.supersededBy)return false;
  if(!receipt.pendingRunId)return true;
  const holder=db.get('runs',receipt.pendingRunId);
  return !holder||runEnded.has(holder.status);
}

export function ownedReceipts(db,{projectId,roleId,conversationId}) {
  return db.listProject(KIND,projectId).filter(r=>(conversationId===undefined||r.conversationId===conversationId)&&visibleTo(db,r,roleId));
}

const digest=r=>({id:r.id,role:r.sourceRoleName||r.sourceRoleId,requestId:r.requestId,runId:r.runId,item:r.item,verdict:r.verdict||'unverified',
  reportRevision:r.reportRevision,version:r.version,stage:r.stage,runStatus:r.runStatus,summary:r.summary,readCommand:`wb result read ${r.requestId}`});

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

const publicReceipt=r=>({...digest(r),state:r.state,receivedAt:r.receivedAt,deliveredRunId:r.deliveredRunId,
  supersededBy:r.supersededBy||null,verification:r.verification,verifications:r.verifications||[]});

/** Only the owning role decides; a newer report revision must be verified on its own receipt, and every decision is kept. */
export function verifyResultReceipt(db,run,input={}) {
  return db.transaction(()=>{
    const id=input.receiptId;
    if(typeof id!=='string'||!/^rr:[0-9a-f]{32}$/.test(id))throw new Error(tr('resultReceipts.invalidReceipt'));
    const r=db.get(KIND,id);
    if(!r||r.projectId!==run.projectId||!visibleTo(db,r,run.roleId))throw new Error(tr('resultReceipts.notFound'));
    if(r.supersededBy)throw new Error(tr('resultReceipts.superseded',{id:r.supersededBy}));
    if(!['accepted','rejected'].includes(input.decision))throw new Error(tr('resultReceipts.invalidDecision'));
    const note=typeof input.note==='string'?input.note.trim():'';
    if(note.length>1000||input.decision==='rejected'&&!note)throw new Error(tr('resultReceipts.noteRequired'));
    const last=r.verifications?.at(-1);
    if(last&&last.decision===input.decision&&last.note===note&&last.runId===run.id)return {...publicReceipt(r),replayed:true};
    const entry={decision:input.decision,note,runId:run.id,at:now()};
    const next=db.put(KIND,{...r,state:'verified',verification:entry,verifications:[...(r.verifications||[]),entry],
      deliveredRunId:r.deliveredRunId||run.id,deliveredAt:r.deliveredAt||entry.at,updatedAt:entry.at});
    return {...publicReceipt(next),replayed:false};
  });
}

/** Progress per original item, derived only from receipts and owner decisions; a pass for an older SHA is kept but stale. */
export function progressItems(db,{projectId,roleId}) {
  const groups=new Map();
  for(const r of ownedReceipts(db,{projectId,roleId}).filter(r=>!r.supersededBy))groups.set(r.item,[...(groups.get(r.item)||[]),r]);
  return [...groups].map(([item,receipts])=>{
    const latest=receipts.at(-1),version=receipts.findLast(r=>r.version)?.version||null;
    const stages=Object.fromEntries(RECEIPT_STAGES.map(stage=>{
      const r=receipts.findLast(x=>x.stage===stage);
      if(!r)return [stage,null];
      const decision=r.verification?.decision||null;
      const status=!decision?'awaiting_verification':decision==='rejected'?'rejected'
        :r.verdict!=='passed'?`verified_${r.verdict||'unverified'}`:r.version&&version&&r.version!==version?'stale':'verified_passed';
      return [stage,{status,version:r.version,verdict:r.verdict||'unverified',receiptId:r.id}];
    }));
    const blocked=['failed','blocked','needs_input'].includes(latest.verdict)||!latest.verdict&&['failed','interrupted'].includes(latest.runStatus);
    return {item,assignee:latest.sourceRoleName||latest.sourceRoleId,version,stages,
      unstaged:receipts.filter(r=>!r.stage).map(r=>({receiptId:r.id,verdict:r.verdict||'unverified',decision:r.verification?.decision||null})),
      blocker:blocked?{receiptId:latest.id,verdict:latest.verdict||'unverified',runStatus:latest.runStatus,summary:latest.summary}:null,
      next:latest.next||null,awaitingVerification:receipts.filter(r=>!r.verification).map(r=>r.id),
      evidence:receipts.map(r=>({receiptId:r.id,state:r.state,readCommand:`wb result read ${r.requestId}`}))};
  });
}

export function receiptList(db,{projectId,roleId}) {
  return {items:progressItems(db,{projectId,roleId}),receipts:ownedReceipts(db,{projectId,roleId}).map(publicReceipt)};
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
