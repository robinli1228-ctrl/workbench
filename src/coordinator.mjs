import { runtimeIssue } from './runtime-probe.mjs';
import { isRoleConfigured } from './default-roles.mjs';

/** The system supervisor configuration is independent of worker roles; no option may silently replace the user's runtime configuration. */
export class Coordinator {
  constructor(db) { this.db = db; }

  saveSupervisor(projectId, nodeId, input) {
    if (!this.db.get('projects', projectId)) throw new Error('Project not found');
    const worker = this.db.get('workers', nodeId);
    if (!worker) throw new Error('Device not found');
    const id = `${projectId}:${nodeId}`, old = this.db.get('supervisorConfigs', id);
    if (input.revision !== undefined && input.revision !== (old?.revision || 0)) throw new Error('Supervisor configuration has changed; refresh and try again');
    if (typeof input.enabled !== 'boolean') throw new Error('enabled must be a boolean');
    const runtime = typeof input.runtime === 'string' ? input.runtime.trim() : '';
    const model = typeof input.model === 'string' ? input.model.trim() : '';
    const effort = typeof input.effort === 'string' ? input.effort.trim() : null;
    if (effort && (effort.length > 32 || /[\r\n]/.test(effort))) throw new Error('Invalid reasoning effort');
    const unchangedDisabled = old && !input.enabled && runtime === old.runtime && model === old.model;
    if (!unchangedDisabled) {
      if (!runtime || !model) throw new Error('Select a CLI and model for the supervisor');
      const issue = runtimeIssue(worker, runtime, model); if (issue) throw new Error(issue);
    }
    const project = this.db.get('projects', projectId);
    if (project.supervisorRoleId) {
      if (!input.enabled) throw new Error('The project must keep its local supervisor');
      const role = this.db.get('roles', project.supervisorRoleId);
      this.db.put('roles', { ...role, nodeId, runtime, model, effort, revision: (role.revision || 1) + 1 });
      this.db.put('projects', { ...project, supervisorNodeId:nodeId });
    }
    return this.db.put('supervisorConfigs', { id, projectId, nodeId, runtime, model, effort,
      enabled: input.enabled, revision: (old?.revision || 0) + 1, updatedAt: new Date().toISOString() });
  }

  /** A project selects its intake node and planner role; names are not a basis for scheduling. */
  configureProject(projectId, input) {
    const project = this.db.get('projects', projectId);
    if (!project) throw new Error('Project not found');
    if (input.coordinationRevision !== undefined && input.coordinationRevision !== (project.coordinationRevision || 0)) throw new Error('Project coordination configuration has changed; refresh and try again');
    const nodeId = input.supervisorNodeId ?? project.supervisorNodeId ?? '';
    if (project.supervisorRoleId && nodeId !== project.supervisorNodeId) throw new Error('The project supervisor must stay on the local device selected at creation');
    const roleId = input.plannerRoleId ?? project.plannerRoleId ?? '';
    if (nodeId && !this.db.get('supervisorConfigs', `${projectId}:${nodeId}`)?.enabled) throw new Error('Configure and enable the supervisor for this node first');
    if (roleId) {
      const role = this.db.get('roles', roleId);
      if (role?.projectId !== projectId || role.archivedAt || !role.enabled || !isRoleConfigured(role)) throw new Error('The planner role must be a configured, enabled role of this project');
    }
    return this.db.put('projects', { ...project, supervisorNodeId: nodeId || null, plannerRoleId: roleId || null,
      coordinationRevision: (project.coordinationRevision || 0) + 1 });
  }
}
