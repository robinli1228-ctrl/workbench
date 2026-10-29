// Project memory lives in AGENTS.md only: init creates it without overwriting, and wb memory is gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { prepareProjectSpace } = await import(pathToFileURL(join(root, 'src', 'project-space.mjs')).href);
const { ensureAgentsFiles } = await import(pathToFileURL(join(root, 'src', 'agents-md.mjs')).href);
const i18n = await import(pathToFileURL(join(root, 'src', 'i18n.mjs')).href);

test('project init creates AGENTS.md and a CLAUDE.md pointer when absent', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'wb-agents-')));
  try {
    const { localRoot } = await prepareProjectSpace([base], { projectId: 'p1', folder: 'demo' });
    const agents = readFileSync(join(localRoot, 'AGENTS.md'), 'utf8');
    for (const h of ['## Project goal', '## Rules and conventions', '## Build and test commands', '## Key decisions']) assert.ok(agents.includes(h), h);
    assert.ok(agents.split('\n').length < 200);
    assert.equal(readFileSync(join(localRoot, 'CLAUDE.md'), 'utf8').trim(), '@AGENTS.md');
    const zh = await i18n.runWithLanguage('zh', () => i18n.tr('agentsMd.template'));
    assert.ok(zh.includes('## \u9879\u76ee\u76ee\u6807'));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('existing AGENTS.md and CLAUDE.md are never overwritten', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-agents-'));
  try {
    writeFileSync(join(dir, 'AGENTS.md'), 'mine\n');
    writeFileSync(join(dir, 'CLAUDE.md'), 'custom\n');
    assert.deepEqual((await ensureAgentsFiles(dir)).created, []);
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), 'mine\n');
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), 'custom\n');
    rmSync(join(dir, 'CLAUDE.md'));
    assert.deepEqual((await ensureAgentsFiles(dir)).created, ["CLAUDE.md"]);
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), 'mine\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The old file memory (MEMORY.md, wb memory show/remember) stays retired; platform memory is search-only and organized by Home.
test('wb memory only searches platform memory', () => {
  const run = (...args) => spawnSync(process.execPath, [join(root, 'src', 'wb-cli.mjs'), ...args], { encoding: 'utf8' });
  const tools = JSON.parse(run('capabilities').stdout).tools;
  assert.deepEqual(tools.filter(t => t.startsWith('memory')), ['memory search'], tools.join(','));
  const help = run('help').stdout;
  assert.match(help, /wb memory search/);
  assert.ok(!/MEMORY\.md|wb memory (?:show|remember|read)/.test(help));
  assert.notEqual(run('memory').status, 0);
  assert.notEqual(run('memory', 'remember', 'x').status, 0);
});

const gitIn = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
const tempRepo = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wb-agents-git-')));
  gitIn(dir, 'init', '-q'); writeFileSync(join(dir, 'README.md'), 'x\n'); gitIn(dir, 'add', 'README.md'); gitIn(dir, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
  return dir;
};

test('linked git repo gets AGENTS.md + CLAUDE.md in a commit touching only those files', async () => {
  const dir = tempRepo();
  const saved = { ...process.env };
  Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' });
  try {
    writeFileSync(join(dir, 'other.txt'), 'staged\n'); gitIn(dir, 'add', 'other.txt');
    const r = await ensureAgentsFiles(dir);
    assert.deepEqual(r, { created: ['AGENTS.md', 'CLAUDE.md'], committed: true, commitError: null });
    assert.equal(gitIn(dir, 'log', '-1', '--format=%s').stdout.trim(), 'chore: add AGENTS.md project memory');
    assert.deepEqual(gitIn(dir, 'show', '--name-only', '--format=', 'HEAD').stdout.trim().split('\n').sort(), ['AGENTS.md', 'CLAUDE.md']);
    assert.equal(gitIn(dir, 'status', '--porcelain').stdout.trim(), 'A  other.txt');
  } finally { process.env = saved; rmSync(dir, { recursive: true, force: true }); }
});

test('git repo with existing AGENTS.md and CLAUDE.md is untouched and gets no commit', async () => {
  const dir = tempRepo();
  try {
    writeFileSync(join(dir, 'AGENTS.md'), 'mine\n'); writeFileSync(join(dir, 'CLAUDE.md'), 'custom\n');
    const head = gitIn(dir, 'rev-parse', 'HEAD').stdout;
    assert.deepEqual(await ensureAgentsFiles(dir), { created: [], committed: false, commitError: null });
    assert.equal(gitIn(dir, 'rev-parse', 'HEAD').stdout, head);
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), 'mine\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failing commit hook leaves the files uncommitted and reports the error', async () => {
  const dir = tempRepo();
  const saved = { ...process.env };
  Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' });
  try {
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const r = await ensureAgentsFiles(dir);
    assert.equal(r.committed, false); assert.ok(r.commitError);
    assert.equal(gitIn(dir, 'log', '--format=%s').stdout.trim(), 'init');
    assert.match(gitIn(dir, 'status', '--porcelain').stdout, /\?\? AGENTS\.md/);
  } finally { process.env = saved; rmSync(dir, { recursive: true, force: true }); }
});
