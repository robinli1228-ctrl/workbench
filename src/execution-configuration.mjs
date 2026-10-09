import {createHash} from 'node:crypto';
import {normalizePlatformSettings} from './platform-prompts.mjs';
import {dependencySnapshot} from './coordination-wait.mjs';
import {tr} from './i18n.mjs';

const version=text=>createHash('sha256').update(String(text??'')).digest('hex');

/** A saved new-contract input must never be interpreted by a downgraded Worker; first-time old-contract launches remain supported. */
export function instructionProtocolIssue(run,worker) {
  return run?.minimalInstructions===1&&worker?.capabilities?.minimalInstructions!==1?tr('minimal.workerProtocolMismatch'):null;
}

/** Only managed role turns can use role-bound configuration; ordinary API tasks keep their original launch contract. */
export function supportsMinimalInstructions(run,worker) {
  return Boolean(run?.roleId&&run.roleSnapshot?.id===run.roleId&&run.roleSessionId&&!run.switchOperationId&&!run.roleSnapshot.platformAssistant&&worker?.capabilities?.minimalInstructions===1);
}

/** Freeze instructions only after Worker admission; queued audit snapshots and native bindings stay untouched. */
export function freezeExecutionConfiguration(db,runId) {
  return db.transaction(()=>{
    const run=db.get('runs',runId),role=run?.roleId?db.get('roles',run.roleId):null;
    if(!run||!['queued','starting','running'].includes(run.status)||run.stopRequested||run.switchOperationId||run.minimalInstructions!==1)
      throw new Error('Execution configuration is not available for this active turn.');
    if(db.get('settings','main')?.paused||!role||role.projectId!==run.projectId||role.nodeId!==run.nodeId||role.runtime!==run.roleSnapshot?.runtime||!role.enabled||role.archivedAt)
      throw new Error('Execution role binding or authorization changed before start.');
    if(run.executionConfiguration)return run.executionConfiguration;
    const settings=normalizePlatformSettings(db.get('settings','main'));
    // The fixed supervisor's internal role text is maintained setup guidance, not its user-editable prompt.
    const roleInstructions=run.roleSnapshot?.systemSupervisor&&!run.roleSnapshot.platformAssistant?'':role.instructions??'';
    const snapshot={runId,roleId:run.roleId,roleRevision:role.revision||1,roleInstructions,
      platformPrompt:settings.platformPrompt,supervisorPrompt:run.roleSnapshot?.systemSupervisor&&!run.roleSnapshot.platformAssistant?settings.supervisorPrompt:'',
      platformSavedAt:settings.promptsUpdatedAt||null,versions:{role:version(roleInstructions),platform:version(settings.platformPrompt),supervisor:version(run.roleSnapshot?.systemSupervisor?settings.supervisorPrompt:'')},
      dependencyEvents:dependencySnapshot(db,run.requestId),frozenAt:new Date().toISOString()};
    db.put('runs',{...run,executionConfiguration:snapshot,configurationState:'prepared'});
    return snapshot;
  });
}
