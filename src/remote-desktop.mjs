import { tr } from './i18n.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {isIP} from 'node:net';
const MAX_REMOTE_DESKTOP_URL = 512;
const execute = promisify(execFile);

/**
 * Only accept an RDP or browser gateway address declared by the device itself; credentials must not travel with the link.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeRemoteDesktopUrl(value) {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url || url.length > MAX_REMOTE_DESKTOP_URL) return '';
  if (!/^(?:rdp|https?):\/\//i.test(url)) return '';
  if (/(?:password|passwd|passcode|token|secret)\s*=/i.test(url)) return '';
  return url;
}

/** Desktop connections target registered devices only and always bind to the local loopback address. */
export function normalizeDesktopConfig(input) {
  const desktopUser = String(input?.desktopUser || '').trim();
  if (!desktopUser) return null;
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(desktopUser)) throw new Error(tr('remoteDesktop.invalidRemoteDesktopUser'));
  const desktopPort = Number(input.desktopPort || 3389);
  const desktopLocalPort = Number(input.desktopLocalPort || 3390);
  if (!Number.isInteger(desktopPort) || desktopPort < 1 || desktopPort > 65535) throw new Error(tr('remoteDesktop.invalidRemoteDesktopPort'));
  if (!Number.isInteger(desktopLocalPort) || desktopLocalPort < 1024 || desktopLocalPort > 65535) throw new Error(tr('remoteDesktop.localPortMustBeBetween'));
  return { desktopUser, desktopPort, desktopLocalPort };
}

/** A separate SSH forward does not affect the reverse tunnel used by the Worker. */
export function desktopTunnelSpec(device, keyPath) {
  const config = normalizeDesktopConfig(device);
  if (!config) throw new Error(tr('remoteDesktop.configureRemoteDesktopUserFirst'));
  if (!keyPath || !/^[a-zA-Z0-9._:-]+$/.test(device.host) || !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(device.user)) throw new Error(tr('remoteDesktop.deviceSshTunnelConfigurationUnavailable'));
  return { command: 'ssh', args: [
    '-NT', '-p', String(device.port), '-i', keyPath,
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=10',
    '-L', `127.0.0.1:${config.desktopLocalPort}:127.0.0.1:${config.desktopPort}`,
    `${device.user}@${device.host}`
  ] };
}

/** Only the registered loopback forward and an established SSH connection to its target qualify for reuse. */
export function matchesDesktopTunnel(device, command, connections) {
  const config = normalizeDesktopConfig(device);
  if (!config) return false;
  const words = String(command || '').trim().split(/\s+/);
  if (!['ssh', '/usr/bin/ssh'].includes(words[0]) || words.at(-1) !== `${device.user}@${device.host}`) return false;
  const forward = `127.0.0.1:${config.desktopLocalPort}:127.0.0.1:${config.desktopPort}`;
  const forwards = words.flatMap((word, index) => word === '-L' ? [words[index + 1] || ''] : word.startsWith('-L') ? [word.slice(2)] : []);
  // Without ExitOnForwardFailure, an earlier conflicting bind can win while the intended bind silently fails.
  const samePort = forwards.filter(value => Number(value.match(/^(?:(?:\[[^\]]+\]|[^:]*):)?(\d+):/)?.[1]) === config.desktopLocalPort);
  if (!samePort.length || samePort.some(value => value !== forward)) return false;
  const target = `${isIP(device.host) === 6 ? `[${device.host}]` : device.host}:${Number(device.port)}`;
  return String(connections || '').split('\n').some(line => {
    const remote = line.startsWith('n') ? line.slice(1).split('->')[1] : null;
    return remote && (isIP(device.host) ? remote === target : remote.endsWith(`:${Number(device.port)}`));
  });
}

/** Inspect a same-user listener without taking ownership of it; unknown ports and failed inspection remain blocked. */
export async function probeExistingDesktopTunnel(device) {
  try {
    const config = normalizeDesktopConfig(device);
    if (!config || process.platform !== 'darwin') return null;
    const uid = String(process.getuid());
    const listeners = async () => {
      const {stdout} = await execute('/usr/sbin/lsof', ['-nP','-t','-a',`-iTCP:${config.desktopLocalPort}`,'-sTCP:LISTEN','-u',uid], {timeout:2000});
      return [...new Set(stdout.trim().split(/\s+/).filter(value => /^\d+$/.test(value)))];
    };
    const inspect = async (pid, fields) => (await execute('/bin/ps', ['-ww','-p',pid,'-o',fields], {timeout:2000})).stdout.trim();
    const connectionsOf = async pid => {
      try { return (await execute('/usr/sbin/lsof', ['-nP','-a','-p',pid,'-iTCP','-sTCP:ESTABLISHED','-F','n'], {timeout:2000})).stdout; }
      catch (error) {
        // ProxyCommand may own the socket instead of SSH; only "no connections" permits fallback, not inspection errors.
        if (error.code === 1 && !error.stdout && !error.stderr) return '';
        throw error;
      }
    };
    const pids = await listeners();
    if (pids.length !== 1) return null;
    const pid = pids[0];
    const identity = await inspect(pid, 'lstart=,command='), command = identity.split(/\s+/).slice(5).join(' ');
    let matched = matchesDesktopTunnel(device, command, await connectionsOf(pid));
    if (!matched) {
      // Trust only a direct, same-user system nc transport, not arbitrary descendants or proxy chains.
      if (!isIP(device.host)) return null;
      const {stdout} = await execute('/usr/bin/pgrep', ['-P',pid,'-u',uid,'-x','nc'], {timeout:2000});
      const children = [...new Set(stdout.trim().split(/\s+/).filter(value => /^\d+$/.test(value)))];
      if (children.length !== 1) return null;
      const child = children[0], fields = 'ppid=,uid=,lstart=,command=', before = await inspect(child, fields), words = before.split(/\s+/);
      if (words[0] !== pid || words[1] !== uid || words[7] !== '/usr/bin/nc'
        || words.at(-2) !== device.host || words.at(-1) !== String(Number(device.port))) return null;
      matched = matchesDesktopTunnel(device, command, await connectionsOf(child));
      if (!matched || await inspect(child, fields) !== before) return null;
    }
    // Recheck start time and listener ownership; reuse never grants ownership for later shutdown.
    if (await inspect(pid, 'lstart=,command=') !== identity) return null;
    const current = await listeners();
    return current.length === 1 && current[0] === pid ? {pid:Number(pid)} : null;
  } catch { return null; }
}
