// Standalone backend language tests: `node --test tests/` (no SQLite needed; node:sqlite is stubbed on older Node versions).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const fileUrl = (...p) => pathToFileURL(join(root, ...p)).href;

// store.mjs needs node:sqlite (Node >= 22.5). On older Node only the import is stubbed so modules that merely import the store can be tested.
try { await import('node:sqlite'); } catch {
  register('data:text/javascript,' + encodeURIComponent(
    "export async function resolve(s,c,n){if(s==='node:sqlite')return{url:'data:text/javascript,export class DatabaseSync{}',shortCircuit:true};return n(s,c)}"));
}

const i18n = await import(fileUrl('src', 'i18n.mjs'));
const { default: en } = await import(fileUrl('src', 'locales', 'en.mjs'));
const { default: zh } = await import(fileUrl('src', 'locales', 'zh.mjs'));
const hasCjk = (s) => /[\u3000-\u9fff\uff00-\uffef]/.test(s);
const placeholders = (s) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]))].sort();
const withLanguage = async (lang, fn) => i18n.runWithLanguage(lang, fn);

test('locale catalogs have identical key sets and placeholders', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  assert.ok(Object.keys(en).length > 500);
  for (const key of Object.keys(en)) {
    assert.equal(typeof en[key], 'string', key);
    assert.equal(typeof zh[key], 'string', key);
    assert.ok(en[key].trim() && zh[key].trim(), `${key} is empty`);
    assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), `placeholders differ for ${key}`);
    assert.ok(!hasCjk(en[key]), `${key}: English catalog contains CJK text`);
  }
});

test('Chinese catalog entries are actually Chinese', () => {
  const untranslated = Object.keys(zh).filter(k => !hasCjk(zh[k]));
  assert.deepEqual(untranslated, []);
});

test('every tr() key used in the code exists in the catalogs', () => {
  const missing = [];
  for (const file of readdirSync(src).filter(f => f.endsWith('.mjs'))) {
    const text = readFileSync(join(src, file), 'utf8');
    for (const m of text.matchAll(/\btr\(\s*'([^']+)'/g)) if (!(m[1] in en)) missing.push(`${file}: ${m[1]}`);
  }
  assert.deepEqual(missing, []);
});

test('no CJK characters outside src/locales (use \\u escapes)', () => {
  const offenders = [];
  const scan = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'locales') scan(path); continue; }
      if (hasCjk(readFileSync(path, 'utf8'))) offenders.push(path.slice(root.length + 1));
    }
  };
  scan(src); scan(join(root, 'bin'));
  assert.deepEqual(offenders, []);
});

test('language setting: default, validation, persistence, per-run override', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-lang-'));
  try {
    assert.equal(i18n.getLanguage(), 'en');
    assert.deepEqual([...i18n.LANGUAGES], ['en', 'zh']);
    assert.equal(i18n.initLanguage(dir), 'en');
    assert.throws(() => i18n.setLanguage('fr'), { code: 'INVALID_LANGUAGE' });
    assert.throws(() => i18n.setLanguage(undefined), { code: 'INVALID_LANGUAGE' });
    assert.equal(i18n.setLanguage('zh'), 'zh');
    assert.equal(i18n.getLanguage(), 'zh');
    assert.equal(JSON.parse(readFileSync(join(dir, 'language.json'), 'utf8')).language, 'zh');
    // a fresh process reads the saved choice back from the data dir
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { initLanguage } from ${JSON.stringify(fileUrl('src', 'i18n.mjs'))}; console.log(initLanguage(${JSON.stringify(dir)}))`], { encoding: 'utf8' });
    assert.equal(child.stdout.trim(), 'zh');
    // run payloads can pin a language without touching the stored one
    assert.equal(await withLanguage('en', async () => { await null; return i18n.getLanguage(); }), 'en');
    assert.equal(i18n.getLanguage(), 'zh');
    assert.equal(i18n.setLanguage('en'), 'en');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('WB_LANGUAGE sets the initial default', () => {
  const run = (value) => spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { getLanguage } from ${JSON.stringify(fileUrl('src', 'i18n.mjs'))}; console.log(getLanguage())`],
  { encoding: 'utf8', env: { ...process.env, WB_LANGUAGE: value } }).stdout.trim();
  assert.equal(run('zh'), 'zh');
  assert.equal(run('zh-CN'), 'zh');
  assert.equal(run('en'), 'en');
  assert.equal(run('xx'), 'en');
});

test('tr() / L() resolve at call time and fill parameters', async () => {
  const key = 'defaultRoles.planner';
  assert.equal(await withLanguage('en', () => i18n.tr(key)), en[key]);
  assert.equal(await withLanguage('zh', () => i18n.tr(key)), zh[key]);
  assert.equal(i18n.tr('no.such.key'), 'no.such.key');
  assert.equal(await withLanguage('zh', () => i18n.L({ en: 'a', zh: 'b' })), 'b');
  assert.equal(await withLanguage('en', () => i18n.L({ en: 'a', zh: 'b' })), 'a');
  const paramKey = Object.keys(en).find(k => /^\w+\.roleDoesNotExist$/.test(k));
  assert.ok(paramKey);
  assert.ok((await withLanguage('en', () => i18n.tr(paramKey, { name: 'Dev' }))).includes('@Dev'));
  assert.ok((await withLanguage('zh', () => i18n.tr(paramKey, { name: 'Dev' }))).includes('@Dev'));
  assert.deepEqual(i18n.trAll(key), [en[key], zh[key]]);
});

test('language switch changes platform prompts and default roles', async () => {
  const prompts = await import(fileUrl('src', 'platform-prompts.mjs'));
  const roles = await import(fileUrl('src', 'default-roles.mjs'));
  const snapshot = (lang) => withLanguage(lang, () => ({
    platform: prompts.defaultPlatformPrompt(),
    supervisor: prompts.defaultSupervisorPrompt(),
    rules: prompts.executionRules({ reportRequired: true, roleSnapshot: { systemSupervisor: true } }),
    composed: prompts.composeAgentInstructions('P', 'R'),
    templates: roles.defaultRoleTemplates()
  }));
  const a = await snapshot('en'), b = await snapshot('zh');
  for (const k of ['platform', 'supervisor', 'rules', 'composed']) {
    assert.notEqual(a[k], b[k], k);
    assert.ok(!hasCjk(a[k]), `${k} (en) has CJK`);
    assert.ok(hasCjk(b[k]), `${k} (zh) has no CJK`);
  }
  assert.deepEqual(a.templates.map(t => t.key), b.templates.map(t => t.key));
  assert.deepEqual(a.templates.map(t => t.key), ['reviewer', 'planner', 'developer', 'tester']);
  a.templates.forEach((t, i) => {
    assert.notEqual(t.name, b.templates[i].name);
    assert.notEqual(t.instructions, b.templates[i].instructions);
    assert.notEqual(t.modelHint, b.templates[i].modelHint);
    assert.ok(hasCjk(b.templates[i].instructions) && !hasCjk(t.instructions));
  });
  // The module does not freeze text at import time.
  assert.equal(await withLanguage('en', () => prompts.defaultPlatformPrompt()), a.platform);
});

test('stored default prompts follow the language; customised prompts are kept', async () => {
  const prompts = await import(fileUrl('src', 'platform-prompts.mjs'));
  const zhDefault = await withLanguage('zh', () => prompts.defaultPlatformPrompt());
  const enDefault = await withLanguage('en', () => prompts.defaultPlatformPrompt());
  const fromZh = await withLanguage('en', () => prompts.normalizePlatformSettings({ platformPrompt: zhDefault }));
  assert.equal(fromZh.platformPrompt, enDefault);
  const custom = await withLanguage('en', () => prompts.normalizePlatformSettings({ platformPrompt: 'My own rules', supervisorPrompt: '' }));
  assert.equal(custom.platformPrompt, 'My own rules');
  assert.equal(custom.supervisorPrompt, '');
});

test('validation errors are localized', async () => {
  const prompts = await import(fileUrl('src', 'platform-prompts.mjs'));
  const message = (lang) => withLanguage(lang, () => { try { prompts.updatePausedSetting({}, 'nope'); } catch (e) { return e.message; } });
  assert.equal(await message('en'), 'paused must be a boolean');
  assert.ok(hasCjk(await message('zh')));
});

test('matchers accept both languages', async () => {
  const roles = await import(fileUrl('src', 'default-roles.mjs'));
  assert.ok(roles.isSupervisorName('Supervisor') && roles.isSupervisorName('supervisor'));
  assert.ok(roles.isSupervisorName('\u603b\u7ba1'));
  assert.ok(!roles.isSupervisorName('Developer'));
  for (const lang of ['en', 'zh']) {
    assert.ok(await withLanguage(lang, () => roles.isSupervisorName(i18n.tr('rooms.supervisor'))), `${lang} supervisor display name`);
  }

  const wechat = await import(fileUrl('src', 'wechat-channel.mjs'));
  assert.equal(wechat.parseApprovalReply('Approve'), 'approved');
  assert.equal(wechat.parseApprovalReply(' approve. '), 'approved');
  assert.equal(wechat.parseApprovalReply('\u901a\u8fc7'), 'approved');
  assert.equal(wechat.parseApprovalReply('Reject'), 'rejected');
  assert.equal(wechat.parseApprovalReply('\u62d2\u7edd\u3002'), 'rejected');
  assert.equal(wechat.parseApprovalReply('maybe'), null);

  const rooms = await import(fileUrl('src', 'rooms.mjs'));
  assert.deepEqual(rooms.mentionNames('please check @Developer, then @\u5ba1\u6838\u5458\uff0c and (@Tester)'), ['Developer', '\u5ba1\u6838\u5458', 'Tester']);
  assert.deepEqual(rooms.mentionNames('\u4f60\u597d\uff0c@Developer\u3002\u8bf7\u67e5\u770b@Tester'), ['Developer']);
  assert.equal(rooms.collectiveRoleScope('Please ask all roles to review this plan'), 'all');
  assert.equal(rooms.collectiveRoleScope('have all reviewers comment on it'), 'reviewers');
  assert.equal(rooms.collectiveRoleScope('summarize what all roles already commented'), null);
  assert.equal(rooms.collectiveRoleScope('\u8bf7\u8ba9\u6240\u6709\u89d2\u8272\u5ba1\u6838\u8fd9\u4e2a\u65b9\u6848'), 'all');
  assert.equal(rooms.collectiveRoleScope('\u8ba9\u5404\u4e2a\u5ba1\u6838\u89d2\u8272\u7ed9\u51fa\u610f\u89c1'), 'reviewers');
  assert.equal(rooms.collectiveRoleScope('\u4e0d\u8981\u8ba9\u6240\u6709\u89d2\u8272\u6267\u884c'), null);

  const reports = await import(fileUrl('src', 'run-reports.mjs'));
  assert.equal(reports.runFailureKind({ status: 'failed', error: 'insufficient_quota for this key' }), 'unknown');
  assert.equal(reports.runFailureKind({ status: 'failed', error: '\u8f93\u51fa\u8d85\u9650' }), 'incomplete_output');
  assert.equal(reports.runFailureKind({ status: 'failed', error: 'output token limit reached' }), 'incomplete_output');
});

test('run payload language does not leak between concurrent runs', async () => {
  const roles = await import(fileUrl('src', 'default-roles.mjs'));
  const [a, b] = await Promise.all([
    withLanguage('en', async () => { await new Promise(r => setTimeout(r, 5)); return roles.defaultRoleTemplates()[0].name; }),
    withLanguage('zh', async () => roles.defaultRoleTemplates()[0].name)
  ]);
  assert.equal(a, en['defaultRoles.codeReviewer']);
  assert.equal(b, zh['defaultRoles.codeReviewer']);
});

test('package scripts and files are wired', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.ok(/node --test/.test(pkg.scripts.test));
  assert.ok(pkg.scripts.check.includes('src/i18n.mjs'));
  assert.ok(existsSync(join(src, 'locales', 'zh.mjs')));
});
