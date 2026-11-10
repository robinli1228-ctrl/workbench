import { randomUUID } from 'node:crypto';
import { bindRepository } from './project-repositories.mjs';
import { tr } from './i18n.mjs';

// A delivery that is still being made writes into the repository's bindings; one that is ready, blocked or cancelled does not.
const openDelivery = new Set(['waiting_source','awaiting_approval','publishing']);

/** Git's branch-name rules (check-ref-format --branch), checked before anything reaches a device. */
export function validBranchName(name) {
  if (typeof name !== 'string' || !name || name.length > 200 || name.startsWith('-') || name === '@' || name.endsWith('.') || name.endsWith('/')) return false;
  if (/[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\//.test(name)) return false;
  return name.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock'));
}

/**
 * Per-device repository care from the project page: one unified branch per repository that devices align to, another
 * folder for a device whose copy moved or was deleted, and removing a device or the repository. Files are never deleted;
 * alignment only fast-forwards or switches a clean checkout the user confirmed.
 */
export class RepositoryDevices {
  constructor({ db, admin, query, hosting, online, change, versions }) { Object.assign(this, { db, admin, query, hosting, online, change, versions }); }

  repository(projectId, key) {
    this.admin.check(projectId);
    const repo = this.db.get('repositories', `${projectId}:${key}`);
    if (!repo) throw new Error(tr('repositoryDevices.repositoryNotFound'));
    return repo;
  }
  /** A synchronized repository folder must not change under running file sync (the same rule as moving a binding). */
  syncFence(repo) {
    const sync = this.db.get('sourceSyncConfigs', repo.projectId);
    if (sync?.enabled && !sync.paused && (sync.repositoryIds || []).includes(repo.id)) throw new Error(tr('projectAdmin.pauseSyncBeforeMove'));
  }
  bindings(repo) { return this.db.list('repositoryWorkspaces').filter(b => b.repositoryId === repo.id); }
  async refresh(projectId) { try { await this.versions?.refresh(projectId); } catch {} }

  /** The unified branch; empty clears it. A repository still bound to old baseline copies keeps its pinned branch. */
  setBranch(projectId, key, { branch } = {}) {
    const repo = this.repository(projectId, key), value = typeof branch === 'string' ? branch.trim() : '';
    if (value && !validBranchName(value)) throw new Error(tr('gitVersion.invalidUnifiedBranch'));
    if (this.bindings(repo).some(b => b.baselineBranch) && value !== (repo.baseBranch || '')) throw new Error(tr('repositoryDevices.baselineCopyPinned'));
    // The starting commit only applied to the old baseline copies of the previous branch.
    const saved = this.db.put('repositories', { ...repo, baseBranch: value || null, ...(value !== (repo.baseBranch || '') ? { baseCommit: null } : {}), updatedAt: new Date().toISOString() });
    this.change(); void this.refresh(projectId); return saved;
  }

  /** Each online device moves to origin's copy of the unified branch where that loses nothing; the rest say why not. */
  async align(projectId, key, { allowSwitch = [] } = {}) {
    const repo = this.repository(projectId, key);
    if (!repo.baseBranch) throw new Error(tr('repositoryDevices.setUnifiedBranchFirst'));
    this.syncFence(repo);
    const results = await Promise.all(this.bindings(repo).map(async binding => {
      const nodeId = binding.nodeId, worker = this.db.get('workers', nodeId);
      if (!this.online(nodeId)) return { nodeId, status: 'offline' };
      // An old baseline copy follows its own branch; it is moved back to a source checkout with another folder first.
      if (binding.baselineBranch) return { nodeId, status: 'baseline_copy' };
      if (worker?.capabilities?.repositoryAlign !== 1) return { nodeId, status: 'worker_unsupported' };
      try {
        const credential = await this.hosting.auth(repo.accountId, repo.repoUrl);
        return { nodeId, ...await this.query({ nodeId, projectId }, 'repository_align', { projectId, localRoot: binding.localRoot, repoUrl: repo.repoUrl, credential,
          branch: repo.baseBranch, allowSwitch: Array.isArray(allowSwitch) && allowSwitch.includes(nodeId) }, 90000) };
      } catch (error) { return { nodeId, status: 'error', error: error.message }; }
    }));
    await this.refresh(projectId); return { branch: repo.baseBranch, results };
  }

  /** Another folder for one device. A copy with uncommitted or unpushed work waits for the user's confirmation; a missing one does not. */
  async moveDevice(projectId, key, nodeId, { localRoot, confirm = false } = {}) {
    const repo = this.repository(projectId, key);
    this.syncFence(repo);
    if (!this.db.get('workers', nodeId)) throw new Error(tr('projectRepositories.repositoryDeviceDoesNotExist'));
    if (!this.online(nodeId)) throw new Error(tr('repositoryDevices.deviceOffline'));
    if (typeof localRoot !== 'string' || !localRoot.startsWith('/')) throw new Error(tr('setupWorkspace.invalidRepositoryUrlDirectory'));
    const old = this.db.get('repositoryWorkspaces', `${repo.id}:${nodeId}`), credential = await this.hosting.auth(repo.accountId, repo.repoUrl);
    let containsCommit = null;
    if (old?.localRoot && old.localRoot !== localRoot) {
      const [state] = await this.query({ nodeId, projectId }, 'project_git_versions', { repositories: [{ id: repo.id, key: repo.key, repoUrl: repo.repoUrl, localRoot: old.localRoot, credential,
        ...(repo.baseBranch && !old.baselineBranch ? { targetBranch: repo.baseBranch } : {}) }] }, 90000);
      // Only a folder that is gone needs no confirmation; one that could not be checked may still hold work.
      const unknown = !state || state.status === 'unknown' || state.status === 'offline';
      if (!confirm && state?.status !== 'missing' && (unknown || state.dirty || Number(state.ahead) > 0))
        return { needsConfirm: true, localRoot: old.localRoot, branch: state?.branch || null, dirty: Boolean(state?.dirty), ahead: Number(state?.ahead) || 0, ...(unknown ? { error: state?.error || tr('repositoryDevices.currentFolderUnchecked') } : {}) };
      // Leaving an old baseline copy that still exists: the new checkout must already contain the work delivered into it.
      if (old.baselineBranch && state?.status !== 'missing') {
        if (!/^[a-f0-9]{40,64}$/.test(state?.localCommit || '')) throw new Error(tr('projectAdmin.baselineVersionUnavailable'));
        containsCommit = state.localCommit;
      }
    }
    const checked = await this.query({ nodeId }, 'repository_setup', { operationId: `${randomUUID()}-0`, repoUrl: repo.repoUrl, localRoot, clone: false, credential, ...(containsCommit ? { containsCommit } : {}) }, 90000);
    this.admin.check(projectId); this.syncFence(repo);
    const binding = bindRepository(this.db, repo, nodeId, checked);
    this.change(); await this.refresh(projectId); return { status: 'ready', localRoot: binding.localRoot };
  }

  /** The device stops holding this repository for the project; its folder stays where it is. */
  removeDevice(projectId, key, nodeId) {
    const repo = this.repository(projectId, key);
    this.syncFence(repo);
    const id = `${repo.id}:${nodeId}`;
    if (!this.db.get('repositoryWorkspaces', id)) throw new Error(tr('projectRepositories.repositoryDeviceDoesNotExist'));
    this.db.remove('repositoryWorkspaces', id); this.change(); void this.refresh(projectId); return { removed: true };
  }

  /** The project stops using the repository; every device's folder stays. Refused while a delivery into it is still open. */
  removeRepository(projectId, key) {
    const repo = this.repository(projectId, key);
    const sync = this.db.get('sourceSyncConfigs', projectId);
    if (sync?.enabled && (sync.repositoryIds || []).includes(repo.id)) throw new Error(tr('repositoryDevices.removeFromSyncFirst'));
    if (this.db.list('deliveries').some(d => d.projectId === projectId && openDelivery.has(d.status) && (d.repositoryId === repo.id || (d.items || []).some(item => item.id === repo.id))))
      throw new Error(tr('repositoryDevices.deliveryOpen'));
    this.db.transaction(() => {
      for (const binding of this.bindings(repo)) this.db.remove('repositoryWorkspaces', binding.id);
      this.db.remove('repositoryOperations', repo.id);
      this.db.remove('repositories', repo.id);
    });
    this.change(); void this.refresh(projectId); return { removed: true };
  }
}
