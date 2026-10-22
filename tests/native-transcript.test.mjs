// Transcript model: tool items from different CLIs classify into steps, diffs count lines, and the activity line reads naturally.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { classifyStep, diffLines, summarizeSteps, fileChips, stepTitle, elapsedText, historyTurns, noteRows } = await import(pathToFileURL(join(root, 'public', 'native-transcript.js')).href);
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

test('history rows group into turns: results join their calls, injected user rows neither start nor split a turn', () => {
  const rows = [
    { role: 'user', text: 'fix it', timestamp: '2026-10-20T10:00:00Z' },
    { role: 'assistant', text: 'Looking.', timestamp: '2026-10-20T10:00:05Z' },
    { role: 'tool_call', callId: 't1', name: 'Read', input: { file_path: '/a.mjs' }, timestamp: '2026-10-20T10:00:06Z' },
    { role: 'user', text: '<system-reminder>x</system-reminder>', timestamp: '2026-10-20T10:00:07Z' },
    { role: 'tool_result', callId: 't1', output: 'ok', failed: false, timestamp: '2026-10-20T10:00:07Z' },
    { role: 'tool_call', callId: 't2', name: 'Bash', input: { command: 'npm test' }, timestamp: '2026-10-20T10:00:08Z' },
    { role: 'tool_result', callId: 't2', output: 'boom', failed: true, timestamp: '2026-10-20T10:00:09Z' },
    { role: 'assistant', text: 'Done.', timestamp: '2026-10-20T10:00:10Z' },
    { role: 'user', text: 'thanks', timestamp: '2026-10-20T10:01:00Z' },
    { role: 'tool_result', callId: 'orphan', output: 'late', timestamp: '2026-10-20T10:01:01Z' },
  ];
  const turns = historyTurns(rows, { isPrompt: row => !row.text.startsWith('<') });
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0].parts.map(p => p.kind), ['text', 'tool', 'tool', 'text']);
  assert.deepEqual(turns[0].parts[1], { kind: 'tool', id: 't1', name: 'Read', input: { file_path: '/a.mjs' }, output: 'ok', failed: false, done: true, timestamp: '2026-10-20T10:00:06Z' });
  assert.equal(turns[0].parts[2].failed, true);
  assert.equal(turns[0].endedAt, '2026-10-20T10:00:10Z');
  assert.equal(turns[1].prompt.text, 'thanks'); assert.deepEqual(turns[1].parts, []);
  // A page that starts mid-turn still shows its tool activity under one reply row.
  assert.equal(historyTurns(rows.slice(2, 4))[0].prompt, null);
  // A background task finishing stays inside the running turn as a notice; the reply after it joins the same turn.
  const notice = text => text.match(/<task-id>(\w+)<\/task-id>/)?.[1] || '';
  const bg = historyTurns([
    { role: 'user', text: 'run four agents', timestamp: 't1' },
    { role: 'assistant', text: 'started', timestamp: 't2' },
    { role: 'user', text: '<task-notification><task-id>afb520e7</task-id></task-notification>', timestamp: 't3' },
    { role: 'assistant', text: 'one back', timestamp: 't4' },
    { role: 'user', text: 'next question', timestamp: 't5' },
  ], { isPrompt: row => !row.text.startsWith('<'), noticeOf: row => notice(row.text) });
  assert.equal(bg.length, 2);
  assert.deepEqual(bg[0].parts.map(p => p.kind === 'notice' ? `notice:${p.task}` : p.text), ['started', 'notice:afb520e7', 'one back']);
  assert.equal(bg[0].endedAt, 't4');
  assert.equal(classifyStep({ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' }, output: 'boom', is_error: true, status: 'completed' }, 'succeeded').kind, 'command');
});

test('notes collapse: thinking signals (old and new wording) become one thinking row with a count; identical notes merge', () => {
  const t = text => text;
  const notes = [
    ...Array.from({ length: 14 }, () => ({ kind: 'log', text: '\u6a21\u578b\u6b63\u5728\u601d\u8003\uff08\u5df2\u6536\u5230\u539f\u751f\u8fdb\u5ea6\u4e8b\u4ef6\uff09' })),
    { kind: 'log', text: 'Model is thinking' },
    { kind: 'log', text: 'retrying request' }, { kind: 'log', text: 'retrying  request' },
    { kind: 'error', text: 'Model is thinking' }
  ];
  assert.deepEqual(noteRows(notes, t), [
    { kind: 'thinking', text: 'Model is thinking', count: 15 },
    { kind: 'note', text: 'retrying request', count: 2 },
    { kind: 'error', text: 'Model is thinking', count: 1 }
  ]);
  assert.deepEqual(noteRows([{ kind: 'log', text: '   ' }], t), []);
});
