import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
import { loadConfig } from '../modules/remote-access/src/config.mjs';
import { readPrivateJson } from '../modules/remote-access/src/private-json.mjs';
import { readJson, json } from '../modules/remote-access/src/http-utils.mjs';

const prefix = '/api/settings/remote-access';
const cookieName = 'wb-local-remote-access';
const proofDuration = 15 * 60 * 1000;
const digest = value => createHash('sha256').update(value).digest('hex');
const failure = (message, status = 503) => Object.assign(new Error(message), { status });

/** Local management is separate from public Home authentication: the gateway cannot forward or receive this cookie. */
export function createRemoteAccessSettings({ configFile, homeOrigin, now = Date.now }) {
  const local = new URL(homeOrigin), proofs = new Map();
  let pending = Promise.resolve();

  function localRequest(req) {
    return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
      && req.headers.host === local.host
      && ['127.0.0.1', 'localhost', '[::1]'].includes(local.hostname)
      && (!req.headers.origin || req.headers.origin === local.origin)
      && (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin')
      && (req.method === 'GET' || req.headers.origin === local.origin);
  }

  function proof(req) {
    const values = String(req.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`));
    if (values.length !== 1) return false;
    const value = values[0].slice(cookieName.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(value) && (proofs.get(digest(value)) || 0) > now();
  }

  /** Only the configured loopback service is called, with its credential kept server-side and bounded response size. */
  async function call(config, route, body) {
    const admin = await readPrivateJson(join(config.stateDir, 'admin.json'));
    if (typeof admin?.key !== 'string' || !admin.key || admin.key.length > 256) throw failure('Remote access service is unavailable.');
    const origin = `http://127.0.0.1:${config.adminPort}`;
    const response = await fetch(`${origin}/api/${route}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${admin.key}`, Origin: origin, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length; if (size > 65536) throw failure('Remote access service returned an invalid response.');
      chunks.push(chunk);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    // Do not forward raw service/configuration errors, which can include private paths.
    if (!response.ok) throw failure(response.status === 400 ? 'Check the server settings or set an access password first.' : 'Operation failed. Check local relay status before retrying.', response.status === 400 ? 400 : 503);
    return result;
  }

  function serialize(operation) {
    const result = pending.then(operation); pending = result.catch(() => {}); return result;
  }

  async function handle(req, res, pathname) {
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return false;
    try {
      if (!localRequest(req)) { json(res, 403, { error: 'Manage remote access on the Home computer.' }); return true; }
      for (const [key, expiry] of proofs) if (expiry <= now()) proofs.delete(key);
      const route = pathname.slice(prefix.length);
      if (route === '/bootstrap' && req.method === 'POST') {
        if (proofs.size >= 64) proofs.delete(proofs.keys().next().value);
        const value = randomBytes(32).toString('base64url'); proofs.set(digest(value), now() + proofDuration);
        json(res, 200, { ok: true }, { 'set-cookie': `${cookieName}=${value}; Path=${prefix}; HttpOnly; SameSite=Strict; Max-Age=900` });
        return true;
      }
      if (!proof(req)) { json(res, 403, { error: 'Reopen Basic Settings on the Home computer.' }); return true; }
      if (route === '/status' && req.method === 'GET') {
        try {
          const config = await loadConfig(configFile), state = await call(config, 'status');
          json(res, 200, { available: true, configurationEditable: state.capabilities?.configPatch === 1, passwordConfigured: state.passwordConfigured === true,
            tunnel: { enabled: state.tunnel?.enabled === true, phase: String(state.tunnel?.phase || 'unknown') },
            host: config.ssh.host, publicOrigin: config.publicOrigin, user: config.ssh.user, port: config.ssh.port });
        } catch { json(res, 200, { available: false, error: 'Remote access service is not configured or is unavailable.' }); }
        return true;
      }
      if (req.method !== 'POST') { json(res, 405, { error: 'Unsupported request method.' }); return true; }
      if (route === '/config') {
        const patch = await readJson(req, 4096);
        if (!patch || Array.isArray(patch) || typeof patch !== 'object' || Object.keys(patch).some(key => !['host', 'publicOrigin', 'user', 'port'].includes(key))) throw failure('Unsupported relay settings.', 400);
        await serialize(async () => {
          const config = await loadConfig(configFile);
          if (!Object.keys(patch).length) return;
          const status = await call(config, 'status');
          if (status.capabilities?.configPatch !== 1) throw failure('Update the remote access service before editing server settings.', 409);
          const change = {}, ssh = {};
          for (const key of ['host', 'user', 'port']) if (Object.hasOwn(patch, key)) ssh[key] = patch[key];
          if (Object.keys(ssh).length) change.ssh = ssh;
          if (Object.hasOwn(patch, 'publicOrigin')) change.publicOrigin = patch.publicOrigin;
          await call(config, 'config-patch', change);
        });
        json(res, 200, { ok: true, message: 'Settings saved. Re-enable remote access when ready.' }); return true;
      }
      if (route === '/password') {
        const input = await readJson(req, 4096);
        if (typeof input?.password !== 'string' || input.password.length < 12 || Buffer.byteLength(input.password) > 1024) throw failure('Use a password with at least 12 characters.', 400);
        await serialize(async () => call(await loadConfig(configFile), 'password', { password: input.password }));
        json(res, 200, { ok: true, message: 'Password updated. Previous browser logins were revoked.' }); return true;
      }
      if (['/start', '/stop', '/test'].includes(route)) {
        const result = await serialize(async () => call(await loadConfig(configFile), route.slice(1), {}));
        json(res, 200, { ok: result.ok !== false }); return true;
      }
      json(res, 404, { error: 'Unknown remote access operation.' });
    } catch (error) {
      const status = [400, 409, 413, 503].includes(error.status) ? error.status : 503;
      json(res, status, { error: [400,409].includes(error.status) ? error.message : status === 413 ? 'Settings are too large.' : 'Remote access operation failed; check the local service before retrying.' });
    }
    return true;
  }
  return { handle };
}
