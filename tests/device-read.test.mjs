// wb device ls/read on the Worker: read-only, inside the project folder or the owner's WORKER_READ_ROOTS, through
// realpath (links cannot lead outside), secret-looking names refused, bounded text pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { deviceList, deviceRead, readRootsFrom, DEVICE_READ_LIMITS } from '../src/device-read.mjs';

async function layout(t) {
  const base = await mkdtemp(join(tmpdir(), 'device-read-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, 'project'), logs = join(base, 'logs'), outside = join(base, 'outside');
  for (const dir of [project, join(project, 'logs'), join(project, 'config'), logs, outside]) await mkdir(dir, { recursive: true });
  await writeFile(join(project, 'logs', 'app.log'), Array.from({ length: 1500 }, (_, i) => `${i % 10 === 0 ? 'ERROR' : 'INFO'} line ${i}`).join('\n') + '\n');
  await writeFile(join(project, '.env'), 'SECRET=1');
  await writeFile(join(project, 'config', 'credentials.json'), '{}');
  await writeFile(join(project, 'server.key'), 'k');
  await writeFile(join(project, 'image.bin'), Buffer.from([1, 2, 0, 3]));
  await writeFile(join(logs, 'service.log'), 'started\nready\n');
  await writeFile(join(outside, 'private.txt'), 'nope');
  await symlink(join(outside, 'private.txt'), join(project, 'escape.txt'));
  return { project, logs, outside, readRoots: await readRootsFrom([logs, join(base, 'missing')].join(delimiter), delimiter) };
}

test('read roots skip missing folders', async t => {
  const { logs, readRoots } = await layout(t);
  assert.deepEqual(readRoots, [await realpath(logs)]);
});

test('tail, match and pages read text inside the allowed folders', async t => {
  const { project, logs, readRoots } = await layout(t);
  const tail = await deviceRead({ projectRoot: project, readRoots, path: 'logs/app.log', tail: 3 });
  assert.equal(tail.content, 'INFO line 1497\nINFO line 1498\nINFO line 1499');
  const errors = await deviceRead({ projectRoot: project, readRoots, path: 'logs/app.log', tail: 2, match: 'error' });
  assert.equal(errors.content, 'ERROR line 1480\nERROR line 1490');
  const dflt = await deviceRead({ projectRoot: project, readRoots, path: 'logs/app.log' });
  assert.equal(dflt.lines, 200, 'the default is the last 200 lines');
  await assert.rejects(deviceRead({ projectRoot: project, readRoots, path: 'logs/app.log', tail: DEVICE_READ_LIMITS.tailLines + 1 }), e => e.code === 'invalid_tail');
  const first = await deviceRead({ projectRoot: project, readRoots, path: 'logs/app.log', offset: 0, limit: 20 });
  assert.equal(first.content, 'ERROR line 0\nINFO li');
  assert.equal(first.nextOffset, 20);
  const outsideProject = await deviceRead({ projectRoot: project, readRoots, path: join(logs, 'service.log') });
  assert.equal(outsideProject.content, 'started\nready', 'an owner-opened folder outside the project is readable by absolute path');
});

test('a page never splits a multi-byte character', async t => {
  const { project, readRoots } = await layout(t);
  await writeFile(join(project, 'zh.txt'), '日志日志');
  const page = await deviceRead({ projectRoot: project, readRoots, path: 'zh.txt', offset: 0, limit: 4 });
  assert.equal(page.content, '日');
  assert.equal(page.nextOffset, 3);
  assert.equal((await deviceRead({ projectRoot: project, readRoots, path: 'zh.txt', offset: 3, limit: 6 })).content, '志日');
});

test('outside folders, links leading out, secrets and binaries are refused', async t => {
  const { project, outside, readRoots } = await layout(t);
  const code = async (path, extra = {}) => { try { await deviceRead({ projectRoot: project, readRoots, path, ...extra }); return 'read'; } catch (e) { return e.code; } };
  assert.equal(await code(join(outside, 'private.txt')), 'outside_allowed_folders');
  assert.equal(await code('../outside/private.txt'), 'outside_allowed_folders');
  assert.equal(await code('escape.txt'), 'outside_allowed_folders', 'a link inside the project cannot lead out');
  assert.equal(await code('.env'), 'secret_path');
  assert.equal(await code('config/credentials.json'), 'secret_path');
  assert.equal(await code('server.key'), 'secret_path');
  assert.equal(await code('image.bin', { offset: 0, limit: 10 }), 'binary_file');
  assert.equal(await code('missing.log'), 'not_found');
  assert.equal(await code('logs'), 'not_a_file');
});

test('ls lists one folder level without secret names', async t => {
  const { project, readRoots } = await layout(t);
  const listing = await deviceList({ projectRoot: project, readRoots, path: '.' });
  assert.deepEqual(listing.items.map(i => i.name), ['config', 'logs', 'escape.txt', 'image.bin']);
  assert.equal(listing.items.find(i => i.name === 'logs').kind, 'folder');
  await assert.rejects(deviceList({ projectRoot: project, readRoots, path: 'logs/app.log' }), e => e.code === 'not_a_folder');
});

test('review fixes: wider secret names, sniffed binaries, private handoffs, Worker data and too wide roots', async t => {
  const { project, readRoots } = await layout(t);
  for (const name of ['.git-credentials', '.gitconfig', 'id_rsa_github', '.zsh_history', 'app.sqlite', 'deploy_key', 'serviceAccountKey.json', 'my-credentials.txt', '.ENV', 'ＩＤ_RSA'])
    await writeFile(join(project, name), 'x');
  const code = async (path, extra = {}, more = {}) => { try { await deviceRead({ projectRoot: project, readRoots, path, ...extra, ...more }); return 'read'; } catch (e) { return e.code; } };
  for (const name of ['.git-credentials', '.gitconfig', 'id_rsa_github', '.zsh_history', 'app.sqlite', 'deploy_key', 'serviceAccountKey.json', 'my-credentials.txt', '.ENV', 'ＩＤ_RSA'])
    assert.equal(await code(name), 'secret_path', name);
  assert.equal(await code('.env.example'), 'not_found', 'a public example env file is not a secret');
  // A NUL in the first 8 KiB marks the whole file binary, so 1-byte pages cannot spell out its text.
  await writeFile(join(project, 'mixed.dat'), Buffer.concat([Buffer.from([0]), Buffer.from('user=admin pass=hunter')]));
  assert.equal(await code('mixed.dat', { offset: 5, limit: 1 }), 'binary_file');
  // Other roles' private handoffs and the Worker's own data folder stay out.
  await mkdir(join(project, '.workbench', 'handoffs', 'private', 'r2'), { recursive: true });
  await writeFile(join(project, '.workbench', 'handoffs', 'private', 'r2', 'LATEST.md'), 'private');
  assert.equal(await code('.workbench/handoffs/private/r2/LATEST.md'), 'secret_path');
  await mkdir(join(project, 'state'));await writeFile(join(project, 'state', 'w.txt'), 'w');
  assert.equal(await code('state/w.txt', {}, { denyRoots: [await realpath(join(project, 'state'))] }), 'outside_allowed_folders');
  // A refused path reads the same whether or not it exists.
  assert.equal(await code('/no/such/dir/file'), 'outside_allowed_folders');
  assert.equal(await code('.env.local'), 'secret_path');
  assert.deepEqual(await readRootsFrom(['/', join(project, '..', '..', '..')].join(delimiter), delimiter).then(r => r.filter(p => p === '/')), [], 'the filesystem root is never a read root');
});

test('a single over-long log line is cut to the page; match selects tail mode', async t => {
  const { project, readRoots } = await layout(t);
  await writeFile(join(project, 'logs', 'json.log'), 'x'.repeat(200 * 1024) + '\n');
  const page = await deviceRead({ projectRoot: project, readRoots, path: 'logs/json.log' });
  assert.equal(Buffer.byteLength(page.content), DEVICE_READ_LIMITS.bytes);
  assert.equal(page.lineCut, true);
  const matched = await deviceRead({ projectRoot: project, readRoots, path: 'logs/app.log', match: 'line 1499', offset: 0, limit: 10 });
  assert.equal(matched.mode, 'tail');
  assert.equal(matched.content, 'INFO line 1499');
});

test('ls shows a link as a link without following it', async t => {
  const { project, readRoots } = await layout(t);
  const listing = await deviceList({ projectRoot: project, readRoots, path: '.' });
  const link = listing.items.find(i => i.name === 'escape.txt');
  assert.deepEqual([link.kind, link.size, link.modifiedAt], ['link', null, null]);
});

test('source files that merely use the words are readable; data files and keys with them are not', async t => {
  const { project, readRoots } = await layout(t);
  for (const name of ['CredentialService.java', 'token.js', 'secrets.ts', 'serviceaccount.go', 'id_card.jpg', 'ChatHistory.java']) await writeFile(join(project, name), 'x');
  await mkdir(join(project, 'history')); await writeFile(join(project, 'history', 'notes.md'), 'n');
  const code = async path => { try { await deviceRead({ projectRoot: project, readRoots, path }); return 'read'; } catch (e) { return e.code; } };
  for (const name of ['CredentialService.java', 'token.js', 'secrets.ts', 'serviceaccount.go', 'id_card.jpg', 'ChatHistory.java', 'history/notes.md']) assert.equal(await code(name), 'read', name);
  for (const name of ['credentials.json', 'token.txt', 'secrets.yml', 'id_rsa.pub', 'id_ed25519_sk', '.bash_history']) { await writeFile(join(project, name), 'x'); assert.equal(await code(name), 'secret_path', name); }
  // A long line of multi-byte characters is cut between characters, never inside one.
  await writeFile(join(project, 'logs', 'zh.log'), '日'.repeat(30000) + '\n');
  const page = await deviceRead({ projectRoot: project, readRoots, path: 'logs/zh.log' });
  assert.ok(!page.content.includes('�') && Buffer.byteLength(page.content) <= DEVICE_READ_LIMITS.bytes && page.lineCut);
});
