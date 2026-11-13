// A role's running turn on a fresh CLI process has not reported its context window yet; the ring takes the window an earlier
// turn of the same session reported for the same model instead of saying "unknown".
import test from 'node:test';
import assert from 'node:assert/strict';
import { contextForRole } from '../public/context-usage.js';

test('the context ring borrows the window from an earlier turn of the same session and model', () => {
  const role = { id: 'r', projectId: 'p', nodeId: 'n', runtime: 'claude', model: 'opus' };
  const session = { id: 's', roleId: 'r', projectId: 'p', conversationId: 'p', nodeId: 'n', runtime: 'claude', status: 'active', nativeSessionId: 'x' };
  const run = (id, at, usage) => ({ id, roleId: 'r', projectId: 'p', nodeId: 'n', roleSessionId: 's', model: 'opus', roleSnapshot: { runtime: 'claude', model: 'opus' }, createdAt: at, contextUsage: { sessionId: 'x', observedAt: at, ...usage } });
  const data = { roleSessions: [session], runs: [
    run('old', '2026-11-13T10:00:00Z', { usedTokens: 300000, limitTokens: 1000000, model: 'claude-opus-5-5' }),
    run('now', '2026-11-13T11:46:49Z', { usedTokens: 449836, limitTokens: null, model: 'claude-opus-5-5' })] };
  const sample = contextForRole(role, data);
  assert.equal(sample.usedTokens, 449836); assert.equal(sample.limitTokens, 1000000); assert.ok(Math.abs(sample.percent - 44.9836) < 1e-9);
  // Another model's window is never borrowed.
  data.runs[0].contextUsage.model = 'claude-sonnet-5-5';
  assert.equal(contextForRole(role, data).limitTokens, null);
});
