import { randomUUID } from 'node:crypto';
import { runtimeIssue } from './runtime-probe.mjs';
import { roleWorkspace } from './project-repositories.mjs';
import { giteeRepository } from './repository.mjs';
import { buildTeamContext } from './team-context.mjs';
import { tr } from './i18n.mjs';
import { isSupervisorName, isBroadcastName } from './default-roles.mjs';
import { normalizeResponsibility, roleForAgent } from './role-definition.mjs';

/** The supervisor may be on any device, but the CLI, model, and login state must be confirmed by the target Worker. */
export function validateLocalSupervisor(worker, input, online) {
  if (typeof input.runtime !== 'string' || !input.runtime.trim() || typeof input.model !== 'string' || !input.model.trim()) throw new Error(tr('projectSetup.selectSupervisorCliModel'));
  if (!worker) throw new Error(tr('projectSetup.selectDeviceSupervisorRunsOn'));
  if (!online) throw new Error(tr('projectSetup.supervisorDeviceOfflineStartWorker'));
  if (worker.capabilities?.projectSetup !== 1) throw new Error(tr('projectSetup.upgradeTargetWorkerBeforeConfiguring'));
  const issue = runtimeIssue(worker, input.runtime, input.model);
  if (issue) throw new Error(issue);
  const runtime = worker.runtimes.find(r => r.type === input.runtime);
  if (runtime.authReady !== true) throw new Error(tr('projectSetup.supervisorCliLoginHasNot'));
  const model = runtime.models.find(m => m.id === input.model);
  if (input.effort && !(model.efforts || runtime.efforts || []).includes(input.effort)) throw new Error(tr('projectSetup.supervisorModelDoesNotSupport'));
}

export const setupRules = () => [tr('projectSetup.youProjectSFixedSupervisor'), tr('roleDefinition.supervisorConvention'), tr('coordinator.dynamicPlanningRules')].join('\n\n');

/** Stores and executes configuration proposals; the model can only propose, and the user-confirmation endpoint applies them. */
export class ProjectSetup {
  constructor(db, rooms, query, online, change) {
    Object.assign(this, { db, rooms, query, online, change });
    for (const p of db.list('setupProposals').filter(p=>p.status==='pending' && p.actions?.some(a=>a.localRoot || a.repositoryKey))) {
      db.put('setupProposals',{...p,status:'blocked',error:tr('projectSetup.projectDirectoryRulesHaveBeen')});
    }
    for (const p of db.list('setupProposals').filter(p => p.status === 'running')) {
      db.put('setupProposals', { ...p, status: 'blocked', error: tr('projectSetup.homeRestartedOperationResultNeeds') });
    }
  }
  supervisor(run) {
    const project = this.db.get('projects', run?.projectId);
    if (!project || project.supervisorRoleId !== run.roleId || !run.roleSnapshot?.systemSupervisor) throw new Error(tr('projectSetup.onlyCurrentProjectSupervisorCan'));
    return project;
  }
  /** All roles of this project can read the configuration catalog; proposals and prompt changes still separately check the supervisor identity. */
  catalog(run) {
    const project = this.db.get('projects', run?.projectId);
    const role = run?.roleId ? this.db.get('roles', run.roleId) : null;
    if (!project || !run.roleId || (project.supervisorRoleId !== run.roleId && role?.projectId !== project.id)) throw new Error(tr('projectSetup.youCanOnlyQueryConfiguration'));
    const roles = this.db.list('roles').filter(r => r.projectId === project.id);
    // Older proposals duplicate role records in actions and results; project those too.
    const projectAction = (a, index, proposal) => {
      if (a.type !== 'role') return a;
      const id = proposal.completed?.find(c => c.index === index)?.result?.id || roles.find(r => r.name === a.name)?.id;
      const projected = roleForAgent({ ...a, id }, run);
      // An unresolved legacy name may belong to the caller before a rename; use the live roster for duties.
      if (!id) delete projected.responsibility;
      return projected;
    };
    const proposals = this.db.list('setupProposals').filter(r => r.projectId === project.id).slice(-5).map(p => ({
      ...p, actions: p.actions.map((a, index) => projectAction(a, index, p)), completed: (p.completed || []).map(c => ({
        ...c, result: p.actions[c.index]?.type === 'role' ? roleForAgent(c.result, run) : c.result
      }))
    }));
    return { project, team:buildTeamContext(this.db,run,{online:this.online,inherit:false}), repositories: this.db.list('repositories').filter(r => r.projectId === project.id),
      workspaces: this.db.list('repositoryWorkspaces').filter(r => r.projectId === project.id),
      roles: roles.filter(r => !r.archivedAt).map(r => roleForAgent(r, run)),
      proposals,
      workers: this.db.list('workers').map(w => ({ id: w.id, name: w.name, nodeKind: w.nodeKind,
        online: this.online(w.id), allowedRoots: w.allowedRoots, runtimes: w.runtimes })) };
  }
  /** The supervisor changes only the persistent prompts of this project's working roles; the revision and request ID prevent concurrent overwrites and duplicate writes on retry. */
  updateRolePrompt(run, input) {
    const project = this.supervisor(run);
    if (this.db.get('settings', 'main')?.paused) throw new Error(tr('projectSetup.remoteExecutionPaused'));
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(input?.requestId || '')) throw new Error(tr('projectSetup.stablePromptChangeIdRequired'));
    if (!Number.isInteger(input.revision) || input.revision < 1) throw new Error(tr('projectSetup.currentRoleRevisionRequired'));
    if (typeof input.instructions !== 'string' || !input.instructions.trim() || input.instructions.length > 12000) throw new Error(tr('projectSetup.rolePromptMustBe1'));
    const instructions = input.instructions.trim();
    const id = `role-prompt:${project.id}:${input.requestId}`;
    let changed = false;
    const result = this.db.transaction(() => {
      const prior = this.db.get('rolePromptChanges', id);
      if (prior) {
        if (prior.sourceRunId !== run.id || prior.roleId !== input.roleId || prior.revisionBefore !== input.revision || prior.after !== instructions) throw new Error(tr('projectSetup.promptChangeIdConflict'));
        return prior.result;
      }
      const role = this.db.get('roles', input.roleId);
      if (!role || role.projectId !== project.id) throw new Error(tr('projectSetup.roleDoesNotBelongCurrent'));
      if (role.systemSupervisor || role.platformAssistant) throw new Error(tr('projectSetup.promptsSystemSupervisorPlatformAssistant'));
      if (role.archivedAt) throw new Error(tr('projectSetup.archivedRoleCannotBeModified'));
      if ((role.revision || 1) !== input.revision) throw new Error(tr('projectSetup.roleConfigurationVersionHasChanged'));
      if (role.instructions === instructions) throw new Error(tr('projectSetup.rolePromptUnchanged'));
      const updated = this.db.put('roles', { ...role, instructions, revision: input.revision + 1, updatedAt: new Date().toISOString() });
      const output = { roleId: role.id, name: role.name, revision: updated.revision, appliesTo: 'new_tasks' };
      this.db.put('rolePromptChanges', { id, projectId: project.id, roleId: role.id, roleName: role.name,
        sourceRunId: run.id, revisionBefore: input.revision, revisionAfter: updated.revision,
        before: role.instructions, after: instructions, createdAt: updated.updatedAt, result: output });
      this.db.put('roomMessages', { id: `notice:${id}`, projectId: project.id, sender: 'system', senderName: tr('projectSetup.roleConfiguration'),
        taskIds: [], text: tr('projectSetup.supervisorUpdatedRolePromptFrom', { name: role.name, revision: input.revision, revision2: updated.revision }),
        createdAt: updated.updatedAt });
      this.rooms.touch(project.id);
      changed = true;
      return output;
    });
    if (changed) this.change();
    return result;
  }
  propose(run, input) {
    this.supervisor(run);
    if (typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 1000 || !Array.isArray(input.actions) || !input.actions.length || input.actions.length > 8) throw new Error(tr('projectSetup.proposalNeedsDescription18'));
    const actions = input.actions.map(a => {
      if (!a || !['repository', 'role'].includes(a.type) || !this.db.get('workers', a.nodeId)) throw new Error(tr('projectSetup.invalidActionDevice'));
      if (a.type === 'repository') {
        if (a.localRoot) throw new Error(tr('projectSetup.repositoryPathsComputedFromProject'));
        if (!/^[a-zA-Z0-9_-]{1,40}$/.test(a.key || '') || !giteeRepository(a.repoUrl)) throw new Error(tr('projectSetup.invalidRepositoryIdentifierUrl'));
        return { type: a.type, key: a.key, repoUrl: a.repoUrl, nodeId: a.nodeId, clone: a.clone !== false,
          baseBranch:a.baseBranch || null,baseCommit:a.baseCommit || null,publishBaseline:a.publishBaseline!==false };
      }
      if (isSupervisorName(a.name) || isBroadcastName(a.name) || !/^[\p{L}\p{N}_-]{1,32}$/u.test(a.name || '') || typeof a.instructions !== 'string' || a.instructions.length > 12000) throw new Error(tr('projectSetup.workingRoleNeedsValidName'));
      const issue = runtimeIssue(this.db.get('workers', a.nodeId), a.runtime, a.model);
      if (issue) throw new Error(issue);
      return { type: a.type, name: a.name, nodeId: a.nodeId,
        ...(a.responsibility === undefined ? {} : { responsibility: normalizeResponsibility(a.responsibility) }),
        runtime: a.runtime, model: a.model, effort: a.effort || null, instructions: a.instructions, enabled: true };
    });
    const proposal = this.db.put('setupProposals', { id: randomUUID(), projectId: run.projectId, sourceRunId: run.id,
      summary: input.summary.trim(), actions, completed: [], status: 'pending', createdAt: new Date().toISOString() });
    this.rooms.touch(run.projectId); this.change();
    return { proposalId: proposal.id, status: 'pending', message: tr('projectSetup.actionCardHasBeenIssued') };
  }
  reject(projectId, id) {
    const p = this.db.get('setupProposals', id);
    if (p?.projectId !== projectId || p.status !== 'pending') throw new Error(tr('projectSetup.proposalDoesNotExistHas'));
    this.db.put('setupProposals', { ...p, status: 'rejected' }); this.change();
  }
  async approve(projectId, id) {
    let p = this.db.get('setupProposals', id);
    if (p?.projectId !== projectId) throw new Error(tr('projectSetup.proposalDoesNotBelongProject'));
    if (p.status !== 'pending') return p;
    if (this.db.get('settings', 'main')?.paused) throw new Error(tr('projectSetup.remoteExecutionPaused2'));
    p = this.db.put('setupProposals', { ...p, status: 'running' }); this.change();
    try {
      for (let i = 0; i < p.actions.length; i++) {
        const a = p.actions[i];
        if (this.db.get('settings', 'main')?.paused) throw new Error(tr('projectSetup.remoteExecutionPaused3'));
        if (!this.online(a.nodeId)) throw new Error(tr('projectSetup.targetDeviceOfflineConnectIt'));
        let result;
        if (a.type === 'repository') {
          result = await this.projectsAdmin.repository(projectId, { ...a, mode:'existing', nodeIds:[a.nodeId] });
          if (result.status !== 'ready') throw new Error(result.results.find(r => r.error)?.error || tr('projectSetup.repositoryNotReadyYet'));
        } else {
          const binding = await this.projectsAdmin.prepare(projectId, a.nodeId);
          await this.query({ nodeId: a.nodeId }, 'workspace_check', binding.localRoot);
          const old = this.db.list('roles').find(r => r.projectId === projectId && r.name === a.name && !r.archivedAt);
          if (old?.systemSupervisor) throw new Error(tr('projectSetup.supervisorCannotBeModifiedThrough'));
          result = this.rooms.saveRole(projectId, { ...a, id: old?.id, revision: old?.revision });
        }
        p = this.db.put('setupProposals', { ...p, completed: [...p.completed, { index: i, result }] }); this.change();
      }
      p = this.db.put('setupProposals', { ...p, status: 'succeeded' });
      this.db.put('projects', { ...this.db.get('projects', projectId), setupStatus: 'ready' });
    } catch (e) { p = this.db.put('setupProposals', { ...p, status: 'blocked', error: e.message }); }
    this.db.put('roomMessages', { id: `setup-${p.id}`, projectId, sender: 'system', senderName: tr('projectSetup.setupResult'), taskIds: [],
      text: tr('projectSetup.text', { summary: p.summary, p2: p.status === 'succeeded' ? tr('projectSetup.completed') : tr('projectSetup.notCompleted'), length: p.completed.length, length2: p.actions.length, p5: p.error || '' }),
      createdAt: new Date().toISOString() });
    this.rooms.touch(projectId); this.change();
    return p;
  }
}
