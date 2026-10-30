// The media path matcher finds exactly what the old whole-text pattern found, and stays linear on long words such as
// base64 evidence parts, which made the old pattern backtrack quadratically.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaPathMatches } from '../public/media.js';

// The matcher before this change, kept as the reference.
const EXT = 'mp4|m4v|mov|webm|mkv|ogv|mp3|m4a|aac|wav|ogg|oga|opus|flac|png|jpe?g|gif|webp|pdf|zip|tar|tgz|gz|7z';
const STOP = '\\s`<>"\'，。；：！？、()\\[\\]';
const PATTERN = new RegExp(`(?:\\/|\\.\\.?\\/)?(?:[^${STOP}\\/]+\\/)*[^${STOP}\\/]+\\.(?:${EXT})(?=$|[\\s，。；：！？、()\\[\\]])`, 'gi');
const reference = text => [...text.matchAll(PATTERN)].filter(m => !(m.index > 0 && /[\w:/.]/.test(text[m.index - 1]))).map(m => ({ index: m.index, path: m[0] }));

test('same matches as the old pattern on mixed prose, paths, URLs and punctuation', () => {
  const pieces = ['a', 'b', '日志', '/', '/', '.', '..', './', ':', '-', '_', ' ', '\n', '，', '。', '`', '"', '(', ')', '[', ']', '<', 'http://', 'x.com', '.png', '.PNG', '.mp4', '.pdf', '.jpeg', '.txt', 'tmp', 'out'];
  let seed = 7;
  const random = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 20000; i++) {
    let text = '';
    for (let k = random(14) + 1; k > 0; k--) text += pieces[random(pieces.length)];
    assert.deepEqual(mediaPathMatches(text), reference(text), JSON.stringify(text));
  }
  for (const text of ['见 /tmp/a.png，和 ./out/b.mp4', 'http://x.com/c.png', 'a//b.png', '文件a.png。', 'x/y.pdf`', '(docs/report.pdf)', '../up/z.gif\nnext'])
    assert.deepEqual(mediaPathMatches(text), reference(text), text);
});

test('a long base64 word is scanned in linear time and never taken for a path', () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let word = ''; for (let i = 0; i < 40000; i++) word += alphabet[(i * 37 + (i >> 3)) % 64];
  const text = Array.from({ length: 20 }, () => `BEGIN_BASE64 ${word} END_BASE64`).join('\n');
  const started = performance.now();
  assert.deepEqual(mediaPathMatches(text), []);
  assert.ok(performance.now() - started < 200, 'twenty 40,000-character parts in well under a frame budget per part');
  assert.deepEqual(mediaPathMatches(`${word}.png`), [], 'a word longer than any real path is data, not a path');
});

// The inline document path rule before this change, kept as the reference.
const DOCUMENT = /^(?:\/(?!\/)|\.\.?\/|\.workbench\/docs\/)[^\s`<>"'，。；：！？、()\[\]]+\.(?:md|markdown|txt)(?=$|[\s，。；：！？、()\[\]])/i;
test('inline document paths: same as the old rule at every position, linear on long words', async () => {
  const { documentPathAt } = await import('../public/markdown.js');
  const pieces = ['a', '日', '/', '//', '.', './', '../', '.workbench/docs/', 'docs/', ' ', '\n', '，', '`', '"', '(', ')', '.md', '.MD', '.txt', '.markdown', '.png', 'x'];
  let seed = 11;
  const random = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 5000; i++) {
    let text = '';
    for (let k = random(12) + 1; k > 0; k--) text += pieces[random(pieces.length)];
    for (let cursor = 0; cursor < text.length; cursor++) {
      const old = text.slice(cursor).match(DOCUMENT)?.[0] ?? null;
      assert.equal(documentPathAt(text, cursor), old, JSON.stringify([text, cursor]));
    }
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let word = ''; for (let i = 0; i < 40000; i++) word += alphabet[(i * 37 + (i >> 3)) % 64];
  const { documentWords } = await import('../public/markdown.js');
  const words = documentWords(word), started = performance.now();
  for (let cursor = 0; cursor < word.length; cursor++) if (word[cursor] === '/') documentPathAt(word, cursor, words);
  assert.ok(performance.now() - started < 200, 'every "/" of a 40,000-character word is checked without rescanning it');
});
