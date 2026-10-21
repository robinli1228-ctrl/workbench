// Pasted text over 200 characters becomes a text attachment in both chat input boxes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { PASTE_TEXT_LIMIT, pastesAsFile, pastedTextName, isTextName } = await import(pathToFileURL(join(root, 'public', 'pasted-text.js')).href);

test('only text over 200 characters becomes an attachment, counting characters rather than UTF-16 units', () => {
  assert.equal(PASTE_TEXT_LIMIT, 200);
  const han = '字';
  assert.equal(pastesAsFile(han.repeat(200)), false, 'exactly 200 Chinese characters stay inline');
  assert.equal(pastesAsFile(han.repeat(201)), true);
  assert.equal(pastesAsFile('\u{1F600}'.repeat(150)), false, 'an emoji is one character, not two');
  assert.equal(pastesAsFile(`\n\n   ${'a'.repeat(200)}   \n`), false, 'surrounding blank space is not counted');
  assert.equal(pastesAsFile(`line one\n${'b'.repeat(200)}`), true);
  assert.equal(pastesAsFile(''), false);
  assert.equal(pastesAsFile(undefined), false);
});

test('the attachment is named after the first non-empty line, safe for a file name, as Markdown', () => {
  assert.equal(pastedTextName('\n\n# Release notes\nbody'), 'Release notes.md');
  assert.equal(pastedTextName('a/b:c*d?\nrest'), 'a_b_c_d_.md');
  assert.equal(pastedTextName('notes.txt\nbody'), 'notes.md');
  assert.equal(pastedTextName(`${'x'.repeat(60)}\nbody`), `${'x'.repeat(48)}.md`);
  assert.equal(pastedTextName('   \n\t\n'), 'Pasted text.md');
  assert.equal(isTextName('Release notes.md'), true);
  assert.equal(isTextName('a.TXT'), true);
  assert.equal(isTextName('photo.png'), false);
});
