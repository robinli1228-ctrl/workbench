// Role-created worktrees under .worktrees sync as ordinary folders with their own Git ignore rules; the platform's run-* and
// project-baseline copies, .git markers and other nested repositories stay out, and an oversized new worktree skips only itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureDirectorySnapshot, sourceFilePath, WORKTREE_MAX_FILES, WORKTREE_LIMITS } from '../src/source-sync-files.mjs';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x' };
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { env: ENV, stdio: 'pipe' }).toString();
const scope = { repositoryId: 'project-files:p', generation: 1, scopePolicy: { sharedDocs: true, excludeRoots: ['repo'] } };

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), 'wt-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  await mkdir(repo); git(repo, 'init', '-q');
  await writeFile(join(repo, '.gitignore'), 'out/\n'); await writeFile(join(repo, 'a.txt'), 'a');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'a');
  await mkdir(join(root, '.worktrees', 'task'), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', 'task', join(root, '.worktrees', 'task', 'repo'));
  await writeFile(join(root, '.worktrees', 'task', 'repo', 'b.txt'), 'b');
  await mkdir(join(root, '.worktrees', 'task', 'repo', 'out')); await writeFile(join(root, '.worktrees', 'task', 'repo', 'out', 'build.log'), 'x');
  for (const dir of ['run-1', 'project-baseline/repo']) { await mkdir(join(root, '.worktrees', dir), { recursive: true }); await writeFile(join(root, '.worktrees', dir, 'c.txt'), 'c'); }
  await mkdir(join(root, 'clone')); git(join(root, 'clone'), 'init', '-q'); await writeFile(join(root, 'clone', 'd.txt'), 'd');
  await writeFile(join(root, 'notes.md'), 'n');
  return root;
}

test('a role-created worktree syncs; platform copies, .git, ignored files and other nested repositories do not', async t => {
  const root = await project(t);
  const { entries, excluded } = await captureDirectorySnapshot({ ...scope, root });
  const paths = Object.keys(entries).sort();
  assert.ok(paths.includes('.worktrees/task/repo/a.txt') && paths.includes('.worktrees/task/repo/b.txt'), 'tracked and new files in the worktree sync');
  assert.ok(paths.includes('notes.md'));
  assert.ok(!paths.some(p => p.endsWith('/.git') || p.includes('/.git/')), 'the .git marker never syncs');
  assert.ok(!paths.some(p => p.includes('/out/')), 'the worktree\'s own .gitignore applies');
  assert.ok(!paths.some(p => p.startsWith('.worktrees/run-1') || p.startsWith('.worktrees/project-baseline')), 'platform copies stay out');
  assert.ok(!paths.some(p => p.startsWith('clone/')) && excluded.some(e => e.path === 'clone' && e.reason === 'nested_repository'), 'other nested repositories stay out');
});

test('a new worktree over the cap skips only itself; one that already synced keeps syncing', async t => {
  const root = await project(t), big = join(root, '.worktrees', 'task', 'repo', 'many');
  await mkdir(big);
  for (let i = 0; i <= WORKTREE_MAX_FILES; i++) await writeFile(join(big, `f${i}.txt`), '');
  const fresh = await captureDirectorySnapshot({ ...scope, root });
  assert.ok(!Object.keys(fresh.entries).some(p => p.startsWith('.worktrees/task/repo/')));
  assert.deepEqual(fresh.excluded.filter(e => e.reason === 'worktree_too_large').map(e => e.path), ['.worktrees/task/repo']);
  assert.ok(fresh.entries['notes.md'], 'the rest of the project still syncs');
  const known = await captureDirectorySnapshot({ ...scope, root, baselineEntries: { '.worktrees/task/repo/a.txt': fresh.entries['notes.md'] } });
  assert.ok(known.entries['.worktrees/task/repo/many/f0.txt'], 'a worktree that synced before is not dropped, which would fence the project');
});

test('a received copy without .git selects the same files, so its build output is not offered back', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wt-recv-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const copy = join(root, '.worktrees', 'task', 'repo');
  await mkdir(join(copy, 'out'), { recursive: true });
  await writeFile(join(copy, '.gitignore'), 'out/\n'); await writeFile(join(copy, 'a.txt'), 'a'); await writeFile(join(copy, 'out', 'build.log'), 'x');
  const sender = await captureDirectorySnapshot({ ...scope, root: await project(t) });
  const receiver = await captureDirectorySnapshot({ ...scope, root });
  assert.ok(receiver.entries['.worktrees/task/repo/a.txt']);
  assert.ok(!Object.keys(receiver.entries).some(p => p.includes('/out/')), 'the plain copy applies the same .gitignore');
  assert.ok(!Object.keys(sender.entries).some(p => p.includes('/out/')));
});

test('a new worktree stops short of the project-wide limits; byte-heavy worktrees skip themselves', async t => {
  const root = await project(t), heavy = join(root, '.worktrees', 'task', 'repo', 'blob.bin');
  await writeFile(heavy, Buffer.alloc(WORKTREE_LIMITS.bytes + 1));
  const { entries, excluded } = await captureDirectorySnapshot({ ...scope, root });
  assert.ok(!Object.keys(entries).some(p => p.startsWith('.worktrees/task/')));
  assert.ok(excluded.some(e => e.path === '.worktrees/task/repo' && e.reason === 'worktree_too_large'));
  assert.ok(entries['notes.md']);
});

test('files can be received into a worktree that has its .git marker', async t => {
  const root = await project(t);
  const target = await sourceFilePath(root, '.worktrees/task/repo/new/e.txt', { createParents: true, policy: scope.scopePolicy });
  assert.equal(target.missing, true);
  await assert.rejects(sourceFilePath(root, 'clone/x.txt', { createParents: true, policy: scope.scopePolicy }), /nested_repository|nested/);
});

test('two devices: a worktree created on one arrives on the other, and its removal propagates', async t => {
  const { fixture } = await import('./metadata-fixture.mjs');
  const f = await fixture(t, { detection: '' });
  const a = join(f.dir, 'a'), repo = join(a, 'src-repo');
  await mkdir(repo); git(repo, 'init', '-q'); await writeFile(join(repo, 'x.txt'), 'x'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'x');
  await mkdir(join(a, '.worktrees', 'fix'), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', 'fix', join(a, '.worktrees', 'fix', 'src-repo'));
  await writeFile(join(a, '.worktrees', 'fix', 'src-repo', 'x.txt'), 'changed in the worktree');
  await mkdir(join(a, '.worktrees', 'run-9'), { recursive: true }); await writeFile(join(a, '.worktrees', 'run-9', 'r.txt'), 'r');
  assert.equal((await f.sync()).status, 'completed');
  const received = join(f.dir, 'b', '.worktrees', 'fix', 'src-repo');
  assert.equal(await readFile(join(received, 'x.txt'), 'utf8'), 'changed in the worktree');
  assert.equal(await stat(join(received, '.git')).catch(() => null), null, 'the other device gets a plain folder');
  assert.equal(await stat(join(f.dir, 'b', '.worktrees', 'run-9')).catch(() => null), null, 'run folders stay on their device');
  git(repo, 'worktree', 'remove', '--force', join(a, '.worktrees', 'fix', 'src-repo'));
  assert.equal((await f.sync()).status, 'completed');
  assert.equal(await stat(join(received, 'x.txt')).catch(() => null), null, 'removing the worktree removes the copy');
});
