// Share links: the relay keeps one record per link (scope, read-only or open, fixed expiry of at most 15 days); the gateway
// turns a link into its own cookie, refuses writes on read-only links and closes pages when a link is revoked; Home signs
// guest messages with the name they typed and the owner's with the user name from Basic Settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuthStore, SHARE_MAX_MS } from '../modules/remote-access/src/auth.mjs';
import { createGateway } from '../modules/remote-access/src/gateway.mjs';
import { Store } from '../src/store.mjs';
import { Rooms } from '../src/rooms.mjs';
import { turnOrigin } from '../src/run-context.mjs';
import { tr } from '../src/i18n.mjs';
import { shareTimeLeft, shareQuery } from '../public/share-settings.js';

const DAY = 86400000;
const scope = { kind: 'group', projectId: 'p1', conversationId: 'p1', title: 'Chat' };

test('share records: fixed expiry of at most 15 days, revocable, and reset with the password', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xxxxx-share-auth-'));
  try {
    let clock = Date.parse('2026-11-17T00:00:00Z');
    const auth = await createAuthStore({ stateDir: dir, now: () => clock });
    await assert.rejects(auth.createShare({ scope, mode: 'ro', ttlMs: SHARE_MAX_MS + 1 }), /分享参数无效/);
    await assert.rejects(auth.createShare({ scope, mode: 'admin', ttlMs: DAY }), /分享参数无效/);
    const share = await auth.createShare({ scope, mode: 'rw', ttlMs: DAY });
    assert.equal(share.expiresAt - share.createdAt, DAY);
    const verified = await auth.verifyShare(share.token);
    assert.deepEqual([verified.id, verified.share.mode, verified.share.scope.projectId], [`share:${share.id}`, 'rw', 'p1']);
    assert.equal(auth.listShares().length, 1);
    // Reloaded from disk, the record is the same; a day later it is gone from both checks.
    const again = await createAuthStore({ stateDir: dir, now: () => clock });
    assert.equal((await again.verifyShare(share.token))?.share.id, share.id);
    clock += DAY + 1;
    assert.equal(await again.verifyShare(share.token), null);
    assert.equal(again.listShares().length, 0);
    // Revoking announces the share's own session id, so the gateway closes pages opened on it.
    const live = await again.createShare({ scope, mode: 'ro', ttlMs: DAY }), revoked = [];
    again.events.on('revoke', id => revoked.push(id));
    assert.equal(await again.revokeShare(live.id), true);
    assert.deepEqual(revoked, [`share:${live.id}`]);
    assert.equal(await again.verifyShare(live.token), null);
    // A new password resets logins and links together.
    const kept = await again.createShare({ scope, mode: 'ro', ttlMs: DAY });
    await again.setPassword('a long enough password');
    assert.equal(await again.verifyShare(kept.token), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

/** A gateway in front of a stand-in Home that records what reached it. */
async function gatewayHarness() {
  const dir = await mkdtemp(join(tmpdir(), 'xxxxx-share-gw-'));
  const seen = [];
  const home = http.createServer((req, res) => { seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  await new Promise(resolve => home.listen(0, '127.0.0.1', resolve));
  const auth = await createAuthStore({ stateDir: dir });
  await auth.setPassword('a long enough password');
  const config = { publicOrigin: 'https://xxxxx.example.com', homeUrl: `http://127.0.0.1:${home.address().port}` };
  const gateway = createGateway({ config, auth, readHomeToken: async () => 'home-token' });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const request = (path, { method = 'GET', cookie = '', accept = 'application/json', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: gateway.address().port, path, method, headers: { host: 'xxxxx.example.com', accept, ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin: 'https://xxxxx.example.com', 'content-type': 'application/json' } : {}), ...headers } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject); req.end(body);
  });
  return { auth, seen, request, close: async () => { gateway.close(); home.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('a share link opens without the password, scoped page in the URL, and read-only links cannot write', async () => {
  const h = await gatewayHarness();
  try {
    const ro = await h.auth.createShare({ scope, mode: 'ro', ttlMs: DAY });
    const opened = await h.request(`/s/${ro.token}`, { accept: 'text/html' });
    assert.equal(opened.status, 302);
    const target = new URL(opened.headers.location, 'https://xxxxx.example.com');
    assert.deepEqual([target.pathname, target.searchParams.get('share'), target.searchParams.get('mode'), target.searchParams.get('projectId'), target.searchParams.get('conversationId')], ['/', 'group', 'ro', 'p1', 'p1']);
    const cookie = String(opened.headers['set-cookie']).split(';')[0];
    assert.match(cookie, /^__Host-wb-share=/);
    const session = JSON.parse((await h.request('/_access/session', { cookie })).text);
    assert.equal(session.share.mode, 'ro');
    // Reads reach Home with Home's own token; writes on a read-only link stop at the gateway.
    assert.equal((await h.request('/api/state', { cookie })).status, 200);
    assert.equal(h.seen.at(-1).authorization, 'Bearer home-token');
    const write = await h.request('/api/projects/p1/messages', { method: 'POST', cookie, body: '{}' });
    assert.equal(write.status, 403);
    assert.equal(h.seen.filter(r => r.method === 'POST').length, 0);
    // A link open to messages lets writes through.
    const rw = await h.auth.createShare({ scope, mode: 'rw', ttlMs: DAY });
    const rwCookie = String((await h.request(`/s/${rw.token}`)).headers['set-cookie']).split(';')[0];
    assert.equal((await h.request('/api/projects/p1/messages', { method: 'POST', cookie: rwCookie, body: '{}' })).status, 200);
    // Only the owner manages links: a guest can neither list them nor make or end one, whatever the link allows.
    const before = h.seen.length;
    for (const [path, method, guest] of [['/api/shares?kind=group&projectId=p1', 'GET', cookie], ['/api/shares', 'POST', rwCookie], [`/api/shares/${ro.id}/revoke`, 'POST', rwCookie]]) {
      assert.equal((await h.request(path, { method, cookie: guest, body: method === 'POST' ? '{}' : undefined })).status, 403);
    }
    assert.equal(h.seen.length, before);
    // Revoked: the link and the cookie it gave both end with a plain notice, not the password page.
    await h.auth.revokeShare(ro.id);
    assert.equal((await h.request(`/s/${ro.token}`, { accept: 'text/html' })).status, 410);
    const stale = await h.request('/', { cookie, accept: 'text/html' });
    assert.equal(stale.status, 410);
    assert.match(stale.text, /这个分享已过期或已被撤销/);
    assert.equal((await h.request('/api/state', { cookie })).status, 401);
  } finally { await h.close(); }
});

test('a link clicked on another site opens; a guest is kept on the share address; the owner never enters share mode', async () => {
  const h = await gatewayHarness();
  try {
    const share = await h.auth.createShare({ scope, mode: 'ro', ttlMs: DAY });
    const crossSite = { 'sec-fetch-site': 'cross-site' };
    const opened = await h.request(`/s/${share.token}`, { accept: 'text/html', headers: { ...crossSite, 'sec-fetch-mode': 'navigate' } });
    assert.equal(opened.status, 302);
    assert.equal((await h.request('/api/state', { headers: { ...crossSite, 'sec-fetch-mode': 'cors' } })).status, 403);
    const cookie = String(opened.headers['set-cookie']).split(';')[0], wanted = opened.headers.location;
    // A bookmark or home-screen icon opening "/" lands on the share address again.
    const home = await h.request('/', { cookie, accept: 'text/html' });
    assert.deepEqual([home.status, home.headers.location], [302, wanted]);
    assert.equal((await h.request(wanted, { cookie, accept: 'text/html' })).status, 200);
    // The owner, logged in, clicking the link stays the owner: no share cookie, and share addresses lead home.
    const login = await h.request('/_access/login', { method: 'POST', body: JSON.stringify({ password: 'a long enough password' }) });
    const owner = String(login.headers['set-cookie']).split(';')[0];
    const ownerClick = await h.request(`/s/${share.token}`, { cookie: owner, accept: 'text/html' });
    assert.deepEqual([ownerClick.status, ownerClick.headers.location, ownerClick.headers['set-cookie']], [302, '/', undefined]);
    const ownerShareUrl = await h.request(wanted, { cookie: owner, accept: 'text/html' });
    assert.deepEqual([ownerShareUrl.status, ownerShareUrl.headers.location], [302, '/']);
  } finally { await h.close(); }
});

test('the owner login wins over a share cookie in the same browser', async () => {
  const h = await gatewayHarness();
  try {
    const share = await h.auth.createShare({ scope, mode: 'ro', ttlMs: DAY });
    const login = await h.request('/_access/login', { method: 'POST', body: JSON.stringify({ password: 'a long enough password' }) });
    const owner = String(login.headers['set-cookie']).split(';')[0];
    const shareCookie = String((await h.request(`/s/${share.token}`)).headers['set-cookie']).split(';')[0];
    const session = JSON.parse((await h.request('/_access/session', { cookie: `${owner}; ${shareCookie}` })).text);
    assert.equal(session.share, undefined);
    assert.equal((await h.request('/api/projects/p1/messages', { method: 'POST', cookie: `${owner}; ${shareCookie}`, body: '{}' })).status, 200);
  } finally { await h.close(); }
});

test('guests sign with their own name; the owner with the user name; roles see who a guest is', () => {
  const N = 'w1', P = 'p1', db = new Store(':memory:');
  db.put('projects', { id: P, name: 'Chat', root: '/tmp/chat' });
  db.put('workers', { id: N, capabilities: { runtimeDiscovery: true, roomRoles: true }, runtimes: [{ type: 'claude', supported: true, available: true, models: [{ id: 'haiku' }] }] });
  db.put('workspaces', { id: `${P}:${N}`, projectId: P, nodeId: N, localRoot: '/tmp/chat' });
  db.put('roles', { id: 'a', projectId: P, name: 'Dev', enabled: true, configured: true, nodeId: N, runtime: 'claude', model: 'haiku' });
  const rooms = new Rooms(db); rooms.touch = () => {};
  const mine = rooms.post(P, { clientMessageId: 'm1', text: '@Dev hello' });
  assert.equal(mine.senderName, tr('rooms.me'));
  assert.equal(mine.guest, undefined);
  db.put('settings', { id: 'main', ownerName: 'Xiaoming' });
  assert.equal(rooms.post(P, { clientMessageId: 'm2', text: '@Dev again' }).senderName, 'Xiaoming');
  const guest = rooms.post(P, { clientMessageId: 'm3', text: '@Dev from a guest', guestName: '  Zhang San  ' });
  assert.deepEqual([guest.senderName, guest.guest], ['Zhang San', true]);
  const task = db.get('tasks', guest.taskIds[0]);
  assert.deepEqual(turnOrigin(db, task, null), { kind: 'human', guest: 'Zhang San' });
  assert.deepEqual(turnOrigin(db, db.get('tasks', db.get('roomMessages', 'm2').taskIds[0]), null), { kind: 'human' });
});

test('share tab helpers: time left and the scope query', () => {
  const t = (text, params) => text.replace(/\{(\w+)\}/g, (_, key) => params[key]);
  const now = Date.parse('2026-11-17T00:00:00Z');
  assert.equal(shareTimeLeft(now + 30 * 60000, t, now), '30 min left');
  assert.equal(shareTimeLeft(now + 5 * 3600000, t, now), '5 h left');
  assert.equal(shareTimeLeft(now + 6 * DAY, t, now), '6 days left');
  assert.equal(shareTimeLeft(now - 1, t, now), 'Expired');
  assert.equal(shareQuery({ kind: 'native', nodeId: 'n1', runtime: 'claude', sessionId: '', entryId: 'e1' }), 'kind=native&nodeId=n1&runtime=claude&entryId=e1');
});
