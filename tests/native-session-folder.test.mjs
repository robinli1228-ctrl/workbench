// A new native session's default folder: the device folder alone, or the project's own native-sessions/<name> on that device.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { prepareNativeSessionFolder, sessionFolderName } = await import(pathToFileURL(join(root, 'src', 'folders.mjs')).href);

test('a project session folder is created under the project on this device, named after the session', async t => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'wb-folder-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const projectRoot = join(base, 'tms-ai'); mkdirSync(projectRoot);
  const made = await prepareNativeSessionFolder([base], base, [{ localRoot: projectRoot }], { projectRoot, name: 'TMS agentscope' });
  assert.equal(made.path, join(projectRoot, 'native-sessions', 'TMS agentscope'));
  assert.ok(existsSync(made.path));
  // Without a project the device folder is used, and it must not touch a project folder.
  assert.equal((await prepareNativeSessionFolder([base], base, [{ localRoot: projectRoot }])).path, join(base, 'native-sessions'));
  await assert.rejects(prepareNativeSessionFolder([base], base, [{ localRoot: base }]), /overlaps a project/);
  // Outside the device's allowed roots is refused even for a project.
  await assert.rejects(prepareNativeSessionFolder([join(base, 'tms-ai')], base, [], { projectRoot: base, name: 'x' }));
});

test('session folder names are one safe path segment', () => {
  assert.equal(sessionFolderName('  a/b\\c: d?  '), 'a-b-c- d');
  assert.equal(sessionFolderName('..'), 'session');
  assert.equal(sessionFolderName(''), 'session');
  assert.equal(sessionFolderName('.hidden.'), 'hidden');
  assert.equal(sessionFolderName('x'.repeat(100)).length, 80);
});
