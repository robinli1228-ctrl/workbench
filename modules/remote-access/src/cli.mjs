import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadConfig, saveConfig } from './config.mjs';
import { ensurePrivateDirectory, readPrivateJson } from './private-json.mjs';

async function absent(file) {
  try { await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('文件已存在，拒绝覆盖');
}

function command(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { shell: false, stdio: ['ignore', 'ignore', 'ignore'] });
    child.once('error', () => reject(new Error('本机命令无法启动')));
    child.once('close', code => code === 0 ? resolve() : reject(new Error('本机命令未完成')));
  });
}

/** 首次初始化只生成占位配置，不联网、不覆盖已有设置。 */
export async function initializeConfig(configFile) {
  await absent(configFile);
  const directory = path.dirname(configFile);
  await ensurePrivateDirectory(directory);
  return saveConfig(configFile, { publicOrigin: 'https://relay.example.com', homeUrl: 'http://127.0.0.1:4320',
    tokenFile: path.join(directory, 'home-api-token'), stateDir: path.join(directory, 'state'), gatewayPort: 4321, adminPort: 4322,
    ssh: { host: 'relay.example.com', port: 22, user: 'relay', keyFile: path.join(directory, 'relay-key'), remotePort: 14321 } });
}

/** 专用密钥与原有密钥隔离，任何同名私钥/公钥都拒绝覆盖。 */
export async function generateKey(keyFile) {
  if (!path.isAbsolute(keyFile)) throw new Error('密钥路径必须是绝对路径');
  await absent(keyFile); await absent(`${keyFile}.pub`);
  await ensurePrivateDirectory(path.dirname(keyFile));
  await command('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'workbench-relay', '-f', keyFile]);
  return { privateKeyPath: keyFile, publicKeyPath: `${keyFile}.pub` };
}

/** 管理凭据通过URL片段交给本机页面，不发送给HTTP服务、不输出到终端。 */
export async function openSettings(configFile) {
  if (process.platform !== 'darwin') throw new Error('自动打开设置页目前仅支持 Mac');
  const config = await loadConfig(configFile), admin = await readPrivateJson(path.join(config.stateDir, 'admin.json'));
  if (!admin?.key) throw new Error('请先启动独立访问服务');
  const origin = `http://127.0.0.1:${config.adminPort}`;
  const response = await fetch(`${origin}/api/status`, { headers: { authorization: `Bearer ${admin.key}` }, signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error('本机设置服务尚未就绪');
  await command('/usr/bin/open', [`${origin}/#key=${encodeURIComponent(admin.key)}`]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const action = process.argv[2], index = process.argv.indexOf('--config');
  const configFile = path.resolve(index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : '.local/config.json');
  (async () => {
    if (action === 'init') { await initializeConfig(configFile); console.log('私有占位配置已创建，请填写实际连接信息。'); }
    else if (action === 'generate-key') { const config = await loadConfig(configFile); await generateKey(config.ssh.keyFile); console.log('专用密钥已生成；仅将公钥安装到中转服务器。'); }
    else if (action === 'open-settings') { await openSettings(configFile); console.log('本机设置页已打开。'); }
    else throw new Error('支持 init、generate-key、open-settings；通过 --config 指定本机私有配置');
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
