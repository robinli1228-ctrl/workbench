import path from 'node:path';
import { isIP } from 'node:net';
import { readPrivateJson, writePrivateJson } from './private-json.mjs';

function port(value, fallback) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > 65535) throw new Error('端口必须在 1 到 65535 之间');
  return result;
}

function absoluteFile(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) throw new Error('文件和状态目录必须使用绝对路径');
  return path.normalize(value);
}

/** 上游限定本机回环，防止保存配置后变成任意目标代理或自循环。 */
export function validateConfig(input) {
  if (!input || typeof input !== 'object') throw new Error('配置不能为空');
  const publicUrl = new URL(input.publicOrigin);
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) throw new Error('公开地址必须是无路径的 HTTPS 地址');
  const home = new URL(input.homeUrl ?? 'http://127.0.0.1:4320');
  if (home.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(home.hostname) || home.username || home.password || home.pathname !== '/' || home.search || home.hash) throw new Error('Home 必须是固定的本机 HTTP 回环地址');
  const gatewayPort = port(input.gatewayPort, 4321), adminPort = port(input.adminPort, 4322);
  if (gatewayPort === adminPort || [gatewayPort, adminPort].includes(Number(home.port || 80))) throw new Error('网关、管理页和 Home 端口不能重复');
  const ssh = input.ssh;
  if (!ssh || typeof ssh.host !== 'string' || !(isIP(ssh.host) || /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(ssh.host))) throw new Error('SSH 地址格式不正确');
  if (typeof ssh.user !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/i.test(ssh.user)) throw new Error('SSH 用户名格式不正确');
  const stateDir = absoluteFile(input.stateDir);
  if (stateDir === path.parse(stateDir).root) throw new Error('不能将系统根目录用作状态目录');
  return {
    publicOrigin: publicUrl.origin, homeUrl: home.origin,
    tokenFile: absoluteFile(input.tokenFile), stateDir, gatewayPort, adminPort,
    ssh: { host: ssh.host, port: port(ssh.port, 22), user: ssh.user, keyFile: absoluteFile(ssh.keyFile), remotePort: port(ssh.remotePort, 14321) },
  };
}

/** 保存前完整校验，失败不得覆盖既有配置或私有凭据。 */
export async function saveConfig(file, input) {
  const config = validateConfig(input);
  await writePrivateJson(file, config);
  return config;
}

/** 真实机器地址只读取本机配置，通用程序没有默认服务器。 */
export async function loadConfig(file) {
  const value = await readPrivateJson(file);
  if (!value) throw new Error('请先创建本机私有配置');
  return validateConfig(value);
}
