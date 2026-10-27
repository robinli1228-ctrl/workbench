// A repository is bound where it sits in the project folder, never in a separate baseline copy; a binding left on an older
// baseline copy moves back to its source checkout when the repository is set up again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { ProjectAdmin } from '../src/project-admin.mjs';
import { giteeRepository } from '../src/repository.mjs';
import { setupRepository } from '../src/setup-workspace.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const P = 'p1', URL = 'https://github.com/xxxxx/demo';
function env() {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'demo', folderName: 'demo' });
  for (const id of ['w1', 'w2']) {
    db.put('workers', { id, name: id === 'w1' ? 'server' : 'mac', capabilities: { projectSpace: 1 } });
    db.put('workspaces', { id: `${P}:${id}`, projectId: P, nodeId: id, localRoot: '/xxxxx/demo' });
  }
  const calls = [];
  const query = async (target, kind, body) => {
    calls.push({ kind, body });
    if (kind === 'workspace_check') return { localRoot: body };
    if (kind === 'repository_setup') return { localRoot: body.localRoot, git: { head: 'a'.repeat(40), branch: 'ai_test', dirty: false } };
    if (kind === 'execution_snapshot') return [{ commit: 'b'.repeat(40), dirty: true }];
    throw new Error(`unexpected ${kind}`);
  };
  const admin = new ProjectAdmin(db, query, { auth: async () => null }, () => {});
  return { db, admin, calls };
}

test('a new repository is set up in the project folder without a baseline copy', async () => {
  const e = env();
  const result = await e.admin.repository(P, { mode: 'existing', key: 'code', repoUrl: URL, nodeIds: ['w1'] });
  assert.equal(result.status, 'ready');
  const setup = e.calls.find(c => c.kind === 'repository_setup').body;
  assert.equal(setup.localRoot, '/xxxxx/demo/code');
  assert.equal(setup.projectId, undefined, 'without a project id the Worker binds the checkout itself');
  const binding = e.db.get('repositoryWorkspaces', `${P}:code:w1`);
  assert.equal(binding.localRoot, '/xxxxx/demo/code');
  assert.equal(binding.baselineBranch, undefined);
  assert.equal(e.db.get('repositories', `${P}:code`).baseBranch, null, 'no branch is pinned from the checkout');
});

const baseline = (e, nodeId) => e.db.put('repositoryWorkspaces', { id: `${P}:code:${nodeId}`, projectId: P, repositoryId: `${P}:code`, nodeId,
  localRoot: '/xxxxx/demo/.worktrees/project-baseline/code', sourceRoot: '/xxxxx/demo/code', baselineBranch: 'agentwb/p1', git: { dirty: true } });
const saved = e => e.db.put('repositories', { id: `${P}:code`, projectId: P, key: 'code', name: 'code', repoUrl: giteeRepository(URL).url, baseBranch: 'ai_test' });

test('a binding on an older baseline copy moves back to its source checkout, which must contain the copy\'s commit', async () => {
  const e = env();
  saved(e); baseline(e, 'w1');
  const result = await e.admin.repository(P, { mode: 'existing', key: 'code', repoUrl: URL, nodeIds: ['w1'] });
  assert.equal(result.status, 'ready');
  assert.equal(e.calls.find(c => c.kind === 'repository_setup').body.containsCommit, 'b'.repeat(40), 'the Worker checks the checkout contains the baseline commit');
  const binding = e.db.get('repositoryWorkspaces', `${P}:code:w1`);
  assert.equal(binding.localRoot, '/xxxxx/demo/code');
  assert.equal(binding.baselineBranch, undefined, 'deliveries no longer publish to or advance a baseline copy');
  assert.equal(binding.sourceRoot, undefined);
});

test('every device on a baseline copy moves together, and not while the repository is synced', async () => {
  const e = env();
  saved(e); baseline(e, 'w1'); baseline(e, 'w2');
  await assert.rejects(e.admin.repository(P, { mode: 'existing', key: 'code', repoUrl: URL, nodeIds: ['w1'] }), /mac/);
  e.db.put('sourceSyncConfigs', { id: P, projectId: P, enabled: true, repositoryIds: [`${P}:code`], revision: 1, generation: 1 });
  await assert.rejects(e.admin.repository(P, { mode: 'existing', key: 'code', repoUrl: URL, nodeIds: ['w1', 'w2'] }), /Pause it|暂停/);
  assert.equal(e.db.get('repositoryWorkspaces', `${P}:code:w1`).baselineBranch, 'agentwb/p1', 'nothing moved');
  e.db.put('sourceSyncConfigs', { id: P, projectId: P, enabled: false, repositoryIds: [`${P}:code`], revision: 2, generation: 2 });
  assert.equal((await e.admin.repository(P, { mode: 'existing', key: 'code', repoUrl: URL, nodeIds: ['w1', 'w2'] })).status, 'ready');
});

test('the Worker refuses a source checkout that lacks the baseline commit', async t => {
  const base = await mkdtemp(join(tmpdir(), 'direct-repo-')), root = join(base, 'code');
  t.after(() => rm(base, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x' } }).toString().trim();
  await mkdir(root); git('init', '-q'); git('remote', 'add', 'origin', URL);
  await writeFile(join(root, 'a.txt'), 'a'); git('add', '.'); git('commit', '-qm', 'a');
  const first = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'side'); await writeFile(join(root, 'b.txt'), 'b'); git('add', '.'); git('commit', '-qm', 'b');
  const side = git('rev-parse', 'HEAD'); git('checkout', '-q', '-');
  await setupRepository([base], { repoUrl: URL, localRoot: root, containsCommit: first });
  await assert.rejects(setupRepository([base], { repoUrl: URL, localRoot: root, containsCommit: side }), /does not contain|还不包含/);
});
