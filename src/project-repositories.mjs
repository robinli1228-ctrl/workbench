import { giteeRepository } from './repository.mjs';
import { tr } from './i18n.mjs';

/** New roles work at project scope; repositoryId is only a compatibility entry for old runs. */
export function roleWorkspace(db, projectId, nodeId, repositoryId) {
  if (!repositoryId) return db.get('workspaces', `${projectId}:${nodeId}`);
  const repo = db.get('repositories', repositoryId);
  if (repo?.projectId !== projectId) return null;
  return db.get('repositoryWorkspaces', `${repositoryId}:${nodeId}`);
}

/** A repository alias is unique within the project, and the remote URL keeps the existing Gitee validation. */
export function saveRepository(db, projectId, input) {
  if (!db.get('projects', projectId)) throw new Error(tr('projectRepositories.projectNotFound'));
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(input.key || '')) throw new Error(tr('projectRepositories.repositoryIdentifierMayContainOnly'));
  const id = `${projectId}:${input.key}`;
  const remote = giteeRepository(input.repoUrl);
  if (!remote) throw new Error(tr('projectRepositories.provideRepositoryUrl'));
  const old = db.get('repositories', id);
  if (old && old.repoUrl !== remote.url) throw new Error(tr('projectRepositories.existingRepositoryHasDifferentUrl'));
  if (old?.baseBranch && input.baseBranch && old.baseBranch !== input.baseBranch) throw new Error(tr('projectRepositories.projectBaselineSourceBranchPinned'));
  if (old?.baseCommit && input.baseCommit && old.baseCommit !== input.baseCommit) throw new Error(tr('projectRepositories.projectBaselineStartingCommitPinned'));
  return db.put('repositories', { ...old, id, projectId, key: input.key, name: input.key, repoUrl: remote.url,
    baseBranch:input.baseBranch || old?.baseBranch || null, baseCommit:input.baseCommit || old?.baseCommit || null,
    accountId: input.accountId || old?.accountId || null, updatedAt: new Date().toISOString() });
}

export function bindRepository(db, repo, nodeId, checked) {
  if (db.get('repositories', repo.id)?.projectId !== repo.projectId || !db.get('workers', nodeId)) throw new Error(tr('projectRepositories.repositoryDeviceDoesNotExist'));
  if (!checked.git || !checked.localRoot?.startsWith('/')) throw new Error(tr('projectRepositories.targetDirectoryNotValidGit'));
  return db.put('repositoryWorkspaces', { id: `${repo.id}:${nodeId}`, projectId: repo.projectId,
    repositoryId: repo.id, nodeId, ...checked, checkedAt: new Date().toISOString() });
}
