import { createHash } from 'node:crypto';
import { executionText as tr, traditionalInput } from './input-language.mjs';
import {customExecutionPrompt} from './platform-prompts.mjs';
import {relative,isAbsolute} from 'node:path';

/** Only exceptional directory boundaries and repositories outside cwd need active disclosure; ordinary inventories stay queryable. */
export function executionEnvironmentHint({cwd,projectRoot,boundary,repositories=[]}) {
  const external=repositories.filter(r=>{if(!r.localRoot)return false;const path=relative(cwd,r.localRoot);return path==='..'||path.startsWith('../')||path.startsWith('..\\')||isAbsolute(path);});
  return [cwd!==projectRoot?boundary:'',external.length?tr('minimal.externalRepositories',{repositories:JSON.stringify(external.map(r=>({key:r.key,localRoot:r.localRoot})))}):''].filter(Boolean).join('\n');
}

/** Runtime instructions contain only trusted identity and configured execution text, not directory duties or live inventory. */
export function executionInstructionComponents({run,configuration}) {
  return {identity:tr('minimal.identity',{name:run.roleSnapshot?.name||'',roleId:run.roleId}),
    platform:traditionalInput(customExecutionPrompt(configuration.platformPrompt)),role:traditionalInput(configuration.roleInstructions??''),
    supervisor:traditionalInput(customExecutionPrompt(configuration.supervisorPrompt,'supervisor'))};
}

/** Only a successful prior turn in the same native session proves the input was received; failed or unknown states always send everything. */
export function sameNativeSession(run,prior) {
  return Boolean(run?.resumeNativeSessionId && run.roleSessionId && prior?.status==='succeeded'
    && prior.projectId===run.projectId && prior.nodeId===run.nodeId && prior.roleSessionId===run.roleSessionId
    && prior.nativeSession?.id===run.resumeNativeSessionId);
}

/** Same-session configuration changes need explicit replacement events as well as current native instruction parameters. */
export function instructionDelivery({runtime,run,prior,instructions,roleName,processReused=false,components}) {
  const fingerprint=createHash('sha256').update(JSON.stringify([roleName||'',instructions])).digest('hex');
  if(components) {
    const versions=Object.fromEntries(Object.entries(components).map(([name,text])=>[name,{version:createHash('sha256').update(text).digest('hex'),empty:text===''}]));
    const inherited=sameNativeSession(run,prior)&&prior.configurationState==='applied';
    if(['codex','claude','grok'].includes(runtime)) {
      // A native append acknowledgement survives a later turn failure; unknown delivery must still be retried.
      const acknowledged=runtime==='codex'&&prior?.configurationEventState==='delivered'&&run.resumeNativeSessionId&&run.roleSessionId
        &&prior.projectId===run.projectId&&prior.nodeId===run.nodeId&&prior.roleSessionId===run.roleSessionId&&prior.nativeSession?.id===run.resumeNativeSessionId;
      const confirmed=(inherited||acknowledged)&&prior.configurationEventProtocol===1;
      const changed=run.resumeNativeSessionId?Object.keys(components).filter(name=>!confirmed||prior.instructionComponents?.[name]?.version!==versions[name].version):[];
      const configurationUpdate=changed.map(name=>components[name]!==''?tr('minimal.replaceInstructions',{name,version:versions[name].version,text:components[name]}):tr('minimal.revokeInstructions',{name,version:versions[name].version})).join('\n\n');
      const reused=runtime==='claude'&&processReused&&inherited&&prior.instructionFingerprint===fingerprint;
      return {fingerprint,components:versions,inheritedFrom:reused?prior.id:null,instructions:reused?'':instructions,configurationUpdate,configurationEventProtocol:1};
    }
    if(runtime==='agy') {
      const changed=Object.keys(components).filter(name=>!inherited||prior.instructionComponents?.[name]?.version!==versions[name].version);
      const message=changed.filter(name=>components[name]!==''||Boolean(run.resumeNativeSessionId)&&(name==='role'||name==='platform'||name==='supervisor'))
        .map(name=>components[name]!==''?tr('minimal.replaceInstructions',{name,version:versions[name].version,text:components[name]}):tr('minimal.revokeInstructions',{name,version:versions[name].version})).join('\n\n');
      return {fingerprint,components:versions,inheritedFrom:!changed.length?prior.id:null,instructions:message};
    }
    return {fingerprint,components:versions,inheritedFrom:runtime==='claude'&&processReused&&inherited&&prior.instructionFingerprint===fingerprint?prior.id:null,
      instructions:runtime==='claude'&&processReused&&inherited&&prior.instructionFingerprint===fingerprint?'':instructions};
  }
  const inheritedFrom=(runtime==='agy'||(runtime==='claude'&&processReused)) && sameNativeSession(run,prior) && prior.instructionFingerprint===fingerprint ? prior.id : null;
  return {fingerprint,inheritedFrom,instructions:inheritedFrom?'':instructions};
}

/** Fix the two parts of input actually handed to the Runtime this turn, so the log snapshot and the launch arguments are not assembled separately. */
export function createRunInput({ taskPrompt, boundary, context = '', runtimeGuidance = '', setupHint = '', attachmentHint = '', roleInstructions, executionInstructions = '',sourceInputs=[],minimal=false,environmentHint='',configurationUpdate='' }) {
  if(sourceInputs.length)context=[context,tr(sourceInputs.some(i=>i.inheritedFrom)?'sourceSync.continuedReceipt':'sourceSync.executionReceipt',{versions:JSON.stringify(sourceInputs)})].filter(Boolean).join('\n\n');
  // Components have already been converted before versioning; reprocessing them would rename trusted identities and disagree with native parameters.
  if(minimal)return {instructions:roleInstructions,prompt:traditionalInput([taskPrompt,context,environmentHint,runtimeGuidance,attachmentHint].filter(Boolean).join('\n\n')),...(configurationUpdate?{configurationUpdate}:{})};
  return {
    instructions: roleInstructions,
    prompt: traditionalInput(tr('runInput.currentWorkspaceHasBeenDesignated', { taskPrompt, boundary, context, executionInstructions, runtimeGuidance, setupHint, attachmentHint }))
  };
}
