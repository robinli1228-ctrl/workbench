import {createHash} from 'node:crypto';
import {tr} from './i18n.mjs';

/** Identical normalized content identifies a retry; an explicit new ID permits a deliberate new submission. */
export function reportFingerprint(input) {
  return createHash('sha256').update(JSON.stringify({verdict:input.verdict,
    summary:typeof input.summary==='string'?input.summary.trim():input.summary,
    evidence:input.evidence||[],next:input.next||'',
    // Progress fields join the fingerprint only when present, so earlier receipts keep their content-derived IDs.
    ...(input.version!=null?{version:input.version}:{}),...(input.stage!=null?{stage:input.stage}:{}),...(input.item!=null?{item:input.item}:{})})).digest('hex');
}
export const reportSubmissionId=input=>input.submissionId===undefined?reportFingerprint(input):input.submissionId;
const uncertain=error=>error.outcomeUnknown===true || (!error.status&&/timeout|timed out|fetch failed|ECONNRESET|ETIMEDOUT|EPIPE|\u8d85\u65f6|\u8d85\u6642/i.test(error.message||''));

/** A timed-out write may still commit. Query its durable receipt, then retry at most once with the same ID. */
export async function submitReport(request,input) {
  const submissionId=reportSubmissionId(input),payload={...input,submissionId},fingerprint=reportFingerprint(input);
  const pending=()=>({protocol:1,state:'pending_confirmation',runId:input.runId,submissionId,saved:null,
    note:tr('runReports.pendingConfirmation'),checkCommand:`wb report status ${submissionId}`});
  async function send(retryAllowed) {
    try{return await request(payload);}catch(error){
      if(retryAllowed&&!uncertain(error))throw error;
      let receipt;
      try{receipt=await request({runId:input.runId,action:'status',submissionId,fingerprint});}catch{return pending();}
      if(receipt.protocol!==1)return pending(); // An older Home cannot prove idempotent retry support.
      if(['saved','ignored'].includes(receipt.state))return receipt;
      if(receipt.state!=='not_saved')return pending();
      if(!receipt.canSubmit)return {...receipt,note:tr('runReports.reportCanOnlyBeSubmitted')};
      return retryAllowed?send(false):pending();
    }
  }
  return send(true);
}
