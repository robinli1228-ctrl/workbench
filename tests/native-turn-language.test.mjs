// Takeover prompts reach the CLI in Traditional Chinese, like group-chat runs; control turns are passed through untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { NativeTurnRunner } = await import(pathToFileURL(join(root, 'src', 'native-turns.mjs')).href);
const SID = '00000000-1111-4222-8333-444444444444';

test('a takeover prompt is converted to Traditional Chinese before the CLI sees it; paths and slash commands stay exact', async () => {
  const captured = [];
  const runner = new NativeTurnRunner({ send() {}, resolveSession: async () => ({ workspace: '/tmp/demo' }), canStart: () => true,
    createSession: ({ emit }) => ({ proc: null, async start(prompt) { captured.push(prompt); emit('status', { status: 'succeeded' }); }, async stop() {}, shutdown() {} }) });
  await runner.start({ id: 't1', runtime: 'grok', sessionId: SID, prompt: '请帮我检查这个文件的编码问题，路径是 src/app.js' });
  assert.equal(captured[0], '請幫我檢查這個文件的編碼問題，路徑是 src/app.js');
  await runner.start({ id: 't2', runtime: 'grok', sessionId: SID, prompt: '/compact', control: 'compact' });
  assert.equal(captured[1], '/compact');
});
