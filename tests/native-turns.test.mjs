// Session-page takeover: exact native resume, idempotent sends, occupancy refusal and no Workbench injection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = name => import(pathToFileURL(join(root, 'src', name)).href);
const { NativeTurnsHome, NativeTurnRunner, applyNativeTurnEvent } = await load('native-turns.mjs');
const { Store } = await load('store.mjs');
const { nativeTurnArgs, NativeCliSession: CliPrintSession, NativeCodexSession, createNativeSession } = await load('native-turn-sessions.mjs');
const { createHomeNativeTurns } = await load('native-turns-home.mjs');
const { receiveTurnFiles } = await load('native-turns-worker.mjs');
const { assertNativeSessionIdle } = await load('native-sessions.mjs');

const SID = '00000000-1111-4222-8333-444444444444';
function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-native-turns-'));
  const db = new Store(join(dir, 'home.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const sent = [];
  const turns = new NativeTurnsHome({ db, send: (nodeId, payload) => sent.push({ nodeId, ...payload }), online: () => true, change() {},
    assertIdle: input => assertNativeSessionIdle(db, { ...input, workspace: null, projectId: null }) });
  return { db, sent, turns, worker: { id: 'n1', capabilities: { nativeTurns: 3 } } };
}

test('a takeover send is idempotent by client ID and forwards only the exact native ID and text', t => {
  const { sent, turns, worker } = home(t);
  const body = { runtime: 'codex', sessionId: SID, clientTurnId: 'client-000001', text: 'continue please' };
  const first = turns.create('n1', worker, body), again = turns.create('n1', worker, body);
  assert.equal(first.id, again.id);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { nodeId: 'n1', type: 'native_turn', id: first.id, runtime: 'codex', sessionId: SID, prompt: 'continue please', attachments: [] });
  assert.throws(() => turns.create('n1', worker, { ...body, text: 'changed' }), /already used/);
  const queued = turns.create('n1', worker, { ...body, clientTurnId: 'client-000002' });
  assert.equal(queued.status, 'waiting'); assert.equal(sent.length, 1, 'a message sent while replying waits in Home, nothing reaches the Worker yet');
});

test('takeover is refused for invalid input, old Workers and sessions owned by a terminal or managed run', t => {
  const { db, turns, worker } = home(t);
  const body = { runtime: 'claude', sessionId: SID, clientTurnId: 'client-000010', text: 'hi' };
  assert.throws(() => turns.create('n1', worker, { ...body, runtime: 'bash' }), /Unsupported CLI/);
  assert.throws(() => turns.create('n1', worker, { ...body, sessionId: '../x' }), /Invalid native session ID/);
  assert.throws(() => turns.create('n1', worker, { ...body, text: '  ' }), /Enter a message/);
  assert.throws(() => turns.create('n1', { capabilities: {} }, body), /Upgrade this Worker/);
  db.put('terminalSessions', { id: 'term-1', status: 'active', nativeSession: { runtime: 'claude', id: SID } });
  assert.throws(() => turns.create('n1', worker, body), /occupied/);
  db.put('terminalSessions', { id: 'term-1', status: 'released', nativeSession: { runtime: 'claude', id: SID } });
  db.put('runs', { id: 'run-1', projectId: 'p1', status: 'running', nativeSession: { runtime: 'claude', id: SID } });
  assert.throws(() => turns.create('n1', worker, body), /managed CLI/);
});

test('turn events keep completed messages in order and ignore updates after the end', () => {
  let turn = { id: 'x', status: 'queued', text: '' };
  for (const event of [{ kind: 'status', status: 'running' }, { kind: 'text', text: 'Hel' }, { kind: 'text', text: 'lo' }, { kind: 'message', text: 'Hello' },
    { kind: 'text', text: 'Done' }, { kind: 'message', text: 'Done.' }, { kind: 'tool', text: 'shell', item: { id: 'a', name: 'shell', status: 'inProgress' } }, { kind: 'status', status: 'succeeded' }, { kind: 'status', status: 'running' }])
    turn = applyNativeTurnEvent(turn, event);
  assert.equal(turn.text, 'Hello\n\nDone.');
  assert.equal(turn.status, 'succeeded');
  assert.deepEqual(turn.events.map(e => e.type), ['text', 'message', 'text', 'message', 'tool']);
  assert.equal(applyNativeTurnEvent({ status: 'stopping' }, { kind: 'status', status: 'running' }).status, 'stopping');
});

test('a disconnect keeps a turn running until the Worker is back or the grace expires; a Home restart still ends it', t => {
  const { db, turns, worker } = home(t);
  const turn = turns.create('n1', worker, { runtime: 'grok', sessionId: SID, clientTurnId: 'client-000020', text: 'go' });
  turns.disconnected('n1', { expireMs: 60000 });
  assert.equal(db.get('nativeTurns', turn.id).status, 'queued', 'the turn is not ended by the disconnect');
  assert.ok(db.get('nativeTurns', turn.id).disconnectedAt);
  assert.ok(turns.list('n1', 'grok', SID)[0].disconnectedAt, 'the page sees the flag');
  // The Worker reconnects and still runs this turn: the flag clears and nothing else changes.
  turns.reconnected('n1', [turn.id]);
  assert.equal(db.get('nativeTurns', turn.id).status, 'queued');
  assert.equal(db.get('nativeTurns', turn.id).disconnectedAt, undefined);
  // The Worker reconnects without it (it restarted): the turn ended while the device was away.
  turns.disconnected('n1', { expireMs: 60000 }); turns.reconnected('n1', []);
  assert.equal(db.get('nativeTurns', turn.id).status, 'interrupted');
  assert.match(db.get('nativeTurns', turn.id).error, /reconnected without/);
  // No reconnection in time: the old ending applies.
  const second = turns.create('n1', worker, { runtime: 'grok', sessionId: SID, clientTurnId: 'client-000021', text: 'again' });
  turns.disconnected('n1', { expireMs: 60000 }); turns.expireDisconnected('n1');
  assert.equal(db.get('nativeTurns', second.id).status, 'interrupted');
  assert.match(db.get('nativeTurns', second.id).error, /Device disconnected/);
  db.put('nativeTurns', { ...db.get('nativeTurns', second.id), status: 'running' });
  turns.recover();
  assert.equal(db.get('nativeTurns', second.id).status, 'interrupted');
});

test('the Worker buffers what its turns report while Home is away, delivers it in order on resume, and stops them when the grace expires', async () => {
  const created = [], sent = [];
  const runner = new NativeTurnRunner({ send: m => sent.push(m), resolveSession: async () => ({ workspace: '/tmp/demo' }), createSession: options => { const s = residentFake(created)(options); s.hold = true; return s; } });
  await runner.start({ id: 'k1', runtime: 'codex', sessionId: SID, prompt: 'long' });
  const before = sent.length;
  runner.suspend({ graceMs: 60000 });
  created[0].options.emit('message', { text: 'still working' });
  created[0].options.emit('tool', { text: 'Bash', item: { id: 't1', name: 'Bash', status: 'completed' } });
  assert.equal(sent.length, before, 'nothing is sent while Home is away');
  assert.deepEqual(runner.activeIds(), ['k1']);
  assert.equal(created[0].shutdowns, 0, 'the CLI keeps running');
  runner.resume();
  assert.deepEqual(sent.slice(before).map(m => m.event.kind), ['message', 'tool'], 'buffered events arrive in order');
  created[0].options.emit('message', { text: 'live again' });
  assert.equal(sent.at(-1).event.text, 'live again', 'after resume events go out at once');
  // Home does not come back in time: the turn is stopped, and that report waits for the next connection.
  runner.suspend({ graceMs: 20 });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(created[0].options.emit && sent.at(-1).event.text, 'live again', 'the stop is buffered, not sent');
  runner.resume();
  assert.equal(sent.filter(m => m.id === 'k1').at(-1).event.status, 'interrupted');
  assert.deepEqual(runner.activeIds(), []);
});

test('a turn that ends during the blip is still named on reconnection, so Home settles it by its own report, not as lost', async t => {
  const created = [], sent = [];
  const runner = new NativeTurnRunner({ send: m => sent.push(m), resolveSession: async () => ({ workspace: '/tmp/demo' }), createSession: options => { const s = residentFake(created)(options); s.hold = true; return s; } });
  await runner.start({ id: 'b1', runtime: 'codex', sessionId: SID, prompt: 'long' });
  runner.suspend({ graceMs: 60000 });
  created[0].options.emit('message', { text: 'done while away' }); created[0].options.emit('status', { status: 'succeeded' });
  assert.deepEqual(runner.activeIds(), ['b1'], 'the finished turn still waits in the buffer');
  // Home: the registration names b1, so it stays; the buffered succeeded report then ends it without an error.
  const { db, turns, worker } = home(t);
  const turn = turns.create('n1', worker, { runtime: 'codex', sessionId: SID, clientTurnId: 'client-000030', text: 'long' });
  turns.disconnected('n1', { expireMs: 60000 }); turns.reconnected('n1', [turn.id]);
  assert.equal(db.get('nativeTurns', turn.id).error, undefined);
  turns.receive('n1', { type: 'native_turn_event', id: turn.id, event: { kind: 'message', text: 'done while away' } });
  turns.receive('n1', { type: 'native_turn_event', id: turn.id, event: { kind: 'status', status: 'succeeded' } });
  assert.equal(db.get('nativeTurns', turn.id).status, 'succeeded'); assert.equal(db.get('nativeTurns', turn.id).error, undefined);
  runner.resume();
  assert.deepEqual(runner.activeIds(), []);
  // A full buffer sheds old text first and never the ending status.
  const r2 = new NativeTurnRunner({ send: m => sent.push(m), resolveSession: async () => ({ workspace: '/tmp/demo' }), createSession: residentFake([]) });
  r2.suspend({ graceMs: 60000 }); for (let i = 0; i < 20000; i++) r2.post({ type: 'native_turn_event', id: 'x', event: { kind: 'text', text: String(i) } });
  r2.post({ type: 'native_turn_event', id: 'x', event: { kind: 'status', status: 'succeeded' } });
  assert.equal(r2.outbox.length, 20000); assert.equal(r2.outbox[0].event.text, '1'); assert.equal(r2.outbox.at(-1).event.kind, 'status');
  r2.resume();
});

test('Worker runner resumes the history folder and stops a CLI that returns a different native ID', async () => {
  const events = [], created = [];
  const fake = reply => ({ start: async () => reply(), stop: async () => { fake.stopped = true; }, shutdown() {} });
  const runner = new NativeTurnRunner({ send: m => events.push(m), resolveSession: async () => ({ workspace: '/tmp/demo' }),
    createSession: options => { created.push(options); return fake(() => { options.emit('status', { status: 'running', nativeSessionId: SID }); options.emit('message', { text: 'ok' }); options.emit('status', { status: 'succeeded' }); }); } });
  await runner.start({ id: 't1', runtime: 'codex', sessionId: SID, prompt: 'p' });
  assert.equal(created[0].cwd, '/tmp/demo');
  assert.equal(created[0].resumeSessionId, SID);
  assert.deepEqual(events.filter(e => e.event).map(e => e.event.status || e.event.kind), ['starting', 'starting', 'running', 'message', 'succeeded']);
  assert.equal(runner.size, 0);
  events.length = 0;
  const other = new NativeTurnRunner({ send: m => events.push(m), resolveSession: async () => ({ workspace: '/tmp/demo' }),
    createSession: options => fake(() => options.emit('status', { status: 'running', nativeSessionId: 'aaaaaaaa-0000-0000-0000-000000000000' })) });
  await other.start({ id: 't2', runtime: 'codex', sessionId: SID, prompt: 'p' });
  assert.match(events.filter(e => e.event).at(-1).event.error, /different native session/);
  events.length = 0;
  const unknown = new NativeTurnRunner({ send: m => events.push(m), resolveSession: async () => ({ workspace: null }), createSession: () => assert.fail('must not start') });
  await unknown.start({ id: 't3', runtime: 'claude', sessionId: SID, prompt: 'p' });
  assert.match(events.filter(e => e.event).at(-1).event.error, /working folder/);
});

test('native takeover arguments resume exactly and carry no Workbench rules or model override', () => {
  for (const runtime of ['claude', 'grok', 'agy']) {
    const args = nativeTurnArgs(runtime, { cwd: '/tmp/demo', sessionId: SID, prompt: 'hello' });
    assert.ok(args.includes(SID), runtime);
    for (const flag of ['--append-system-prompt', '--rules', '--model', '-m', '--system-prompt-snapshot']) assert.ok(!args.includes(flag), `${runtime} ${flag}`);
  }
  assert.throws(() => nativeTurnArgs('claude', { cwd: '/tmp', sessionId: null, prompt: 'x' }), /exact native session ID/);
});

test('a controlled per-turn Grok executable receives the exact resume and streams its reply', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wb-native-cli-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'grok');
  writeFileSync(bin, `#!/usr/bin/env node\nconst a=process.argv.slice(2);const id=a[a.indexOf('--resume')+1];\nconsole.log(JSON.stringify({type:'system',session_id:id}));\nconsole.log(JSON.stringify({type:'result',subtype:'success',session_id:id,result:'echo:'+a[a.indexOf('-p')+1]+':'+process.cwd()}));\n`);
  chmodSync(bin, 0o755);
  const prior = process.env.GROK_BIN; process.env.GROK_BIN = bin; t.after(() => { if (prior === undefined) delete process.env.GROK_BIN; else process.env.GROK_BIN = prior; });
  const events = [];
  const runner = new NativeTurnRunner({ send: m => { if (m.event) events.push(m.event); }, resolveSession: async () => ({ workspace: dir }),
    createSession: ({ runtime, cwd, resumeSessionId, emit, keepAlive }) => new CliPrintSession({ cwd, runtime, emit, resumeSessionId, env: process.env, keepAlive }) });
  const done = new Promise(resolve => { const timer = setInterval(() => { if (events.some(e => ['succeeded', 'failed'].includes(e.status))) { clearInterval(timer); resolve(); } }, 20); });
  await runner.start({ id: 't9', runtime: 'grok', sessionId: SID, prompt: 'hi' });
  await done;
  assert.equal(events.at(-1).status, 'succeeded', JSON.stringify(events));
  assert.equal(events.find(e => e.kind === 'message').text, `echo:hi:${dir}`);
});

const fakeProc = () => ({ exitCode: null, signalCode: null, killed: false });
function residentFake(created, { stopStatus = 'interrupted' } = {}) {
  return options => {
    const session = { options, proc: fakeProc(), starts: 0, reuses: 0, shutdowns: 0,
      reuse(next) { this.reuses++; Object.assign(this.options, next); },
      async start(prompt) { this.starts++; this.lastPrompt = prompt; if (!this.hold) { this.options.emit('message', { text: `reply ${this.starts}` }); this.options.emit('status', { status: 'succeeded' }); } },
      async stop() { this.options.emit('status', { status: stopStatus }); },
      shutdown() { this.shutdowns++; this.proc.exitCode = 0; } };
    created.push(session); return session;
  };
}

test('a resident CLI is started once per takeover, reused, counted once and closed on idle or release', async () => {
  const sent = [], created = [];
  const runner = new NativeTurnRunner({ send: m => sent.push(m), resolveSession: async () => ({ workspace: '/tmp/demo' }), createSession: residentFake(created), idleMs: 30 });
  await runner.start({ id: 'r1', runtime: 'claude', sessionId: SID, prompt: 'one' });
  await runner.start({ id: 'r2', runtime: 'claude', sessionId: SID, prompt: 'two' });
  assert.equal(created.length, 1);
  assert.equal(created[0].reuses, 1);
  assert.equal(created[0].options.keepAlive, true);
  assert.equal(runner.size, 1);
  assert.ok(runner.holds('claude', SID));
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(runner.size, 0);
  assert.equal(created[0].shutdowns, 1);
  assert.deepEqual(sent.at(-1), { type: 'native_takeover_closed', runtime: 'claude', sessionId: SID, reason: 'idle' });
  await runner.start({ id: 'r3', runtime: 'codex', sessionId: SID, prompt: 'three' });
  runner.release('codex', SID);
  assert.equal(created[1].shutdowns, 1);
  assert.equal(sent.at(-1).reason, 'released');
});

test('stop interrupts the current turn but keeps the resident process for the next message', async () => {
  const created = [], sent = [];
  const runner = new NativeTurnRunner({ send: m => sent.push(m), resolveSession: async () => ({ workspace: '/tmp/demo' }), createSession: options => { const s = residentFake(created)(options); s.hold = true; return s; } });
  await runner.start({ id: 's1', runtime: 'codex', sessionId: SID, prompt: 'long' });
  await runner.stop('s1');
  assert.equal(sent.filter(m => m.id === 's1').at(-1).event.status, 'interrupted');
  assert.equal(created[0].shutdowns, 0);
  assert.equal(runner.size, 1);
  created[0].hold = false;
  await runner.start({ id: 's2', runtime: 'codex', sessionId: SID, prompt: 'next' });
  assert.equal(created.length, 1);
  assert.equal(sent.filter(m => m.id === 's2').at(-1).event.status, 'succeeded');
  runner.stopAll();
});

test('Grok has no resident input mode and resumes per turn; images are refused for it and non-image files become paths', async t => {
  const created = [], sent = [];
  const runner = new NativeTurnRunner({ send: m => sent.push(m), resolveSession: async () => ({ workspace: '/tmp/demo' }), createSession: residentFake(created),
    prepareInputs: async m => ({ files: m.files || [], images: m.images || [] }) });
  await runner.start({ id: 'g1', runtime: 'grok', sessionId: SID, prompt: 'look', files: [{ name: 'notes.txt', path: '/data/notes.txt', mime: 'application/octet-stream' }] });
  await runner.start({ id: 'g2', runtime: 'grok', sessionId: SID, prompt: 'again' });
  assert.equal(created.length, 2);
  assert.equal(created[0].options.keepAlive, false);
  assert.equal(created[0].shutdowns, 1);
  assert.match(created[0].lastPrompt, /notes\.txt: \/data\/notes\.txt/);
  assert.equal(runner.size, 0);
  await runner.start({ id: 'g3', runtime: 'grok', sessionId: SID, prompt: 'img', images: [{ mime: 'image/png', data: 'AA==' }] });
  assert.match(sent.at(-1).event.error, /cannot receive images/);
  const { db, worker } = home(t);
  const dir = mkdtempSync(join(tmpdir(), 'wb-native-files-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hook = createHomeNativeTurns({ db, dataDir: dir, send() {}, online: () => true, change() {} }), turns = hook.turns, store = turns.attachments;
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const request = Object.assign((async function* () { yield png; })(), { headers: { 'x-file-name': 'shot.png', 'content-length': String(png.length) } });
  const image = await store.upload(NativeTurnsHome.owner('n1'), request);
  assert.equal(db.get('attachments', image.id), null, 'takeover files never enter group-chat attachments');
  assert.equal(db.get('nativeTurnAttachments', image.id).projectId, 'native:n1');
  assert.equal(image.mime, 'image/png');
  assert.throws(() => turns.create('n1', worker, { runtime: 'grok', sessionId: SID, clientTurnId: 'client-img-01', text: 'x', attachmentIds: [image.id] }), /cannot receive images/);
  assert.throws(() => turns.create('n2', worker, { runtime: 'claude', sessionId: SID, clientTurnId: 'client-img-02', text: 'x', attachmentIds: [image.id] }), /Attachment|attachment/);
  const turn = turns.create('n1', worker, { runtime: 'claude', sessionId: SID, clientTurnId: 'client-img-03', text: 'see', attachmentIds: [image.id] });
  assert.deepEqual(turns.attachmentFor(turn.id, image.id), { owner: 'native:n1', id: image.id });
});

test('turn events retain tools, intermediate messages, errors and phases in order for the page', () => {
  let turn = { id: 'x', status: 'queued', text: '' };
  const steps = [[{ kind: 'status', status: 'starting' }, 'starting'], [{ kind: 'log', text: 'Model is thinking', thinking: true }, 'thinking'],
    [{ kind: 'tool', text: 'Bash', item: { id: 't1', name: 'Bash', input: { command: 'ls' }, status: 'inProgress' } }, 'tool'],
    [{ kind: 'tool', text: 'Bash', item: { id: 't1', status: 'completed', output: 'a.txt' } }, 'working'],
    [{ kind: 'message', text: 'Interim note', phase: 'commentary' }, 'replying']];
  for (const [event, phase] of steps) { turn = applyNativeTurnEvent(turn, event); assert.equal(turn.phase, phase); }
  turn = applyNativeTurnEvent(turn, { kind: 'status', status: 'failed', error: 'boom' });
  assert.deepEqual(turn.events.map(e => e.type), ['log', 'tool', 'tool', 'message', 'error']);
  assert.equal(turn.events[1].payload.item.input.command, 'ls');
  assert.equal(turn.phase, null);
  assert.equal(applyNativeTurnEvent(turn, { kind: 'text', text: 'late' }), turn);
});

test('a resident Claude stream-json process receives exact resume, keeps its pid across turns and gets images as content blocks', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wb-native-resident-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!/usr/bin/env node
const a=process.argv.slice(2);if(!a.includes('--input-format'))process.exit(3);const id=a[a.indexOf('--resume')+1];
console.log(JSON.stringify({type:'system',session_id:id}));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.type!=='user')return;
 const c=m.message.content,images=Array.isArray(c)?c.filter(b=>b.type==='image').length:0,raw=Array.isArray(c)?c[0].text:c;
 // The page's question hint rides in a system-reminder block ahead of the prompt; the words the person typed follow it.
 const end='</system-reminder>',hinted=raw.startsWith('<system-reminder>')&&raw.includes('AskUserQuestion'),text=(hinted?raw.slice(raw.indexOf(end)+end.length).trimStart():raw)+(hinted?'':' nohint');
 console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'tu'+text,name:'Read',input:{file:'x'}}]}}));
 console.log(JSON.stringify({type:'result',subtype:'success',session_id:id,result:'pid='+process.pid+' text='+text+' images='+images}));});
`.replace('#!/usr/bin/env node\n', '#!/usr/bin/env node\nconst require=(await import("node:module")).createRequire(import.meta.url);\n'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  chmodSync(bin, 0o755);
  const prior = process.env.CLAUDE_BIN; process.env.CLAUDE_BIN = bin; t.after(() => { if (prior === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prior; });
  const events = [];
  const runner = new NativeTurnRunner({ send: m => events.push(m), resolveSession: async () => ({ workspace: dir }),
    prepareInputs: async m => ({ files: [], images: m.withImage ? [{ mime: 'image/png', data: 'iVBORw0KGgo=' }] : [] }),
    createSession: ({ runtime, cwd, resumeSessionId, emit, keepAlive, inputImages }) => { const s = new CliPrintSession({ cwd, runtime, emit, resumeSessionId, env: process.env, keepAlive, inputImages }); return s; } });
  t.after(() => runner.stopAll());
  const finished = id => new Promise(resolve => { const timer = setInterval(() => { const e = events.find(x => x.id === id && ['succeeded', 'failed'].includes(x.event?.status)); if (e) { clearInterval(timer); resolve(e); } }, 20); });
  await runner.start({ id: 'c1', runtime: 'claude', sessionId: SID, prompt: 'first' });
  assert.equal((await finished('c1')).event.status, 'succeeded');
  await runner.start({ id: 'c2', runtime: 'claude', sessionId: SID, prompt: 'second', withImage: true });
  assert.equal((await finished('c2')).event.status, 'succeeded');
  const replies = events.filter(e => e.event?.kind === 'message').map(e => e.event.text);
  const pids = replies.map(text => text.match(/pid=(\d+)/)[1]);
  assert.equal(pids[0], pids[1]);
  assert.match(replies[0], /text=first images=0/);
  assert.match(replies[1], /text=second images=1/);
  assert.ok(events.some(e => e.id === 'c2' && e.event?.kind === 'tool' && e.event.item.name === 'Read'));
  assert.equal(runner.size, 1);
});

test('a resident Codex app-server resumes the thread once and reuses it for later turns with image input items', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wb-native-codex-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'codex.mjs');
  writeFileSync(bin, `import {createInterface} from 'node:readline';let resumes=0,turns=0;const out=m=>process.stdout.write(JSON.stringify(m)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize')out({id:m.id,result:{}});
 if(m.method==='thread/resume'){resumes++;out({id:m.id,result:{thread:{id:m.params.threadId}}});}
 if(m.method==='turn/start'){turns++;const images=m.params.input.filter(i=>i.type==='localImage').length,hinted=String(m.params.input[0]?.text).startsWith('<system-reminder>')&&String(m.params.input[0]?.text).includes('request_user_input'),id='turn'+turns;out({id:m.id,result:{turn:{id}}});out({method:'turn/started',params:{turn:{id}}});
  out({method:'item/started',params:{item:{id:'cmd'+turns,type:'commandExecution',command:'ls'}}});
  out({method:'item/completed',params:{item:{id:'msg'+turns,type:'agentMessage',text:'resumes='+resumes+' turns='+turns+' images='+images+' hinted='+hinted+' pid='+process.pid}}});
  out({method:'turn/completed',params:{turn:{id,status:'completed'}}});}
});`);
  const wrapper = join(dir, 'codex');
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${bin}" "$@"\n`); chmodSync(wrapper, 0o755);
  const prior = process.env.CODEX_BIN; process.env.CODEX_BIN = wrapper; t.after(() => { if (prior === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = prior; });
  const events = [];
  const runner = new NativeTurnRunner({ send: m => events.push(m), resolveSession: async () => ({ workspace: dir }),
    prepareInputs: async m => ({ files: m.withImage ? [{ name: 'a.png', path: join(dir, 'a.png'), mime: 'image/png' }] : [], images: [] }),
    createSession: ({ cwd, resumeSessionId, emit, keepAlive, attachments }) => new NativeCodexSession({ cwd, writableRoots: [cwd], attachments, emit, resumeSessionId, env: process.env, keepAlive }) });
  t.after(() => runner.stopAll());
  const finished = id => new Promise(resolve => { const timer = setInterval(() => { const e = events.find(x => x.id === id && ['succeeded', 'failed'].includes(x.event?.status)); if (e) { clearInterval(timer); resolve(e); } }, 20); });
  await runner.start({ id: 'x1', runtime: 'codex', sessionId: SID, prompt: 'a' });
  assert.equal((await finished('x1')).event.status, 'succeeded');
  await runner.start({ id: 'x2', runtime: 'codex', sessionId: SID, prompt: 'b', withImage: true });
  assert.equal((await finished('x2')).event.status, 'succeeded', JSON.stringify(events.filter(e => e.id === 'x2')));
  const replies = events.filter(e => e.event?.kind === 'message').map(e => e.event.text);
  // Each page turn carries the question hint ahead of the typed words.
  assert.match(replies[0], /resumes=1 turns=1 images=0 hinted=true/);
  assert.match(replies[1], /resumes=1 turns=2 images=1 hinted=true/);
  assert.equal(replies[0].match(/pid=(\d+)/)[1], replies[1].match(/pid=(\d+)/)[1]);
  assert.ok(events.some(e => e.event?.kind === 'tool' && e.event.item.command === 'ls'));
});

test('takeover files are verified by hash and stored under the Worker data folder', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wb-native-recv-'))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bytes = Buffer.from('hello'), sha256 = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
  const item = { id: '11111111-1111-4111-8111-111111111111', name: 'a.txt', mime: 'application/octet-stream', size: 5, sha256 };
  const turnId = '22222222-2222-4222-8222-222222222222';
  const ok = async () => new Response(bytes);
  const [file] = await receiveTurnFiles({ items: [item], turnId, root: dir, home: 'http://127.0.0.1:1', token: 'x', fetchImpl: ok });
  assert.ok(file.path.startsWith(join(dir, turnId)));
  await assert.rejects(receiveTurnFiles({ items: [{ ...item, sha256: '0'.repeat(64) }], turnId, root: dir, home: 'http://127.0.0.1:1', token: 'x', fetchImpl: ok }), /verification/);
});

test('managed adapters keep their default behaviour: the shared Codex and print classes are untouched by takeover', async () => {
  const { CodexSession } = await load('codex.mjs');
  const { CliPrintSession: Base } = await load('cli-print-session.mjs');
  assert.ok(new Base({ cwd: '/tmp', runtime: 'claude', model: 'm', emit() {} }).args('hi').includes('--append-system-prompt'));
  assert.equal(Object.prototype.hasOwnProperty.call(CodexSession.prototype, 'close'), false);
  assert.ok(new NativeCodexSession({ cwd: '/tmp', emit() {}, resumeSessionId: SID }) instanceof CodexSession);
});

test('Worker refuses a second concurrent turn for one session and cleans files after a turn', async () => {
  const sent = [], cleaned = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const runner = new NativeTurnRunner({ send: m => sent.push(m), canStart() {}, cleanup: id => cleaned.push(id),
    resolveSession: async () => { await gate; return { workspace: '/tmp' }; },
    createSession: ({ emit }) => ({ proc: null, async start() { emit('status', { status: 'succeeded' }); }, async stop() {}, shutdown() {} }) });
  const a = runner.start({ id: 'a', runtime: 'grok', sessionId: SID, prompt: 'x' });
  await runner.start({ id: 'b', runtime: 'grok', sessionId: SID, prompt: 'y' });
  assert.ok(sent.some(m => m.id === 'b' && m.event?.status === 'failed' && /still replying/.test(m.event.error)));
  release(); await a; await new Promise(r => setTimeout(r, 0));
  assert.ok(sent.some(m => m.id === 'a' && m.event?.status === 'succeeded'));
  assert.deepEqual(cleaned.sort(), ['a', 'b']);
});

test('the turns route reports the queue state and takes pause, order and withdraw', async t => {
  const { db, worker } = home(t);
  db.put('workers', worker);
  const dir = mkdtempSync(join(tmpdir(), 'wb-native-queue-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hook = createHomeNativeTurns({ db, dataDir: dir, send() {}, online: () => true, change() {} }), turns = hook.turns;
  const call = async (method, path, payload = {}) => {
    let out = null; const url = new URL(`http://h${path}`);
    const handled = await hook.http({ method }, {}, { pathname: url.pathname, url, json: (res, value) => { out = value; }, body: async () => payload });
    assert.equal(handled, true); return out;
  };
  const send = (id, text) => turns.create('n1', worker, { runtime: 'claude', sessionId: SID, clientTurnId: id, text });
  send('client-route-a', 'first'); const b = send('client-route-b', 'second'), c = send('client-route-c', 'third');
  const read = () => call('GET', `/api/native-sessions/n1/turns?runtime=claude&sessionId=${SID}`);
  assert.deepEqual((await read()).queue, { paused: false });
  assert.equal((await call('POST', '/api/native-sessions/n1/turns/queue', { runtime: 'claude', sessionId: SID, paused: true })).queue.paused, true);
  assert.deepEqual((await read()).queue, { paused: true });
  const ordered = await call('POST', '/api/native-sessions/n1/turns/queue', { runtime: 'claude', sessionId: SID, order: [c.id, b.id] });
  assert.deepEqual(ordered.items.map(x => x.prompt), ['third', 'second']);
  assert.equal((await call('POST', `/api/native-sessions/n1/turns/${b.id}/withdraw`)).withdrawn, true);
  assert.equal(db.get('nativeTurns', b.id).status, 'cancelled');
});

test('a question from the CLI waits on the turn until the page answers; the CLI\'s resolution clears it', () => {
  let turn = { id: 'x', status: 'running', phase: 'working', text: '' };
  turn = applyNativeTurnEvent(turn, { kind: 'question', id: 'req-1', questions: [{ id: 'q1', header: 'Colour', question: 'Which colour?', options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }], multiSelect: false, allowOther: true }] });
  assert.equal(turn.status, 'waiting_user'); assert.equal(turn.phase, 'waiting'); assert.equal(turn.question.id, 'req-1'); assert.equal(turn.question.questions[0].question, 'Which colour?');
  assert.ok(!turn.events?.length, 'the question is not an event row');
  const other = applyNativeTurnEvent(turn, { kind: 'question_resolved', id: 'req-9' });
  assert.ok(other.question, 'a resolution for another question leaves this one waiting');
  turn = applyNativeTurnEvent(turn, { kind: 'question_resolved', id: 'req-1' });
  assert.equal(turn.question, undefined); assert.equal(turn.status, 'running'); assert.equal(turn.phase, 'working');
  const ended = applyNativeTurnEvent(applyNativeTurnEvent({ id: 'y', status: 'running', text: '' }, { kind: 'question', id: 'r', questions: [{ id: 'q1', question: 'x', options: [] }] }), { kind: 'status', status: 'succeeded' });
  assert.equal(ended.question, undefined, 'a turn that ends takes its open question with it');
});

test('Home forwards the page\'s answer to the Worker once and marks the question answered until the CLI resolves it', t => {
  const { db, sent, turns, worker } = home(t);
  const turn = turns.create('n1', worker, { runtime: 'claude', sessionId: SID, clientTurnId: 'client-ask-01', text: 'ask me' });
  turns.receive('n1', { type: 'native_turn_event', id: turn.id, event: { kind: 'status', status: 'running' } });
  assert.throws(() => turns.answer('n1', turn.id, { answers: { q1: ['Blue'] } }), /no longer waiting/);
  turns.receive('n1', { type: 'native_turn_event', id: turn.id, event: { kind: 'question', id: 'req-1', questions: [{ id: 'q1', header: 'Colour', question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: false, allowOther: true }] } });
  assert.equal(turns.list('n1', 'claude', SID)[0].question.id, 'req-1');
  assert.throws(() => turns.answer('n1', turn.id, { answers: {} }), /Enter an answer/);
  assert.throws(() => turns.answer('n1', turn.id, { questionId: 'other', answers: { q1: ['Blue'] } }), /no longer waiting/);
  const view = turns.answer('n1', turn.id, { answers: { q1: ['Blue'], bogus: ['x'] } });
  assert.equal(view.question.answered, true); assert.equal(view.status, 'waiting_user');
  const message = sent.find(m => m.type === 'native_turn_answer');
  assert.deepEqual({ ...message, nodeId: undefined }, { type: 'native_turn_answer', id: turn.id, questionId: 'req-1', answers: { q1: ['Blue'] }, skip: false, nodeId: undefined });
  assert.throws(() => turns.answer('n1', turn.id, { answers: { q1: ['Red'] } }), /no longer waiting/, 'an answered question takes no second answer');
  turns.receive('n1', { type: 'native_turn_event', id: turn.id, event: { kind: 'question_resolved', id: 'req-1' } });
  assert.equal(db.get('nativeTurns', turn.id).question, undefined); assert.equal(db.get('nativeTurns', turn.id).status, 'running');
  turns.receive('n1', { type: 'native_turn_event', id: turn.id, event: { kind: 'question', id: 'req-2', questions: [{ id: 'q1', question: 'Again?', options: [] }] } });
  assert.equal(turns.answer('n1', turn.id, { skip: true }).question.skip, true);
  assert.equal(sent.filter(m => m.type === 'native_turn_answer').at(-1).skip, true);
});

test('a resident Claude hosts permission prompts: AskUserQuestion reaches the page as a question, the answer goes back as updatedInput, other prompts are allowed', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wb-native-ask-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'claude'), log = join(dir, 'stdin.log');
  writeFileSync(bin, `#!/usr/bin/env node
const fs=require('node:fs');const a=process.argv.slice(2);if(!a.includes('--permission-prompt-tool'))process.exit(3);const id=a[a.indexOf('--resume')+1];
console.log(JSON.stringify({type:'system',session_id:id}));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{fs.appendFileSync('${log}',line+'\\n');const m=JSON.parse(line);
 if(m.type==='control_request'&&m.request.subtype==='initialize'){console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{commands:[]}}}));return;}
 if(m.type==='user'){
  console.log(JSON.stringify({type:'control_request',request_id:'perm-bash',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'ls'},tool_use_id:'tu-bash'}}));
  console.log(JSON.stringify({type:'control_request',request_id:'perm-ask',request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',input:{questions:[{question:'Which colour?',header:'Colour',options:[{label:'Red',description:'r'},{label:'Blue',description:'b'}],multiSelect:false}]},tool_use_id:'tu-ask',requires_user_interaction:true}}));
  return;}
 if(m.type==='control_response'&&m.response.request_id==='perm-ask'){const r=m.response.response;
  console.log(JSON.stringify({type:'result',subtype:'success',session_id:id,result:'answers='+JSON.stringify(r.updatedInput?r.updatedInput.answers:null)+' behavior='+r.behavior}));}});
`.replace('#!/usr/bin/env node\n', '#!/usr/bin/env node\nconst require=(await import("node:module")).createRequire(import.meta.url);\n'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  chmodSync(bin, 0o755);
  const prior = process.env.CLAUDE_BIN; process.env.CLAUDE_BIN = bin; t.after(() => { if (prior === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prior; });
  const events = [];
  const runner = new NativeTurnRunner({ send: m => events.push(m), resolveSession: async () => ({ workspace: dir }), createSession: options => createNativeSession(options) });
  t.after(() => runner.stopAll());
  const until = pred => new Promise(resolve => { const timer = setInterval(() => { const e = events.find(pred); if (e) { clearInterval(timer); resolve(e); } }, 20); });
  await runner.start({ id: 'a1', runtime: 'claude', sessionId: SID, prompt: 'ask' });
  const asked = await until(e => e.id === 'a1' && e.event?.kind === 'question');
  assert.equal(asked.event.id, 'perm-ask');
  assert.deepEqual(asked.event.questions, [{ id: 'q1', header: 'Colour', question: 'Which colour?', multiSelect: false, allowOther: true, options: [{ label: 'Red', description: 'r' }, { label: 'Blue', description: 'b' }] }]);
  assert.ok(events.some(e => e.id === 'a1' && e.event?.status === 'waiting_user'));
  runner.answer('a1', { questionId: 'perm-ask', answers: { q1: ['Blue'] } });
  const done = await until(e => e.id === 'a1' && ['succeeded', 'failed'].includes(e.event?.status));
  assert.equal(done.event.status, 'succeeded');
  assert.ok(events.some(e => e.id === 'a1' && e.event?.kind === 'question_resolved' && e.event.id === 'perm-ask'));
  const reply = events.filter(e => e.id === 'a1' && e.event?.kind === 'message').map(e => e.event.text).join('\n');
  assert.match(reply, /answers=\{"Which colour\?":"Blue"\} behavior=allow/);
  const lines = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines[0].request.subtype, 'initialize', 'the SDK handshake precedes the first message');
  const bash = lines.find(l => l.type === 'control_response' && l.response.request_id === 'perm-bash');
  assert.deepEqual(bash.response.response, { behavior: 'allow', updatedInput: { command: 'ls' } }, 'ordinary prompts are allowed, as the bypass mode would');
});

test('a resident Codex opts into request_user_input; the question reaches the page and the answers go back by question id', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wb-native-codex-ask-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'codex.mjs'), log = join(dir, 'stdin.log');
  writeFileSync(bin, `import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';const out=m=>process.stdout.write(JSON.stringify(m)+'\\n');
appendFileSync('${log}',JSON.stringify(process.argv.slice(2))+'\\n');
createInterface({input:process.stdin}).on('line',line=>{appendFileSync('${log}',line+'\\n');const m=JSON.parse(line);
 if(m.method==='initialize')out({id:m.id,result:{}});
 if(m.method==='thread/resume')out({id:m.id,result:{thread:{id:m.params.threadId}}});
 if(m.method==='turn/start'){out({id:m.id,result:{turn:{id:'t1'}}});out({method:'turn/started',params:{turn:{id:'t1'}}});
  out({id:77,method:'item/tool/requestUserInput',params:{threadId:m.params.threadId,turnId:'t1',itemId:'call_1',questions:[{id:'colour',header:'Colour',question:'Which colour?',isOther:true,isSecret:false,options:[{label:'Red',description:'r'},{label:'Blue',description:'b'}]}],isBlocking:false}});}
 if(m.id===77){out({method:'item/completed',params:{item:{id:'msg1',type:'agentMessage',text:'answers='+JSON.stringify(m.result.answers)}}});out({method:'turn/completed',params:{turn:{id:'t1',status:'completed'}}});}
});`);
  const wrapper = join(dir, 'codex');
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${bin}" "$@"\n`); chmodSync(wrapper, 0o755);
  const prior = process.env.CODEX_BIN; process.env.CODEX_BIN = wrapper; t.after(() => { if (prior === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = prior; });
  const events = [];
  const runner = new NativeTurnRunner({ send: m => events.push(m), resolveSession: async () => ({ workspace: dir }), createSession: options => createNativeSession(options) });
  t.after(() => runner.stopAll());
  const until = pred => new Promise(resolve => { const timer = setInterval(() => { const e = events.find(pred); if (e) { clearInterval(timer); resolve(e); } }, 20); });
  await runner.start({ id: 'k1', runtime: 'codex', sessionId: SID, prompt: 'ask' });
  const asked = await until(e => e.id === 'k1' && e.event?.kind === 'question');
  assert.equal(asked.event.id, 'call_1');
  assert.deepEqual(asked.event.questions, [{ id: 'colour', header: 'Colour', question: 'Which colour?', multiSelect: false, allowOther: true, secret: false, options: [{ label: 'Red', description: 'r' }, { label: 'Blue', description: 'b' }] }]);
  runner.answer('k1', { questionId: 'call_1', answers: { colour: ['Blue'] } });
  assert.equal((await until(e => e.id === 'k1' && ['succeeded', 'failed'].includes(e.event?.status))).event.status, 'succeeded');
  const reply = events.filter(e => e.id === 'k1' && e.event?.kind === 'message').map(e => e.event.text).join('\n');
  assert.match(reply, /answers=\{"colour":\{"answers":\["Blue"\]\}\}/);
  const lines = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(lines[0].join(' ').includes('-c features.default_mode_request_user_input=true app-server'), 'the feature flag rides on the launch');
  assert.equal(lines.find(l => l.method === 'initialize').params.capabilities.experimentalApi, true);
});
