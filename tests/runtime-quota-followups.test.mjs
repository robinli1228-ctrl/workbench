// Quota survives Worker restarts, quiet hours and one failed check; resends of the same values stay quiet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectClaude, useQuotaIdentitySalt } from '../src/runtime-probe.mjs';
import { mergeRuntimeQuota, expireRuntimeQuota, applyRuntimeQuota, quotaSignature, mergeReportedRuntimes, sessionQuotaIdentity, sampleQuotaIdentity } from '../src/runtime-quota.mjs';
import { roleTokenBalance } from '../public/quota-state.js';

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
if(a[0]==='--version'){console.log('2.1.303 (Claude Code)');if(auth.vanish)require('node:fs').unlinkSync(process.argv[1]);process.exit(0);}
if(a[0]==='auth'){if(auth.kill)process.kill(process.pid,'SIGKILL');if(auth.stdout)console.log(auth.stdout);if(auth.stderr)console.error(auth.stderr);process.exit(auth.code);}
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

test('a token-only Claude login is identified by a salted hash of its token, which changes with the token', async t => {
  const prior = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  t.after(() => { if (prior === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = prior; });
  fakeClaude(t, { code: 0, stdout: JSON.stringify({ authenticated: true, authMethod: 'oauth_token', apiProvider: 'firstParty' }) });
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'token-one'; const one = await inspectClaude();
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'token-two'; const two = await inspectClaude();
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN; const none = await inspectClaude();
  assert.equal(one.authReady, true, 'authenticated:true counts as signed in');
  assert.match(one.quotaIdentity || '', /^[a-f0-9]{64}$/); assert.notEqual(one.quotaIdentity, two.quotaIdentity);
  assert.doesNotMatch(JSON.stringify(one), /token-one/, 'the token is never reported');
  assert.equal(none.quotaIdentity, null, 'no email and no token: no identity, as before');
  fakeClaude(t, { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: null, orgId: 'org-1' }) });
  assert.equal((await inspectClaude()).quotaIdentity, null, 'an organization alone is shared by seats and is no identity');
});

test('only an interrupted auth check is unknown and retried; a crash or a signed-out answer is definite', async t => {
  fakeClaude(t, { kill: true });
  const failed = await inspectClaude();
  assert.equal(failed.authUnknown, true); assert.equal(failed.transient, true); assert.equal(failed.quotaIdentity, undefined);
  fakeClaude(t, { code: 1, stderr: 'Error: unknown command auth' });
  const crashed = await inspectClaude();
  assert.equal(crashed.authUnknown, undefined); assert.equal(crashed.transient, undefined); assert.equal(crashed.authReady, false);
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
  assert.equal(sessionQuotaIdentity(failed), null, 'a new session does not bind the borrowed identity');
  assert.equal(applyRuntimeQuota([failed], 'claude', { quotaSource: 'session', quota: { fiveHour: win(41, 0, 3600000) } }, failed.quotaIdentity, now)[0], failed, 'no live sample refreshes a borrowed identity');
  const restored = mergeRuntimeQuota(failed, report(), now);
  assert.equal(restored.quota?.fiveHour?.usedPercent, 40); assert.equal(restored.quotaStale, false); assert.equal(sessionQuotaIdentity(restored), 'id-a');
  const signedOut = mergeRuntimeQuota(saved, { type: 'claude', authReady: false, available: false }, now);
  assert.equal(signedOut.quota, null, 'a definite sign-out still drops it');
});

test('within three hours a sample stays valid until its window resets; a window past its reset alone becomes unknown', () => {
  const quiet = mergeRuntimeQuota(null, report({ quotaSource: 'session', quota: { fiveHour: win(40, 3600000, 3600000), weekly: win(70, 3600000, 86400000) } }), now);
  assert.equal(quiet.quotaStale, false, 'a quiet hour is not staleness');
  assert.equal(expireRuntimeQuota(quiet, now), quiet, 'nothing to expire keeps the same object');
  const later = expireRuntimeQuota(quiet, now + 90 * 60000);
  assert.equal(later.quota.fiveHour, undefined, 'the 5h window past its reset is unknown');
  assert.equal(later.quota.weekly.usedPercent, 70); assert.equal(later.quota.remainingPercent, 30); assert.equal(later.quotaStale, false);
  const gone = expireRuntimeQuota(later, now + 2 * 86400000);
  assert.equal(gone.quota, null); assert.equal(gone.quotaStale, true);
});

test('a sample older than three hours is kept but shown as not latest', () => {
  const old = mergeRuntimeQuota(null, report({ quotaSource: 'session', quota: { weekly: win(70, 4 * 3600000, 86400000) } }), now);
  assert.equal(old.quota.weekly.usedPercent, 70); assert.equal(old.quotaStale, true);
  const fresh = mergeRuntimeQuota(null, report({ quotaSource: 'session', quota: { weekly: win(70, 3600000, 86400000) } }), now);
  assert.equal(expireRuntimeQuota(fresh, now + 3 * 3600000).quotaStale, true, 'the heartbeat marks it once it passes three hours');
  const credits = mergeRuntimeQuota(null, { type: 'codex', authReady: true, quotaIdentity: 'id-c', quotaSource: 'session', quota: { credits: { balance: 5, hasCredits: true, unlimited: false, checkedAt: iso(now - 4 * 3600000) } } }, now);
  assert.equal(credits.quotaStale, true, 'Codex credits age out too');
});

test('a Worker registration after a restart keeps the saved quota of the same account and drops windows past their reset', () => {
  const saved = [mergeRuntimeQuota(null, report({ quotaSource: 'session', quota: { fiveHour: win(40, 60000, -1000), weekly: win(70, 60000, 86400000) } }), now - 5000)];
  const fresh = [mergeRuntimeQuota(null, report({ checkedAt: iso(now) }), now)];
  assert.equal(fresh[0].quota, null, 'the restarted Worker has no samples yet');
  const [merged] = mergeReportedRuntimes(saved, fresh, now);
  assert.equal(merged.quota?.weekly?.usedPercent, 70); assert.equal(merged.quota?.fiveHour, undefined); assert.equal(merged.quotaStale, false);
});

test('the quota signature ignores sample times, so a resend of the same values compares equal', () => {
  const a = report({ quota: { fiveHour: win(40, 0, 3600000) } }), b = report({ quota: { fiveHour: { ...win(40, 0, 3600000), checkedAt: iso(now + 5000) } } });
  assert.equal(quotaSignature(a), quotaSignature(b));
  assert.notEqual(quotaSignature(a), quotaSignature(report({ quota: { fiveHour: win(41, 0, 3600000) } })));
});

test('one old part greys only itself: fresh windows stay current beside old Codex credits or an old Claude weekly window', () => {
  const codex = mergeRuntimeQuota(null, { type: 'codex', authReady: true, quotaIdentity: 'id-c', quotaSource: 'session', quota: { fiveHour: win(30, 60000, 3600000), weekly: win(50, 60000, 86400000), credits: { balance: 5, hasCredits: true, unlimited: false, checkedAt: iso(now - 4 * 3600000) } } }, now);
  assert.equal(codex.quotaStale, false); assert.equal(codex.quota.credits.stale, true); assert.equal(codex.quota.fiveHour.stale, false);
  const worker = { id: 'n1', runtimes: [codex] };
  assert.equal(roleTokenBalance({ nodeId: 'n1', runtime: 'codex', model: 'gpt' }, worker), '充足', 'the balance uses the fresh windows, not 未知');
  const saved = mergeRuntimeQuota(null, report({ quotaSource: 'session', quota: { fiveHour: win(20, 4 * 3600000, 3600000), weekly: win(60, 4 * 3600000, 86400000) } }), now);
  const claude = mergeRuntimeQuota(saved, report({ quotaSource: 'session', quota: { fiveHour: win(25, 0, 3600000) } }), now);
  assert.equal(claude.quotaStale, false, 'an event with only five_hour does not leave the runtime stale');
  assert.equal(claude.quota.fiveHour.stale, false); assert.equal(claude.quota.weekly.stale, true);
  const aged = expireRuntimeQuota({ ...claude, quota: { ...claude.quota, fiveHour: win(25, 3600000, 5 * 3600000) } }, now + 2.5 * 3600000);
  assert.equal(aged.quota.fiveHour.stale, true); assert.equal(aged.quotaStale, true, 'once every part is old the runtime is stale');
  assert.equal(expireRuntimeQuota(claude, now), claude);
});

test('a session started while the account was unknown has its samples counted once the account is known again', () => {
  const known = report({ quotaSource: 'session', quota: null });
  assert.equal(sampleQuotaIdentity(null, known), 'id-a');
  assert.equal(sampleQuotaIdentity(null, { ...known, authUnknown: true }), null);
  assert.equal(sampleQuotaIdentity('id-old', known), 'id-old', 'a bound session keeps its own account');
  const applied = applyRuntimeQuota([known], 'claude', { quotaSource: 'session', quota: { fiveHour: win(10, 0, 3600000) } }, sampleQuotaIdentity(null, known), now)[0];
  assert.equal(applied.quota.fiveHour.usedPercent, 10);
});

test('a CLI swapped by a self-update between checks is unknown, not signed out', async t => {
  fakeClaude(t, { vanish: true, code: 0, stdout: '{}' });
  const result = await inspectClaude();
  assert.equal(result.authUnknown, true); assert.equal(result.transient, true);
});

test('a signed-out Grok or Agy report drops its saved quota; a report merely without quota keeps it greyed', () => {
  const saved = [{ type: 'grok', authReady: true, quota: { fiveHour: win(50, 0, 3600000) }, quotaStatus: 'ok' }];
  assert.equal(mergeReportedRuntimes(saved, [{ type: 'grok', authReady: false, quota: null }], now)[0].quota, null);
  const kept = mergeReportedRuntimes([{ ...saved[0], quota: { fiveHour: win(50, 0, 3600000) } }], [{ type: 'grok', authReady: true, quota: null }], now)[0];
  assert.equal(kept.quota.fiveHour.usedPercent, 50); assert.equal(kept.quotaStale, true);
});
