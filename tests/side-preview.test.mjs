// The right-side Preview takes an item only while the Sessions page is shown on a desktop-width window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let phone = false;
globalThis.matchMedia = query => ({ matches: query === '(max-width: 1000px)' && phone });
const { setSidePreviewOpener, canOpenSide, openSide } = await import(pathToFileURL(join(root, 'public', 'side-preview.js')).href);

test('openSide reaches the panel only on the Sessions page at desktop width', () => {
  const opened = [];
  let sessions = true;
  assert.equal(canOpenSide(), false, 'nothing is registered yet');
  setSidePreviewOpener({ available: () => sessions, open: item => opened.push(item.title) });
  assert.equal(openSide({ title: 'reply' }), true);
  assert.equal(openSide(null), false, 'an empty item is ignored');
  sessions = false;
  assert.equal(canOpenSide(), false, 'the group chat has no right-side preview');
  assert.equal(openSide({ title: 'group chat file' }), false);
  sessions = true; phone = true;
  assert.equal(openSide({ title: 'phone' }), false, 'phones have no room beside the chat');
  phone = false;
  assert.equal(openSide({ title: 'picture' }), true);
  assert.deepEqual(opened, ['reply', 'picture']);
});
