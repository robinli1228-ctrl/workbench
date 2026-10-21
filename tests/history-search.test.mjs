// wb history search scopes: by role (name, id, supervisor, the human), by file, by time window; the CLI resolves friendly times.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = name => import(pathToFileURL(join(root, 'src', name)).href);
const { History } = await load('history.mjs');
const { Store } = await load('store.mjs');
const { historySearchInput } = await load('wb-tools.mjs');
const i18n = await load('i18n.mjs');
const P = 'proj-1';
const at = h => new Date(Date.UTC(2026, 9, 20, h)).toISOString();

function seed() {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'demo', supervisorRoleId: 'sup' });
  db.put('roles', { id: 'sup', projectId: P, name: '总管', systemSupervisor: true });
  db.put('roles', { id: 'dev', projectId: P, name: 'Dev' });
  db.put('roles', { id: 'qa', projectId: P, name: 'QA' });
  db.put('roomMessages', { id: 'm-human', projectId: P, sender: 'human', senderName: '我', text: 'please fix src/rooms.mjs ordering', createdAt: at(1) });
  db.put('roomMessages', { id: 'm-dev', projectId: P, sender: 'agent', senderName: 'Dev', roleId: 'dev', text: 'changed src/rooms.mjs and public/app.js', createdAt: at(3) });
  db.put('roomMessages', { id: 'm-old-agent', projectId: P, sender: 'agent', senderName: 'QA', text: 'old message without roleId, tests pass', createdAt: at(5) });
  db.put('runs', { id: 'r-dev', projectId: P, roleId: 'dev', roleSnapshot: { name: 'Dev' }, result: 'implemented the ordering fix', createdAt: at(4), updatedAt: at(4) });
  db.put('runReports', { id: 'r-dev', projectId: P, roleId: 'dev', files: [{ path: 'docs/ordering-notes.md', bytes: 10, sha256: 'x' }] });
  db.put('runs', { id: 'r-qa', projectId: P, roleId: 'qa', roleSnapshot: { name: 'QA' }, result: 'verified ordering on the page', createdAt: at(7), updatedAt: at(7) });
  db.put('coordinationRequests', { id: 'c-1', projectId: P, targetRoleId: 'qa', sourceRunId: 'r-dev', summary: 'test the ordering fix', result: 'passed', createdAt: at(6), updatedAt: at(6) });
  return db;
}
const ids = page => page.items.map(item => item.id).sort();
const search = (db, input) => i18n.runWithLanguage('en', () => new History(db).search(P, input));

test('no scope keeps today\'s full-text behaviour', () => {
  const db = seed();
  assert.deepEqual(ids(search(db, { query: 'ordering' })), ['c-1', 'm-human', 'r-dev', 'r-qa']);
  assert.equal(search(db, { query: 'ordering' }).scope, undefined);
});

test('by role: name, id, the supervisor by its default name, the human, and both sides of a call', () => {
  const db = seed();
  assert.deepEqual(ids(search(db, { role: 'dev' })), ['c-1', 'm-dev', 'r-dev'], 'a call counts for the role whose run sent it');
  assert.deepEqual(ids(search(db, { role: 'QA' })), ['c-1', 'm-old-agent', 'r-qa'], 'name match is case-insensitive; an old message matches by sender name');
  assert.deepEqual(ids(search(db, { role: ['我'] })), ['m-human']);
  assert.deepEqual(ids(search(db, { role: ['Dev', 'me'], query: 'src/rooms.mjs' })), ['m-dev', 'm-human']);
  assert.deepEqual(search(db, { role: 'Supervisor' }).items, [], 'the supervisor resolves by either default name');
  assert.deepEqual(search(db, { role: 'dev' }).scope, { roles: ['Dev'] });
  assert.throws(() => search(db, { role: 'ghost' }), /No role "ghost"/, 'an unknown role is an error, not an empty result');
  assert.throws(() => search(db, { role: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }), /1 to 8/);
});

test('by file: a path the text names, or a file the role\'s report attached', () => {
  const db = seed();
  assert.deepEqual(ids(search(db, { file: 'src/rooms.mjs' })), ['m-dev', 'm-human']);
  assert.deepEqual(ids(search(db, { file: './public/app.js' })), ['m-dev'], 'a leading ./ is ignored');
  assert.deepEqual(ids(search(db, { file: 'docs/ordering-notes.md' })), ['r-dev'], 'report attachments count');
});

test('by time window, combined with role and keyword, before paging', () => {
  const db = seed();
  assert.deepEqual(ids(search(db, { since: at(4), until: at(6) })), ['c-1', 'm-old-agent', 'r-dev']);
  assert.deepEqual(ids(search(db, { since: at(4), role: 'qa', query: 'ordering' })), ['c-1', 'r-qa']);
  const seen = [];let cursor = null, pages = 0;
  do { const page = search(db, { since: at(2), limit: 2, cursor }); assert.ok(page.items.length <= 2); seen.push(...ids(page)); cursor = page.nextCursor; pages++; } while (cursor);
  assert.equal(pages, 3);
  assert.deepEqual(seen.sort(), ['c-1', 'm-dev', 'm-old-agent', 'r-dev', 'r-qa'], 'the window applies before paging, nothing outside it and nothing lost');
  assert.throws(() => search(db, { since: 'not a time' }), /since is not a valid time/);
  assert.throws(() => search(db, { since: at(6), until: at(2) }), /since must not be later/);
});

test('the CLI turns flags and friendly times into the search input', () => {
  const now = new Date(2026, 9, 21, 15, 30);
  const local = (y, m, d, h = 0, min = 0, s = 0, ms = 0) => new Date(y, m, d, h, min, s, ms).toISOString();
  assert.deepEqual(historySearchInput(['ordering', 'fix'], now), { query: 'ordering fix' });
  assert.deepEqual(historySearchInput(['--role', 'Dev', '--role', 'QA', '--file', 'src/rooms.mjs', 'bug'], now), { query: 'bug', role: ['Dev', 'QA'], file: 'src/rooms.mjs' });
  assert.equal(historySearchInput(['--since', '2h'], now).since, new Date(now.getTime() - 7200e3).toISOString());
  assert.equal(historySearchInput(['--since', '3d'], now).since, new Date(now.getTime() - 3 * 86400e3).toISOString());
  assert.equal(historySearchInput(['--since', 'today'], now).since, local(2026, 9, 21));
  assert.deepEqual(historySearchInput(['--since', 'yesterday', '--until', 'yesterday'], now), { query: '', since: local(2026, 9, 20), until: local(2026, 9, 20, 23, 59, 59, 999) });
  assert.deepEqual(historySearchInput(['--since', '2026-10-19', '--until', '2026-10-20'], now), { query: '', since: local(2026, 9, 19), until: local(2026, 9, 20, 23, 59, 59, 999) });
  assert.equal(historySearchInput(['--until', '2026-10-20T08:00:00Z'], now).until, '2026-10-20T08:00:00.000Z');
  assert.deepEqual(historySearchInput(['--limit', '5', '--', '--literal'], now), { query: '--literal', limit: 5 });
  for (const bad of [['--since'], ['--bogus', 'x'], ['--since', 'someday'], ['--limit', 'x'], ['--file', 'a', '--file', 'b']])
    assert.throws(() => i18n.runWithLanguage('en', () => historySearchInput(bad, now)), /Usage: wb history search/, JSON.stringify(bad));
});
