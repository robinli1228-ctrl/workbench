// Transcript model: tool items from different CLIs classify into steps, diffs count lines, and the activity line reads naturally.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { classifyStep, diffLines, summarizeSteps, fileChips, stepTitle, elapsedText } = await import(pathToFileURL(join(root, 'public', 'native-transcript.js')).href);
const t = (text, params) => params ? text.replace(/\{(\w+)\}/g, (m, k) => params[k] ?? m) : text;

test('Claude, Codex, Grok and Agy tool items classify into read/edit/write/command/search steps with file paths', () => {
  const read = classifyStep({ id: '1', name: 'Read', input: { file_path: '/repo/src/a.mjs' }, status: 'completed', output: '     1→import x\n     2→export y' }, 'succeeded');
  assert.equal(read.kind, 'read'); assert.deepEqual(read.files, ['/repo/src/a.mjs']);
  const edit = classifyStep({ id: '2', name: 'Edit', input: { file_path: '/repo/src/a.mjs', old_string: 'a\nb\nc', new_string: 'a\nB\nc\nd' }, status: 'completed' }, 'succeeded');
  assert.equal(edit.kind, 'edit'); assert.equal(edit.added, 2); assert.equal(edit.removed, 1);
  const write = classifyStep({ id: '3', name: 'write_file', arguments: JSON.stringify({ path: '/repo/new.txt', content: 'one\ntwo' }), status: 'completed' }, 'succeeded');
  assert.equal(write.kind, 'write'); assert.equal(write.added, 2);
  const codex = classifyStep({ id: '4', type: 'command_execution', command: ['bash', '-lc', 'npm test'], aggregatedOutput: 'ok', exitCode: 0, status: 'completed' }, 'succeeded');
  assert.equal(codex.kind, 'command'); assert.equal(stepTitle(codex, t).target, 'bash -lc npm test');
  const change = classifyStep({ id: '5', type: 'file_change', changes: [{ path: 'src/x.ts', kind: 'update', diff: '--- a\n+++ b\n-old\n+new\n+more' }], status: 'completed' }, 'succeeded');
  assert.equal(change.kind, 'edit'); assert.deepEqual(change.files, ['src/x.ts']); assert.equal(change.added, 2); assert.equal(change.removed, 1);
  const agy = classifyStep({ id: '6', name: 'grep_search', parameters: { query: 'TODO' }, status: 'failed' }, 'succeeded');
  assert.equal(agy.kind, 'search'); assert.equal(agy.failed, true);
  const bash = classifyStep({ id: '7', name: 'Bash', input: { command: 'git status', description: 'Show status' }, status: 'inProgress' }, 'running');
  assert.equal(bash.kind, 'command'); assert.equal(bash.running, true); assert.equal(stepTitle(bash, t).target, 'Show status');
});

test('the activity line counts unique files, sums edit stats and appends failures and duration', () => {
  const steps = [
    classifyStep({ id: '1', name: 'Read', input: { file_path: '/r/a.mjs' } }, 'succeeded'),
    classifyStep({ id: '2', name: 'Read', input: { file_path: '/r/a.mjs' } }, 'succeeded'),
    classifyStep({ id: '3', name: 'Edit', input: { file_path: '/r/a.mjs', old_string: 'x', new_string: 'y\nz' } }, 'succeeded'),
    classifyStep({ id: '4', name: 'Bash', input: { command: 'ls' }, status: 'failed' }, 'succeeded')
  ];
  assert.equal(summarizeSteps(steps, t, { duration: '42s' }), 'Read 1 file · Edited 1 file +2 −1 · Ran 1 command · 1 failed · 42s');
  const chips = fileChips(steps);
  assert.equal(chips.length, 1); assert.equal(chips[0].step.kind, 'edit');
});

test('line diffs are exact for small inputs and bounded for huge ones', () => {
  const d = diffLines('a\nb\nc', 'a\nc\nd');
  assert.deepEqual(d.rows.map(r => r.type + ':' + r.text), ['ctx:a', 'del:b', 'ctx:c', 'add:d']);
  const big = diffLines('x\n'.repeat(3000), 'y\n'.repeat(3000));
  assert.equal(big.truncated, true);
  assert.equal(elapsedText(Date.now() - 95000), '1m 35s');
});
