import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const children = [];
let stopping = false;
/** The dev command runs two truly independent processes; it does not stand in for cross-machine acceptance testing. */
function start(file) {
  const p = spawn(process.execPath, [file], { cwd: root, stdio: 'inherit', env: process.env });
  children.push(p); p.on('exit', code => { if (!stopping) stop(code || 0); });
}
function stop(code = 0) { stopping = true; for (const p of children) p.kill('SIGTERM'); setTimeout(() => process.exit(code), 2000); }
start('src/home.mjs');
for (let i = 0; i < 40; i++) {
  try { const r = await fetch(`http://127.0.0.1:${process.env.PORT || 4317}/healthz`); if (r.ok) break; } catch {}
  await new Promise(resolve => setTimeout(resolve, 100));
}
if (!stopping) start('src/worker.mjs');
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
