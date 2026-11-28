// bin/wb-codex-proxy routes Codex alone through WORKBENCH_CODEX_PROXY (loopback direct) and runs the real executable;
// SSH-provisioned Workers receive it, executable, next to bin/wb.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const wrapper = new URL('../bin/wb-codex-proxy', import.meta.url).pathname;

test('the wrapper sets the proxy for Codex, keeps loopback direct and passes arguments through', { skip: process.platform === 'win32' }, () => {
  assert.ok(statSync(wrapper).mode & 0o111, 'the wrapper is executable');
  const dir = mkdtempSync(join(tmpdir(), 'wb-codex-proxy-')), fake = join(dir, 'codex');
  try {
    writeFileSync(fake, '#!/bin/sh\nprintf "%s|%s|%s|%s\\n" "$HTTPS_PROXY" "$http_proxy" "$NO_PROXY" "$*"\n'); chmodSync(fake, 0o755);
    const out = execFileSync(wrapper, ['app-server', '--listen', 'stdio'], { env: { PATH: process.env.PATH, WORKBENCH_CODEX_PROXY: 'http://127.0.0.1:7890', WORKBENCH_CODEX_EXECUTABLE: fake, NO_PROXY: 'internal.example' }, encoding: 'utf8' }).trim();
    const [https, http, noProxy, args] = out.split('|');
    assert.equal(https, 'http://127.0.0.1:7890'); assert.equal(http, 'http://127.0.0.1:7890');
    assert.deepEqual(noProxy.split(','), ['localhost', '127.0.0.1', '::1', 'internal.example']);
    assert.equal(args, 'app-server --listen stdio');
    assert.throws(() => execFileSync(wrapper, [], { env: { PATH: process.env.PATH, WORKBENCH_CODEX_EXECUTABLE: fake }, stdio: 'pipe' }), 'without a proxy it refuses to run instead of going direct');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SSH-provisioned Workers receive the wrapper and make it executable', () => {
  const source = readFileSync(new URL('../src/device-admin.mjs', import.meta.url), 'utf8');
  assert.match(source, /\['package\.json','package-lock\.json','bin\/wb','bin\/wb-codex-proxy'\]/);
  assert.match(source, /chmod\(join\(dir,'bin\/wb-codex-proxy'\),0o755\)/);
});
