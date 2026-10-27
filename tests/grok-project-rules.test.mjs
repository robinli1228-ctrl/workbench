// Grok skips an untrusted folder's AGENTS.md, so Workbench sends it with Grok's rules unless the folder is already trusted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithLanguage } from '../src/i18n.mjs';
import { grokProjectRules } from '../src/grok-project-rules.mjs';

async function env(t) {
  const base = await mkdtemp(join(tmpdir(), 'grok-rules-')), project = join(base, 'project'), grokHome = join(base, 'grok');
  await mkdir(project); await mkdir(grokHome);
  t.after(() => rm(base, { recursive: true, force: true }));
  return { project, grokHome };
}

test('an untrusted folder\'s AGENTS.md is sent with the rules', async t => runWithLanguage('zh', async () => {
  const e = await env(t);
  await writeFile(join(e.project, 'AGENTS.md'), '# Rules\n\nWork in the bound folder.\n');
  const text = await grokProjectRules(e.project, { grokHome: e.grokHome, env: {} });
  assert.ok(text.startsWith(`項目規則（${join(e.project, 'AGENTS.md')}）：\n`));
  assert.ok(text.endsWith('# Rules\n\nWork in the bound folder.'), 'the file text is sent as written');
}));

test('a folder Grok trusts, or a subfolder in the same checkout, gets a pointer instead of the text', async t => runWithLanguage('en', async () => {
  const e = await env(t);
  await writeFile(join(e.project, 'AGENTS.md'), 'rules');
  await writeFile(join(e.grokHome, 'trusted_folders.toml'), `[folders."${e.project}"]\ntrusted = true\ndecided_at = 1\n`);
  assert.match(await grokProjectRules(e.project, { grokHome: e.grokHome, env: {} }), /Grok loads them itself/);
  await mkdir(join(e.project, 'sub')); await writeFile(join(e.project, 'sub', 'AGENTS.md'), 'sub rules');
  assert.match(await grokProjectRules(join(e.project, 'sub'), { grokHome: e.grokHome, env: {} }), /Grok loads them itself/, 'trust covers subfolders');
  await mkdir(join(e.project, 'repo', '.git'), { recursive: true }); await writeFile(join(e.project, 'repo', 'AGENTS.md'), 'repo rules');
  assert.match(await grokProjectRules(join(e.project, 'repo'), { grokHome: e.grokHome, env: {} }), /repo rules$/, 'a nested checkout is a separate workspace');
  await writeFile(join(e.grokHome, 'trusted_folders.toml'), `[folders.'${e.project}']\ntrusted = true\n`);
  assert.match(await grokProjectRules(e.project, { grokHome: e.grokHome, env: {} }), /Grok loads them itself/, 'a literal-quoted key counts');
  await writeFile(join(e.grokHome, 'trusted_folders.toml'), `[folders."${e.project}"]\ntrusted = false\n`);
  assert.match(await grokProjectRules(e.project, { grokHome: e.grokHome, env: {} }), /rules$/, 'a declined folder is not trusted');
  assert.match(await grokProjectRules(e.project, { grokHome: e.grokHome, env: { GROK_FOLDER_TRUST: '0' } }), /Grok loads them itself/, 'with folder trust off Grok loads it everywhere');
}));

test('a symlinked AGENTS.md is followed, and an unreadable one is pointed to without failing the run', async t => runWithLanguage('en', async () => {
  const e = await env(t);
  await writeFile(join(e.project, 'CLAUDE.md'), 'shared rules');
  await symlink('CLAUDE.md', join(e.project, 'AGENTS.md'));
  assert.match(await grokProjectRules(e.project, { grokHome: e.grokHome, env: {} }), /shared rules$/);
  await chmod(join(e.project, 'CLAUDE.md'), 0o000);
  try { if (process.getuid?.() !== 0) assert.match(await grokProjectRules(e.project, { grokHome: e.grokHome, env: {} }), /could not be read/); }
  finally { await chmod(join(e.project, 'CLAUDE.md'), 0o644); }
}));

test('no AGENTS.md sends nothing; an oversized one is pointed to, not attached', async t => runWithLanguage('en', async () => {
  const e = await env(t);
  assert.equal(await grokProjectRules(e.project, { grokHome: e.grokHome }), '');
  await writeFile(join(e.project, 'AGENTS.md'), 'x'.repeat(64 * 1024 + 1));
  const text = await grokProjectRules(e.project, { grokHome: e.grokHome });
  assert.match(text, /over 64 KB/);
  assert.ok(!text.includes('xxxx'));
}));
