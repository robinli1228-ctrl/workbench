// The Claude model probe must let the CLI exit on its own: a kill during start-up can lose a login it was renewing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeClaudeModels } from '../src/runtime-probe.mjs';

const fake = (dir, { leaveOnEof }) => {
  const bin = join(dir, 'claude'), log = join(dir, 'log');
  writeFileSync(bin, `#!/usr/bin/env node
const fs=require('node:fs'),log=${JSON.stringify(log)},note=s=>fs.appendFileSync(log,s+'\\n');
process.on('SIGTERM',()=>note('sigterm'));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
 if(m.request?.subtype==='initialize')console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{models:[{value:'opus'}]}}}));
}).on('close',()=>{note('eof');if(${leaveOnEof})process.exit(0);setInterval(()=>{},1000);});
`.replace('#!/usr/bin/env node\n', '#!/usr/bin/env node\nconst require=(await import("node:module")).createRequire(import.meta.url);\n'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  chmodSync(bin, 0o755);
  return { bin, log };
};
const until = async (check, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return true; await new Promise(r => setTimeout(r, 20)); } return false; };

test('the Claude probe answers at once but leaves the CLI running until start-up settles, then lets it exit by itself', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-claude-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { bin, log } = fake(dir, { leaveOnEof: true });
  // Leave room for cold executable startup on macOS; the catalog must still return before the settlement boundary.
  const settleMs = 2000, begun = Date.now();
  assert.deepEqual(await probeClaudeModels(bin, { settleMs, killMs: 4000 }), [{ value: 'opus' }]);
  assert.ok(Date.now() - begun < settleMs, 'the catalog does not wait for the settle time');
  assert.equal(existsSync(log), false, 'stdin stays open while start-up work may still be running');
  assert.ok(await until(() => existsSync(log), 3000));
  assert.ok(Date.now() - begun >= settleMs);
  assert.equal(readFileSync(log, 'utf8'), 'eof\n', 'closed by end of input, never signalled');
});

test('a Claude probe that does not exit after its input ends is killed only after the grace period', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-claude-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { bin, log } = fake(dir, { leaveOnEof: false });
  assert.deepEqual(await probeClaudeModels(bin, { settleMs: 100, killMs: 400 }), [{ value: 'opus' }]);
  assert.ok(await until(() => existsSync(log), 2000));
  const pid = Number(String(await import('node:child_process').then(c => c.execFileSync('pgrep', ['-f', bin]))).trim().split('\n')[0]);
  assert.ok(pid > 0, 'still running after its input ended');
  assert.ok(await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 3000), 'killed after the grace period');
});
