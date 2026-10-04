import { tr } from './i18n.mjs';
const MAX_REMOTE_DESKTOP_URL = 512;

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
