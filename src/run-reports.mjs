import {terminal} from './store.mjs';

const verdicts=new Set(['passed','failed','blocked','needs_input']);
/** Discussions only handle information; they must not prematurely produce a business delivery or a prompt aimed at the user. Compatible with legacy plain Runs. */
export function acceptsBusinessReport(run) {
  return Boolean(run&&!run.discussionWaiting&&!run.discussionDeliveryId&&(!run.turnPurpose||run.turnPurpose==='task'));
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

/** The business verdict is submitted explicitly by the executing role; version and identity are attached by the platform, and an exit code cannot substitute for it. */
export function saveRunReport(db,run,input) {
  if(!run || terminal.has(run.status) || ['stopping','reconciling'].includes(run.status)) throw new Error('A report can only be submitted for a currently active run');
  if(!acceptsBusinessReport(run))return {runId:run.id,ignored:true,note:'Business report not recorded: a discussion is in progress or a question is awaiting an answer. Finish after reply/resolve as this turn requires; a waiting business turn simply ends; information needed from the user is left to the original business continuation turn to report.'};
  if(!verdicts.has(input.verdict)) throw new Error('verdict must be passed/failed/blocked/needs_input');
  if(typeof input.summary!=='string' || !input.summary.trim() || input.summary.length>3000) throw new Error('Report summary must be 1-3000 characters');
  const evidence=input.evidence||[];
  if(!Array.isArray(evidence)||evidence.length>20||evidence.some(e=>typeof e!=='string'||!e.trim()||e.length>1500)) throw new Error('Verification evidence allows at most 20 items of up to 1500 characters each');
  if(input.verdict==='passed'&&!evidence.length) throw new Error('A passed verdict must include actual verification evidence; use blocked if it cannot be verified');
  if(input.next!=null && (typeof input.next!=='string'||input.next.length>1000)) throw new Error('Next step must be at most 1000 characters');
  const old=db.get('runReports',run.id);
  const report=db.put('runReports',{id:run.id,projectId:run.projectId,roleId:run.roleId,requestId:run.requestId,
    verdict:input.verdict,summary:input.summary.trim(),evidence,next:input.next||'',revision:(old?.revision||0)+1,updatedAt:new Date().toISOString()});
  db.put('runs',{...db.get('runs',run.id),report});
  return {runId:run.id,verdict:report.verdict,revision:report.revision,note:'Business verdict recorded; end this turn, the platform verifies the final run state and delivery version.'};
}

export function outcomeFor(db,run) {
  if(run.status!=='succeeded') return 'failed';
  return db.get('runReports',run.id)?.verdict || 'unverified';
}
