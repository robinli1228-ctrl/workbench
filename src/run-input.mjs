import { createHash } from 'node:crypto';
import { executionText as tr, traditionalInput, sentText } from './input-language.mjs';
import {customExecutionPrompt,retiredCommandGuidance} from './platform-prompts.mjs';
import {relative,isAbsolute,resolve} from 'node:path';

/**
 * The environment block names only what the model cannot assume. A project directory at its own HEAD needs one line;
 * otherwise each repository is listed with its path, and, outside the project directory, its version: the version
 * assigned to this turn (a plan baseline, a delivery, another run's workspace), or a retained copy behind the project.
 * Every line is built from converted templates with the values inserted as they are.
 */
export function executionEnvironmentHint({cwd,projectRoot,boundary,repositories=[],inputRepositoryVersions=[],sharedDocs=null,readOnly=false,assigned=false,concurrentRoles=null}) {
  const short=value=>String(value||'').slice(0,12);
  const atRoot=resolve(cwd)===resolve(projectRoot||cwd);
  const outside=path=>{const rel=relative(cwd,path);return rel==='..'||rel.startsWith('../')||rel.startsWith('..\\')||isAbsolute(rel);};
  const lines=[atRoot?sentText('turnInput.envProjectIsCwd',{root:projectRoot||cwd,access:sentText(readOnly?'turnInput.envReadOnly':'turnInput.envWritable')})
    :[sentText('turnInput.envCwd',{cwd}),boundary].filter(Boolean).join('\n')];
  const versions=new Map(inputRepositoryVersions.map(v=>[v.id,v])),missing=[];
  const listed=inputRepositoryVersions.length?inputRepositoryVersions:repositories;
  const listAll=!atRoot||listed.length>1||listed.some(r=>r.localRoot&&outside(r.localRoot));
  for(const repo of listed) {
    const v=versions.get(repo.id)||repo;
    if(v.unavailable||!v.localRoot){missing.push(v.key||v.id);continue;}
    if(!listAll)continue;
    let detail='';
    if(!atRoot||outside(v.localRoot)) {
      if(v.commit)detail+=sentText('turnInput.envRepoCommit',{commit:short(v.commit)});
      if(v.dirty)detail+=sentText('turnInput.envDirty');
      if(v.expectedCommit||assigned)detail+=sentText('turnInput.envPinned');
      else if(v.commit&&v.boundCommit&&v.commit!==v.boundCommit)detail+=sentText('turnInput.envStale',{bound:short(v.boundCommit)});
    }
    lines.push(sentText('turnInput.envRepo',{key:v.key||v.id,path:v.localRoot,detail}));
  }
  if(missing.length)lines.push(sentText('turnInput.envMissing',{keys:missing.join(', ')}));
  if(sharedDocs)lines.push(sentText('turnInput.envSharedDocs',{path:sharedDocs}));
  // The project allows several roles to edit at once: say who else is running now and how to stay out of each other's way.
  if(concurrentRoles)lines.push(sentText('turnInput.envConcurrent'),...(concurrentRoles.length?[sentText('turnInput.envConcurrentOthers',{names:concurrentRoles.join(', ')})]:[]));
  return lines.join('\n');
}

const originLabel=origin=>origin?.kind==='platform'?sentText('turnInput.fromPlatform')
  :origin?.kind==='role'?origin.name?sentText('turnInput.fromRole',{name:origin.name}):sentText('turnInput.fromRoleUnknown'):sentText('turnInput.fromUser');

/**
 * One turn's input in a fixed order: the message (origin label, text, attachments), then a divider and each platform
 * addition under its own title. The message text and Home's parts are converted as before; labels, titles, names,
 * paths and parts the Worker already built in the sent script are not converted again. Ranges match the sent text.
 */
export function composeTurnInput({message,attachments=[],home=[],worker=[]}) {
  const blocks=[];
  if(message)blocks.push({key:'message',group:'message',text:[originLabel(message.origin),traditionalInput(String(message.text||''))].filter(Boolean).join('\n')});
  if(attachments.length)blocks.push({key:'attachments',group:'message',text:[sentText('turnInput.attachments'),...attachments.map(a=>sentText('turnInput.attachmentItem',{name:a.name,path:a.path}))].join('\n')});
  const additions=[...home.map(part=>({...part,group:'home'})),...worker.map(part=>({...part,group:'worker'}))].filter(part=>typeof part.text==='string'&&part.text.trim());
  if(additions.length) {
    blocks.push({key:'divider',group:'divider',text:sentText('turnInput.platformDivider')});
    for(const part of additions) {
      const key=`turnInput.title.${part.key}`,title=tr(key)===key?sentText('turnInput.title.other'):sentText(key);
      blocks.push({key:part.key,group:part.group,text:`${title}\n${part.sent?part.text.trim():traditionalInput(part.text.trim())}`});
    }
  }
  let prompt='';const sections=[];
  for(const block of blocks) {
    if(prompt)prompt+='\n\n';
    sections.push({key:block.key,group:block.group,start:prompt.length,end:prompt.length+block.text.length});
    prompt+=block.text;
  }
  return {prompt,sections};
}

/** Runtime instructions contain only trusted identity and configured execution text, not directory duties or live inventory. */
export function executionInstructionComponents({run,configuration}) {
  // Only the template is converted to the sent script; the role name and ID are inserted afterwards, exactly as configured.
  const identity=sentText('minimal.identity',{name:run.roleSnapshot?.name||'',roleId:run.roleId});
  return {identity,
    platform:traditionalInput(customExecutionPrompt(configuration.platformPrompt)),role:traditionalInput(retiredCommandGuidance(configuration.roleInstructions)),
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
export function createRunInput({ taskPrompt, boundary, context = '', runtimeGuidance = '', setupHint = '', attachmentHint = '', roleInstructions, executionInstructions = '',sourceInputs=[],minimal=false,environmentHint='',configurationUpdate='',turn=null }) {
  const sourceReceipt=sourceInputs.length?tr(sourceInputs.some(i=>i.inheritedFrom)?'sourceSync.continuedReceipt':'sourceSync.executionReceipt',{versions:JSON.stringify(sourceInputs)}):'';
  if(minimal&&turn) {
    const {prompt,sections}=composeTurnInput({message:turn.message,attachments:turn.attachments,home:turn.home,
      worker:[{key:'dependencies',text:turn.dependencies||''},{key:'sourceWorkspace',text:context},{key:'sourceInputs',text:sourceReceipt},
        {key:'environment',text:environmentHint,sent:true},{key:turn.rulesKey||'stage',text:executionInstructions},{key:'wb',text:turn.wb||'',sent:true}]});
    return {instructions:roleInstructions,prompt,sections,...(configurationUpdate?{configurationUpdate}:{})};
  }
  if(sourceReceipt)context=[context,sourceReceipt].filter(Boolean).join('\n\n');
  // Components have already been converted before versioning; reprocessing them would rename trusted identities and disagree with native parameters.
  if(minimal)return {instructions:roleInstructions,prompt:traditionalInput([taskPrompt,context,environmentHint,executionInstructions,runtimeGuidance,attachmentHint].filter(Boolean).join('\n\n')),...(configurationUpdate?{configurationUpdate}:{})};
  return {
    instructions: roleInstructions,
    prompt: traditionalInput(tr('runInput.currentWorkspaceHasBeenDesignated', { taskPrompt, boundary, context:[context,environmentHint].filter(Boolean).join('\n\n'), executionInstructions, runtimeGuidance, setupHint, attachmentHint }))
  };
}
