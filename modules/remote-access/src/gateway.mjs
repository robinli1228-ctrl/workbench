import http from 'node:http';
import { readFileSync } from 'node:fs';
import { readJson, json } from './http-utils.mjs';

const loginHtml = readFileSync(new URL('../public/login.html', import.meta.url));
const loginScript = readFileSync(new URL('../public/login.js', import.meta.url));
const cookieName = '__Host-wb-access';
const cookieFlags = 'Path=/; HttpOnly; Secure; SameSite=Lax';
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function copyHeaders(headers) {
  const excluded = new Set([...hopHeaders, ...String(headers.connection || '').toLowerCase().split(',').map(s => s.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !excluded.has(key)));
}

function cookie(req) {
  const values = String(req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`));
  return values.length === 1 ? values[0].slice(cookieName.length + 1) : '';
}

/** 对路径只接受单层规范编码；阻止网关和 Home 对同一路径解释不同。 */
function route(req) {
  if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw Object.assign(new Error('路径无效'), { status: 400 });
  const url = new URL(req.url, 'http://gateway.invalid');
  const decoded = decodeURIComponent(url.pathname);
  if (/[\\%\x00-\x1f\x7f]/.test(decoded) || decoded.startsWith('//')) throw Object.assign(new Error('路径编码无效'), { status: 400 });
  const canonical = new URL(decoded.split('/').map(encodeURIComponent).join('/'), 'http://gateway.invalid').pathname;
  return { pathname: decodeURIComponent(canonical), upstreamPath: canonical + url.search };
}

function workerOnly(pathname) {
  return ['/worker', '/api/agent', '/api/worker', '/api/settings/remote-access'].some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function loginPage(res, status) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(loginHtml);
}

/** 公网只进入该监听器；本机设置在另一个从不转发的监听器中。 */
export function createGateway({ config, auth, readHomeToken }) {
  const active = new Map();
  function revoke(id) {
    for (const [key, connections] of active) if (id === null || key === id) for (const close of [...connections]) close();
  }
  auth.events.on('revoke', revoke);

  const server = http.createServer(async (req, res) => {
    try {
      const publicOrigin = new URL(config.publicOrigin), home = new URL(config.homeUrl);
      if (req.headers.host !== publicOrigin.host || (req.headers.origin && req.headers.origin !== publicOrigin.origin) || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: '访问来源不匹配' });
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return json(res, 405, { error: '请求方式不支持' });
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== publicOrigin.origin) return json(res, 403, { error: '写请求必须来自本站' });
      const { pathname, upstreamPath } = route(req);
      if (workerOnly(pathname)) return json(res, 403, { error: '该接口不向浏览器开放' });

      if (pathname === '/_access/login.js' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return res.end(loginScript);
      }
      if (['/_access', '/_access/', '/_access/login'].includes(pathname) && req.method === 'GET') return loginPage(res, 200);
      if (pathname === '/_access/login' && req.method === 'POST') {
        const body = await readJson(req);
        const login = await auth.login(body.password);
        if (!login) return json(res, 401, { error: auth.configured() ? '密码不正确' : '请先在 Mac 上设置访问密码' });
        return json(res, 200, { ok: true, expiresAt: login.expiresAt }, { 'set-cookie': `${cookieName}=${login.token}; Max-Age=1296000; ${cookieFlags}` });
      }

      const token = cookie(req);
      const session = await auth.verify(token);
      if (!session) {
        if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/' || String(req.headers.accept).includes('text/html'))) return loginPage(res, 401);
        return json(res, 401, { error: '登录已失效，请刷新页面重新登录' });
      }
      if (pathname === '/_access/session' && req.method === 'GET') return json(res, 200, { loggedIn: true, expiresAt: session.expiresAt });
      if (pathname === '/_access/logout' && req.method === 'POST') {
        await auth.logout(token);
        return json(res, 200, { ok: true }, { 'set-cookie': `${cookieName}=; Max-Age=0; ${cookieFlags}` });
      }
      if (pathname === '/_access' || pathname.startsWith('/_access/')) return json(res, 404, { error: '访问入口不存在' });

      let upstream, deadline, finished = false;
      const connections = active.get(session.id) || new Set();
      const close = () => {
        finished = true; upstream?.destroy();
        if (!res.headersSent) json(res, 401, { error: '登录已失效，请重新登录' });
        else if (String(res.getHeader('content-type')).includes('text/event-stream')) res.end();
        else res.destroy();
      };
      connections.add(close); active.set(session.id, connections);
      const expiry = setTimeout(close, Math.max(0, session.expiresAt - Date.now())); expiry.unref();
      function cleanup() {
        finished = true; clearTimeout(expiry); clearTimeout(deadline);
        connections.delete(close); if (!connections.size) active.delete(session.id);
        upstream?.destroy();
      }
      res.once('close', cleanup);
      req.once('aborted', close);
      let homeToken;
      try { homeToken = await readHomeToken(); }
      catch { return json(res, 503, { error: 'Mac 尚未配置 Home 访问凭证' }); }
      if (finished || res.destroyed) return;
      if (typeof homeToken !== 'string' || !homeToken.trim() || /[\r\n]/.test(homeToken)) return json(res, 503, { error: 'Home 访问凭证不可用' });

      const headers = copyHeaders(req.headers);
      for (const key of Object.keys(headers)) if (key === 'cookie' || key === 'authorization' || key === 'forwarded' || key.startsWith('x-forwarded-') || key === 'x-real-ip') delete headers[key];
      headers.host = home.host;
      headers.authorization = `Bearer ${homeToken.trim()}`;
      if (req.headers.origin) headers.origin = home.origin;
      upstream = http.request({ protocol: home.protocol, hostname: home.hostname.replace(/^\[|\]$/g, ''), port: home.port || 80, method: req.method, path: upstreamPath, headers }, response => {
        clearTimeout(deadline);
        if (finished) { response.destroy(); return; }
        const responseHeaders = copyHeaders(response.headers);
        delete responseHeaders['set-cookie'];
        if (pathname.startsWith('/api/') || pathname.startsWith('/media/')) responseHeaders['cache-control'] = 'no-store';
        responseHeaders['x-content-type-options'] = 'nosniff';
        responseHeaders['referrer-policy'] = 'no-referrer';
        for (const [name, value] of Object.entries(responseHeaders)) if (value !== undefined) res.setHeader(name, value);
        res.writeHead(response.statusCode || 502);
        response.on('error', () => res.destroy());
        response.pipe(res);
      });
      // 上传结束后才计算响应等待预算，不能用总时长限制误伤大文件上传。
      upstream.once('finish', () => { deadline = setTimeout(() => upstream.destroy(), 120000); deadline.unref(); });
      upstream.on('error', () => {
        if (finished || res.destroyed) return;
        if (res.headersSent) res.destroy();
        else json(res, 502, { error: 'Mac Home 暂时无法访问，请稍后刷新；本次写请求不会自动重发' });
      });
      req.pipe(upstream);
    } catch (error) {
      const status = [400, 413, 429].includes(error.status) ? error.status : error instanceof URIError ? 400 : 500;
      if (status === 413) res.shouldKeepAlive = false;
      json(res, status, { error: status === 429 ? '登录尝试过于频繁，请稍后再试' : status === 400 ? '请求格式错误' : status === 413 ? '请求内容过大' : '访问服务暂时无法处理请求' }, status === 429 ? { 'retry-after': '60' } : {});
    }
  });
  server.requestTimeout = 0;
  server.on('upgrade', (req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  server.once('close', () => { auth.events.off('revoke', revoke); revoke(null); });
  return server;
}
