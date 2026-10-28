// A repository URL without a picked account uses the account owning it, then the default, then the platform's only account.
// The settings page shows the same choice before saving (public/project-space.js), and saving basic project information
// without the retired single repository link keeps what is stored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Hosting } from '../src/hosting.mjs';
import { matchHostingAccount } from '../public/project-space.js';

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
});

test('saving basic information without the old repository link keeps it', () => {
  const db = new Store(':memory:');
  db.put('projects', { id: 'p1', name: 'demo', repoUrl: 'https://gitee.com/xxxxx/app.git', repository: { owner: 'xxxxx', repo: 'app' } });
  const saved = db.updateProject('p1', { name: 'renamed', description: 'notes' });
  assert.equal(saved.name, 'renamed');
  assert.equal(saved.repoUrl, 'https://gitee.com/xxxxx/app.git');
  assert.equal(db.updateProject('p1', { name: 'renamed', repoUrl: '' }).repoUrl, '', 'an explicit empty link still clears it');
});
