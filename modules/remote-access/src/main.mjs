import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { createAuthStore } from './auth.mjs';
import { createGateway } from './gateway.mjs';
import { createAdmin } from './admin.mjs';
import { createTunnel } from './tunnel.mjs';
import { createLifecycle } from './lifecycle.mjs';
import { readPrivateJson, writePrivateJson } from './private-json.mjs';

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
}

function close(server) {
  server.closeAllConnections();
  return server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
}

/** 两个监听器和专用隧道都属于本进程；不查杀任何其他服务。 */
export async function startService(configFile) {
  const config = await loadConfig(configFile);
  const auth = await createAuthStore({ stateDir: config.stateDir });
  const adminKey = randomBytes(32).toString('base64url');
  const enabledFile = path.join(config.stateDir, 'enabled.json');
  const rawTunnel = createTunnel({ loadConfig: () => loadConfig(configFile) });
  const tunnel = createLifecycle({ tunnel: rawTunnel, persistEnabled: enabled => writePrivateJson(enabledFile, { enabled }) });
  const gateway = createGateway({ config, auth, readHomeToken: async () => {
    const handle = await fs.open(config.tokenFile, 'r');
    try {
      const size = (await handle.stat()).size;
      if (size < 1 || size > 4096) throw new Error('凭据文件大小不正确');
      return (await handle.readFile('utf8')).trim();
    } finally { await handle.close(); }
  } });
  const admin = createAdmin({ configFile, auth, tunnel, adminKey, onConfigSaved: next => Object.assign(config, next) });
  let stopping;
  const stop = () => stopping ||= (async () => { await tunnel.shutdown(); await Promise.all([close(gateway), close(admin)]); })();
  try {
    await listen(gateway, config.gatewayPort); await listen(admin, config.adminPort);
    // 只在两个端口都成功绑定后发布新凭据，重复启动失败不能使旧设置页失效。
    await writePrivateJson(path.join(config.stateDir, 'admin.json'), { key: adminKey });
    if ((await readPrivateJson(enabledFile))?.enabled === true && auth.configured()) {
      await tunnel.restore().catch(() => { /* 保留本机管理入口，让用户修复专用密钥。 */ });
    }
    return { gateway, admin, stop };
  } catch (error) { await stop(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const index = process.argv.indexOf('--config');
  const configFile = path.resolve(index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : '.local/config.json');
  startService(configFile).then(service => {
    console.log('独立访问服务已启动；原 Workbench 未修改。');
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { service.stop().catch(() => { process.exitCode = 1; }); });
  }).catch(() => { console.error('独立访问服务启动失败，请检查私有配置、文件权限和端口占用。'); process.exitCode = 1; });
}
