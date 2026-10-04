/** Supports HTTPS and SSH addresses of Gitee/GitHub; names keep their case, and credentials are supplied by the connector. */
export function giteeRepository(value = '') {
  if (typeof value !== 'string') throw new Error('Repository URL must be text');
  const text = value.trim();
  if (!text) return null;
  const match = text.match(/^(https:\/\/|git@)(gitee\.com|github\.com)[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  if (!match || ['.', '..'].includes(match[3]) || ['.', '..'].includes(match[4])) throw new Error('Enter a GitHub/Gitee repository URL without a password or token');
  const [, prefix, domain, owner, repo] = match, host = domain.toLowerCase();
  return { url: `${prefix.toLowerCase() === 'git@' ? `git@${host}:` : `https://${host}/`}${owner}/${repo}.git`, webUrl: `https://${host}/${owner}/${repo}`, owner, repo, provider: host.split('.')[0] };
}
