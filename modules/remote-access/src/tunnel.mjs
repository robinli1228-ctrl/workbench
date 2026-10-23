import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { validateConfig } from './config.mjs';

/** 每条隧道有自己的进程，不读取用户SSH配置或复用既有ControlMaster。 */
export function sshArguments(input) {
  const config = validateConfig(input);
  return ['-NTv', '-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ForwardAgent=no',
    '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=10',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-p', String(config.ssh.port), '-i', config.ssh.keyFile,
    '-l', config.ssh.user, '-R', `127.0.0.1:${config.ssh.remotePort}:127.0.0.1:${config.gatewayPort}`, '--', config.ssh.host];
}

/** 只返回错误类别，SSH调试输出中的地址、路径和指纹不进入状态或日志。 */
function errorCategory(line) {
  if (/HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(line)) return '服务器身份校验失败，请先核对主机指纹';
  if (/Permission denied|Load key .*invalid|bad permissions/i.test(line)) return 'SSH 密钥或登录权限不正确';
  if (/remote port forwarding failed/i.test(line)) return '服务器转发端口被占用或未授权';
  if (/timed out|Could not resolve|No route|Network is unreachable|Connection refused/i.test(line)) return '服务器暂时不可达，请检查网络和 SSH 端口';
  return null;
}

/** 管理进程生命周期；测试只替换真实外部SSH进程边界。 */
export function createTunnel({ loadConfig, spawnProcess = spawn }) {
  let child = null, starting = null, enabled = false, phase = 'stopped', error = null;
  let generation = 0, retry = null, retryDelay = 3000, connectedAt = null;
  const status = () => ({ enabled, phase, error, connectedAt });

  function schedule() {
    if (!enabled || retry) return;
    phase = 'retrying';
    retry = setTimeout(() => { retry = null; if (enabled) start().catch(() => {}); }, retryDelay);
    retry.unref(); retryDelay = Math.min(30000, retryDelay * 2);
  }

  async function start() {
    if (child) return status();
    if (starting) return starting;
    enabled = true; const ownGeneration = ++generation;
    starting = (async () => {
      const config = validateConfig(await loadConfig());
      if (config.ssh.host.endsWith('.example.com')) throw new Error('请先填写实际服务器地址');
      const key = await fs.lstat(config.ssh.keyFile);
      if (!key.isFile() || key.isSymbolicLink() || (key.mode & 0o077)) throw new Error('专用密钥必须是权限0600的普通文件');
      if (!enabled || ownGeneration !== generation) return status();
      clearTimeout(retry); retry = null; phase = 'connecting'; error = null;
      const owned = spawnProcess('/usr/bin/ssh', sshArguments(config), { shell: false, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, LC_ALL: 'C' } });
      child = owned;
      let tail = '';
      owned.stderr?.on('data', buffer => {
        if (child !== owned) return;
        tail = (tail + buffer.toString()).slice(-8192);
        for (const line of tail.split('\n').slice(0, -1)) {
          if (/remote forward success for:/.test(line)) { phase = 'connected'; error = null; connectedAt = new Date().toISOString(); retryDelay = 3000; }
          const reason = errorCategory(line); if (reason) error = reason;
        }
        tail = tail.slice(tail.lastIndexOf('\n') + 1);
      });
      owned.on('error', () => { if (child === owned) error = '无法启动专用 SSH 进程'; });
      owned.once('close', () => {
        if (child !== owned) return;
        child = null; connectedAt = null;
        if (enabled) { error ||= 'SSH 连接已断开，正在等待重连'; schedule(); }
        else phase = 'stopped';
      });
      return status();
    })().catch(failure => {
      if (ownGeneration === generation) { enabled = false; phase = 'error'; error = '本机隧道配置或专用密钥尚未就绪'; }
      throw failure;
    }).finally(() => { starting = null; });
    return starting;
  }

  async function stop() {
    enabled = false; generation++; clearTimeout(retry); retry = null;
    // 自动重连也可能正在异步读取配置；等它被 generation 撤销，下一次启用才不会误复用旧 promise。
    if (starting) await starting.catch(() => {});
    const owned = child; child = null; connectedAt = null; phase = 'stopped'; error = null;
    if (!owned) return status();
    await new Promise(resolve => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; clearTimeout(force); resolve(); } };
      const force = setTimeout(() => { owned.kill('SIGKILL'); }, 2000);
      owned.once('close', finish); owned.once('error', finish);
      owned.kill('SIGTERM');
    });
    return status();
  }

  /** 测试可临时使用所需转发端口，但结束后恢复原启停状态。 */
  async function test() {
    const wasEnabled = enabled;
    try {
      await start();
      const until = Date.now() + 12000;
      while (Date.now() < until && enabled && phase !== 'connected') await new Promise(resolve => setTimeout(resolve, 50));
      return { ok: phase === 'connected', message: phase === 'connected' ? '专用 SSH 转发已建立；HTTPS 页面还需单独验证' : error || 'SSH 转发尚未建立' };
    } finally { if (!wasEnabled) await stop(); }
  }
  return { start, stop, status, test };
}
