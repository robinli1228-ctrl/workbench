// Opening a new native session on the Sessions page: the iTerm launcher runs headlessly and answers "Hi" in the CLI's print mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = name => import(pathToFileURL(join(root, 'src', name)).href);
const { nativeHelloArgs, nativeSessionId } = await load('terminal-resume.mjs');
const { nativeTuiArgs } = await load('native-sessions.mjs');
const FRESH = '163d8877-79eb-45b4-bd10-5ba6466a2ca5';

test('hello args keep the TUI session and permission flags and add each CLI print mode with JSON output', () => {
  assert.deepEqual(nativeHelloArgs('claude', nativeTuiArgs('claude', { freshId: FRESH, allowAll: true })),
    ['-p', 'Hi', '--output-format', 'stream-json', '--verbose', '--session-id', FRESH, '--dangerously-skip-permissions']);
  assert.deepEqual(nativeHelloArgs('grok', nativeTuiArgs('grok', { freshId: FRESH })),
    ['--session-id', FRESH, '--output-format', 'streaming-messages-json', '-p', 'Hi']);
  assert.deepEqual(nativeHelloArgs('codex', nativeTuiArgs('codex', { allowAll: true })),
    ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', 'Hi']);
  assert.deepEqual(nativeHelloArgs('agy', nativeTuiArgs('agy', {})), ['--output-format', 'stream-json', '--print', 'Hi']);
  assert.throws(() => nativeHelloArgs('other', []), /resume/);
});

test('a new Codex thread reports its ID as thread_id on the exec JSON stream', () => {
  assert.equal(nativeSessionId({ type: 'thread.started', thread_id: FRESH }, 'codex'), FRESH);
  assert.equal(nativeSessionId({ type: 'thread.started', thread_id: FRESH }, 'claude'), null);
  assert.equal(nativeSessionId({ type: 'item.completed', item: { id: 'item_0' } }, 'codex'), null);
});
