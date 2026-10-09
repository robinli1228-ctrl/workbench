import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { tr } from './i18n.mjs';

const exec = promisify(execFile);
const env = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oStrictHostKeyChecking=yes -oConnectTimeout=8' });
const git = async (cwd, args) => (await exec('git', args, { cwd, env: env(), timeout: 60000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
const inside = (root, path) => { const r = relative(root, path); return !r || (!r.startsWith('..') && !isAbsolute(r)); };
const repoKey = url => String(url).replace(/^(?:https:\/\/|ssh:\/\/git@|git@)([^/:]+)[:/]/, '$1/').replace(/\/?\.git\/?$/, '').replace(/\/$/, '');

function checkId(runId) { if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(runId)) throw new Error(tr('gitDelivery.invalidRunId')); }
function checkCommit(commit) { if (typeof commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error(tr('gitDelivery.fullGitCommitIdRequired')); }
function checkRef(ref) { if (typeof ref !== 'string' || !/^refs\/heads\/agent-delivery\/[a-zA-Z0-9_-]{1,100}$/.test(ref)) throw new Error(tr('gitDelivery.onlyPlatformDeliveryBranchCan')); }
async function checkRemote(root, repoUrl, push = false) {
  if (!repoUrl || repoKey(await git(root, ['remote', 'get-url', ...(push ? ['--push'] : []), 'origin'])) !== repoKey(repoUrl)) throw new Error(tr('gitDelivery.nodeRepositoryOriginDoesNot'));
}
async function expectedFolder(root, runId) {
  checkId(runId);
  const canonical = await realpath(root), parent = join(canonical, '.worktrees');
  await mkdir(parent, { recursive: true });
  if (!inside(canonical, await realpath(parent))) throw new Error(tr('gitDelivery.workingDirectoryLinkOutBounds'));
  return { root: canonical, folder: join(parent, `run-${runId}`) };
}

/** Create an independent directory at the pinned SHA locally; a retransmission may reuse the directory of the same version, and an existing directory is never switched. */
export async function prepareAtCommit({ root, runId, commit }) {
  checkCommit(commit);
  const paths = await expectedFolder(root, runId);
  if (await git(paths.root, ['cat-file', '-t', commit]) !== 'commit') throw new Error(tr('gitDelivery.objectNotCodeCommit'));
  let exists = false;
  try { exists = (await stat(paths.folder)).isDirectory(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (exists) {
    if (await realpath(paths.folder) !== paths.folder || await realpath(await git(paths.folder, ['rev-parse', '--show-toplevel'])) !== paths.folder) throw new Error(tr('gitDelivery.existingWorkingDirectoryDoesNot'));
    if (await git(paths.folder, ['rev-parse', 'HEAD']) !== commit) throw new Error(tr('gitDelivery.existingWorkingDirectoryCommitDoes'));
  } else await git(paths.root, ['worktree', 'add', '-b', `agent/${runId}`, paths.folder, commit]);
  return { folder: paths.folder, baseCommit: commit };
}

/** Publish only the version already committed in this managed directory; push to a separate ref, with no merge and no force push. */
export async function publishDelivery({ root, workspace, runId, repoUrl, commit, ref, projectScope = false }) {
  checkCommit(commit); checkRef(ref);
  const paths = await expectedFolder(root, runId);
  if (await realpath(workspace) !== (projectScope ? paths.root : paths.folder)) throw new Error(tr('gitDelivery.deliveryDirectoryDoesNotBelong'));
  if (await git(workspace, ['rev-parse', 'HEAD']) !== commit) throw new Error(tr('gitDelivery.deliveryCommitNotCurrentRun'));
  if (await git(workspace, ['status', '--porcelain'])) throw new Error(tr('gitDelivery.workspaceHasUncommittedContentDefine'));
  await checkRemote(paths.root, repoUrl); await checkRemote(paths.root, repoUrl, true);
  const before = await git(paths.root, ['ls-remote', 'origin', ref]);
  if (before && before.split(/\s+/)[0] !== commit) throw new Error(tr('gitDelivery.deliveryBranchAlreadyPointsAnother'));
  if (!before) await git(paths.root, ['push', '--porcelain', 'origin', `${commit}:${ref}`]);
  const confirmed = await git(paths.root, ['ls-remote', 'origin', ref]);
  if (confirmed.split(/\s+/)[0] !== commit) throw new Error(tr('gitDelivery.remoteDeliveryCommitCouldNot'));
  return { repoUrl, commit, ref, status: 'ready' };
}

/** The receiver verifies the SHA after fetching the transfer ref and never treats a moving remote HEAD as the delivered version. */
export async function receiveDelivery({ root, runId, delivery }) {
  checkCommit(delivery?.commit); checkRef(delivery?.ref);
  if (delivery.status !== 'ready') throw new Error(tr('gitDelivery.deliveryNotReadyYet'));
  await checkRemote(root, delivery.repoUrl);
  await git(root, ['fetch', '--no-tags', 'origin', delivery.ref]);
  if (await git(root, ['rev-parse', 'FETCH_HEAD']) !== delivery.commit) throw new Error(tr('gitDelivery.remoteCommitDoesNotMatch'));
  return prepareAtCommit({ root, runId, commit: delivery.commit });
}

/** Home only registers and dispatches deliveries; Git writes must be performed by the source Worker after the work has really finished. */
export class Deliveries {
  constructor(db) { this.db = db; }

  request(run, input) {
    const project = this.db.get('projects', run.projectId);
    if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.requestId)) throw new Error(tr('gitDelivery.invalidDeliveryRequestId'));
    checkCommit(input.commit);
    let items = input.items;
    // Project-scoped Runs carry repositories rather than the retired role-level repositoryUrl.
    // Infer only an unambiguous single repository; preserve legacy delivery fingerprints.
    if (items === undefined && !run.repositoryUrl && !project?.repoUrl) {
      if (run.repositories?.length > 1) throw new Error(tr('gitDelivery.projectDeliveryRequiresAuto'));
      if (run.repositories?.length === 1) {
        const repo = run.repositories[0];
        items = [{ id: repo.id, repoUrl: repo.repoUrl, commit: input.commit }];
      }
    }
    if (items) {
      if (!Array.isArray(items) || !items.length || items.length !== run.repositories?.length || new Set(items.map(i=>i.id)).size !== items.length) throw new Error(tr('gitDelivery.projectDeliveryMustIncludeAll'));
      for (const item of items) {
        const repo = run.repositories.find(r=>r.id===item.id);
        if (!repo || repo.repoUrl !== item.repoUrl) throw new Error(tr('gitDelivery.deliveryRepositoryDoesNotBelong'));
        checkCommit(item.commit);
      }
    }
    const repositoryUrl = items?.[0]?.repoUrl || run.repositoryUrl || project?.repoUrl;
    if (!repositoryUrl) throw new Error(tr('gitDelivery.configureGitRepositoryExecutingRole'));
    const id = createHash('sha256').update(`${run.id}:${input.requestId}`).digest('hex').slice(0, 32);
    const fingerprint = JSON.stringify({ runId: run.id, commit: input.commit, items, repoUrl: repositoryUrl, summary: input.summary || '' });
    const old = this.db.get('deliveries', id);
    if (old) { if (old.fingerprint !== fingerprint) throw new Error(tr('gitDelivery.deliveryIdConflictsWithDifferent')); return old; }
    if (['failed', 'interrupted'].includes(run.status)) throw new Error(tr('gitDelivery.failedRunCannotBeDelivered'));
    if (typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 8000) throw new Error(tr('gitDelivery.deliveryDescriptionMustBe1'));
    return this.db.put('deliveries', { id, projectId: run.projectId, sourceRunId: run.id, sourceNodeId: run.nodeId,
      ...(items ? {items} : {}),
      repositoryId: run.repositoryId || null, commit: input.commit, baseCommit: run.baseCommit || null, repoUrl: repositoryUrl, ref: `refs/heads/agent-delivery/${id}`,
      summary: input.summary.trim(), status: 'waiting_source', fingerprint, approvedAt: null, createdAt: new Date().toISOString() });
  }

  approve(projectId, id) {
    const r = this.db.get('deliveries', id);
    if (r?.projectId !== projectId) throw new Error(tr('gitDelivery.deliveryDoesNotBelongProject'));
    if (!['waiting_source', 'awaiting_approval'].includes(r.status)) throw new Error(tr('gitDelivery.currentDeliveryCannotBeApproved'));
    return this.db.put('deliveries', { ...r, approvedAt: new Date().toISOString() });
  }

  schedule() {
    const nodes = new Set();
    if (this.db.get('settings', 'main')?.paused) return [];
    for (const r of this.db.list('deliveries').filter(d => ['waiting_source', 'awaiting_approval'].includes(d.status))) {
      const run = this.db.get('runs', r.sourceRunId);
      const request = run?.requestId ? this.db.get('coordinationRequests', run.requestId)
        : this.db.list('coordinationRequests').find(c => c.currentRunId === r.sourceRunId);
      if (request?.status === 'cancelled') { this.db.put('deliveries', { ...r, status: 'cancelled', error: tr('gitDelivery.sourceCallWasCancelled') }); continue; }
      if (!run || ['failed', 'interrupted'].includes(run.status)) {
        this.db.put('deliveries', { ...r, status: 'blocked', error: tr('gitDelivery.sourceRunDidNotSucceed') }); continue;
      }
      if (run.status !== 'succeeded') continue;
      if (!r.approvedAt) { if (r.status !== 'awaiting_approval') this.db.put('deliveries', { ...r, status: 'awaiting_approval' }); continue; }
      const project = this.db.get('projects', r.projectId);
      const repositoryUrl = r.repositoryId ? this.db.get('repositories', r.repositoryId)?.repoUrl : project?.repoUrl;
      if (r.items ? r.items.some(item=>this.db.get('repositories',item.id)?.repoUrl !== item.repoUrl) : repositoryUrl !== r.repoUrl) { this.db.put('deliveries', { ...r, status: 'blocked', error: tr('gitDelivery.projectRepositoryConfigurationHasChanged') }); continue; }
      this.db.transaction(() => {
        this.db.put('commands', { id: `delivery:${r.id}`, type: 'delivery_publish', deliveryId: r.id, runId: run.id, nodeId: run.nodeId, acked: false, createdAt: new Date().toISOString() });
        this.db.put('deliveries', { ...r, status: 'publishing' });
      });
      nodes.add(run.nodeId);
    }
    return [...nodes];
  }

  accept(runId, result) {
    const r = this.db.get('deliveries', result?.deliveryId);
    if (!r || r.sourceRunId !== runId) throw new Error(tr('gitDelivery.deliverySourceDoesNotMatch'));
    if (r.status !== 'publishing') return r;
    if (result.status === 'ready' && result.commit === r.commit && result.ref === r.ref) {
      return this.db.put('deliveries', { ...r, status: 'ready', updatedAt: new Date().toISOString() });
    }
    return this.db.put('deliveries', { ...r, status: 'blocked', error: String(result.error || tr('gitDelivery.deliveryVersionNotConfirmed')).slice(0, 1000), updatedAt: new Date().toISOString() });
  }
}
