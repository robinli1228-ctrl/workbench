import { randomUUID } from 'node:crypto';
import { folderName } from './project-space.mjs';
import { saveRepository, bindRepository } from './project-repositories.mjs';

/** The page and the configuration assistant share project operations; all paths are computed from the project/device configuration. */
export class ProjectAdmin {
  constructor(db, query, hosting, change) { Object.assign(this, { db, query, hosting, change }); this.busy = new Set(); }
  check(projectId) {
    const project = this.db.get('projects', projectId);
    if (!project) throw new Error('Project not found');
    if (this.db.get('settings', 'main')?.paused) throw new Error('Remote execution is paused');
    if (this.db.list('runs').some(r => r.projectId === projectId && !['succeeded','failed','interrupted'].includes(r.status))) throw new Error('The project is running; change directories or repositories after it finishes');
    return project;
  }
  async prepare(projectId, nodeId) {
    const project = this.check(projectId), worker = this.db.get('workers', nodeId);
    if (!worker || worker.capabilities?.projectSpace !== 1) throw new Error('Upgrade the device Worker before preparing the project directory');
    const existing = this.db.get('workspaces', `${projectId}:${nodeId}`);
    // Existing directories are not moved; all newly participating devices use the stable project folder name.
    const checked = existing ? await this.query({ nodeId }, 'workspace_check', existing.localRoot)
      : await this.query({ nodeId }, 'project_directory', { projectId, folder: folderName(project.folderName), workspaceRoot: worker.workspaceRoot || worker.allowedRoots?.[0] });
    const result = this.db.bindWorkspace(projectId, nodeId, { ...existing, ...checked });
    this.change(); return result;
  }
  async repository(projectId, input) {
    const project = this.check(projectId);
    if (!['existing','create'].includes(input.mode)) throw new Error('Choose to link an existing repository or create a new one');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(input.key || '')) throw new Error('The repository directory name may contain only letters, digits, hyphens, and underscores');
    if (input.baseBranch && (typeof input.baseBranch !== 'string' || input.baseBranch.length > 100 || input.baseBranch.startsWith('-'))) throw new Error('Invalid project baseline source branch');
    if(input.baseCommit && !/^[a-f0-9]{40,64}$/.test(input.baseCommit))throw new Error('The pinned starting point needs a full Git commit ID');
    if (!Array.isArray(input.nodeIds) || !input.nodeIds.length || input.nodeIds.some(id => !this.db.get('workers', id))) throw new Error('Select the participating devices');
    const operationKey = `${projectId}:${input.key}`;
    if (this.busy.has(operationKey)) throw new Error('This repository is being prepared; wait for the result');
    this.busy.add(operationKey);
    try {
      let repo = this.db.get('repositories', operationKey);
      const previous = this.db.get('repositoryOperations', operationKey);
      if (input.mode === 'create' && !repo) {
        if (previous?.status === 'creating_remote' || previous?.status === 'remote_uncertain') throw new Error('The result of the last repository creation is unconfirmed; check the hosting platform and use "link an existing repository" instead of creating it again');
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
        if(snapshot[0]?.dirty || !snapshot[0]?.commit)throw new Error('The existing project baseline is uncommitted or unreadable; handle it before adding the device');
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
