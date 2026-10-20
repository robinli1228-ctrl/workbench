// A Claude history preview shows each conversation row once: api-request-blob rows repeat the bodies and are not messages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { readNativeSession, historyMessages } = await import(pathToFileURL(join(root, 'src', 'native-sessions.mjs')).href);
const SID = '0f3a3b2c-1111-4222-8333-444444444444';

test('api-request-blob rows recorded by Claude Code 2.1.303 do not duplicate prompts or replies in the preview', async t => {
  const home = mkdtempSync(join(tmpdir(), 'wb-claude-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const workspace = '/srv/work/demo', dir = join(home, 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const user = { role: 'user', content: '错了，不要最新的一条' }, assistant = { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: '改好了' }], usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 5 } };
  const rows = [
    { type: 'api-request-blob', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>memory</system-reminder>' }, { type: 'text', text: user.content }] } },
    { type: 'user', uuid: 'u1', timestamp: '2026-10-20T05:08:17.000Z', cwd: workspace, message: user },
    { type: 'attachment', uuid: 'a1', timestamp: '2026-10-20T05:08:17.100Z' },
    { type: 'api-request-blob', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: '改好了' }] } },
    { type: 'assistant', uuid: 'as1', timestamp: '2026-10-20T05:08:30.000Z', message: assistant },
    { type: 'api-request-blob', message: { role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: '改好了' }] } },
  ];
  writeFileSync(join(dir, `${SID}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const env = { HOME: home, CLAUDE_CONFIG_DIR: home }, record = { id: SID, runtime: 'claude', workspace };
  for (const options of [{}, { historyPage: true }]) {
    const page = await readNativeSession('claude', SID, { env, record, ...options });
    assert.deepEqual(page.messages.map(m => [m.role, m.text]), [['user', '错了，不要最新的一条'], ['assistant', '改好了']]);
    assert.equal(page.sessionConfiguration.model, 'claude-opus-5-5', 'the request blob after the reply is not the session model');
    assert.equal(page.sessionConfiguration.contextTokens, 15);
  }
  assert.equal((await readNativeSession('claude', SID, { env, record })).title, '错了，不要最新的一条');
});

test('tool calls and results come out of a Claude history as rows the page can pair; sidechains and long outputs stay out', () => {
  const at = '2026-10-20T05:08:17.000Z';
  const rows = [
    { type: 'user', timestamp: at, message: { role: 'user', content: 'run tests' } },
    { type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'Running.' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test', description: 'x'.repeat(5000) } }] } },
    { type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'y'.repeat(5000), is_error: false }] } },
    { type: 'user', timestamp: at, isSidechain: true, message: { role: 'user', content: 'subagent prompt' } },
    { type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'All green.' }] } },
  ];
  const messages = historyMessages(rows, 'claude');
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'tool_call', 'tool_result', 'assistant']);
  assert.equal(messages[2].callId, 'toolu_1'); assert.equal(messages[2].input.command, 'npm test'); assert.equal(messages[2].input.description.length, 4001);
  assert.equal(messages[3].output.length, 4001); assert.equal(messages[3].failed, false);
});

test('Codex and Grok histories yield the same tool rows, with the command behind a Codex exec script', () => {
  const codex = historyMessages([
    { type: 'response_item', timestamp: 't1', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } },
    { type: 'response_item', timestamp: 't2', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'text(await tools.exec_command({cmd:"git status", yield_time_ms: 1000}))' } },
    { type: 'response_item', timestamp: 't3', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'clean' }] } },
    { type: 'response_item', timestamp: 't4', payload: { type: 'function_call', call_id: 'c2', name: 'spawn_agent', arguments: '{"task_name":"review"}' } },
    { type: 'response_item', timestamp: 't5', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'hidden' }] } },
    { type: 'response_item', timestamp: 't6', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
  ], 'codex');
  assert.deepEqual(codex.map(m => [m.role, m.callId ?? m.text]), [['user', 'hi'], ['tool_call', 'c1'], ['tool_result', 'c1'], ['tool_call', 'c2'], ['assistant', 'done']]);
  assert.deepEqual(codex[1].input, { command: 'git status' }); assert.equal(codex[2].output, 'clean'); assert.equal(codex[3].input, '{"task_name":"review"}');
  const grok = historyMessages([
    { type: 'user', content: [{ type: 'text', text: 'ls please' }] },
    { type: 'assistant', content: 'Sure.', tool_calls: [{ id: 'g1', name: 'run_terminal_command', arguments: '{"command":"ls"}' }] },
    { type: 'tool_result', tool_call_id: 'g1', content: 'a b' },
    { type: 'reasoning', summary: [] },
  ], 'grok');
  assert.deepEqual(grok.map(m => m.role), ['user', 'assistant', 'tool_call', 'tool_result']);
  assert.equal(grok[2].name, 'run_terminal_command'); assert.equal(grok[3].output, 'a b');
});
