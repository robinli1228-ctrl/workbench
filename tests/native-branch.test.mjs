// Branch and delete of a native session's folder: the copy, the delete guard, and the two CLI forks (fake CLIs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, chmodSync, rmSync, realpathSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { branchTarget, copyFolder, measureFolder, deletableFolder, forkClaude, forkCodex } = await import(pathToFileURL(join(root, 'src', 'native-branch.mjs')).href);

function sandbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wb-branch-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the branch goes next to the folder with the first free number, never beside an allowed root', async t => {
  const base = sandbox(t), project = join(base, 'proj'), session = join(project, 'native-sessions', 'demo');
  mkdirSync(session, { recursive: true }); mkdirSync(`${session}-branch-1`);
  assert.equal(await branchTarget(session, [base]), `${session}-branch-2`);
  await assert.rejects(branchTarget(project, [project]), /top-level allowed folder/);
  await assert.rejects(branchTarget(join(base, 'outside'), [project]), /top-level allowed folder/);
});

test('the copy is exact (hidden files, .git, symlinks as links) and refuses folders over the limits', async t => {
  const base = sandbox(t), source = join(base, 'src');
  mkdirSync(join(source, '.git'), { recursive: true }); mkdirSync(join(source, 'sub'));
  writeFileSync(join(source, '.env'), 'SECRET=1'); writeFileSync(join(source, '.git', 'HEAD'), 'ref: refs/heads/main\n'); writeFileSync(join(source, 'sub', 'a.txt'), 'hello');
  symlinkSync('/etc/hostname', join(source, 'link'));
  const size = await copyFolder(source, join(base, 'copy'));
  assert.equal(readFileSync(join(base, 'copy', '.env'), 'utf8'), 'SECRET=1');
  assert.equal(readFileSync(join(base, 'copy', '.git', 'HEAD'), 'utf8'), 'ref: refs/heads/main\n');
  assert.equal(readFileSync(join(base, 'copy', 'sub', 'a.txt'), 'utf8'), 'hello');
  assert.ok(lstatSync(join(base, 'copy', 'link')).isSymbolicLink(), 'a symlink stays a link');
  assert.equal(size.entries, 6);
  await assert.rejects(copyFolder(source, join(base, 'copy')), /EEXIST|exists/, 'never copies over an existing folder');
  await assert.rejects(measureFolder(source, { entries: 3, bytes: 1e9 }), /more than 3 files/);
  await assert.rejects(copyFolder(source, join(base, 'big'), { entries: 100, bytes: 5 }), /larger than/);
  assert.equal(existsSync(join(base, 'big')), false, 'nothing is left behind after a refused copy');
});

test('delete only takes a folder Workbench made for this session, and nothing anyone else uses', async t => {
  const base = sandbox(t), project = join(base, 'proj'), sessions = join(project, 'native-sessions');
  const own = join(sessions, 'demo'), shared = join(base, 'native-sessions'), branch = join(base, 'repo-branch-1'), handmade = join(base, 'handmade');
  for (const dir of [own, shared, branch, handmade, join(own, 'nested')]) mkdirSync(dir, { recursive: true });
  const entry = { id: 'e1', workspace: own }, roots = [base];
  assert.deepEqual(await deletableFolder({ workspace: own, entry, registry: [entry], roots }), { ok: true, path: own });
  assert.equal((await deletableFolder({ workspace: branch, entry: { id: 'e2', workspace: branch, folderCreated: true }, roots })).ok, true, 'a branch copy Workbench created');
  assert.match((await deletableFolder({ workspace: handmade, entry: { id: 'e3', workspace: handmade }, roots })).reason, /not created by Workbench/);
  assert.match((await deletableFolder({ workspace: shared, entry: { id: 'e4', workspace: shared }, roots })).reason, /not created by Workbench/, 'the shared default folder of standalone sessions');
  assert.match((await deletableFolder({ workspace: own, entry: null, roots })).reason, /created in Workbench/);
  assert.match((await deletableFolder({ workspace: base, entry: { id: 'e5', workspace: base, folderCreated: true }, roots })).reason, /top-level allowed folder/);
  assert.match((await deletableFolder({ workspace: own, entry, roots, bindings: [{ projectId: 'p', localRoot: join(own, 'nested') }] })).reason, /project folder/);
  assert.equal((await deletableFolder({ workspace: own, entry, roots, bindings: [{ projectId: 'p', localRoot: project }] })).ok, true, 'a session folder inside its project is fine');
  assert.match((await deletableFolder({ workspace: own, entry, roots, registry: [entry, { id: 'other', workspace: join(own, 'nested') }] })).reason, /Another session/);
  assert.match((await deletableFolder({ workspace: own, entry, roots, runs: [{ workspace: own }] })).reason, /group-chat run/);
  const gone = await deletableFolder({ workspace: join(sessions, 'missing'), entry: { id: 'e6' }, roots });
  assert.equal(gone.missing, true); assert.equal(gone.ok, false);
});

function fakeBin(dir, name, body) {
  const file = join(dir, `${name}.mjs`); writeFileSync(file, body);
  const wrapper = join(dir, name); writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${file}" "$@"\n`); chmodSync(wrapper, 0o755);
  return wrapper;
}

test('Claude forks with one print turn in the copy under the chosen ID; a failure reports the CLI\'s reason', async t => {
  const dir = sandbox(t), cwd = join(dir, 'copy'); mkdirSync(cwd);
  const log = join(dir, 'args.json');
  const bin = fakeBin(dir, 'claude', `import {writeFileSync} from 'node:fs';const a=process.argv.slice(2);writeFileSync(${JSON.stringify(log)},JSON.stringify({a,cwd:process.cwd()}));
const id=a[a.indexOf('--session-id')+1];
if(a[a.indexOf('--resume')+1]==='broken'){console.log(JSON.stringify({type:'result',is_error:true,result:'No conversation found'}));process.exit(1);}
console.log(JSON.stringify({type:'result',is_error:false,result:'Branch ready.',session_id:id}));`);
  const NEW = '40b81b0d-79e8-4456-9120-1ac36138ac8e';
  const result = await forkClaude({ bin, cwd, sessionId: 'orig-session-1', newSessionId: NEW, notice: 'copied to X' });
  assert.deepEqual(result, { sessionId: NEW, reply: 'Branch ready.' });
  const seen = JSON.parse(readFileSync(log, 'utf8'));
  assert.equal(seen.cwd, cwd);
  assert.deepEqual(seen.a, ['-p', 'copied to X', '--resume', 'orig-session-1', '--fork-session', '--session-id', NEW, '--output-format', 'json', '--dangerously-skip-permissions']);
  await assert.rejects(forkClaude({ bin, cwd, sessionId: 'broken', newSessionId: NEW, notice: 'x' }), /No conversation found/);
});

test('Codex forks with thread/fork into the copy, then runs the notice turn on the new thread', async t => {
  const dir = sandbox(t), cwd = join(dir, 'copy'); mkdirSync(cwd);
  const log = join(dir, 'rpc.log');
  const bin = fakeBin(dir, 'codex', `import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';const out=m=>process.stdout.write(JSON.stringify(m)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{appendFileSync(${JSON.stringify(log)},line+'\\n');const m=JSON.parse(line);
 if(m.method==='initialize')out({id:m.id,result:{}});
 if(m.method==='thread/fork')out({id:m.id,result:{thread:{id:'forked-'+m.params.threadId,forkedFromId:m.params.threadId}}});
 if(m.method==='turn/start'){out({id:m.id,result:{turn:{id:'t1'}}});out({id:77,method:'item/commandExecution/requestApproval',params:{}});}
 // The turn finishes only once the approval request has been answered, as a real server would wait for it.
 if(m.id===77&&!m.method)out({method:'turn/completed',params:{turn:{id:'t1',status:'completed'}}});
});`);
  const result = await forkCodex({ bin, cwd, sessionId: 'thread-1', notice: 'copied to X' });
  assert.deepEqual(result, { sessionId: 'forked-thread-1' });
  const lines = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const fork = lines.find(l => l.method === 'thread/fork'), turn = lines.find(l => l.method === 'turn/start');
  assert.deepEqual(fork.params, { threadId: 'thread-1', cwd, approvalPolicy: 'never', sandbox: 'workspace-write' });
  assert.deepEqual(turn.params, { threadId: 'forked-thread-1', input: [{ type: 'text', text: 'copied to X' }] });
  assert.ok(lines.some(l => l.id === 77 && l.error), 'an approval request during the notice turn is refused, so it cannot hang');
});

test('a Codex that cannot start fails the branch at once instead of hanging it', async t => {
  const dir = sandbox(t), cwd = join(dir, 'copy'); mkdirSync(cwd);
  const started = Date.now();
  await assert.rejects(forkCodex({ bin: join(dir, 'no-such-codex'), cwd, sessionId: 'thread-1', notice: 'x' }), /could not start/);
  assert.ok(Date.now() - started < 5000);
});
