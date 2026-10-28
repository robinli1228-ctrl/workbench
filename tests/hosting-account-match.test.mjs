// A repository URL without a picked account uses the account owning it, then the default, then the platform's only account.
// The settings page shows the same choice before saving (public/project-space.js), and saving basic project information
// without the retired single repository link keeps what is stored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Hosting } from '../src/hosting.mjs';
import { matchHostingAccount, hostingAccountAmbiguous } from '../public/project-space.js';

const credentials = { get: async id => ({ token: `token-${id}` }) };
function hosting(accounts, preferred) {
  const db = new Store(':memory:');
  for (const account of accounts) db.put('hostingAccounts', account);
  if (preferred) db.put('settings', { id: 'main', hostingAccountId: preferred });
  return { db, hosting: new Hosting(db, credentials) };
}
const ORG = { id: 'org', provider: 'gitee', owner: 'xxxxx-org', login: 'xxxxx', label: 'gitee · xxxxx-org' };
const ME = { id: 'me', provider: 'gitee', owner: 'xxxxx', login: 'xxxxx', label: 'gitee · xxxxx' };
const GH = { id: 'gh', provider: 'github', owner: 'xxxxx', login: 'xxxxx', label: 'github · xxxxx' };

test('the account owning the repository wins over the default', async () => {
  const { hosting: h } = hosting([ORG, ME, GH], 'me');
  assert.equal(h.match('https://gitee.com/xxxxx-org/app'), 'org');
  assert.equal((await h.auth(null, 'git@gitee.com:xxxxx-org/app.git')).token, 'token-org');
  assert.equal(h.match('https://gitee.com/someone-else/app'), 'me', 'no owner match falls back to the default');
  assert.equal(h.match('https://github.com/someone-else/app'), 'gh', 'the platform\'s only account');
  assert.equal(matchHostingAccount('https://gitee.com/xxxxx-org/app', [ORG, ME, GH], 'me')?.id, 'org');
  assert.equal(matchHostingAccount('https://gitee.com/someone-else/app', [ORG, ME, GH], 'me')?.id, 'me');
  assert.equal(matchHostingAccount('not a url', [ORG], ''), null);
});

test('several possible accounts without a default stay an error; none means device credentials', async () => {
  const { hosting: h } = hosting([ORG, ME], 'gh-missing');
  assert.equal(h.match('https://gitee.com/someone-else/app'), null);
  await assert.rejects(h.auth(null, 'https://gitee.com/someone-else/app'));
  assert.equal(await hosting([GH]).hosting.auth(null, 'https://gitee.com/xxxxx/app'), null);
  assert.equal(matchHostingAccount('https://gitee.com/someone-else/app', [ORG, ME], ''), null);
  assert.equal(hostingAccountAmbiguous('https://gitee.com/someone-else/app', [ORG, ME], ''), true, 'the page warns instead of promising device credentials');
  assert.equal(hostingAccountAmbiguous('https://github.com/someone-else/app', [ORG, ME], ''), false);
});

test('saving basic information without the old repository link keeps it', () => {
  const db = new Store(':memory:');
  db.put('projects', { id: 'p1', name: 'demo', repoUrl: 'https://gitee.com/xxxxx/app.git', repository: { owner: 'xxxxx', repo: 'app' } });
  const saved = db.updateProject('p1', { name: 'renamed', description: 'notes' });
  assert.equal(saved.name, 'renamed');
  assert.equal(saved.repoUrl, 'https://gitee.com/xxxxx/app.git');
  assert.equal(db.updateProject('p1', { name: 'renamed', repoUrl: '' }).repoUrl, '', 'an explicit empty link still clears it');
});

test('sessions only use the account owning their remote', async () => {
  const { hosting: h } = hosting([ORG, ME, GH], 'me');
  assert.equal(h.match('https://gitee.com/xxxxx-org/app', { ownerOnly: true }), 'org');
  assert.equal(h.match('https://gitee.com/someone-else/app', { ownerOnly: true }), null, 'no default or sole-account fallback for sessions');
  assert.equal(h.match('https://github.com/someone-else/app', { ownerOnly: true }), null);
});

test('a session remembers its remote once, and a changed remote drops an account picked for the old one', async () => {
  const { NativeTurnsHome, nativeSettingsKey } = await import('../src/native-turns.mjs');
  const db = new Store(':memory:');
  const turns = new NativeTurnsHome({ db, send() {}, online: () => true, change() {}, assertIdle() {}, attachments: { resolve: () => [] } });
  const S = '11111111-2222-3333-4444-555555555555', key = nativeSettingsKey('n1', 'claude', S);
  assert.equal(turns.settings('n1', 'claude', S).remoteChecked, false);
  turns.rememberRemote('n1', 'claude', S, null);
  assert.deepEqual([turns.settings('n1', 'claude', S).remoteChecked, turns.settings('n1', 'claude', S).repoUrl], [true, null], 'a folder without a remote is not asked again');
  db.put('nativeSessionSettings', { ...db.get('nativeSessionSettings', key), hostingAccountId: 'me', repoUrl: 'https://gitee.com/xxxxx/a.git' });
  turns.rememberRemote('n1', 'claude', S, 'https://gitee.com/xxxxx/a.git');
  assert.equal(turns.settings('n1', 'claude', S).hostingAccountId, 'me');
  turns.rememberRemote('n1', 'claude', S, 'https://gitee.com/xxxxx/b.git');
  assert.deepEqual([turns.settings('n1', 'claude', S).hostingAccountId, turns.settings('n1', 'claude', S).repoUrl], [null, 'https://gitee.com/xxxxx/b.git']);
  assert.equal(turns.settings('n1', 'claude', S).accountOptOut, false);
  db.put('nativeSessionSettings', { ...db.get('nativeSessionSettings', key), hostingAccountId: null });
  turns.rememberRemote('n1', 'claude', S, 'https://gitee.com/xxxxx/c.git');
  assert.equal(turns.settings('n1', 'claude', S).accountOptOut, true, 'choosing the device credentials earlier stays');
});
