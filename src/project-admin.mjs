import { randomUUID } from 'node:crypto';
import { folderName } from './project-space.mjs';
import { saveRepository, bindRepository } from './project-repositories.mjs';
import { tr } from './i18n.mjs';

/** The page and the configuration assistant share project operations; all paths are computed from the project/device configuration. */
export class ProjectAdmin {
  constructor(db, query, hosting, change) { Object.assign(this, { db, query, hosting, change }); this.busy = new Set(); }
  check(projectId) {
    const project = this.db.get('projects', projectId);
    if (!project) throw new Error(tr('projectAdmin.projectNotFound'));
    if (this.db.get('settings', 'main')?.paused) throw new Error(tr('projectAdmin.remoteExecutionPaused'));
    if (this.db.list('runs').some(r => r.projectId === projectId && !['succeeded','failed','interrupted'].includes(r.status))) throw new Error(tr('projectAdmin.projectRunningChangeDirectoriesRepositories'));
    return project;
  }
  async prepare(projectId, nodeId) {
    const project = this.check(projectId), worker = this.db.get('workers', nodeId);
    if (!worker || worker.capabilities?.projectSpace !== 1) throw new Error(tr('projectAdmin.upgradeDeviceWorkerBeforePreparing'));
    const existing = this.db.get('workspaces', `${projectId}:${nodeId}`);
    // Existing directories are not moved; all newly participating devices use the stable project folder name.
    const checked = existing ? await this.query({ nodeId }, 'workspace_check', existing.localRoot)
      : await this.query({ nodeId }, 'project_directory', { projectId, folder: folderName(project.folderName), workspaceRoot: worker.workspaceRoot || worker.allowedRoots?.[0] });
    const result = this.db.bindWorkspace(projectId, nodeId, { ...existing, ...checked });
    this.change(); return result;
  }
  async repository(projectId, input) {
    const project = this.check(projectId);
    if (!['existing','create'].includes(input.mode)) throw new Error(tr('projectAdmin.chooseLinkExistingRepositoryCreate'));
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(input.key || '')) throw new Error(tr('projectAdmin.repositoryDirectoryNameMayContain'));
    if (input.baseBranch && (typeof input.baseBranch !== 'string' || input.baseBranch.length > 100 || input.baseBranch.startsWith('-'))) throw new Error(tr('projectAdmin.invalidProjectBaselineSourceBranch'));
    if(input.baseCommit && !/^[a-f0-9]{40,64}$/.test(input.baseCommit))throw new Error(tr('projectAdmin.pinnedStartingPointNeedsFull'));
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
        repo = saveRepository(this.db, projectId, { key: input.key, repoUrl: url, accountId: input.accountId, baseBranch:input.baseBranch,baseCommit:input.baseCommit });
      } else {
        repo = saveRepository(this.db, projectId, { key: input.key, repoUrl: input.repoUrl || repo?.repoUrl, accountId: input.accountId || repo?.accountId,
          baseBranch:input.baseBranch,baseCommit:input.baseCommit });
      }
      const results = [];
      const existingBaseline = this.db.list('repositoryWorkspaces').find(binding => binding.repositoryId === repo.id && binding.baselineBranch);
      let expectedCommit = null;
      if(existingBaseline) {
        const snapshot=await this.query({nodeId:existingBaseline.nodeId},'execution_snapshot',
          {repositories:[{id:repo.id,key:repo.key,localRoot:existingBaseline.localRoot}]},30000);
        if(snapshot[0]?.dirty || !snapshot[0]?.commit)throw new Error(tr('projectAdmin.existingProjectBaselineUncommittedUnreadable'));
        expectedCommit=snapshot[0].commit;
      }
      for (const nodeId of [...new Set(input.nodeIds)]) {
        try {
          const binding = await this.prepare(projectId, nodeId);
          const previousBinding = this.db.get('repositoryWorkspaces', `${repo.id}:${nodeId}`);
          const sourceRoot = previousBinding?.sourceRoot || previousBinding?.localRoot || `${binding.localRoot}/${repo.key}`;
          const credential = await this.hosting.auth(repo.accountId, repo.repoUrl);
          const checked = await this.query({ nodeId }, 'repository_setup', { operationId: `${randomUUID()}-0`, repoUrl: repo.repoUrl, localRoot:sourceRoot,
            clone: input.clone !== false, credential, projectId, projectRoot:binding.localRoot, key:repo.key,
            baseBranch:repo.baseBranch, baseCommit:repo.baseCommit, expectedCommit,publishBaseline:input.publishBaseline!==false }, 90000);
          if (!expectedCommit) expectedCommit=checked.git.head;
          if (!repo.baseBranch) repo=this.db.put('repositories',{...repo,baseBranch:checked.baseBranch});
          bindRepository(this.db, repo, nodeId, checked); results.push({ nodeId, status: 'ready', localRoot:checked.localRoot });
        } catch (e) { results.push({ nodeId, status: 'blocked', error: e.message }); }
      }
      const operation = this.db.put('repositoryOperations', { id: operationKey, projectId, status: results.every(r => r.status === 'ready') ? 'ready' : 'blocked', results });
      this.change(); return { repo, ...operation };
    } finally { this.busy.delete(operationKey); }
  }
}
