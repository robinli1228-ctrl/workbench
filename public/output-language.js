import {Converter} from './vendor/opencc-t2cn.js';

// Vendored browser build of the already installed opencc-js 1.4.2; no CDN or model request.
const convert = Converter({from:'t',to:'cn'});
// Protect concrete resources, not whole prose fragments merely containing a dot or a quote.
const protectedText = /(`+)[^\n]*?\1|(["'])(?:[A-Za-z]:[\\/]|~?\/|\.{1,2}\/|[\p{L}\p{N}_.-]+[\\/])[^"'\n]*?\2|\]\([^\n)]*\)|(?:https?|file):\/\/[^\s<>"'「」“”‘’『』，。；：！？、]+|(?:[A-Za-z]:[\\/]|~\/|\.{1,2}\/|\/)[^\s<>`"'「」“”‘’『』，。；：！？、()\[\]|]+|(?:[\p{L}\p{N}_.-]+[\\/])+[^\s<>`"'「」“”‘’『』，。；：！？、()\[\]|]+|[\p{L}\p{N}_-][\p{L}\p{N}_.-]*\.[A-Za-z0-9]{1,16}(?=$|[\s`"'「」“”‘’『』，。；：！？、()\[\]<>|])/gu;
const command = /^\s*(?:\$\s+|(?:sudo|env|git|cat|rg|grep|find|sed|awk|echo|printf|python\d*|node|npm|npx|pnpm|yarn|bash|sh|zsh|curl|wget|ssh|scp|rsync|docker|kubectl|systemctl|apt(?:-get)?|pip\d*|claude|grok|agy|codex|mkdir|rm|mv|cp|chmod|chown|touch|ls|cd|pwd|test|export|source|make|cmake|gradle|gradlew|mvn|cargo|go|dotnet|composer|uv|java|javac|ruby|perl|powershell|pwsh|pytest|const|let|var|function|class|import)\b|[A-Za-z_][\w]*=|[{}\[\]]|#!)/;

// Every redraw converts the same texts again; results are remembered (least recently used first out, bounded by count and
// size). Text without a Han character is never changed, so it is returned at once (base64, logs, English prose).
const HAN = /\p{Script=Han}/u, MEMO_ENTRIES = 3000, MEMO_CHARS = 4_000_000, MEMO_TEXT = 100_000;
const memo = new Map();let memoChars = 0;

/** Simplify display prose, including quotations; stored input, copied originals, code and resource identifiers stay exact. */
export function simplifiedCliOutput(text) {
  if (typeof text !== 'string' || !text || !HAN.test(text)) return text;
  const known = memo.get(text);
  if (known !== undefined) { memo.delete(text); memo.set(text, known); return known; }
  const value = convertProse(text);
  if (text.length <= MEMO_TEXT) {
    memo.set(text, value); memoChars += text.length + value.length;
    for (const [key, old] of memo) { if (memo.size <= MEMO_ENTRIES && memoChars <= MEMO_CHARS) break; memo.delete(key); memoChars -= key.length + old.length; }
  }
  return value;
}

function convertProse(text) {
  let fence = null;
  return text.match(/[^\n]*\n|[^\n]+$/g).map(line => {
    const body=line.replace(/^\s{0,3}(?:>\s*)+/,'');
    const marker = body.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      const value = marker[1];
      if (!fence) fence = value;
      else if (value[0] === fence[0] && value.length >= fence.length) fence = null;
      return line;
    }
    const markdownLink = /^\s*\[[^\]\n]+\]\(/.test(body);
    const indentedCode=/^(?: {4}|\t)/.test(body)&&!/^\s*(?:[-+*]|\d+[.)])\s+/.test(body);
    if (fence || indentedCode || !markdownLink && command.test(body)) return line;
    let offset = 0, result = '';
    for (const match of line.matchAll(protectedText)) {
      result += convert(line.slice(offset, match.index)) + match[0];
      offset = match.index + match[0].length;
    }
    return result + convert(line.slice(offset));
  }).join('');
}
