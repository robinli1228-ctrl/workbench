import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { giteeRepository } from './repository.mjs';

/** Credentials are separate from the business database and the status API, and files are replaced atomically to avoid partial writes. */
export class CredentialStore {
  constructor(directory) { this.directory = directory; }
  path(id) { if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid credential ID'); return join(this.directory, `${id}.json`); }
  async get(id) { try { return JSON.parse(await readFile(this.path(id), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
  async set(id, value) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = this.path(id), tmp = `${file}.${randomUUID()}`;
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600 }); await rename(tmp, file);
  }
}

/** Official hosting APIs; external errors return only the status code and never echo requests that contain credentials. */
export class Hosting {
  constructor(db, credentials, request = fetch) { Object.assign(this, { db, credentials, request }); }
  async call(provider, token, path, method = 'GET', input) {
    if (!['github', 'gitee'].includes(provider)) throw new Error('Choose GitHub or Gitee');
    const base = provider === 'github' ? 'https://api.github.com' : 'https://gitee.com/api/v5';
    const url = new URL(`${base}${path}`);
    if (provider === 'gitee' && method === 'GET') url.searchParams.set('access_token',token);
    let response;
    try { response = await this.request(url.href, { method, redirect: 'error', signal: AbortSignal.timeout(25000),
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'AgentWorkbench' },
      ...(input ? { body: JSON.stringify(provider === 'gitee' ? {...input,access_token:token} : input) } : {}) }); }
    catch { throw new Error(`${provider} network request failed or timed out; check the connection and retry`); }
    if (!response.ok) {
      const error=new Error(`${provider} request failed (HTTP ${response.status}); check the account permissions, repository name, or network`);
      // A clearly rejected request can be corrected and retried; timeouts and server-side errors still require checking the remote state.
      error.remoteUncertain=response.status===408 || response.status>=500;
      throw error;
    }
    return response.json();
  }
  async save(input) {
    const old = input.id ? this.db.get('hostingAccounts', input.id) : null;
    if (input.id && !old) throw new Error('Account not found');
    const id = old?.id || randomUUID();
    const token = input.token || (await this.credentials.get(id))?.token;
    if (typeof token !== 'string' || !token || token.length > 4096 || /[\r\n]/.test(token)) throw new Error('Enter a valid access token');
    const provider = old?.provider || input.provider;
    const user = await this.call(provider, token, '/user');
    const owner = input.owner?.trim() || user.login;
    if (!/^[\w.-]{1,100}$/.test(owner || '')) throw new Error('Invalid account or organization name');
    await this.credentials.set(id, { token });
    const result = this.db.put('hostingAccounts', { id, provider, login: user.login, owner, private: input.private !== false,
      label: `${provider} · ${owner}`, verifiedAt: new Date().toISOString() });
    if (input.isDefault || !this.db.get('settings', 'main')?.hostingAccountId) this.db.put('settings', { ...this.db.get('settings', 'main'), id: 'main', hostingAccountId: id });
    return result;
  }
  async auth(accountId, url) {
    if (!accountId) {
      const accounts=this.db.list('hostingAccounts').filter(account=>account.provider===giteeRepository(url)?.provider);
      const preferred=this.db.get('settings','main')?.hostingAccountId;
      accountId=accounts.find(account=>account.id===preferred)?.id || (accounts.length===1?accounts[0].id:null);
      if(!accountId && accounts.length)throw new Error('There are multiple hosting accounts on the same platform; choose an account in the project repository');
      if(!accountId)return null;
    }
    const account = this.db.get('hostingAccounts', accountId), remote = giteeRepository(url);
    if (!account || remote.provider !== account.provider) throw new Error('The repository does not match the hosting account');
    const secret = await this.credentials.get(account.id);
    if (!secret?.token) throw new Error('The account credential is missing; reconnect');
    return { provider: account.provider, login: account.login, token: secret.token };
  }
  async create(accountId, name, description = '') {
    const account = this.db.get('hostingAccounts', accountId);
    const rejected = message => Object.assign(new Error(message), {remoteUncertain:false});
    if (!account) throw rejected('Connect a code-hosting account in the basic settings first');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(name || '')) throw rejected('Invalid repository name');
    const token = (await this.credentials.get(account.id))?.token;
    if (!token) throw rejected('The account credential is missing');
    const org = account.owner !== account.login;
    const path = org ? `/orgs/${encodeURIComponent(account.owner)}/repos` : '/user/repos';
    // "A repository with the same name already exists" is not treated as success; the user must choose to link the existing repository.
    const result = await this.call(account.provider, token, path, 'POST', { name, description: String(description).slice(0,300), private: account.private, auto_init: true });
    const remote = giteeRepository(result.clone_url || result.html_url);
    if (!remote || remote.provider !== account.provider || remote.owner.toLowerCase() !== account.owner.toLowerCase()) throw new Error('The repository identity returned by the remote does not match');
    return remote.url;
  }
}

/** Git credentials are passed only through the child-process environment; they are never written into origin, the command line, or project files. */
export function gitCredentialEnv(url, credential) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oStrictHostKeyChecking=yes -oConnectTimeout=8' };
  if (!credential || !url.startsWith('https://')) return env;
  const remote = giteeRepository(url);
  if (remote.provider !== credential.provider) throw new Error('The Git credential does not match the target platform');
  const login = credential.provider === 'github' ? 'x-access-token' : credential.login;
  const auth = Buffer.from(`${login}:${credential.token}`).toString('base64');
  return { ...env, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: `http.${remote.webUrl}.git.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Basic ${auth}`,
    GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '' };
}

/** The CLI inherits only the private config file path; credentials never enter launch arguments, run logs, or native session configuration. */
export async function runtimeGitEnvironment({directory,key,repositories=[],credentials={},env=process.env}) {
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(key||''))throw new Error('Invalid Git auth configuration ID');
  const home=env.HOME||homedir();
  const includes=env.GIT_CONFIG_GLOBAL?[env.GIT_CONFIG_GLOBAL]:[join(env.XDG_CONFIG_HOME||join(home,'.config'),'git','config'),join(home,'.gitconfig')];
  let content=includes.map(path=>`[include]\n\tpath = ${JSON.stringify(path)}\n`).join('');
  for(const repo of repositories) {
    const credential=credentials[repo.id];if(!credential)continue;
    const remote=giteeRepository(repo.repoUrl);
    if(!remote || remote.provider!==credential.provider || typeof credential.token!=='string' || !credential.token || /[\r\n]/.test(credential.token))throw new Error('The project Git credential is invalid or the platform does not match');
    const login=credential.provider==='github'?'x-access-token':credential.login;
    if(typeof login!=='string'||/[\r\n]/.test(login))throw new Error('Invalid Git account');
    const header=`Authorization: Basic ${Buffer.from(`${login}:${credential.token}`).toString('base64')}`;
    content+=`[http ${JSON.stringify(remote.webUrl+'.git')}]\n\textraHeader =\n\textraHeader = ${JSON.stringify(header)}\n\tfollowRedirects = false\n`;
  }
  await mkdir(directory,{recursive:true,mode:0o700});
  const file=join(directory,`${key}.gitconfig`),temporary=`${file}.${randomUUID()}`;
  await writeFile(temporary,content,{mode:0o600});await rename(temporary,file);
  // The path is fixed per role; the content is replaced atomically every turn so that a kept-alive CLI reads the updated token immediately.
  return {...env,GIT_CONFIG_GLOBAL:file,GIT_TERMINAL_PROMPT:'0'};
}
