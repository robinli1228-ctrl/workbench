// A Claude history preview shows each conversation row once: api-request-blob rows repeat the bodies and are not messages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { readNativeSession } = await import(pathToFileURL(join(root, 'src', 'native-sessions.mjs')).href);
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
