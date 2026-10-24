// History pages carry tool summaries; a step's full call and result are read on demand and shown like a live step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { readNativeSession, readNativeToolDetail } = await import(pathToFileURL(join(root, 'src', 'native-sessions.mjs')).href);
const SID = '0f3a3b2c-5555-4222-8333-444444444444';

function claudeHistory(t) {
  const home = mkdtempSync(join(tmpdir(), 'wb-tool-detail-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const workspace = '/xxxxx/demo', dir = join(home, 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-')), file = join(dir, `${SID}.jsonl`);
  mkdirSync(dir, { recursive: true });
  const at = '2026-10-24T05:00:00.000Z', long = 'z'.repeat(40000);
  const rows = [
    { type: 'user', timestamp: at, message: { role: 'user', content: 'fix it' } },
    { type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_e', name: 'Edit', input: { file_path: '/xxxxx/demo/a.js', old_string: 'a\nb', new_string: 'a\nB\nc' } }] } },
    { type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_e', content: long }] } },
  ];
  writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return { file, env: { HOME: home, CLAUDE_CONFIG_DIR: home }, record: { id: SID, runtime: 'claude', workspace }, long };
}

test('a preview page carries summaries only; the detail reads the full call and output in chunks and refuses a rewritten history', async t => {
  const h = claudeHistory(t);
  const page = await readNativeSession('claude', SID, { env: h.env, record: h.record, historyPage: true, toolPreview: true });
  const call = page.messages.find(m => m.role === 'tool_call'), result = page.messages.find(m => m.role === 'tool_result');
  assert.equal(call.input, undefined); assert.equal(result.output, undefined);
  assert.equal(call.toolSummary.kind, 'edit'); assert.deepEqual(call.toolSummary.files, ['/xxxxx/demo/a.js']);
  const input = await readNativeToolDetail('claude', SID, { env: h.env, record: h.record, ref: call.detailRef });
  assert.deepEqual(JSON.parse(input.text).input.new_string, 'a\nB\nc');
  let text = '', offset = 0;
  do { const chunk = await readNativeToolDetail('claude', SID, { env: h.env, record: h.record, ref: result.detailRef, offset }); text += chunk.text; offset = chunk.nextOffset; } while (offset != null);
  assert.equal(text, h.long, 'the full output, not the 4000-character clip');
  appendFileSync(h.file, JSON.stringify({ type: 'user', timestamp: '2026-10-24T05:01:00.000Z', message: { role: 'user', content: 'more' } }) + '\n');
  assert.equal((await readNativeToolDetail('claude', SID, { env: h.env, record: h.record, ref: call.detailRef })).callId, 'toolu_e', 'appends keep references valid');
  writeFileSync(h.file, '{}\n'.repeat(400));
  await assert.rejects(readNativeToolDetail('claude', SID, { env: h.env, record: h.record, ref: call.detailRef }), /changed|Invalid/);
});

// Just enough DOM for activityBlock: elements, classes, children and click listeners.
class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.parent = null; this.className = ''; this.textContent = ''; this.listeners = {}; this.dataset = {}; this.style = {}; this.open = false;
    const self = this; this.classList = { toggle(c) { const has = self.className.split(' ').includes(c); self.className = has ? self.className.split(' ').filter(x => x !== c).join(' ') : `${self.className} ${c}`.trim(); return !has; }, add(c) { if (!self.className.split(' ').includes(c)) self.className = `${self.className} ${c}`.trim(); }, remove() {}, contains: c => self.className.split(' ').includes(c) }; }
  append(...nodes) { for (let n of nodes) { if (typeof n === 'string') { const s = new Node('#text'); s.textContent = n; n = s; } n.parent = this; this.children.push(n); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  replaceWith(node) { const i = this.parent.children.indexOf(this); node.parent = this.parent; this.parent.children[i] = node; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] || []) fn({ preventDefault() {}, stopPropagation() {} }); }
  setAttribute() {} querySelector() { return null; }
  all() { return [this, ...this.children.flatMap(c => c.all())]; }
  find(cls) { return this.all().find(n => n.className.split(' ').includes(cls)); }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('opening a history step rebuilds its normal view and a preview gets the full step', async () => {
  globalThis.document = { createElement: tag => new Node(tag), createElementNS: (ns, tag) => new Node(tag), createDocumentFragment: () => new Node('#fragment'), addEventListener() {}, removeEventListener() {} };
  const { activityBlock } = await import(pathToFileURL(join(root, 'public', 'native-transcript.js')).href);
  const t = text => text, reads = [], previews = [];
  const pages = {
    call: { role: 'tool_call', callId: 'toolu_e', text: JSON.stringify({ name: 'Edit', input: { file_path: '/xxxxx/a.js', old_string: 'a\nb', new_string: 'a\nB\nc' } }), offset: 0, nextOffset: null },
    result: { role: 'tool_result', callId: 'toolu_e', text: 'ok', offset: 0, nextOffset: null }
  };
  const step = { kind: 'edit', id: 'toolu_e', name: 'Edit', files: ['/xxxxx/a.js'], added: 2, removed: 1, detailRefs: ['call', 'result'] };
  const box = activityBlock({ steps: [step], t, onPreview: (full, path) => previews.push([full, path]), onDetail: async (s, ref, offset) => { reads.push([ref, offset]); return pages[ref]; } });
  box.open = true; box.fire('toggle');
  const head = box.find('nt-step-head');
  head.fire('click'); await settle(); await settle();
  assert.deepEqual(reads, [['call', 0], ['result', 0]]);
  assert.ok(box.find('nt-diff'), 'an edit opens as a diff, not raw JSON');
  box.find('nt-step-preview').fire('click'); await settle();
  assert.equal(previews.length, 1);
  assert.equal(previews[0][0].kind, 'edit');
  assert.ok(Array.isArray(previews[0][0].pairs) && previews[0][0].pairs.length, 'the preview gets the rebuilt edit, not the summary');
  assert.equal(previews[0][1], '/xxxxx/a.js');
  assert.equal(reads.length, 2, 'the rebuilt step is reused, not read again');
  delete globalThis.document;
});

test('a step too large to rebuild falls back to raw chunks', async () => {
  globalThis.document = { createElement: tag => new Node(tag), createElementNS: (ns, tag) => new Node(tag), createDocumentFragment: () => new Node('#fragment'), addEventListener() {}, removeEventListener() {} };
  const { activityBlock } = await import(pathToFileURL(join(root, 'public', 'native-transcript.js')).href);
  const big = 'x'.repeat(16384);
  const step = { kind: 'command', id: 'c1', name: 'Bash', files: [], detailRefs: ['out'] };
  let calls = 0;
  const box = activityBlock({ steps: [step], t: text => text, onDetail: async (s, ref, offset) => { calls++; return { role: 'tool_result', callId: 'c1', text: big, offset, nextOffset: offset + big.length < 10 * 524288 ? offset + big.length : null }; } });
  box.open = true; box.fire('toggle');
  box.find('nt-step-head').fire('click');
  for (let i = 0; i < 80 && !box.find('nt-code'); i++) await settle();
  assert.ok(box.find('nt-code'), 'raw text is shown');
  assert.ok(box.all().some(n => n.textContent === 'Load more'), 'with a Load more button');
  assert.ok(calls < 40, 'stops reading once the record is known to be too large');
  delete globalThis.document;
});
