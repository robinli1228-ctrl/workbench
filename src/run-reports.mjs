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

/** No report means unverified; process failures remain in runStatus/error, not fabricated business verdicts. */
export function outcomeFor(db,run) {
  return db.get('runReports',run.id)?.verdict || 'unverified';
}
