import {terminal} from './store.mjs';
import { tr } from './i18n.mjs';
import {createHash} from 'node:crypto';
import {reportFingerprint,reportSubmissionId} from './report-submission.mjs';
import {registerResultReceipt,RECEIPT_STAGES} from './result-receipts.mjs';

const verdicts=new Set(['passed','failed','blocked','needs_input']);
// Reject obvious probe placeholders without pretending to judge the truth of substantive evidence.
const placeholder=value=>/^(?:test|testing|todo|tbd|placeholder|\u6d4b\u8bd5|\u5f85\u8865\u5145)[.!\u3002\s]*$/iu.test(value.trim());
/** Discussions only handle information; they must not prematurely produce a business delivery or a prompt aimed at the user. Compatible with legacy plain Runs. */
export function acceptsBusinessReport(run) {
  return Boolean(run&&!run.switchOperationId&&!run.discussionWaiting&&!run.discussionDeliveryId&&(!run.turnPurpose||run.turnPurpose==='task'));
}
/** Classify only by the error reason of a failed run; body text is not error evidence, and unknown errors must not be let through as temporary faults. */
export function runFailureKind(run) {
  if(run?.status!=='failed')return null;
  const error=String(run.error||'');
  if(/insufficient[_ ]quota|quota exceeded|current quota|billing|credits? exhausted|\u989d\u5ea6(?:\u4e0d\u8db3|\u8017\u5c3d)|\u4f59\u989d\u4e0d\u8db3|insufficient (?:quota|balance)/i.test(error))return 'unknown';
  if(/unauthenticated|unauthorized|permission denied|access denied|operation not permitted|invalid (?:api[ _-]?key|token|credentials)|(?:authentication|login) (?:required|failed)|not logged in|(?:HTTP(?:\/\d(?:\.\d)?)?\s*[: ]\s*|code\s*[:= ]\s*)(?:401|403)\b|\u6743\u9650\u4e0d\u8db3|\u767b\u5f55\u5931\u6548|\u6388\u6743\u5931\u8d25/i.test(error))return 'authorization';
  if(/output token limit|maximum output tokens|response.{0,30}(?:truncated|cut off)|\u8f93\u51fa.{0,10}(?:\u8d85\u9650|\u622a\u65ad)/i.test(error))return 'incomplete_output';
  if(/(?:HTTP(?:\/\d(?:\.\d)?)?(?:\s+(?:status|error))?[\s:]+|(?:status|code)[\s":=]+)(?:429|502|503|504)\b|service (?:is )?(?:currently )?unavailable|temporarily unavailable|bad gateway|gateway time(?:out|d out)|too many requests|rate limit(?:ed| exceeded)?|\b(?:ETIMEDOUT|ECONNRESET|EAI_AGAIN)\b/i.test(error))return 'temporary_service';
  return 'unknown';
}

const active=run=>Boolean(run&&!terminal.has(run.status)&&!['stopping','reconciling'].includes(run.status));
const submissionKey=(runId,id)=>createHash('sha256').update(JSON.stringify([runId,id])).digest('hex');
function checkedId(id){if(typeof id!=='string'||! /^[\w-]{1,128}$/.test(id))throw new Error(tr('runReports.invalidSubmissionId'));return id;}
function savedResult(db,run,submissionId,fingerprint) {
  const receipt=db.get('reportSubmissions',submissionKey(run.id,submissionId)),current=db.get('runReports',run.id);
  if(receipt&&fingerprint&&receipt.fingerprint!==fingerprint)throw new Error(tr('runReports.submissionConflict'));
  const legacyId=current&&!current.submissionId?reportFingerprint(current):null;
  if(!receipt&&legacyId===submissionId&&fingerprint&&fingerprint!==legacyId)throw new Error(tr('runReports.submissionConflict'));
  // Reports written by older Workers remain confirmable without changing their historical revision.
  const result=receipt?.result|| (legacyId===submissionId
    ?{runId:run.id,verdict:current.verdict,revision:current.revision}:null);
  return result?{...result,protocol:1,state:'saved',saved:true,submissionId,currentRevision:current?.revision,
    superseded:Boolean(current&&current.revision!==result.revision),note:current&&current.revision!==result.revision
      ?tr('runReports.superseded',{revision:result.revision,currentRevision:current.revision}):tr('runReports.businessVerdictRecordedEndTurn')}:null;
}
/** Receipt reads remain available after a Run settles; they cannot write a verdict or revive execution. */
export function readReportSubmission(db,run,input) {
  if(!run)throw new Error(tr('runReports.reportCanOnlyBeSubmitted'));
  const submissionId=checkedId(input.submissionId),saved=savedResult(db,run,submissionId,input.fingerprint);
  if(saved)return saved;
  if(!acceptsBusinessReport(run))return {protocol:1,state:'ignored',runId:run.id,submissionId,ignored:true,note:tr('runReports.businessReportNotRecordedDiscussion')};
  return {protocol:1,state:'not_saved',saved:false,runId:run.id,submissionId,canSubmit:active(run)};
}

/** Report, frozen receipt and Run projection commit together; replay never increments revision or restores an older verdict. */
export function saveRunReport(db,run,input) {return db.transaction(()=>{
  run=run&&db.get('runs',run.id);
  if(!run)throw new Error(tr('runReports.reportCanOnlyBeSubmitted'));
  const submissionId=checkedId(reportSubmissionId(input)),fingerprint=reportFingerprint(input),saved=savedResult(db,run,submissionId,fingerprint);
  if(saved)return {...saved,replayed:true};
  if(!active(run))throw new Error(tr('runReports.reportCanOnlyBeSubmitted'));
  if(!acceptsBusinessReport(run))return {protocol:1,state:'ignored',runId:run.id,submissionId,ignored:true,note:tr('runReports.businessReportNotRecordedDiscussion')};
  if(!verdicts.has(input.verdict)) throw new Error(tr('runReports.verdictMustBePassedFailed'));
  if(typeof input.summary!=='string' || !input.summary.trim() || input.summary.length>3000) throw new Error(tr('runReports.reportSummaryMustBe1'));
  const evidence=input.evidence||[];
  if(!Array.isArray(evidence)||evidence.length>20||evidence.some(e=>typeof e!=='string'||!e.trim()||e.length>1500)) throw new Error(tr('runReports.verificationEvidenceAllowsAtMost'));
  if(input.verdict==='passed'&&!evidence.length) throw new Error(tr('runReports.passedVerdictMustIncludeActual'));
  if(placeholder(input.summary)||evidence.some(placeholder))throw new Error(tr('runReports.placeholderNotEvidence'));
  if(input.next!=null && (typeof input.next!=='string'||input.next.length>1000)) throw new Error(tr('runReports.nextStepMustBeAt'));
  // Optional progress facts: an exact commit, the stage it evidences and the original item. Merged or deployed needs a real SHA.
  if(input.version!=null&&(typeof input.version!=='string'||!/^[0-9a-f]{40}$/.test(input.version)))throw new Error(tr('runReports.invalidVersion'));
  if(input.stage!=null&&!RECEIPT_STAGES.includes(input.stage))throw new Error(tr('runReports.invalidStage'));
  if(['merged','deployed'].includes(input.stage)&&!input.version)throw new Error(tr('runReports.stageNeedsVersion'));
  if(input.item!=null&&(typeof input.item!=='string'||!/^[\w:.-]{1,120}$/.test(input.item)))throw new Error(tr('runReports.invalidItem'));
  const old=db.get('runReports',run.id);
  // Before replacing a pre-receipt report, freeze its content-derived ID so a late legacy retry cannot restore it.
  if(old&&!old.submissionId){
    const legacyId=reportFingerprint(old),key=submissionKey(run.id,legacyId);
    if(!db.get('reportSubmissions',key))db.put('reportSubmissions',{id:key,projectId:run.projectId,runId:run.id,submissionId:legacyId,fingerprint:legacyId,
      result:{runId:run.id,verdict:old.verdict,revision:old.revision},createdAt:old.updatedAt||new Date().toISOString()});
  }
  const report=db.put('runReports',{id:run.id,projectId:run.projectId,roleId:run.roleId,requestId:run.requestId,submissionId,
    verdict:input.verdict,summary:input.summary.trim(),evidence,next:input.next||'',revision:(old?.revision||0)+1,updatedAt:new Date().toISOString(),
    ...(input.version?{version:input.version}:{}),...(input.stage?{stage:input.stage}:{}),...(input.item?{item:input.item}:{})});
  db.put('runs',{...db.get('runs',run.id),report});
  registerResultReceipt(db,{run:db.get('runs',run.id),report});
  const result={runId:run.id,verdict:report.verdict,revision:report.revision};
  db.put('reportSubmissions',{id:submissionKey(run.id,submissionId),projectId:run.projectId,runId:run.id,submissionId,fingerprint,result,createdAt:report.updatedAt});
  return {...result,protocol:1,state:'saved',saved:true,submissionId,note:tr('runReports.businessVerdictRecordedEndTurn')};
});}

/** No report means unverified; process failures remain in runStatus/error, not fabricated business verdicts. */
export function outcomeFor(db,run) {
  return db.get('runReports',run.id)?.verdict || 'unverified';
}
