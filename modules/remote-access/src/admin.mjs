import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadConfig, saveConfig, validateConfig } from './config.mjs';
import { readJson, json } from './http-utils.mjs';
import { LifecycleError } from './lifecycle.mjs';

const page = readFileSync(new URL('../public/settings.html', import.meta.url));
const script = readFileSync(new URL('../public/settings.js', import.meta.url));

function authorized(value, key) {
  const actual = Buffer.from(value || ''), expected = Buffer.from(`Bearer ${key}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 本机管理API和公网网关完全分开；回环来源本身不能替代管理凭证。 */
export function createAdmin({ configFile, auth, tunnel, adminKey, onConfigSaved = () => {} }) {
  const server = http.createServer(async (req, res) => {
    try {
      const localHost = `127.0.0.1:${server.address().port}`, localOrigin = `http://${localHost}`;
      if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || req.headers.host !== localHost || (req.headers.origin && req.headers.origin !== localOrigin) || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: '仅允许本机设置页面访问' });
      if (!['GET', 'POST'].includes(req.method)) return json(res, 405, { error: '请求方式不支持' });
      if (req.method === 'POST' && req.headers.origin !== localOrigin) return json(res, 403, { error: '设置请求来源不匹配' });
      const url = new URL(req.url, localOrigin);
      if (req.method === 'GET' && ['/', '/settings.js'].includes(url.pathname)) {
        res.writeHead(200, { 'content-type': url.pathname === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
        return res.end(url.pathname === '/' ? page : script);
      }
      if (!authorized(req.headers.authorization, adminKey)) return json(res, 401, { error: '管理凭据已失效，请在 Mac 上重新打开设置页' });
      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, { passwordConfigured: auth.configured(), tunnel: tunnel.status(), capabilities: { configPatch: 1 } });
      if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, await loadConfig(configFile));
      if (req.method === 'POST' && url.pathname === '/api/config-patch') {
        const patch = await readJson(req, 16384);
        if (Object.keys(patch).some(key => !['publicOrigin','homeUrl','tokenFile','ssh'].includes(key)) || (Object.hasOwn(patch,'ssh') && (!patch.ssh || typeof patch.ssh !== 'object' || Array.isArray(patch.ssh) || Object.keys(patch.ssh).some(key => !['host','port','user','keyFile','remotePort'].includes(key))))) return json(res, 400, { error: '配置字段不支持' });
        let next;
        // Read/merge/validate inside the same queue used by every settings surface, before stopping a valid connection.
        await tunnel.configure(async () => { await saveConfig(configFile, next); await onConfigSaved(next); }, async () => {
          const current = await loadConfig(configFile);
          try { next = validateConfig({ ...current, ...patch, ssh: { ...current.ssh, ...patch.ssh } }); }
          catch { throw Object.assign(new Error('配置格式不正确'), { status: 400 }); }
        });
        return json(res, 200, { ok: true, message: '配置已保存，旧远程连接已停用；测试通过后可重新启用' });
      }
      if (req.method === 'POST' && url.pathname === '/api/config') {
        const body = await readJson(req, 16384);
        let next;
        try { next = validateConfig(body); } catch { return json(res, 400, { error: '配置格式不正确，请检查地址、端口和绝对文件路径' }); }
        const current = await loadConfig(configFile);
        if (['gatewayPort', 'adminPort', 'stateDir'].some(key => current[key] !== next[key])) return json(res, 409, { error: '监听端口或状态目录须停用本访问服务后修改，不影响 Workbench' });
        await tunnel.configure(async () => { await saveConfig(configFile, next); await onConfigSaved(next); });
        return json(res, 200, { ok: true, message: '配置已保存，旧远程连接已停用；测试通过后可重新启用' });
      }
      if (req.method === 'POST' && url.pathname === '/api/password') {
        const { password } = await readJson(req);
        if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 1024) return json(res, 400, { error: '密码至少12个字符，且不超过1024字节' });
        await auth.setPassword(password);
        return json(res, 200, { ok: true, message: '密码已设置，原网页登录已全部失效' });
      }
      if (req.method === 'POST' && url.pathname === '/api/start') {
        if (!auth.configured()) return json(res, 400, { error: '请先在 Mac 上设置访问密码' });
        await tunnel.start(); return json(res, 200, { ok: true, tunnel: tunnel.status() });
      }
      if (req.method === 'POST' && url.pathname === '/api/stop') { await tunnel.stop(); return json(res, 200, { ok: true, tunnel: tunnel.status() }); }
      if (req.method === 'POST' && url.pathname === '/api/test') return json(res, 200, await tunnel.test());
      return json(res, 404, { error: '设置入口不存在' });
    } catch (error) {
      if (error instanceof LifecycleError) return json(res, 503, { error: error.message });
      if (error.status === 413) res.shouldKeepAlive = false;
      const status = [400, 413, 429].includes(error.status) ? error.status : 500;
      json(res, status, { error: status === 413 ? '设置内容过大' : '操作未完成，请核对本机配置和专用密钥后重试' });
    }
  });
  server.requestTimeout = 30000;
  server.on('upgrade', (req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  return server;
}
