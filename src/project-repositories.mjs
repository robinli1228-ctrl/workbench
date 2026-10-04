import { giteeRepository } from './repository.mjs';

/** New roles work at project scope; repositoryId is only a compatibility entry for old runs. */
export function roleWorkspace(db, projectId, nodeId, repositoryId) {
  if (!repositoryId) return db.get('workspaces', `${projectId}:${nodeId}`);
  const repo = db.get('repositories', repositoryId);
  if (repo?.projectId !== projectId) return null;
  return db.get('repositoryWorkspaces', `${repositoryId}:${nodeId}`);
}

/** A repository alias is unique within the project, and the remote URL keeps the existing Gitee validation. */
export function saveRepository(db, projectId, input) {
  if (!db.get('projects', projectId)) throw new Error('Project not found');
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(input.key || '')) throw new Error('The repository identifier may contain only letters, digits, hyphens, and underscores');
  const id = `${projectId}:${input.key}`;
  const remote = giteeRepository(input.repoUrl);
  if (!remote) throw new Error('Provide a repository URL');
  const old = db.get('repositories', id);
  if (old && old.repoUrl !== remote.url) throw new Error('The existing repository has a different URL; use a new repository identifier');
  if (old?.baseBranch && input.baseBranch && old.baseBranch !== input.baseBranch) throw new Error('The project baseline source branch is pinned; create another repository or handle the original baseline first');
  if (old?.baseCommit && input.baseCommit && old.baseCommit !== input.baseCommit) throw new Error('The project baseline starting commit is pinned; handle the original baseline first');
  return db.put('repositories', { ...old, id, projectId, key: input.key, name: input.key, repoUrl: remote.url,
    baseBranch:input.baseBranch || old?.baseBranch || null, baseCommit:input.baseCommit || old?.baseCommit || null,
    accountId: input.accountId || old?.accountId || null, updatedAt: new Date().toISOString() });
}

export function bindRepository(db, repo, nodeId, checked) {
  if (db.get('repositories', repo.id)?.projectId !== repo.projectId || !db.get('workers', nodeId)) throw new Error('The repository or device does not exist');
  if (!checked.git || !checked.localRoot?.startsWith('/')) throw new Error('The target directory is not a valid Git repository');
  return db.put('repositoryWorkspaces', { id: `${repo.id}:${nodeId}`, projectId: repo.projectId,
    repositoryId: repo.id, nodeId, ...checked, checkedAt: new Date().toISOString() });
}
