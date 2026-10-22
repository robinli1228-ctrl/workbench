// Sessions-page controls for a native session: chosen model/effort ride on turns, control turns compact or switch in place, context snapshots land on the turn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = name => import(pathToFileURL(join(root, 'src', name)).href);
const { nativeTurnArgs, NativeCodexSession } = await load('native-turn-sessions.mjs');
const { NativeTurnsHome, applyNativeTurnEvent, nativeTurnView } = await load('native-turns.mjs');
const { ClaudeContextUsage } = await load('context-usage.mjs');
const { Store } = await load('store.mjs');
const SID = '00000000-1111-4222-8333-444444444444';

test('chosen model and effort become CLI flags; nothing is added when they are unset', () => {
  assert.deepEqual(nativeTurnArgs('claude', { sessionId: SID, keepAlive: true, model: 'claude-haiku-5-5', effort: 'low' }),
    ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--resume', SID, '--model', 'claude-haiku-5-5', '--effort', 'low', '--permission-mode', 'bypassPermissions', '--permission-prompt-tool', 'stdio']);
  assert.deepEqual(nativeTurnArgs('claude', { sessionId: SID, keepAlive: true }),
    ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--resume', SID, '--permission-mode', 'bypassPermissions', '--permission-prompt-tool', 'stdio']);
  // A one-shot turn has nobody to answer a prompt, so it keeps bypassing them. No launch flag carries instructions.
  assert.ok(!nativeTurnArgs('claude', { sessionId: SID, keepAlive: true }).includes('--append-system-prompt'));
  assert.ok(!new NativeCodexSession({ cwd: '/w', resumeSessionId: SID, emit() {} }).launchArgs().some(arg => arg.startsWith('developer_instructions=')));
  assert.ok(nativeTurnArgs('claude', { sessionId: SID, prompt: 'hi' }).includes('--dangerously-skip-permissions'));
  assert.ok(nativeTurnArgs('grok', { cwd: '/w', sessionId: SID, prompt: 'hi', model: 'grok-5', effort: 'high' }).join(' ').includes('-m grok-5 --reasoning-effort high'));
  assert.ok(nativeTurnArgs('agy', { sessionId: SID, keepAlive: true, model: 'gemini-x' }).join(' ').includes('--model gemini-x --conversation'));
});

test('a Codex control turn starts thread/compact/start instead of a prompt, and the chosen model rides on turn/start', async () => {
  const calls = [];
  const session = new NativeCodexSession({ cwd: '/w', emit() {}, resumeSessionId: SID, model: 'gpt-6.1-sol', control: 'compact' });
  Object.getPrototypeOf(NativeCodexSession.prototype).request = async function (method, params) { calls.push([method, params]); return { thread: { id: SID }, turn: { id: 't1' } }; };
  await session.request('turn/start', { threadId: SID, input: [] });
  session.control = null;
  await session.request('turn/start', { threadId: SID, input: [] });
  assert.deepEqual(calls, [['thread/compact/start', { threadId: SID }], ['turn/start', { threadId: SID, input: [], model: 'gpt-6.1-sol' }]]);
});

function home() {
  const db = new Store(':memory:'), sent = [];
  const turns = new NativeTurnsHome({ db, send: (nodeId, m) => sent.push({ nodeId, ...m }), online: () => true, change() {}, assertIdle() {}, attachments: { resolve: () => [] } });
  const worker = { capabilities: { nativeTurns: 3, nativeControls: 1 }, runtimes: [{ type: 'claude', models: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-haiku-5-5' }] }] };
  return { db, sent, turns, worker };
}

test('settings are saved per session and sent with every turn; a resident Claude gets a /model turn at once', () => {
  const { sent, turns, worker } = home();
  const saved = turns.saveSettings('n1', worker, { runtime: 'claude', sessionId: SID, model: 'claude-haiku-5-5' });
  assert.equal(saved.model, 'claude-haiku-5-5'); assert.equal(saved.applied, 'next_turn');
  assert.throws(() => turns.saveSettings('n1', worker, { runtime: 'claude', sessionId: SID, model: 'nope' }), /not available/);
  assert.throws(() => turns.saveSettings('n1', worker, { runtime: 'claude', sessionId: SID, effort: 'silly' }), /Invalid reasoning effort/);
  turns.create('n1', worker, { runtime: 'claude', sessionId: SID, clientTurnId: 'client-turn-1', text: 'hello' });
  assert.equal(sent.at(-1).model, 'claude-haiku-5-5'); assert.equal('effort' in sent.at(-1), false);
  // The takeover is open now: an effort change becomes an in-place /effort control turn.
  turns.receive('n1', { type: 'native_turn_event', id: sent.at(-1).id, event: { kind: 'status', status: 'succeeded' } });
  const changed = turns.saveSettings('n1', worker, { runtime: 'claude', sessionId: SID, effort: 'low' });
  assert.equal(changed.applied, 'in_place');
  assert.equal(sent.at(-1).prompt, '/effort low'); assert.equal(sent.at(-1).control, 'effort');
  assert.equal(turns.settings('n1', 'claude', SID).effort, 'low');
});

test('a compaction control turn is /compact for Claude, an empty prompt for Codex, and refused elsewhere', () => {
  const { sent, turns, worker } = home();
  const claude = turns.create('n1', worker, { runtime: 'claude', sessionId: SID, clientTurnId: 'client-turn-2', control: 'compact' });
  assert.equal(claude.prompt, '/compact'); assert.equal(claude.control, 'compact'); assert.equal(sent.at(-1).control, 'compact');
  turns.receive('n1', { type: 'native_turn_event', id: claude.id, event: { kind: 'status', status: 'succeeded' } });
  const codex = turns.create('n1', worker, { runtime: 'codex', sessionId: SID, clientTurnId: 'client-turn-3', control: 'compact' });
  assert.equal(codex.prompt, ''); assert.equal(sent.at(-1).prompt, '');
  turns.receive('n1', { type: 'native_turn_event', id: codex.id, event: { kind: 'status', status: 'succeeded' } });
  assert.throws(() => turns.create('n1', worker, { runtime: 'grok', sessionId: SID, clientTurnId: 'client-turn-4', control: 'compact' }), /cannot compact/);
});

test('context snapshots are kept on the turn and a Claude compaction records pre/post tokens', () => {
  const turn = applyNativeTurnEvent({ id: 't', status: 'running', events: [] }, { kind: 'context_usage', sample: { usedTokens: 20071, limitTokens: 1000000, state: 'measured' } });
  assert.equal(turn.contextUsage.usedTokens, 20071); assert.equal(turn.events.length, 0);
  assert.equal(nativeTurnView(turn).contextUsage.limitTokens, 1000000);
  const tracker = new ClaudeContextUsage();
  const sample = tracker.receive({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 20071, post_tokens: 2001 } }, SID);
  assert.equal(sample.state, 'compacted'); assert.equal(sample.usedTokens, 2001); assert.deepEqual(sample.compacted, { preTokens: 20071, postTokens: 2001 });
});

test('a hosting account binds to a session only with a matching repository host, and rides on turns as a credential', async () => {
  const { db, sent, turns, worker } = home();
  db.put('hostingAccounts', { id: 'acct-gh', provider: 'github', login: 'robin' });
  db.put('hostingAccounts', { id: 'acct-gitee', provider: 'gitee', login: 'robin' });
  const url = 'https://github.com/robinli1228-ctrl/workbench.git';
  assert.throws(() => turns.saveSettings('n1', worker, { runtime: 'claude', sessionId: SID, hostingAccountId: 'acct-gitee', repoUrl: url }), /does not match/);
  assert.throws(() => turns.saveSettings('n1', worker, { runtime: 'claude', sessionId: SID, hostingAccountId: 'acct-gh' }), /remote URL is unknown/);
  const saved = turns.saveSettings('n1', worker, { runtime: 'claude', sessionId: SID, hostingAccountId: 'acct-gh', repoUrl: url });
  assert.equal(saved.hostingAccountId, 'acct-gh'); assert.equal(saved.repoUrl, url);
  turns.create('n1', worker, { runtime: 'claude', sessionId: SID, clientTurnId: 'client-turn-9', text: 'push it' }, { gitCredential: { provider: 'github', login: 'x-access-token', token: 't', repoUrl: url } });
  assert.deepEqual(sent.at(-1).gitCredential, { provider: 'github', login: 'x-access-token', token: 't', repoUrl: url });
  const cleared = turns.saveSettings('n1', worker, { runtime: 'claude', sessionId: SID, hostingAccountId: null });
  assert.equal(cleared.hostingAccountId, null); assert.equal(cleared.repoUrl, url);
});
