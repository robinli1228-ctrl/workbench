// Quota survives Worker restarts, quiet hours and one failed check; resends of the same values stay quiet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectClaude, useQuotaIdentitySalt } from '../src/runtime-probe.mjs';
import { mergeRuntimeQuota, expireRuntimeQuota, applyRuntimeQuota, quotaSignature } from '../src/runtime-quota.mjs';

const originalBin = process.env.CLAUDE_BIN;
test.after(() => { if (originalBin === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = originalBin; });
const now = Date.parse('2026-10-24T12:00:00Z'), iso = ms => new Date(ms).toISOString();
const win = (used, checkedAgo, resetIn) => ({ usedPercent: used, remainingPercent: 100 - used, resetsAt: iso(now + resetIn), checkedAt: iso(now - checkedAgo) });
const report = (extra = {}) => ({ type: 'claude', authReady: true, available: true, quotaIdentity: 'id-a', ...extra });

/** A fake claude answering --version, auth status (as the test sets) and the model catalog request. */
function fakeClaude(t, auth) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-quota-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!/usr/bin/env node
const require=(await import("node:module")).createRequire(import.meta.url);
const a=process.argv.slice(2),auth=${JSON.stringify(auth)};
if(a[0]==='--version'){console.log('2.1.303 (Claude Code)');process.exit(0);}
if(a[0]==='auth'){if(auth.stdout)console.log(auth.stdout);if(auth.stderr)console.error(auth.stderr);process.exit(auth.code);}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
 console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{models:[{value:'opus'}]}}}));});
`);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  chmodSync(bin, 0o755);
  process.env.CLAUDE_BIN = bin;
}

test('the quota identity follows the persisted salt, so a Worker restart keeps the same account identity', async t => {
  fakeClaude(t, { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'someone@example.com', orgId: 'org-1' }) });
  useQuotaIdentitySalt('salt-1'); const first = (await inspectClaude()).quotaIdentity;
  useQuotaIdentitySalt('salt-2'); const other = (await inspectClaude()).quotaIdentity;
  useQuotaIdentitySalt('salt-1'); const again = (await inspectClaude()).quotaIdentity;
  assert.ok(first && first === again, 'the same salt after a restart gives the same identity');
  assert.notEqual(first, other);
  assert.doesNotMatch(first, /someone|example/, 'the identity never carries the email');
});

test('a token-only Claude login without an email still has a quota identity', async t => {
  fakeClaude(t, { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' }) });
  const result = await inspectClaude();
  assert.equal(result.authReady, true);
  assert.match(result.quotaIdentity || '', /^[a-f0-9]{64}$/);
});

test('a failed auth check is unknown and retried; a signed-out answer is definite', async t => {
  fakeClaude(t, { code: 1, stderr: 'Error: socket hang up' });
  const failed = await inspectClaude();
  assert.equal(failed.authUnknown, true); assert.equal(failed.transient, true); assert.equal(failed.quotaIdentity, undefined);
  fakeClaude(t, { code: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }) });
  const out = await inspectClaude();
  assert.equal(out.authReady, false); assert.equal(out.authUnknown, undefined); assert.equal(out.transient, undefined);
});

test('one failed check keeps the last account samples as unconfirmed, and the next good check restores them', () => {
  const saved = mergeRuntimeQuota(null, report({ quotaSource: 'session', quota: { fiveHour: win(40, 60000, 3600000) } }), now);
  assert.equal(saved.quotaStale, false);
  const failed = mergeRuntimeQuota(saved, { type: 'claude', authReady: false, available: false, authUnknown: true, transient: true }, now);
  assert.equal(failed.quota?.fiveHour?.usedPercent, 40, 'a failed check no longer wipes the quota');
  assert.equal(failed.quotaStale, true); assert.equal(failed.quotaInvalidated, false);
  const restored = mergeRuntimeQuota(failed, report(), now);
  assert.equal(restored.quota?.fiveHour?.usedPercent, 40); assert.equal(restored.quotaStale, false);
  const live = applyRuntimeQuota([failed], 'claude', { quotaSource: 'session', quota: { fiveHour: win(41, 0, 3600000) } }, failed.quotaIdentity, now)[0];
  assert.equal(live.quota.fiveHour.usedPercent, 41); assert.equal(live.quotaStale, false, 'a live sample from the same account confirms it');
  const signedOut = mergeRuntimeQuota(saved, { type: 'claude', authReady: false, available: false }, now);
  assert.equal(signedOut.quota, null, 'a definite sign-out still drops it');
});

test('a sample stays valid until its window resets, whatever its age; a window past its reset alone becomes unknown', () => {
  const quiet = mergeRuntimeQuota(null, report({ quotaSource: 'session', quota: { fiveHour: win(40, 3 * 3600000, 3600000), weekly: win(70, 3 * 3600000, 86400000) } }), now);
  assert.equal(quiet.quotaStale, false, 'three quiet hours are not staleness');
  assert.equal(expireRuntimeQuota(quiet, now), quiet, 'nothing to expire keeps the same object');
  const later = expireRuntimeQuota(quiet, now + 2 * 3600000);
  assert.equal(later.quota.fiveHour, undefined, 'the 5h window past its reset is unknown');
  assert.equal(later.quota.weekly.usedPercent, 70); assert.equal(later.quota.remainingPercent, 30); assert.equal(later.quotaStale, false);
  const gone = expireRuntimeQuota(later, now + 2 * 86400000);
  assert.equal(gone.quota, null); assert.equal(gone.quotaStale, true);
});

test('the quota signature ignores sample times, so a resend of the same values compares equal', () => {
  const a = report({ quota: { fiveHour: win(40, 0, 3600000) } }), b = report({ quota: { fiveHour: { ...win(40, 0, 3600000), checkedAt: iso(now + 5000) } } });
  assert.equal(quotaSignature(a), quotaSignature(b));
  assert.notEqual(quotaSignature(a), quotaSignature(report({ quota: { fiveHour: win(41, 0, 3600000) } })));
});
