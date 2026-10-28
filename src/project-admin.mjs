import { randomUUID } from 'node:crypto';
import { folderName,assertProjectReady } from './project-space.mjs';
import { saveRepository, bindRepository } from './project-repositories.mjs';
import { tr } from './i18n.mjs';

/** The page and the configuration assistant share project operations; all paths are computed from the project/device configuration. */
export class ProjectAdmin {
  constructor(db, query, hosting, change) { Object.assign(this, { db, query, hosting, change }); this.busy = new Set(); }
  check(projectId) {
    assertProjectReady(this.db,projectId);
    const project = this.db.get('projects', projectId);
    if (!project) throw new Error(tr('projectAdmin.projectNotFound'));
    if (this.db.list('runs').some(r => r.projectId === projectId && !['succeeded','failed','interrupted'].includes(r.status))) throw new Error(tr('projectAdmin.projectRunningChangeDirectoriesRepositories'));
    return project;
  }
  async prepare(projectId, nodeId) {
    const project = this.check(projectId), worker = this.db.get('workers', nodeId);
    if (!worker || worker.capabilities?.projectSpace !== 1) throw new Error(tr('projectAdmin.upgradeDeviceWorkerBeforePreparing'));
    const existing = this.db.get('workspaces', `${projectId}:${nodeId}`);
    // Existing directories are not moved; all newly participating devices use the stable project folder name.
    const checked = existing ? await this.query({ nodeId,projectId }, 'workspace_check', existing.localRoot)
      : await this.query({ nodeId }, 'project_directory', { projectId, folder: folderName(project.folderName), workspaceRoot: worker.workspaceRoot || worker.allowedRoots?.[0] });
    const result = this.db.bindWorkspace(projectId, nodeId, { ...existing, ...checked });
    this.change(); return result;
  }
  async repository(projectId, input) {
    const project = this.check(projectId);
    if (!['existing','create'].includes(input.mode)) throw new Error(tr('projectAdmin.chooseLinkExistingRepositoryCreate'));
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(input.key || '')) throw new Error(tr('projectAdmin.repositoryDirectoryNameMayContain'));
    if (input.baseBranch && (typeof input.baseBranch !== 'string' || input.baseBranch.length > 100 || input.baseBranch.startsWith('-'))) throw new Error(tr('projectAdmin.invalidProjectBaselineSourceBranch'));
    if (!Array.isArray(input.nodeIds) || !input.nodeIds.length || input.nodeIds.some(id => !this.db.get('workers', id))) throw new Error(tr('projectAdmin.selectParticipatingDevices'));
    const operationKey = `${projectId}:${input.key}`;
    if (this.busy.has(operationKey)) throw new Error(tr('projectAdmin.repositoryBeingPreparedWaitFor'));
    this.busy.add(operationKey);
    try {
      let repo = this.db.get('repositories', operationKey);
      const previous = this.db.get('repositoryOperations', operationKey);
      if (input.mode === 'create' && !repo) {
        if (previous?.status === 'creating_remote' || previous?.status === 'remote_uncertain') throw new Error(tr('projectAdmin.resultLastRepositoryCreationUnconfirmed'));
        this.db.put('repositoryOperations', { id: operationKey, projectId, status: 'creating_remote' }); this.change();
        let url;
        try { url = await this.hosting.create(input.accountId, input.remoteName || `${project.folderName}-${input.key}`, project.description); }
        catch (e) { this.db.put('repositoryOperations', { id: operationKey, projectId, status: e.remoteUncertain===false ? 'blocked' : 'remote_uncertain', error: e.message }); throw e; }
        repo = saveRepository(this.db, projectId, { key: input.key, repoUrl: url, accountId: input.accountId, baseBranch:input.baseBranch });
      } else {
        repo = saveRepository(this.db, projectId, { key: input.key, repoUrl: input.repoUrl || repo?.repoUrl, accountId: input.accountId || repo?.accountId,
          baseBranch:input.baseBranch });
      }
      const results = [], prepared = [], nodeIds = [...new Set(input.nodeIds)];
      const priorBindings = nodeIds.map(nodeId=>this.db.get('repositoryWorkspaces',`${repo.id}:${nodeId}`));
      // Bindings left on an older baseline copy move back to their source checkouts, on every device at once: a baseline copy
      // cannot receive deliveries from a direct checkout, and a synced folder must not move under running source sync.
      const onBaseline = this.db.list('repositoryWorkspaces').filter(b => b.repositoryId === repo.id && b.baselineBranch);
      if (onBaseline.length) {
        const left = onBaseline.filter(b => !nodeIds.includes(b.nodeId));
        if (left.length) throw new Error(tr('projectAdmin.moveEveryBaselineDevice', { devices: left.map(b => this.db.get('workers', b.nodeId)?.name || b.nodeId).join(tr('projectAdmin.listSeparator')) }));
        const sync = this.db.get('sourceSyncConfigs', projectId);
        if (sync?.enabled && (sync.repositoryIds || []).includes(repo.id)) throw new Error(tr('projectAdmin.pauseSyncBeforeMove'));
      }
      for (const nodeId of nodeIds) {
        try {
          const binding = await this.prepare(projectId, nodeId);
          const previousBinding = this.db.get('repositoryWorkspaces', `${repo.id}:${nodeId}`);
          // The repository is bound where it sits in the project folder.
          const localRoot = previousBinding?.sourceRoot || previousBinding?.localRoot || `${binding.localRoot}/${repo.key}`;
          let containsCommit = null;
          if (previousBinding?.baselineBranch) {
            // Unavailable evidence is not proof that the old copy was absent or contained no work.
            containsCommit = (await this.query({ nodeId, projectId }, 'execution_snapshot', { repositories: [{ id: repo.id, key: repo.key, localRoot: previousBinding.localRoot }] }, 30000))[0]?.commit;
            if(!/^[a-f0-9]{40,64}$/.test(containsCommit||''))throw new Error(tr('projectAdmin.baselineVersionUnavailable'));
          }
          const credential = await this.hosting.auth(repo.accountId, repo.repoUrl);
          const checked = await this.query({ nodeId }, 'repository_setup', { operationId: `${randomUUID()}-0`, repoUrl: repo.repoUrl, localRoot,
            clone: input.clone !== false, credential, ...(containsCommit ? { containsCommit } : {}) }, 90000);
          prepared.push({nodeId,checked}); results.push({ nodeId, status: 'ready', localRoot:checked.localRoot });
        } catch (e) { results.push({ nodeId, status: 'blocked', error: e.message }); }
      }
      // Commit device bindings together after all asynchronous preparation, fencing new tasks and configuration changes.
      if(results.every(r=>r.status==='ready'))try{this.db.transaction(()=>{
        this.check(projectId);
        if(onBaseline.length&&this.db.get('sourceSyncConfigs',projectId)?.enabled&&this.db.get('sourceSyncConfigs',projectId).repositoryIds?.includes(repo.id))throw new Error(tr('projectAdmin.pauseSyncBeforeMove'));
        for(let i=0;i<nodeIds.length;i++)if(JSON.stringify(this.db.get('repositoryWorkspaces',`${repo.id}:${nodeIds[i]}`))!==JSON.stringify(priorBindings[i]))throw new Error(tr('projectAdmin.repositoryBindingsChanged'));
        for(const {nodeId,checked}of prepared)bindRepository(this.db,repo,nodeId,checked);
      });}catch(e){for(const result of results)Object.assign(result,{status:'blocked',error:e.message});}
      if(results.some(r=>r.status!=='ready'))for(const result of results)if(result.status==='ready')Object.assign(result,{status:'blocked',error:tr('projectAdmin.repositoryBindingsUnchanged')});
      const operation = this.db.put('repositoryOperations', { id: operationKey, projectId, status: results.every(r => r.status === 'ready') ? 'ready' : 'blocked', results });
      this.change(); return { repo, ...operation };
    } finally { this.busy.delete(operationKey); }
  }
}
