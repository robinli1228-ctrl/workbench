// Each repository has one unified branch; devices align to origin's copy of it only in ways that lose nothing, a device
// whose copy moved or was deleted gets another folder (asking first when the current one holds unsaved work), and a
// device or the repository can be removed without deleting any folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { inspectGitRepositoryVersion, alignRepository } from '../src/git-version.mjs';
import { setupRepository } from '../src/setup-workspace.mjs';
import { RepositoryDevices } from '../src/project-repository-devices.mjs';

const URL = 'https://gitee.com/xxxxx/demo.git';
// Binding a folder commits its AGENTS.md/CLAUDE.md there; give this process a Git identity as a device would have.
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }).trim();
const commit = async (cwd, file, text) => { await writeFile(join(cwd, file), text);git(cwd, 'add', '-A');git(cwd, 'commit', '-qm', text); };

/** A bare "origin" reached through the logical Gitee URL, and checkouts that clone it. */
async function remote(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'wb-repo-')));t.after(() => rm(dir, { recursive: true, force: true }));
  const bare = join(dir, 'origin.git');git(dir, 'init', '-q', '--bare', '-b', 'main', bare);
  const clone = async name => {
    const path = join(dir, name);git(dir, 'clone', '-q', bare, path);
    git(path, 'remote', 'set-url', 'origin', URL);git(path, 'config', `url.${bare}.insteadOf`, URL);
    return path;
  };
  const seed = await clone('seed');await commit(seed, 'a.md', 'one');git(seed, 'push', '-q', 'origin', 'HEAD:main');
  git(seed, 'switch', '-qc', 'feature');await commit(seed, 'f.md', 'feature');git(seed, 'push', '-q', 'origin', 'feature');git(seed, 'switch', '-q', 'main');
  return { dir, seed, clone };
}

test('devices are compared with the unified branch and aligned only where nothing is lost', async t => {
  const { seed, clone } = await remote(t);
  const behind = await clone('behind'), dirty = await clone('dirty'), other = await clone('other'), ahead = await clone('ahead');
  git(other, 'switch', '-q', 'feature');
  await commit(ahead, 'mine.md', 'local only');
  await commit(seed, 'a.md', 'two');git(seed, 'push', '-q', 'origin', 'HEAD:main');
  await writeFile(join(dirty, 'a.md'), 'edited, not committed');
  const remoteHead = git(seed, 'rev-parse', 'HEAD');

  const state = await inspectGitRepositoryVersion({ localRoot: other, repoUrl: URL, targetBranch: 'main' });
  assert.equal(state.onTarget, false);assert.equal(state.branch, 'feature');assert.equal(state.remoteCommit, remoteHead);
  assert.equal((await inspectGitRepositoryVersion({ localRoot: behind, repoUrl: URL, targetBranch: 'main' })).behind, 1);

  const updated = await alignRepository({ localRoot: behind, repoUrl: URL, branch: 'main' });
  assert.equal(updated.status, 'updated');assert.equal(git(behind, 'rev-parse', 'HEAD'), remoteHead);
  assert.equal((await alignRepository({ localRoot: behind, repoUrl: URL, branch: 'main' })).status, 'synced');

  const before = git(dirty, 'rev-parse', 'HEAD');
  assert.equal((await alignRepository({ localRoot: dirty, repoUrl: URL, branch: 'main' })).status, 'dirty');
  assert.equal(git(dirty, 'rev-parse', 'HEAD'), before);assert.match(git(dirty, 'status', '--porcelain'), /a\.md/, 'uncommitted work untouched');

  assert.equal((await alignRepository({ localRoot: other, repoUrl: URL, branch: 'main' })).status, 'needs_switch');
  assert.equal(git(other, 'symbolic-ref', '--short', 'HEAD'), 'feature', 'not switched without confirmation');
  const switched = await alignRepository({ localRoot: other, repoUrl: URL, branch: 'main', allowSwitch: true });
  assert.equal(switched.switchedFrom, 'feature');assert.equal(git(other, 'rev-parse', 'HEAD'), remoteHead);
  assert.ok(git(other, 'rev-parse', 'feature'), 'the old branch is kept');

  const diverged = await alignRepository({ localRoot: ahead, repoUrl: URL, branch: 'main' });
  assert.deepEqual([diverged.status, diverged.ahead, diverged.behind], ['diverged', 1, 1]);
  assert.match(git(ahead, 'log', '-1', '--format=%s'), /local only/, 'the unpushed commit stays');
  await assert.rejects(alignRepository({ localRoot: behind, repoUrl: URL, branch: 'no-such-branch' }), /no-such-branch/);
});

test('align never drops commits of a detached HEAD, overwrites ignored files, or follows a branch the remote no longer has', async t => {
  const { seed, clone } = await remote(t);
  // A detached checkout with a commit no branch holds.
  const detached = await clone('detached');git(detached, 'switch', '-q', '--detach');await commit(detached, 'lost.md', 'only here');
  const keep = git(detached, 'rev-parse', 'HEAD');
  assert.equal((await alignRepository({ localRoot: detached, repoUrl: URL, branch: 'main', allowSwitch: true })).status, 'detached_commits');
  assert.equal(git(detached, 'rev-parse', 'HEAD'), keep);
  // A local ignored secret where the target branch tracks a file of the same name.
  const ignored = await clone('ignored');await commit(ignored, '.gitignore', 'secret.env');
  await writeFile(join(ignored, 'secret.env'), 'MY LOCAL SECRET');
  git(seed, 'switch', '-qc', 'tracked');await commit(seed, 'secret.env', 'from the remote');git(seed, 'push', '-q', 'origin', 'tracked');git(seed, 'switch', '-q', 'main');
  await assert.rejects(alignRepository({ localRoot: ignored, repoUrl: URL, branch: 'tracked', allowSwitch: true }));
  assert.equal(execFileSync('cat', [join(ignored, 'secret.env')], { encoding: 'utf8' }), 'MY LOCAL SECRET');
  // The remote deleted the branch: the stale local copy is not followed.
  const stale = await clone('stale');git(stale, 'fetch', '-q', 'origin', '+refs/heads/feature:refs/remotes/origin/feature');
  git(seed, 'push', '-q', 'origin', '--delete', 'feature');
  const result = await alignRepository({ localRoot: stale, repoUrl: URL, branch: 'feature', allowSwitch: true });
  assert.equal(result.status, 'remote_unavailable');assert.equal(git(stale, 'symbolic-ref', '--short', 'HEAD'), 'main');
});

test('another folder for a device, removing a device or the repository, and the unified branch', async t => {
  const { dir, clone } = await remote(t);
  const current = await clone('current'), next = await clone('next');
  await commit(current, 'wip.md', 'unpushed');
  const db = new Store(':memory:'), P = 'p1';
  db.put('projects', { id: P, name: 'demo' });db.put('workers', { id: 'mac', name: 'Macbook', capabilities: { repositoryAlign: 1 } });
  db.put('repositories', { id: `${P}:demo`, projectId: P, key: 'demo', name: 'demo', repoUrl: URL, baseBranch: 'main' });
  db.put('repositoryWorkspaces', { id: `${P}:demo:mac`, projectId: P, repositoryId: `${P}:demo`, nodeId: 'mac', localRoot: current, git: { head: 'x', branch: 'main' } });
  const calls = [];
  const query = async (target, action, input) => {
    calls.push(action);
    if (action === 'project_git_versions') return Promise.all(input.repositories.map(async r => {
      try { return { repositoryId: r.id, ...await inspectGitRepositoryVersion({ ...r, localRoot: r.localRoot }) }; }
      catch (error) { return { repositoryId: r.id, status: error.code === 'ENOENT' ? 'missing' : 'unknown', error: error.message }; }
    }));
    if (action === 'repository_setup') return setupRepository([dir], input);
    if (action === 'repository_align') return alignRepository({ ...input });
    throw new Error(action);
  };
  const admin = { check: id => { if (db.list('runs').some(r => r.projectId === id && r.status === 'running')) throw new Error('running');return db.get('projects', id); } };
  const devices = new RepositoryDevices({ db, admin, query, hosting: { auth: async () => null }, online: () => true, change: () => {}, versions: { refresh: async () => {} } });

  const asked = await devices.moveDevice(P, 'demo', 'mac', { localRoot: next });
  assert.deepEqual([asked.needsConfirm, asked.ahead, asked.localRoot], [true, 1, current], 'unpushed work in the current folder is shown first');
  assert.equal(db.get('repositoryWorkspaces', `${P}:demo:mac`).localRoot, current, 'nothing changed before confirming');
  const moved = await devices.moveDevice(P, 'demo', 'mac', { localRoot: next, confirm: true });
  assert.equal(moved.status, 'ready');assert.equal(db.get('repositoryWorkspaces', `${P}:demo:mac`).localRoot, next);

  // The bound folder was deleted: choosing another one asks nothing.
  await rm(next, { recursive: true, force: true });
  const back = await devices.moveDevice(P, 'demo', 'mac', { localRoot: current });
  assert.equal(back.status, 'ready');assert.equal(db.get('repositoryWorkspaces', `${P}:demo:mac`).localRoot, current);

  // A current folder that cannot be checked (here: not this repository any more) still asks first.
  const foreign = join(dir, 'foreign');git(dir, 'init', '-q', foreign);git(foreign, 'remote', 'add', 'origin', 'https://gitee.com/xxxxx/foreign.git');
  db.put('repositoryWorkspaces', { ...db.get('repositoryWorkspaces', `${P}:demo:mac`), localRoot: foreign });
  const unchecked = await devices.moveDevice(P, 'demo', 'mac', { localRoot: current });
  assert.equal(unchecked.needsConfirm, true);assert.ok(unchecked.error);
  await devices.moveDevice(P, 'demo', 'mac', { localRoot: current, confirm: true });

  // A folder of another repository is refused.
  const otherRepo = join(dir, 'unrelated');git(dir, 'init', '-q', otherRepo);git(otherRepo, 'remote', 'add', 'origin', 'https://gitee.com/xxxxx/other.git');
  await assert.rejects(devices.moveDevice(P, 'demo', 'mac', { localRoot: otherRepo, confirm: true }));

  assert.throws(() => devices.setBranch(P, 'demo', { branch: '-x' }));assert.throws(() => devices.setBranch(P, 'demo', { branch: 'a b' }));
  for (const bad of ['.hidden', 'x.lock/y', 'end.', '@', 'a\tb']) assert.throws(() => devices.setBranch(P, 'demo', { branch: bad }), undefined, bad);
  assert.equal(devices.setBranch(P, 'demo', { branch: '' }).baseBranch, null, 'the branch can be cleared');
  assert.equal(devices.setBranch(P, 'demo', { branch: 'feature' }).baseBranch, 'feature');
  // A device still on an old baseline copy keeps the pinned branch and is not aligned.
  db.put('repositoryWorkspaces', { id: `${P}:demo:srv`, projectId: P, repositoryId: `${P}:demo`, nodeId: 'srv', localRoot: '/xxxxx/.worktrees/project-baseline/demo', baselineBranch: 'agentwb/x' });
  db.put('workers', { id: 'srv', name: 'Debian', capabilities: { repositoryAlign: 1 } });
  assert.throws(() => devices.setBranch(P, 'demo', { branch: 'main' }), /baseline|基线/);
  assert.equal((await devices.align(P, 'demo')).results.find(r => r.nodeId === 'srv').status, 'baseline_copy');
  db.remove('repositoryWorkspaces', `${P}:demo:srv`);
  const aligned = await devices.align(P, 'demo', { allowSwitch: ['mac'] });
  assert.equal(aligned.results[0].switchedFrom, 'main', JSON.stringify(aligned));assert.equal(git(current, 'symbolic-ref', '--short', 'HEAD'), 'feature');

  // A synchronized repository folder does not change under running file sync; a running project changes nothing.
  db.put('sourceSyncConfigs', { id: P, projectId: P, enabled: true, repositoryIds: [`${P}:demo`] });
  await assert.rejects(devices.align(P, 'demo'), /sync|同步/i);assert.throws(() => devices.removeDevice(P, 'demo', 'mac'), /sync|同步/i);
  db.put('sourceSyncConfigs', { id: P, projectId: P, enabled: true, paused: true, repositoryIds: [`${P}:demo`] });
  assert.throws(() => devices.removeRepository(P, 'demo'), /sync|同步/i, 'a repository in the sync scopes is taken out of them first');
  db.remove('sourceSyncConfigs', P);
  db.put('runs', { id: 'r1', projectId: P, status: 'running' });assert.throws(() => devices.removeDevice(P, 'demo', 'mac'), /running/);db.remove('runs', 'r1');

  db.put('deliveries', { id: 'd1', projectId: P, status: 'publishing', items: [{ id: `${P}:demo` }] });
  assert.throws(() => devices.removeRepository(P, 'demo'), /deliver|交付/i);db.put('deliveries', { id: 'd1', projectId: P, status: 'ready', items: [{ id: `${P}:demo` }] });
  assert.deepEqual(devices.removeDevice(P, 'demo', 'mac'), { removed: true });
  assert.deepEqual(devices.removeRepository(P, 'demo'), { removed: true });
  assert.equal(db.get('repositories', `${P}:demo`), null);
  assert.ok(git(current, 'rev-parse', 'HEAD'), 'the folder is still there');
});
