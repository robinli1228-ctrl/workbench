import { createHash } from 'node:crypto';

/** Only a successful prior turn in the same native session proves the input was received; failed or unknown states always send everything. */
export function sameNativeSession(run,prior) {
  return Boolean(run?.resumeNativeSessionId && run.roleSessionId && prior?.status==='succeeded'
    && prior.projectId===run.projectId && prior.nodeId===run.nodeId && prior.roleSessionId===run.roleSessionId
    && prior.nativeSession?.id===run.resumeNativeSessionId);
}

/** Agy appends the rules as an ordinary message; the system configuration of other CLIs must still be provided every time and cannot be faked through history. */
export function instructionDelivery({runtime,run,prior,instructions,roleName,processReused=false}) {
  const fingerprint=createHash('sha256').update(JSON.stringify([roleName||'',instructions])).digest('hex');
  const inheritedFrom=(runtime==='agy'||(runtime==='claude'&&processReused)) && sameNativeSession(run,prior) && prior.instructionFingerprint===fingerprint ? prior.id : null;
  return {fingerprint,inheritedFrom,instructions:inheritedFrom?'':instructions};
}

/** Fix the two parts of input actually handed to the Runtime this turn, so the log snapshot and the launch arguments are not assembled separately. */
export function createRunInput({ taskPrompt, boundary, context = '', runtimeGuidance = '', setupHint = '', attachmentHint = '', roleInstructions, executionInstructions = '' }) {
  return {
    instructions: roleInstructions,
    prompt: `${taskPrompt}\n\n${boundary} The current workspace has been designated by the Worker.${context}\n${executionInstructions}\n${runtimeGuidance}${setupHint}${attachmentHint}`
  };
}
