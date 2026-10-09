import { runtimeIssue } from './runtime-probe.mjs';
import { tr } from './i18n.mjs';
import {assertBindingEditAllowed} from './role-switch-policy.mjs';

/** The system supervisor configuration is independent of worker roles; no option may silently replace the user's runtime configuration. */
export class Coordinator {
  constructor(db,{migrate=true}={}) {
    this.db = db;
    if(!migrate)return;
    // Retire the old hint so discovery cannot silently steer later turns to a fixed planner.
    for(const project of db.list('projects')){
      if(!Object.hasOwn(project,'plannerRoleId'))continue;
      const {plannerRoleId,...rest}=project;
      db.put('projects',{...rest,coordinationRevision:(project.coordinationRevision||0)+1});
    }
  }

  saveSupervisor(projectId, nodeId, input) {
    const project = this.db.get('projects', projectId);
    assertBindingEditAllowed(this.db, project?.supervisorRoleId && this.db.get('roles', project.supervisorRoleId), {...input,nodeId});
    const config = this.validateSupervisor(projectId, nodeId, input);
    if (project.supervisorRoleId) {
      const role = this.db.get('roles', project.supervisorRoleId);
      this.db.put('roles', {...role,nodeId,runtime:config.runtime,model:config.model,effort:config.effort,revision:(role.revision||1)+1});
      this.db.put('projects', {...project,supervisorNodeId:nodeId});
    }
    return this.db.put('supervisorConfigs',config);
  }

  /** Candidate validation must not alter any of the three supervisor records. */
  validateSupervisor(projectId, nodeId, input) {
    if (!this.db.get('projects', projectId)) throw new Error(tr('coordinator.projectNotFound'));
    const worker = this.db.get('workers', nodeId);
    if (!worker) throw new Error(tr('coordinator.deviceNotFound'));
    const id = `${projectId}:${nodeId}`, old = this.db.get('supervisorConfigs', id);
    if (input.revision !== undefined && input.revision !== (old?.revision || 0)) throw new Error(tr('coordinator.supervisorConfigurationHasChangedRefresh'));
    if (typeof input.enabled !== 'boolean') throw new Error(tr('coordinator.enabledMustBeBoolean'));
    const runtime = typeof input.runtime === 'string' ? input.runtime.trim() : '';
    const model = typeof input.model === 'string' ? input.model.trim() : '';
    const effort = typeof input.effort === 'string' ? input.effort.trim() : null;
    if (effort && (effort.length > 32 || /[\r\n]/.test(effort))) throw new Error(tr('coordinator.invalidReasoningEffort'));
    const unchangedDisabled = old && !input.enabled && runtime === old.runtime && model === old.model;
    if (!unchangedDisabled) {
      if (!runtime || !model) throw new Error(tr('coordinator.selectCliModelForSupervisor'));
      const issue = runtimeIssue(worker, runtime, model); if (issue) throw new Error(issue);
    }
    const project = this.db.get('projects', projectId);
    if (project.supervisorRoleId) {
      if (!input.enabled) throw new Error(tr('coordinator.projectMustKeepItsLocal'));
    }
    return { id, projectId, nodeId, runtime, model, effort,
      enabled: input.enabled, revision: (old?.revision || 0) + 1, updatedAt: new Date().toISOString() };
  }

  /** Only the intake node is configured here; the model selects collaborators for each task. */
  configureProject(projectId, input) {
    const project = this.db.get('projects', projectId);
    if (!project) throw new Error(tr('coordinator.projectNotFound2'));
    if (input.coordinationRevision !== undefined && input.coordinationRevision !== (project.coordinationRevision || 0)) throw new Error(tr('coordinator.projectCoordinationConfigurationHasChanged'));
    const nodeId = input.supervisorNodeId ?? project.supervisorNodeId ?? '';
    if (project.supervisorRoleId && nodeId !== project.supervisorNodeId) throw new Error(tr('coordinator.projectSupervisorMustStayOn'));
    if (nodeId && !this.db.get('supervisorConfigs', `${projectId}:${nodeId}`)?.enabled) throw new Error(tr('coordinator.configureEnableSupervisorForNode'));
    const {plannerRoleId,...rest}=project;
    return this.db.put('projects', { ...rest, supervisorNodeId: nodeId || null,
      coordinationRevision: (project.coordinationRevision || 0) + 1 });
  }
}
