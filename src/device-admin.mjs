import { spawn } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { desktopTunnelSpec, normalizeDesktopConfig } from './remote-desktop.mjs';
import { tr } from './i18n.mjs';

/** Probes only the local loopback listener and never touches the public desktop port. */
function localPortOpen(port) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

/** Fixed commands run over SSH; the password is passed through the askpass environment and never enters arguments or public records. */
export class DeviceAdmin {
  constructor({ db, credentials, base, data, workerToken, change, homePort, spawnProcess = spawn, tunnelRestartMs = 5000, hostPlatform = process.platform, probePort = localPortOpen }) {
    Object.assign(this, { db, credentials, base, data, workerToken, change, spawnProcess, tunnelRestartMs, hostPlatform, probePort });
    this.homePort = Number(homePort || process.env.PORT || 4317);
    this.running = new Set();
    this.tunnels = new Map();
    this.tunnelTimers = new Map();
    this.desktopTunnels = new Map();
    this.stoppingTunnels = false;
  }

  /** A loopback Home address means the Worker relies on reverse SSH forwarding; other directly reachable addresses are not taken over. */
  tunnelSpec(device, credential) {
    let url;
    try { url = new URL(device?.homeUrl); } catch { return null; }
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !credential?.keyPath) return null;
    const remotePort = Number(url.port || (url.protocol === 'wss:' ? 443 : 80));
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) return null;
    return {
      command: 'ssh',
      args: [
        '-NT', '-p', String(device.port), '-i', credential.keyPath,
        '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=10',
        '-R', `${url.hostname}:${remotePort}:127.0.0.1:${this.homePort}`,
        `${device.user}@${device.host}`,
      ],
    };
  }

  async ensureTunnel(id) {
    if (this.stoppingTunnels || this.tunnels.has(id)) return false;
    const device = this.db.get('devices', id);
    if (!device) return false;
    const spec = this.tunnelSpec(device, await this.credentials.get(id));
    if (!spec) return false;
    const timer = this.tunnelTimers.get(id);
    if (timer) { clearTimeout(timer); this.tunnelTimers.delete(id); }
    const child = this.spawnProcess(spec.command, spec.args, { env: process.env, stdio: 'ignore' });
    this.tunnels.set(id, child);
    const restart = () => {
      if (this.tunnels.get(id) !== child) return;
      this.tunnels.delete(id);
      if (this.stoppingTunnels) return;
      const next = setTimeout(() => {
        this.tunnelTimers.delete(id);
        void this.ensureTunnel(id);
      }, this.tunnelRestartMs);
      next.unref?.();
      this.tunnelTimers.set(id, next);
    };
    child.once('error', restart);
    child.once('close', restart);
    return true;
  }

  async startTunnels() {
    this.stoppingTunnels = false;
    await Promise.all(this.db.list('devices').map(device => this.ensureTunnel(device.id)));
  }

  restartTunnel(id) {
    const child = this.tunnels.get(id);
    this.tunnels.delete(id);
    try { child?.kill('SIGTERM'); } catch {}
    const timer = this.tunnelTimers.get(id);
    if (timer) clearTimeout(timer);
    this.tunnelTimers.delete(id);
    if (!this.stoppingTunnels) void this.ensureTunnel(id);
  }

  stopTunnels() {
    this.stoppingTunnels = true;
    for (const timer of this.tunnelTimers.values()) clearTimeout(timer);
    this.tunnelTimers.clear();
    const children = [...this.tunnels.values()];
    this.tunnels.clear();
    for (const child of children) { try { child.kill('SIGTERM'); } catch {} }
    for (const child of this.desktopTunnels.values()) { try { child.kill('SIGTERM'); } catch {} }
    this.desktopTunnels.clear();
  }

  /** Check the server desktop port first, then set up a dedicated tunnel; a local listener must not be misreported as the remote xrdp being available. */
  async prepareDesktop(id) {
    if (this.hostPlatform !== 'darwin') throw new Error(tr('deviceAdmin.oneClickRemoteDesktopOnly'));
    const device = this.db.get('devices', id);
    if (!device) throw new Error(tr('deviceAdmin.deviceNotFound'));
    const config = normalizeDesktopConfig(device);
    if (!config) throw new Error(tr('deviceAdmin.configureRemoteDesktopUserIn'));
    const credential = await this.credentials.get(id);
    if (!credential?.keyPath) throw new Error(tr('deviceAdmin.oneClickRemoteDesktopNeeds'));
    const remote = await this.ssh(device, `import {connect} from 'node:net';
const socket=connect({host:'127.0.0.1',port:${config.desktopPort}});
const finish=ready=>{socket.destroy();console.log(JSON.stringify({ready}));};
socket.setTimeout(3000);socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.once('timeout',()=>finish(false));`, 15000);
    if (!remote.ready) throw new Error(tr('deviceAdmin.serverXrdpNotListeningOn', { desktopPort: config.desktopPort }));
    let tunnel = this.desktopTunnels.get(id);
    if (tunnel && (tunnel.exitCode !== null || !(await this.probePort(config.desktopLocalPort)))) {
      this.desktopTunnels.delete(id);
      try { tunnel.kill('SIGTERM'); } catch {}
      tunnel = null;
    }
    if (!tunnel) {
      if (await this.probePort(config.desktopLocalPort)) throw new Error(tr('deviceAdmin.localPortInUseBy', { desktopLocalPort: config.desktopLocalPort }));
      const spec = desktopTunnelSpec(device, credential.keyPath);
      tunnel = this.spawnProcess(spec.command, spec.args, { stdio: 'ignore' });
      this.desktopTunnels.set(id, tunnel);
      let exited = false;
      const clear = () => { exited = true; if (this.desktopTunnels.get(id) === tunnel) this.desktopTunnels.delete(id); };
      tunnel.once('error', clear);
      tunnel.once('close', clear);
      let ready = false;
      for (let attempt = 0; attempt < 20 && !exited; attempt++) {
        if (await this.probePort(config.desktopLocalPort)) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!ready) {
        this.desktopTunnels.delete(id);
        try { tunnel.kill('SIGTERM'); } catch {}
        throw new Error(tr('deviceAdmin.sshDesktopTunnelWasNot'));
      }
    }
    return { localPort: config.desktopLocalPort, deviceName: device.name };
  }
  /** Windows App only opens the saved connection list and does not create a new RDP configuration that loses the saved credentials. */
  async launchDesktop(id) {
    if (this.hostPlatform !== 'darwin') throw new Error(tr('deviceAdmin.oneClickRemoteDesktopOnly2'));
    const device = this.db.get('devices', id);
    if (!device) throw new Error(tr('deviceAdmin.deviceNotFound2'));
    const config = normalizeDesktopConfig(device);
    const tunnel = this.desktopTunnels.get(id);
    if (!config || !tunnel || tunnel.exitCode !== null || !(await this.probePort(config.desktopLocalPort))) throw new Error(tr('deviceAdmin.sshDesktopTunnelNotReady'));
    await new Promise((resolve, reject) => {
      // A new connection would not reuse the desktop credentials saved in Windows App; only launch the client and let the user click an existing connection.
      const child = this.spawnProcess('open', ['-a', 'Windows App'], { stdio: 'ignore' });
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(tr('deviceAdmin.localRemoteDesktopClientTimed'))); }, 10000);
      child.once('error', () => { clearTimeout(timer); reject(new Error(tr('deviceAdmin.couldNotStartLocalWindows'))); });
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(tr('deviceAdmin.windowsAppFailedStart'))); });
    });
    return { opened: true, localPort: config.desktopLocalPort };
  }
  /** One-step interface compatible with the original device card entry. */
  async openDesktop(id) {
    await this.prepareDesktop(id);
    return this.launchDesktop(id);
  }
  async save(input) {
    const old = input.id ? this.db.get('devices', input.id) : null;
    if (input.id && !old) throw new Error(tr('deviceAdmin.deviceNotFound3'));
    if (!/^[a-zA-Z0-9._:-]+$/.test(input.host || '') || input.host.startsWith('-')) throw new Error(tr('deviceAdmin.invalidServerAddress'));
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(input.user || '')) throw new Error(tr('deviceAdmin.invalidSshUser'));
    if (!Number.isInteger(Number(input.port || 22)) || Number(input.port || 22) < 1 || Number(input.port || 22) > 65535) throw new Error(tr('deviceAdmin.invalidSshPort'));
    if (typeof input.workspaceRoot !== 'string' || !input.workspaceRoot.startsWith('/') || input.workspaceRoot.includes('\0')) throw new Error(tr('deviceAdmin.defaultWorkspaceMustBeAbsolute'));
    const url = new URL(input.homeUrl);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.pathname !== '/worker' || url.username || url.password || url.search) throw new Error(tr('deviceAdmin.enterHomeAddressReachableFrom'));
    const desktop = normalizeDesktopConfig(input);
    const id = old?.id || randomUUID();
    const priorSecret = await this.credentials.get(id);
    await this.credentials.set(id, { password: input.password || priorSecret?.password || '', keyPath: input.keyPath || priorSecret?.keyPath || '' });
    const value = { id, name: String(input.name || input.host).slice(0,80), host: input.host, user: input.user, port: Number(input.port || 22), workspaceRoot: input.workspaceRoot,
      homeUrl: url.href, nodeId: old?.nodeId || `device-${id}`, status: old?.status || 'saved',
      desktopUser: desktop?.desktopUser || '', desktopPort: desktop?.desktopPort || null, desktopLocalPort: desktop?.desktopLocalPort || null };
    this.db.put('devices', value);
    if (!old || ['host','port','user','homeUrl'].some(key => old[key] !== value[key]) || input.password || input.keyPath) this.restartTunnel(id);
    if (old && ['desktopUser','desktopPort','desktopLocalPort','host','port','user'].some(key => old[key] !== value[key])) {
      const tunnel = this.desktopTunnels.get(id); this.desktopTunnels.delete(id);
      try { tunnel?.kill('SIGTERM'); } catch {}
    }
    this.change(); return value;
  }
  async ssh(device, script, timeout = 30000) {
    const credential = await this.credentials.get(device.id) || {};
    const args = ['-T', '-p', String(device.port), '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10'];
    const env = { ...process.env };
    if (credential.keyPath) args.push('-i', credential.keyPath);
    if (credential.password) {
      const helper = join(this.data, 'ssh-askpass.sh');
      await writeFile(helper, '#!/bin/sh\nprintf "%s" "$WB_SSH_PASSWORD"\n', { mode: 0o700 });
      Object.assign(env, { SSH_ASKPASS: helper, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'agent-workbench', WB_SSH_PASSWORD: credential.password });
    } else args.push('-o', 'BatchMode=yes');
    args.push(`${device.user}@${device.host}`, 'node --input-type=module');
    return new Promise((resolve, reject) => {
      const child = spawn('ssh', args, { env, stdio: ['pipe','pipe','pipe'] });
      let output = '', failure = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
      child.stdout.on('data', b => { if (output.length < 100000) output += b; });
      child.stderr.on('data', b => { if (failure.length < 10000) failure += b; });
      child.on('error', () => { clearTimeout(timer); reject(new Error(tr('deviceAdmin.homeCouldNotStartSsh'))); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(tr('deviceAdmin.sshCheckFailedCheckConnection', { p1: code ?? tr('deviceAdmin.timedOut') })));
        try { resolve(JSON.parse(output.trim().split('\n').at(-1))); } catch { reject(new Error(tr('deviceAdmin.deviceReturnedNoValidCheck'))); }
      });
      child.stdin.on('error', () => {}); child.stdin.end(script);
    });
  }
  async check(id) {
    const d = this.db.get('devices', id); if (!d) throw new Error(tr('deviceAdmin.deviceNotFound4'));
    const r = await this.ssh(d, tr('deviceAdmin.importHostnamePlatformFromNode', { p1: JSON.stringify(d.workspaceRoot) }));
    this.db.put('devices', { ...d, status:'checked', check:r, checkedAt:new Date().toISOString(), error:null }); this.change(); return r;
  }
  async provision(id) {
    const d = this.db.get('devices', id); if (!d) throw new Error(tr('deviceAdmin.deviceNotFound5'));
    if (this.running.has(id)) throw new Error(tr('deviceAdmin.deviceBeingOnboarded'));
    this.running.add(id);
    this.db.put('devices', { ...d, status:'installing', error:null }); this.change();
    try {
      await this.check(id);
      // Distribute only the source code and lock files the Worker needs; never send Home data, project files, or the account store.
      const { readdir } = await import('node:fs/promises');
      const files = {};
      for (const name of await readdir(join(this.base,'src'))) if (name.endsWith('.mjs')) files[`src/${name}`] = await readFile(join(this.base,'src',name),'utf8');
      for (const name of ['package.json','package-lock.json','bin/wb']) files[name] = await readFile(join(this.base,name),'utf8');
      const config = { HOME_URL:d.homeUrl, WORKER_TOKEN:this.workerToken, WORKER_ROOTS:d.workspaceRoot, WORKSPACE_ROOT:d.workspaceRoot, NODE_NAME:d.name, NODE_ID:d.nodeId, NODE_KIND:'cloud' };
      const script = `import {mkdir,writeFile,readFile,open,chmod} from 'node:fs/promises'; import {homedir} from 'node:os'; import {join,dirname} from 'node:path'; import {execFileSync,spawn} from 'node:child_process';
const dir=join(homedir(),'.agent-workbench',${JSON.stringify(d.id)}), config=${JSON.stringify(config)}, files=${JSON.stringify(files)};
await mkdir(dir,{recursive:true}); await mkdir(config.WORKER_ROOTS,{recursive:true});
const data=join(dir,'data'); await mkdir(data,{recursive:true});
let alive=false; try {const pid=Number(await readFile(join(data,'worker.lock'),'utf8')); if(pid>0){process.kill(pid,0);alive=true;}}catch(e){if(e.code==='EPERM')alive=true;}
if(alive){ console.log(JSON.stringify({started:false,alreadyRunning:true})); }
else {
for(const [name,content] of Object.entries(files)){const file=join(dir,name);await mkdir(dirname(file),{recursive:true});await writeFile(file,content);}
await chmod(join(dir,'bin/wb'),0o755); execFileSync('npm',['ci','--omit=dev','--ignore-scripts'],{cwd:dir,stdio:'pipe',timeout:120000});
config.WORKER_DATA_DIR=data; config.PATH=join(homedir(),'.local/bin')+':'+join(homedir(),'.grok/bin')+':'+process.env.PATH; await writeFile(join(dir,'worker-config.json'),JSON.stringify(config),{mode:0o600});
const launcher="import {readFileSync,openSync} from 'node:fs';import {spawn} from 'node:child_process';import {join} from 'node:path';const dir="+JSON.stringify(dir)+";const config=JSON.parse(readFileSync(join(dir,'worker-config.json'),'utf8'));function start(){const log=openSync(join(dir,'worker.log'),'a',0o600);const child=spawn(process.execPath,['src/worker.mjs'],{cwd:dir,env:{...process.env,...config},stdio:['ignore',log,log]});child.on('exit',()=>setTimeout(start,5000));}start();";
await writeFile(join(dir,'launch.mjs'),launcher); const log=await open(join(dir,'launcher.log'),'a',0o600);
const child=spawn(process.execPath,[join(dir,'launch.mjs')],{cwd:dir,detached:true,stdio:['ignore',log.fd,log.fd]});child.unref();await log.close();
console.log(JSON.stringify({started:true,installDirectory:dir,autostart:false})); }
`;
      const result = await this.ssh(d, script, 180000);
      this.db.put('devices', { ...this.db.get('devices',id), status:'waiting_connection', result }); this.change(); return result;
    } catch (e) { this.db.put('devices',{...this.db.get('devices',id),status:'blocked',error:e.message});this.change();throw e; }
    finally { this.running.delete(id); }
  }
}
