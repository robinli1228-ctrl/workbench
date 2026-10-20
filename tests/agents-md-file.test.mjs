// The AGENTS.md a session uses: the nearest one upwards within the device root; edits refuse stale copies; creation lands in the project.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { locateAgentsFile, readAgentsFile, writeAgentsFile } = await import(pathToFileURL(join(root, 'src', 'agents-md.mjs')).href);

function tree(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'wb-agents-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const project = join(base, 'tms-ai'), session = join(project, 'native-sessions', 'demo');
  mkdirSync(session, { recursive: true });
  return { base, project, session };
}

test('a session folder inside a project reads the project AGENTS.md; the walk stops at the device root', async t => {
  const { base, project, session } = tree(t);
  writeFileSync(join(project, 'AGENTS.md'), '# project memory\n');
  writeFileSync(join(dirname(base), 'AGENTS.md'), '# never read\n', { flag: 'w' });
  t.after(() => rmSync(join(dirname(base), 'AGENTS.md'), { force: true }));
  const found = await readAgentsFile([base], session);
  assert.equal(found.found, true); assert.equal(found.path, join(project, 'AGENTS.md')); assert.equal(found.content, '# project memory\n');
  rmSync(join(project, 'AGENTS.md'));
  const missing = await locateAgentsFile([base], session);
  assert.equal(missing.found, false); assert.equal(missing.path, join(session, 'AGENTS.md'));
  await assert.rejects(locateAgentsFile([join(base, 'elsewhere')], session), /outside the device roots/);
});

test('edits write only the file in use and refuse a stale copy; creation goes to the project folder', async t => {
  const { base, project, session } = tree(t);
  writeFileSync(join(project, 'AGENTS.md'), 'v1');
  utimesSync(join(project, 'AGENTS.md'), new Date('2026-10-20T00:00:00Z'), new Date('2026-10-20T00:00:00Z'));
  const current = await locateAgentsFile([base], session);
  await assert.rejects(writeAgentsFile([base], session, { path: join(session, 'AGENTS.md'), content: 'x' }), /Only the AGENTS.md/);
  await assert.rejects(writeAgentsFile([base], session, { path: current.path, content: 'x', expectedModifiedAt: '2026-10-19T00:00:00.000Z' }), /changed on the device/);
  const saved = await writeAgentsFile([base], session, { path: current.path, content: 'v2', expectedModifiedAt: current.modifiedAt });
  assert.equal(saved.path, current.path); assert.equal(readFileSync(current.path, 'utf8'), 'v2');
  rmSync(current.path);
  await assert.rejects(writeAgentsFile([base], session, { content: 'new' }), /create it first/);
  const created = await writeAgentsFile([base], session, { content: '# mine\n', create: true, createDir: project });
  assert.equal(created.path, join(project, 'AGENTS.md')); assert.equal(readFileSync(created.path, 'utf8'), '# mine\n');
  assert.equal(readFileSync(join(project, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n', 'the CLAUDE.md pointer comes with it');
  assert.equal(existsSync(join(session, 'AGENTS.md')), false);
  await assert.rejects(writeAgentsFile([base], session, { content: 'y'.repeat(700000), create: true }), /up to 600 KB/);
});
